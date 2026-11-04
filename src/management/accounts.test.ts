import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManagementStore } from "./store";
import { GitHubAccounts } from "./accounts";
const resources: { store: ManagementStore; directory: string }[] = [];
afterEach(() => {
  for (const r of resources.splice(0)) {
    r.store.close();
    rmSync(r.directory, { recursive: true, force: true });
  }
});
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "accounts-"));
  const store = new ManagementStore(directory);
  resources.push({ store, directory });
  const api = {
    oauth: vi.fn(async (_parameters: Record<string, string>) => ({
      access_token: "private-user-token",
      refresh_token: "private-refresh-token",
      expires_in: 28800,
      refresh_token_expires_in: 15552000,
    })),
    identity: vi.fn(async (_token: string) => ({ id: "456", login: "alice" })),
  };
  const accounts = new GitHubAccounts(store, "https://gitissues.example", api);
  accounts.saveApp("Iv1.testclient", "test-app", "private-client-secret");
  async function pending(discord = "123") {
    const ticket = new URL(accounts.begin(discord)).searchParams.get("ticket")!;
    const flow = accounts.start(ticket);
    const state = new URL(flow.url).searchParams.get("state")!;
    await accounts.callback(state, flow.browser, "code");
    return { ...flow, state, ticket, pending: accounts.pending(discord)! };
  }
  return { store, accounts, api, pending, directory };
}
describe("GitHub account authorization", () => {
  it("requires the initiating Discord identity to confirm after browser authorization", async () => {
    const { accounts, pending, api } = setup();
    const flow = await pending();
    expect(new URL(flow.url).searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(api.oauth.mock.calls[0][0].code_verifier).toHaveLength(43);
    expect(await accounts.access("123")).toBeUndefined();
    expect(() => accounts.confirm("999", flow.pending.id)).toThrow();
    accounts.confirm("123", flow.pending.id);
    expect(await accounts.access("123")).toEqual({
      token: "private-user-token",
      githubId: "456",
      login: "alice",
    });
    expect(await accounts.access("123", "other")).toBeUndefined();
    expect(() => accounts.confirm("123", flow.pending.id)).toThrow();
    expect(() => accounts.start(flow.ticket)).toThrow();
    await expect(
      accounts.callback(flow.state, flow.browser, "code"),
    ).rejects.toThrow();
  });
  it("rejects a callback without the same browser cookie and never exchanges its code", async () => {
    const { accounts, api } = setup();
    const ticket = new URL(accounts.begin("123")).searchParams.get("ticket")!;
    const flow = accounts.start(ticket);
    const state = new URL(flow.url).searchParams.get("state")!;
    await expect(
      accounts.callback(state, "wrong-browser", "code"),
    ).rejects.toThrow();
    expect(api.oauth).not.toHaveBeenCalled();
  });
  it("prevents one GitHub identity from linking to two Discord identities", async () => {
    const { accounts, pending } = setup();
    accounts.confirm("123", (await pending()).pending.id);
    const second = await pending("999");
    expect(() => accounts.confirm("999", second.pending.id)).toThrow(
      "already linked",
    );
  });
  it("removes pending flows and tokens on unlink, app changes, and revocation", async () => {
    const { accounts, pending, store } = setup();
    accounts.confirm("123", (await pending()).pending.id);
    const attempt = await pending();
    accounts.unlink("123");
    expect(await accounts.access("123")).toBeUndefined();
    expect(() => accounts.confirm("123", attempt.pending.id)).toThrow();
    expect(store.secret("github-user:123")).toBeUndefined();
    accounts.confirm("123", (await pending()).pending.id);
    accounts.revokeGithub("456");
    expect(await accounts.access("123")).toBeUndefined();
    expect(accounts.link("123")?.status).toBe("reauthorize");
    accounts.confirm("123", (await pending()).pending.id);
    accounts.saveApp(
      "Iv1.otherclient",
      "another-app",
      "another-private-secret",
    );
    expect(await accounts.access("123")).toBeUndefined();
  });
  it("refreshes once for concurrent requests and does not resurrect an unlinked account", async () => {
    const { accounts, pending, store, api } = setup();
    accounts.confirm("123", (await pending()).pending.id);
    const saved = JSON.parse(store.secret("github-user:123")!);
    saved.expiresAt = 1;
    store.saveSecret("github-user:123", JSON.stringify(saved));
    let complete!: (value: Awaited<ReturnType<typeof api.oauth>>) => void;
    api.oauth.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const a = accounts.access("123"),
      b = accounts.access("123");
    expect(api.oauth).toHaveBeenCalledTimes(2);
    accounts.unlink("123");
    complete({
      access_token: "new",
      refresh_token: "rotated",
      expires_in: 28800,
      refresh_token_expires_in: 15552000,
    });
    expect(await a).toBeUndefined();
    expect(await b).toBeUndefined();
    expect(store.secret("github-user:123")).toBeUndefined();
  });
  it("binds relay signatures to the repository and actual GitHub author", () => {
    const { accounts } = setup();
    const relay = {
      kind: "message" as const,
      sourceId: "789",
      writer: { kind: "user" as const, discordId: "123", githubId: "456" },
    };
    const marker = accounts.sign(relay, "org/repo");
    expect(accounts.verify(marker, "456", "ORG/REPO")).toEqual(relay);
    expect(accounts.verify(marker, "999", "org/repo")).toBeUndefined();
    expect(accounts.verify(marker, "456", "org/other")).toBeUndefined();
    expect(
      accounts.verify(marker.replace(":789:", ":790:"), "456", "org/repo"),
    ).toBeUndefined();
  });
  it("encrypts tokens and client secrets on disk", async () => {
    const { accounts, pending, store, directory } = setup();
    accounts.confirm("123", (await pending()).pending.id);
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const data = readFileSync(
      path.join(directory, "management.sqlite"),
    ).toString();
    expect(data).not.toContain("private-user-token");
    expect(data).not.toContain("private-refresh-token");
    expect(data).not.toContain("private-client-secret");
    expect(JSON.stringify(accounts.app())).not.toContain("secret");
  });
});
