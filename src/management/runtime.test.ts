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
        credential: "credential",
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
        credential: "credential",
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
