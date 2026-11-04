import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createManagementServer, Control } from "./server";
import { ManagementStore } from "./store";
import { GitHubInstallations } from "./installations";
import { GitHubAccounts } from "./accounts";
import { Store } from "../bridge/database";
const resources: {
  store: ManagementStore;
  directory: string;
  states: Store[];
}[] = [];
const password = "a private test admin password";
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "management-api-"));
  const store = new ManagementStore(directory);
  const states: Store[] = [];
  resources.push({ store, directory, states });
  const channels = [
    { id: "123456", name: "bugs", guild: "Workspace" },
    { id: "654321", name: "features", guild: "Workspace" },
  ];
  const control: Control = {
    status: () => ({
      discord: { configured: false, connected: false },
      mappings: [],
    }),
    channels: vi.fn(async () => channels),
    reload: vi.fn(async () => {}),
    worker: vi.fn(),
    userGuilds: vi.fn(async () => []),
    userChannels: vi.fn(async () => []),
    authorizeForum: vi.fn(),
    resumeHeld: vi.fn(),
  };
  const providers = {
    validateDiscord: vi.fn(async () => "Bot"),
  };
  const installations = {
    config: vi.fn(() => ({
      appId: "123",
      configured: true,
      generation: "test",
    })),
    configure: vi.fn(async () => {}),
    installations: vi.fn(async () => [
      { id: 1, owner: "org", selection: "selected", suspended: false },
    ]),
    repositories: vi.fn(async () => [
      { id: 11, fullName: "org/one", name: "one", private: true },
      { id: 12, fullName: "org/two", name: "two", private: true },
    ]),
  };
  const accounts = new GitHubAccounts(store, "https://gitissues.example.com");
  const publicApp = createManagementServer(
    store,
    control,
    {
      bootstrap: false,
      publicUrl: "https://gitissues.example.com",
      accounts,
      installations: installations as unknown as GitHubInstallations,
    },
    providers,
  );
  const local = createManagementServer(
    store,
    control,
    { bootstrap: true },
    providers,
  );
  const auth = () => {
    if (!store.hasAdmin()) store.createAdmin(password);
    return `bridge_session=${store.session()}`;
  };
  const headers = {
    Host: "gitissues.example.com",
    Origin: "https://gitissues.example.com",
  };
  return {
    store,
    accounts,
    installations,
    directory,
    states,
    control,
    providers,
    publicApp,
    local,
    auth,
    headers,
  };
}
afterEach(() => {
  for (const r of resources.splice(0)) {
    for (const s of r.states) s.close();
    r.store.close();
    rmSync(r.directory, { recursive: true, force: true });
  }
});
describe("management API", () => {
  it("protects app secrets and exposes only account metadata", async () => {
    const { publicApp, headers, auth } = setup();
    const body = {
      clientId: "Iv1.testclient",
      slug: "test-app",
      clientSecret: "private-client-secret",
    };
    expect(
      (await request(publicApp).post("/api/github-app").set(headers).send(body))
        .status,
    ).toBe(401);
    const cookie = auth();
    expect(
      (
        await request(publicApp)
          .post("/api/github-app")
          .set(headers)
          .set("Cookie", cookie)
          .send(body)
      ).status,
    ).toBe(200);
    const state = await request(publicApp)
      .get("/api/state")
      .set(headers)
      .set("Cookie", cookie);
    expect(state.body.githubApp).toMatchObject({
      configured: true,
      callbackUrl: "https://gitissues.example.com/auth/github/callback",
    });
    expect(state.text).not.toContain(body.clientSecret);
  });
  it("sets a secure OAuth browser cookie and refuses invalid callbacks without an admin session", async () => {
    const { publicApp, headers, accounts } = setup();
    accounts.saveApp("Iv1.testclient", "test-app", "private-client-secret");
    const startUrl = new URL(accounts.begin("123"));
    let formToken = "",
      cookie = "";
    for (let i = 0; i < 3; i++) {
      const landing = await request(publicApp)
        .get(startUrl.pathname + startUrl.search)
        .set(headers);
      expect(landing.status).toBe(200);
      expect(landing.text).toContain("Continue to GitHub");
      expect(landing.headers["content-security-policy"]).toContain(
        "form-action 'self' https://github.com/login/oauth/authorize;",
      );
      formToken = landing.text.match(/name="formToken" value="([^"]+)"/)![1];
      cookie = landing.headers["set-cookie"][0].split(";")[0];
    }
    const response = await request(publicApp)
      .post("/auth/github/start")
      .set(headers)
      .set("Origin", "null")
      .set("Cookie", cookie)
      .type("form")
      .send({ ticket: startUrl.searchParams.get("ticket"), formToken });
    expect(response.status).toBe(303);
    expect(response.headers.location).toMatch(
      /^https:\/\/github.com\/login\/oauth\/authorize\?/,
    );
    expect(String(response.headers["set-cookie"])).toContain(
      "HttpOnly; Secure; SameSite=Lax",
    );
    expect(
      (
        await request(publicApp)
          .get("/auth/github/callback?state=wrong&code=bad")
          .set(headers)
      ).status,
    ).toBe(400);
    expect(
      (await request(publicApp).get("/api/state").set(headers)).status,
    ).toBe(401);
  });
  it("rejects cross-origin link consumption and expired tickets", async () => {
    const { publicApp, headers, accounts, store } = setup();
    accounts.saveApp("Iv1.testclient", "test-app", "private-client-secret");
    const url = new URL(accounts.begin("123"));
    const ticket = url.searchParams.get("ticket");
    const landing = await request(publicApp)
      .get(url.pathname + url.search)
      .set(headers);
    const formToken = landing.text.match(
      /name="formToken" value="([^"]+)"/,
    )![1];
    const cookie = landing.headers["set-cookie"][0].split(";")[0];
    const post = () =>
      request(publicApp)
        .post("/auth/github/start")
        .set(headers)
        .set("Cookie", cookie)
        .type("form");
    expect(
      (
        await post()
          .set("Origin", "https://other.example")
          .send({ ticket, formToken })
      ).status,
    ).toBe(403);
    expect((await post().send({ ticket, formToken: "forged" })).status).toBe(
      403,
    );
    expect(
      (
        await request(publicApp)
          .post("/auth/github/start")
          .set(headers)
          .type("form")
          .send({ ticket, formToken })
      ).status,
    ).toBe(403);
    expect(
      (await post().send({ ticket: "different-ticket", formToken })).status,
    ).toBe(403);
    store.db.exec("UPDATE github_attempts SET expires=0");
    expect((await post().send({ ticket, formToken })).status).toBe(400);
  });
  it("accepts signed authorization revocations without a repository and rejects forged ones", async () => {
    const { publicApp, headers, accounts, store } = setup();
    store.saveSecret("webhook", "shared-webhook-secret");
    const revoke = vi.spyOn(accounts, "revokeGithub");
    const body = JSON.stringify({ action: "revoked", sender: { id: 456 } });
    const delivery = () =>
      request(publicApp)
        .post("/github-webhook")
        .set(headers)
        .set("Content-Type", "application/json")
        .set("x-github-event", "github_app_authorization")
        .set("x-github-delivery", "revoke-1");
    expect((await delivery().send(body)).status).toBe(401);
    expect(revoke).not.toHaveBeenCalled();
    const signature =
      "sha256=" +
      createHmac("sha256", "shared-webhook-secret").update(body).digest("hex");
    expect(
      (await delivery().set("x-hub-signature-256", signature).send(body))
        .status,
    ).toBe(200);
    expect(revoke).toHaveBeenCalledWith("456");
  });
  it("preserves leading and trailing spaces when signing in with an environment-created password", async () => {
    const { store, publicApp, headers } = setup();
    const password = "  environment password  ";
    store.createAdmin(password);
    expect(
      (
        await request(publicApp)
          .post("/api/login")
          .set(headers)
          .send({ password })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(publicApp)
          .post("/api/login")
          .set(headers)
          .send({ password: password.trim() })
      ).status,
    ).toBe(401);
  });

  it("rejects forged webhooks and ignores paused or unmapped repositories", async () => {
    const { store, publicApp, headers } = setup();
    store.saveSecret("webhook", "shared-webhook-secret");
    store.saveMapping({
      id: "paused",
      owner: "org",
      repo: "one",
      channel: "123456",
      backfill: false,
      enabled: false,
      roles: [],
    });
    const send = (repo, signature) => {
      const raw = JSON.stringify({
        repository: { full_name: repo },
        issue: { number: 12 },
        action: "opened",
      });
      const actual =
        "sha256=" +
        createHmac("sha256", "shared-webhook-secret").update(raw).digest("hex");
      return request(publicApp)
        .post("/github-webhook")
        .set({
          ...headers,
          "Content-Type": "application/json",
          "x-hub-signature-256": signature || actual,
          "x-github-event": "issues",
          "x-github-delivery": "delivery",
        })
        .send(raw);
    };
    expect((await send("org/one", "bad-signature")).status).toBe(401);
    expect((await send("org/one")).body.ignored).toBe(true);
    expect((await send("org/not-mapped")).status).toBe(403);
  });
  it("keeps the private-key endpoint authenticated and never returns the saved key", async () => {
    const { publicApp, auth, headers, installations } = setup();
    const body = { appId: "123", privateKey: "test-only-private-key" };
    expect(
      (
        await request(publicApp)
          .post("/api/github-installation")
          .set(headers)
          .send(body)
      ).status,
    ).toBe(401);
    const cookie = auth();
    const response = await request(publicApp)
      .post("/api/github-installation")
      .set({ ...headers, Cookie: cookie })
      .send(body);
    expect(response.status).toBe(200);
    expect(installations.configure).toHaveBeenCalledWith(
      "123",
      "test-only-private-key",
    );
    const state = await request(publicApp)
      .get("/api/state")
      .set({ ...headers, Cookie: cookie });
    expect(state.body.githubInstallation).toMatchObject({
      appId: "123",
      configured: true,
    });
    expect(state.text).not.toContain(body.privateKey);
  });
  it("removes PAT endpoints and exposes installation discovery only to administrators", async () => {
    const { publicApp, auth, headers, installations } = setup();
    expect(
      (await request(publicApp).get("/api/installations").set(headers)).status,
    ).toBe(401);
    const cookie = auth();
    expect(
      (
        await request(publicApp)
          .post("/api/credentials")
          .set({ ...headers, Cookie: cookie })
          .send({ token: "pat" })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(publicApp)
          .get("/api/installations")
          .set({ ...headers, Cookie: cookie })
      ).body.installations[0].owner,
    ).toBe("org");
    const repos = await request(publicApp)
      .get("/api/repositories?installation=1")
      .set({ ...headers, Cookie: cookie });
    expect(repos.body.repositories).toHaveLength(2);
    expect(installations.repositories).toHaveBeenCalledWith(1);
  });
  it("invalidates sessions on logout and rejects expired sessions", async () => {
    const { publicApp, auth, headers, store } = setup();
    const cookie = auth();
    expect(
      (
        await request(publicApp)
          .post("/api/logout")
          .set({ ...headers, Cookie: cookie })
          .send({})
      ).status,
    ).toBe(200);
    expect(
      (
        await request(publicApp)
          .get("/api/state")
          .set({ ...headers, Cookie: cookie })
      ).status,
    ).toBe(401);
    const expired = auth();
    store.db.exec("UPDATE sessions SET expires=0");
    expect(
      (
        await request(publicApp)
          .get("/api/state")
          .set({ ...headers, Cookie: expired })
      ).status,
    ).toBe(401);
  });

  it("does not allow public bootstrap or unauthenticated access to configuration", async () => {
    const { publicApp, headers } = setup();
    expect(
      (
        await request(publicApp)
          .post("/api/setup")
          .set(headers)
          .send({ password })
      ).status,
    ).toBe(403);
    expect(
      (await request(publicApp).get("/api/state").set(headers)).status,
    ).toBe(401);
    expect(
      (await request(publicApp).get("/api/channels").set(headers)).status,
    ).toBe(401);
  });
  it("bootstraps only on the private localhost listener and never allows a second admin", async () => {
    const { local, store } = setup();
    expect(
      (
        await request(local)
          .post("/api/setup")
          .set({
            Host: "gitissues.example.com",
            Origin: "https://gitissues.example.com",
          })
          .send({ password })
      ).status,
    ).toBe(403);
    const headers = { Host: "localhost:5001", Origin: "http://localhost:5001" };
    const response = await request(local)
      .post("/api/setup")
      .set(headers)
      .send({ password });
    expect(response.status).toBe(200);
    expect(store.authenticate(password)).toBe(true);
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(
      (await request(local).post("/api/setup").set(headers).send({ password }))
        .status,
    ).toBe(409);
  });
  it("sets secure sessions, checks password, and rate limits repeated failures", async () => {
    const { publicApp, store, headers } = setup();
    store.createAdmin(password);
    const success = await request(publicApp)
      .post("/api/login")
      .set(headers)
      .send({ password });
    expect(success.status).toBe(200);
    expect(success.headers["set-cookie"][0]).toContain("Secure");
    for (let i = 0; i < 5; i++)
      expect(
        (
          await request(publicApp)
            .post("/api/login")
            .set(headers)
            .send({ password: "wrong" })
        ).status,
      ).toBe(401);
    expect(
      (
        await request(publicApp)
          .post("/api/login")
          .set(headers)
          .send({ password: "wrong" })
      ).status,
    ).toBe(429);
  });
  it("rejects cross-origin mutations and unknown management hostnames", async () => {
    const { publicApp, auth, headers } = setup();
    const cookie = auth();
    expect(
      (
        await request(publicApp)
          .post("/api/discord")
          .set({
            ...headers,
            Origin: "https://attacker.example",
            Cookie: cookie,
          })
          .send({ token: "test" })
      ).status,
    ).toBe(403);
    expect(
      (await request(publicApp).get("/").set("Host", "attacker.example"))
        .status,
    ).toBe(403);
  });
  it("accepts secrets once, validates access, and never returns them in state", async () => {
    const { publicApp, auth, headers, store, providers } = setup();
    const cookie = auth();
    const botToken = "discord-never-return-this";
    expect(
      (
        await request(publicApp)
          .post("/api/discord")
          .set({ ...headers, Cookie: cookie })
          .send({ token: botToken, webhookSecret: "webhook-private-secret" })
      ).status,
    ).toBe(200);
    expect(providers.validateDiscord).toHaveBeenCalledWith(botToken);
    const state = await request(publicApp)
      .get("/api/state")
      .set({ ...headers, Cookie: cookie });
    expect(JSON.stringify(state.body)).not.toContain(botToken);
    expect(JSON.stringify(state.body)).not.toContain("webhook-private-secret");
  });
  it("validates repository access and prevents duplicate channel mappings", async () => {
    const { publicApp, auth, headers, store } = setup();
    const cookie = auth();
    const body = {
      installation: 1,
      repository: "org/one",
      channel: "123456",
      backfill: false,
    };
    expect(
      (
        await request(publicApp)
          .post("/api/mappings")
          .set({ ...headers, Cookie: cookie })
          .send(body)
      ).status,
    ).toBe(201);
    expect(
      (
        await request(publicApp)
          .post("/api/mappings")
          .set({ ...headers, Cookie: cookie })
          .send({ ...body, repository: "org/two" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(publicApp)
          .post("/api/mappings")
          .set({ ...headers, Cookie: cookie })
          .send({
            ...body,
            repository: "org/not-authorized",
            channel: "654321",
          })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(publicApp)
          .post("/api/mappings")
          .set({ ...headers, Cookie: cookie })
          .send({ ...body, repository: "other/one", channel: "654321" })
      ).status,
    ).toBe(400);
  });
  it("routes organization webhook events by repository, isolating identical issue numbers", async () => {
    const { store, publicApp, headers, control, states, directory } = setup();
    store.saveSecret("webhook", "shared-webhook-secret");
    const a = new Store(path.join(directory, "a.sqlite"), "org/one:123456"),
      b = new Store(path.join(directory, "b.sqlite"), "org/two:654321");
    states.push(a, b);
    for (const [id, repo, channel] of [
      ["one", "one", "123456"],
      ["two", "two", "654321"],
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
    vi.mocked(control.worker).mockImplementation((id) => ({
      mapping: store.mapping(id)!,
      store: id === "one" ? a : b,
    }));
    for (const repo of ["one", "two"]) {
      const raw = JSON.stringify({
        repository: { full_name: `org/${repo}` },
        issue: { number: 12 },
        action: "opened",
      });
      const signature =
        "sha256=" +
        createHmac("sha256", "shared-webhook-secret").update(raw).digest("hex");
      const response = await request(publicApp)
        .post("/github-webhook")
        .set({
          ...headers,
          "Content-Type": "application/json",
          "x-hub-signature-256": signature,
          "x-github-event": "issues",
          "x-github-delivery": `delivery-${repo}`,
        })
        .send(raw);
      expect(response.status).toBe(202);
    }
    expect(a.next()!.task).toEqual({ type: "github", issue: 12 });
    expect(b.next()!.task).toEqual({ type: "github", issue: 12 });
    expect(a.health().pending).toBe(1);
    expect(b.health().pending).toBe(1);
  });
});
