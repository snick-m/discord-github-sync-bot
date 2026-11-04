import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManagementStore } from "./store";
import { GitHubInstallations } from "./installations";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const resources: { store: ManagementStore; directory: string }[] = [];
afterEach(() => {
  for (const r of resources.splice(0)) {
    r.store.close();
    rmSync(r.directory, { recursive: true, force: true });
  }
});
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "installations-")),
    store = new ManagementStore(directory);
  resources.push({ store, directory });
  store.set(
    "githubApp",
    JSON.stringify({ clientId: "Iv1.testclient", slug: "test-app" }),
  );
  let sequence = 0;
  const api = vi.fn(
    async (
      method: string,
      url: string,
      _token: string,
      _body?: unknown,
    ): Promise<any> => {
      if (url === "/app")
        return { id: 123, client_id: "Iv1.testclient", slug: "test-app" };
      if (url.startsWith("/app/installations?"))
        return [
          {
            id: 1,
            account: { login: "org" },
            repository_selection: "selected",
          },
        ];
      if (url.endsWith("/installation")) return { id: 1 };
      if (method === "POST")
        return {
          token: `read-token-${++sequence}`,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        };
      if (url.startsWith("/installation/repositories?"))
        return {
          repositories: [
            {
              id: 11,
              owner: { login: "org" },
              full_name: "org/one",
              name: "one",
              has_issues: true,
              private: true,
            },
            {
              id: 12,
              owner: { login: "org" },
              full_name: "org/archived",
              name: "archived",
              has_issues: true,
              archived: true,
            },
            {
              id: 13,
              owner: { login: "other" },
              full_name: "other/wrong",
              name: "wrong",
              has_issues: true,
            },
          ],
        };
      throw new Error("Unexpected test endpoint");
    },
  );
  const service = new GitHubInstallations(store, api);
  return { store, service, api };
}
describe("GitHub App installation access", () => {
  it("validates and signs a short-lived RS256 app JWT without exposing the private key", async () => {
    const { service, api, store } = setup();
    await service.configure("123", key);
    const jwt = api.mock.calls[0][2];
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString()).alg).toBe(
      "RS256",
    );
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBe(600);
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        pair.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(service.config()).toMatchObject({ appId: "123", configured: true });
    expect(JSON.stringify(service.config())).not.toContain("PRIVATE KEY");
    expect(
      store.db
        .prepare("SELECT value FROM vault WHERE id='githubAppPrivateKey'")
        .get()?.value,
    ).not.toContain("PRIVATE KEY");
  });
  it("rejects invalid keys and credentials belonging to another OAuth app", async () => {
    const { service, api, store } = setup();
    await expect(service.configure("Iv1.wrong", key)).rejects.toThrow(
      "numeric",
    );
    await expect(service.configure("123", "bad-key")).rejects.toThrow("RSA");
    api.mockResolvedValueOnce({
      id: 123,
      client_id: "Iv1.otherclient",
      slug: "test-app",
    });
    await expect(service.configure("123", key)).rejects.toThrow(
      "same GitHub App",
    );
    expect(store.secret("githubAppPrivateKey")).toBeUndefined();
  });
  it("limits sync tokens to one repository and read-only permissions, with refresh and concurrency deduplication", async () => {
    const { service, api } = setup();
    await service.configure("123", key);
    const [a, b] = await Promise.all([
      service.repositoryToken("org", "one"),
      service.repositoryToken("org", "one"),
    ]);
    expect(a).toBe(b);
    let mint = api.mock.calls.filter((c) => c[0] === "POST");
    expect(mint).toHaveLength(1);
    expect(mint[0][3]).toEqual({
      permissions: { issues: "read", metadata: "read" },
      repositories: ["one"],
    });
    expect(await service.repositoryToken("org", "one")).toBe(a);
    service.invalidate("org", "one");
    expect(await service.repositoryToken("org", "one")).not.toBe(a);
    expect(await service.repositoryToken("org", "two")).not.toBe(a);
    mint = api.mock.calls.filter((c) => c[0] === "POST");
    expect(mint).toHaveLength(3);
    expect(mint[2][3]).toMatchObject({ repositories: ["two"] });
    for (const value of (
      Reflect.get(service, "cache") as Map<string, { expires: number }>
    ).values())
      value.expires = 0;
    const before = api.mock.calls.length;
    await service.repositoryToken("org", "one");
    expect(api.mock.calls.slice(before).some((c) => c[0] === "POST")).toBe(
      true,
    );
  });
  it("pins read tokens to numeric repository and installation IDs", async () => {
    const { service, api } = setup();
    await service.configure("123", key);
    await service.repositoryToken("org", "one", 11, 1);
    expect(api.mock.calls.find((c) => c[0] === "POST")?.[3]).toEqual({
      permissions: { issues: "read", metadata: "read" },
      repository_ids: [11],
    });
    const before = api.mock.calls.filter((c) => c[0] === "POST").length;
    await expect(service.repositoryToken("org", "one", 11, 2)).rejects.toThrow(
      "installation changed",
    );
    expect(api.mock.calls.filter((c) => c[0] === "POST")).toHaveLength(before);
  });
  it("discovers only issue-enabled repositories belonging to the selected installation", async () => {
    const { service, api } = setup();
    await service.configure("123", key);
    expect(await service.installations()).toEqual([
      { id: 1, owner: "org", selection: "selected", suspended: false },
    ]);
    expect(await service.repositories(1)).toEqual([
      { id: 11, fullName: "org/one", name: "one", private: true },
    ]);
    const mint = api.mock.calls.find((c) => c[0] === "POST")!;
    expect(mint[3]).toEqual({
      permissions: { issues: "read", metadata: "read" },
    });
    await expect(service.repositories(999)).rejects.toThrow("unavailable");
    await expect(service.repositories(NaN)).rejects.toThrow("valid");
  });
  it("fails closed on removed installations and never falls back to a PAT", async () => {
    const { service, api } = setup();
    await service.configure("123", key);
    api.mockImplementationOnce(async () => {
      throw Object.assign(new Error("not installed"), { status: 404 });
    });
    await expect(service.repositoryToken("org", "one")).rejects.toMatchObject({
      status: 404,
    });
    expect(api.mock.calls.filter((c) => c[0] === "POST")).toHaveLength(0);
  });
  it("invalidates cached access after the OAuth app changes", async () => {
    const { service, store } = setup();
    await service.configure("123", key);
    await service.repositoryToken("org", "one");
    store.set(
      "githubApp",
      JSON.stringify({ clientId: "Iv1.changedclient", slug: "other" }),
    );
    expect(service.config().configured).toBe(false);
    await expect(service.repositoryToken("org", "one")).rejects.toThrow(
      "Configure",
    );
  });
});
