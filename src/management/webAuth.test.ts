import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManagementStore } from "./store";
import { WebAuth } from "./webAuth";
const resources: { store: ManagementStore; directory: string }[] = [];
afterEach(() => {
  for (const r of resources.splice(0)) {
    r.store.close();
    rmSync(r.directory, { recursive: true, force: true });
  }
});
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "web-auth-")),
    store = new ManagementStore(directory);
  resources.push({ store, directory });
  const api = {
    exchange: vi.fn(async () => ({
      access_token: "discord-private-access",
      scope: "identify",
    })),
    identity: vi.fn(async () => ({
      id: "111111",
      username: "alice",
      global_name: "Alice",
    })),
  };
  const auth = new WebAuth(store, "https://bridge.example", api);
  auth.configure("123456", "private-oauth-secret");
  const flow = () => {
    const start = auth.start();
    return { ...start, state: new URL(start.url).searchParams.get("state")! };
  };
  return { auth, store, api, flow };
}
describe("Discord dashboard sign-in", () => {
  it("binds the OAuth callback to the browser, issuer, and a single-use state", async () => {
    const { auth, flow, api } = setup(),
      start = flow();
    expect(new URL(start.url).searchParams.get("scope")).toBe("identify");
    await expect(
      auth.callback(start.state, "wrong", "code", "https://discord.com"),
    ).rejects.toThrow();
    await expect(
      auth.callback(
        start.state,
        start.browser,
        "code",
        "https://attacker.example",
      ),
    ).rejects.toThrow();
    expect(api.exchange).not.toHaveBeenCalled();
    const result = await auth.callback(
      start.state,
      start.browser,
      "code",
      "https://discord.com",
    );
    expect(auth.user(result.session)).toEqual({
      discord: "111111",
      name: "Alice",
    });
    await expect(
      auth.callback(start.state, start.browser, "code", "https://discord.com"),
    ).rejects.toThrow();
    expect(api.exchange).toHaveBeenCalledOnce();
  });
  it("keeps user sessions separate from administrator sessions and binds CSRF to each session", async () => {
    const { auth, store, flow } = setup(),
      start = flow();
    const result = await auth.callback(
      start.state,
      start.browser,
      "code",
      "https://discord.com",
    );
    expect(store.validSession(result.session)).toBe(false);
    expect(auth.user(store.session())).toBeUndefined();
    expect(auth.verifyCsrf(result.session, auth.csrf(result.session))).toBe(
      true,
    );
    expect(auth.verifyCsrf(result.session, "0".repeat(64))).toBe(false);
    const other = auth.session("111111");
    expect(auth.verifyCsrf(other, auth.csrf(result.session))).toBe(false);
    auth.logout(result.session);
    expect(auth.user(result.session)).toBeUndefined();
  });
  it("stores only hashed session and flow tokens, and discards Discord access tokens after identification", async () => {
    const { auth, store, flow } = setup(),
      start = flow();
    expect(
      JSON.stringify(store.db.prepare("SELECT * FROM web_oauth").all()),
    ).not.toContain(start.state);
    const result = await auth.callback(
      start.state,
      start.browser,
      "code",
      "https://discord.com",
    );
    const rows = JSON.stringify(
      store.db.prepare("SELECT * FROM web_sessions").all(),
    );
    expect(rows).not.toContain(result.session);
    expect(rows).not.toContain("discord-private-access");
    expect(
      JSON.stringify(store.db.prepare("SELECT * FROM vault").all()),
    ).not.toContain("private-oauth-secret");
    expect(JSON.stringify(auth.config())).not.toContain("private-oauth-secret");
  });
  it("expires sessions and pending flows and invalidates them on client changes", async () => {
    const { auth, store, flow } = setup();
    let start = flow();
    store.db.exec("UPDATE web_oauth SET expires=0");
    await expect(
      auth.callback(start.state, start.browser, "code", "https://discord.com"),
    ).rejects.toThrow();
    start = flow();
    const result = await auth.callback(
      start.state,
      start.browser,
      "code",
      "https://discord.com",
    );
    auth.configure("654321", "replacement-secret");
    expect(auth.user(result.session)).toBeUndefined();
  });
});
