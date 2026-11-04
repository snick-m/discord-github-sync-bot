import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManagementStore, Mapping } from "./store";
import { Store } from "../bridge/database";
import { importLegacy, initializeAdmin } from "./import";
const resources: { store: ManagementStore; directory: string }[] = [];
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "manager-"));
  const store = new ManagementStore(directory);
  resources.push({ directory, store });
  return { directory, store };
}
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});
describe("management persistence", () => {
  it("initializes the first administrator from ADMIN_PASSWORD and stores only its hash", () => {
    const { store } = setup();
    const password = "  environment admin password  ";
    expect(initializeAdmin(store, { ADMIN_PASSWORD: password })).toBe(true);
    expect(store.authenticate(password)).toBe(true);
    expect(store.get("admin")).not.toContain(password);
  });
  it("never replaces an existing administrator or invalidates sessions on restart", () => {
    const { store } = setup();
    initializeAdmin(store, { ADMIN_PASSWORD: "original-password" });
    const session = store.session();
    expect(
      initializeAdmin(store, { ADMIN_PASSWORD: "replacement-password" }),
    ).toBe(false);
    expect(store.authenticate("original-password")).toBe(true);
    expect(store.authenticate("replacement-password")).toBe(false);
    expect(store.validSession(session)).toBe(true);
  });
  it("leaves setup available when ADMIN_PASSWORD is unset or blank", () => {
    const { store } = setup();
    expect(initializeAdmin(store, {})).toBe(false);
    expect(initializeAdmin(store, { ADMIN_PASSWORD: "" })).toBe(false);
    expect(store.hasAdmin()).toBe(false);
  });
  it("rejects invalid environment passwords without disclosing them or creating an admin", () => {
    const { store } = setup();
    expect(() => initializeAdmin(store, { ADMIN_PASSWORD: "short" })).toThrow(
      "ADMIN_PASSWORD must contain",
    );
    expect(() =>
      initializeAdmin(store, { ADMIN_PASSWORD: "x".repeat(257) }),
    ).toThrow("ADMIN_PASSWORD must contain");
    expect(store.hasAdmin()).toBe(false);
  });

  it("encrypts saved tokens and never includes them in credential metadata", () => {
    const { store, directory } = setup();
    const token = "github_pat_private_test_value";
    const credential = store.saveCredential({
      label: "Org",
      owner: "org",
      login: "alice",
      token,
    });
    expect(JSON.stringify(store.credentials())).not.toContain(token);
    expect(store.secret(`github:${credential.id}`)).toBe(token);
    expect(
      store.db.prepare("SELECT value FROM vault").get()!.value,
    ).not.toContain(token);
    expect(readFileSync(path.join(directory, "master.key"))).toHaveLength(32);
    store.db.exec("PRAGMA wal_checkpoint(FULL)");
    expect(
      readFileSync(path.join(directory, "management.sqlite")).includes(
        Buffer.from(token),
      ),
    ).toBe(false);
  });
  it("retains encrypted credentials across restarts and fails closed if the key is lost", () => {
    const { store, directory } = setup();
    store.saveSecret("discord", "discord-secret");
    store.close();
    resources.pop();
    const reopened = new ManagementStore(directory);
    expect(reopened.secret("discord")).toBe("discord-secret");
    reopened.close();
    unlinkSync(path.join(directory, "master.key"));
    expect(() => new ManagementStore(directory)).toThrow(
      "encryption key is missing",
    );
    rmSync(directory, { recursive: true, force: true });
  });
  it("stores only password hashes and hashed expiring sessions", () => {
    const { store } = setup();
    const password = "a test administrator password";
    store.createAdmin(password);
    expect(store.get("admin")).not.toContain(password);
    expect(store.authenticate(password)).toBe(true);
    expect(store.authenticate("wrong")).toBe(false);
    expect(() => store.createAdmin("replacement-password")).toThrow(
      "already configured",
    );
    const session = store.session();
    expect(store.validSession(session)).toBe(true);
    expect(store.db.prepare("SELECT hash FROM sessions").get()!.hash).not.toBe(
      session,
    );
    store.logout(session);
    expect(store.validSession(session)).toBe(false);
  });
  it("enforces unique repository/channel pairs while preserving paused mappings", () => {
    const { store } = setup();
    const mapping: Mapping = {
      id: "one",
      owner: "org",
      repo: "one",
      channel: "11111",
      credential: "credential",
      backfill: false,
      enabled: true,
      roles: [],
    };
    store.saveMapping(mapping);
    store.saveMapping({ ...mapping, enabled: false });
    expect(() =>
      store.saveMapping({ ...mapping, id: "two", repo: "two" }),
    ).toThrow();
    expect(() => store.saveMapping({ ...mapping, repo: "changed" })).toThrow(
      "cannot change",
    );
    expect(store.mapping("one")!.enabled).toBe(false);
  });
  it("keeps the same issue numbers isolated in each mapping's SQLite state", () => {
    const { directory } = setup();
    const a = new Store(path.join(directory, "a.sqlite"), "org/a:11111"),
      b = new Store(path.join(directory, "b.sqlite"), "org/b:22222");
    try {
      a.saveLink({
        issue: 12,
        thread: "thread-a",
        origin: "github",
        starter: "a",
      });
      b.saveLink({
        issue: 12,
        thread: "thread-b",
        origin: "github",
        starter: "b",
      });
      expect(a.link(12)!.thread).toBe("thread-a");
      expect(b.link(12)!.thread).toBe("thread-b");
    } finally {
      a.close();
      b.close();
    }
  });
  it("imports a legacy configuration once and preserves the original sync database path", () => {
    const { store, directory } = setup();
    const old = new Store(
      path.join(directory, "sync.sqlite"),
      "org/repo:123456",
    );
    old.close();
    const env = {
      DISCORD_TOKEN: "bot-private",
      GITHUB_ACCESS_TOKEN: "gh-private",
      GITHUB_USERNAME: "org",
      GITHUB_REPOSITORY: "repo",
      DISCORD_CHANNEL_ID: "123456",
      GITHUB_WEBHOOK_SECRET: "webhook-private",
    };
    importLegacy(store, env);
    importLegacy(store, env);
    expect(store.mappings()).toHaveLength(1);
    expect(store.credentials()).toHaveLength(1);
    expect(store.mappings()[0].file).toBe(path.join(directory, "sync.sqlite"));
    expect(store.secret("discord")).toBe("bot-private");
  });
});
