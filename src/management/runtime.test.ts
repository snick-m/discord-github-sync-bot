import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManagementStore } from "./store";
import { Runtime } from "./runtime";

describe("multi-repository runtime", () => {
  it("starts without a bot token and gives each mapping its own persistent worker state", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "runtime-")),
      store = new ManagementStore(directory);
    for (const [id, repo, channel] of [
      ["first", "one", "123456"],
      ["second", "two", "654321"],
    ])
      store.saveMapping({
        id,
        owner: "org",
        repo,
        channel,
        backfill: false,
        enabled: true,
        roles: [],
      });
    const runtime = new Runtime(store, 300_000);
    try {
      await runtime.reload();
      expect(runtime.status().discord.connected).toBe(false);
      const first = runtime.worker("first")!,
        second = runtime.worker("second")!;
      first.store.saveLink({
        issue: 12,
        thread: "thread-first",
        origin: "github",
        starter: "a",
      });
      second.store.saveLink({
        issue: 12,
        thread: "thread-second",
        origin: "github",
        starter: "b",
      });
      expect(first.store.link(12)!.thread).toBe("thread-first");
      expect(second.store.link(12)!.thread).toBe("thread-second");
      store.saveMapping({ ...store.mapping("first")!, enabled: false });
      await runtime.reload();
      expect(runtime.worker("first")!.store.link(12)!.thread).toBe(
        "thread-first",
      );
      expect(runtime.worker("first")!.mapping.enabled).toBe(false);
    } finally {
      await runtime.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("allows another repository's work to complete while a job is backing off", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "runtime-")),
      store = new ManagementStore(directory);
    for (const [id, repo, channel] of [
      ["first", "one", "123456"],
      ["second", "two", "654321"],
    ])
      store.saveMapping({
        id,
        owner: "org",
        repo,
        channel,
        backfill: false,
        enabled: true,
        roles: [],
      });
    const runtime = new Runtime(store, 300_000);
    Reflect.set(runtime, "client", { isReady: () => true, destroy: () => {} });
    const first = runtime.worker("first")!,
      second = runtime.worker("second")!;
    first.engine = {
      run: vi.fn(async () => {
        throw Object.assign(
          new Error("test-only-secret must not be persisted"),
          { status: 403 },
        );
      }),
    } as never;
    second.engine = { run: vi.fn(async () => {}) } as never;
    first.store.enqueue({ type: "github", issue: 12 });
    second.store.enqueue({ type: "github", issue: 12 });
    try {
      await Reflect.get(runtime, "drain").call(runtime);
      expect(first.store.health().pending).toBe(1);
      expect(second.store.health().pending).toBe(0);
      expect(
        first.store.db.prepare("SELECT error FROM jobs").get()!.error,
      ).not.toContain("test-only-secret");
    } finally {
      await runtime.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import {
  ForumChannel,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
describe("Discord mapping authorization", () => {
  async function withRuntime(
    test: (
      runtime: Runtime,
      member: any,
      channel: any,
      bot: any,
    ) => Promise<void>,
  ) {
    const directory = mkdtempSync(path.join(tmpdir(), "forum-auth-")),
      store = new ManagementStore(directory),
      runtime = new Runtime(store, 300000);
    const member = {
      permissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
    };
    const bot = { id: "555555" };
    const all = new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageThreads,
    ]);
    const channel = Object.create(ForumChannel.prototype);
    for (const [key, value] of Object.entries({
      id: "333333",
      name: "issues",
      guildId: "222222",
      permissionsFor: (who: unknown) =>
        who === bot
          ? all
          : new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
    }))
      Object.defineProperty(channel, key, {
        value,
        writable: true,
        configurable: true,
      });
    const guild = {
      id: "222222",
      name: "Workspace",
      members: { fetch: vi.fn(async () => member) },
      fetch: vi.fn(async () => {}),
      roles: { fetch: vi.fn(async () => {}) },
      channels: { fetch: vi.fn(async () => new Map([[channel.id, channel]])) },
    };
    Reflect.set(runtime, "client", {
      user: bot,
      isReady: () => true,
      destroy: () => {},
      channels: { fetch: vi.fn(async () => channel) },
      guilds: { cache: new Map([[guild.id, guild]]) },
    });
    try {
      await test(runtime, member, channel, bot);
    } finally {
      await runtime.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  it("requires current Manage Server permission rather than a cached dashboard claim", async () =>
    withRuntime(async (runtime, member) => {
      expect(await runtime.authorizeForum("111111", "333333")).toMatchObject({
        guildId: "222222",
      });
      member.permissions = new PermissionsBitField([]);
      await expect(runtime.authorizeForum("111111", "333333")).rejects.toThrow(
        "Manage Server",
      );
      expect(await runtime.userGuilds("111111")).toEqual([]);
    }));
  it("requires both forum visibility and all bot permissions", async () =>
    withRuntime(async (runtime, _member, channel, bot) => {
      const original = channel.permissionsFor;
      channel.permissionsFor = (who: unknown) =>
        who === bot ? original(who) : new PermissionsBitField([]);
      await expect(runtime.authorizeForum("111111", "333333")).rejects.toThrow(
        "view",
      );
      channel.permissionsFor = (who: unknown) =>
        who === bot
          ? new PermissionsBitField([PermissionFlagsBits.ViewChannel])
          : original(who);
      await expect(runtime.authorizeForum("111111", "333333")).rejects.toThrow(
        "Manage Threads",
      );
    }));
  it("rejects arbitrary server IDs even if the user belongs to an authorized server", async () =>
    withRuntime(async (runtime) => {
      await expect(runtime.userChannels("111111", "999999")).rejects.toThrow(
        "not in",
      );
    }));
});
