import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManagementStore, Mapping } from "./store";
import { GitHubAccounts } from "./accounts";
import { WebAuth } from "./webAuth";
import { UserAccess, AccessError } from "./userAccess";
import { GitHubInstallations } from "./installations";
import { Control, createManagementServer } from "./server";
import { Store } from "../bridge/database";
const resources: { store: ManagementStore; route: Store; directory: string }[] =
  [];
afterEach(() => {
  for (const r of resources.splice(0)) {
    r.route.close();
    r.store.close();
    rmSync(r.directory, { recursive: true, force: true });
  }
});
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "user-api-")),
    store = new ManagementStore(directory),
    route = new Store(":memory:", "test");
  resources.push({ store, route, directory });
  const accounts = new GitHubAccounts(store, "https://bridge.example"),
    webAuth = new WebAuth(store, "https://bridge.example");
  webAuth.configure("123456", "private-discord-secret");
  store.db.prepare("INSERT INTO web_users VALUES (?,?)").run("111111", "Alice");
  const session = webAuth.session("111111");
  const headers = {
    Host: "bridge.example",
    Origin: "https://bridge.example",
    Cookie: `bridge_user=${session}`,
    "X-CSRF-Token": webAuth.csrf(session),
  };
  accounts.app = vi.fn(() => ({
    clientId: "Iv1.test",
    slug: "test-app",
    configured: true,
  }));
  accounts.link = vi.fn(
    () =>
      ({
        discord: "111111",
        github: "11",
        login: "alice",
        status: "active",
      }) as never,
  );
  const forum = {
    id: "333333",
    name: "issues",
    guildId: "222222",
    guild: "Our server",
  };
  const control = {
    status: () => ({
      discord: { connected: true, id: "123456" },
      mappings: store.mappings().map((m) => ({
        ...m,
        ready: true,
        channelName: m.channel,
        pending: 0,
        failed: 0,
        blocked: 0,
      })),
    }),
    reload: vi.fn(async () => {}),
    worker: vi.fn(() => ({ store: route })),
    channels: vi.fn(async () => [forum]),
    userGuilds: vi.fn(async () => [{ id: "222222", name: "Our server" }]),
    userChannels: vi.fn(async () => [forum]),
    authorizeForum: vi.fn(async (_discord: string, channel: string) => {
      if (channel !== "333333") throw new Error("forbidden");
      return forum;
    }),
    resumeHeld: vi.fn(),
  };
  const repo = {
    id: 10,
    name: "repo",
    fullName: "org/repo",
    private: true,
    installation: 1,
  };
  const access = {
    installations: vi.fn(async () => [{ id: 1, owner: "org" }]),
    repositories: vi.fn(async (_discord: string, id: number) => {
      if (id !== 1) throw new AccessError("not yours");
      return [repo];
    }),
    repository: vi.fn(
      async (_discord: string, installation: number, name: string) => {
        if (installation !== 1 || name !== "org/repo")
          throw new AccessError("not yours");
        return repo;
      },
    ),
    authorize: vi.fn(async (_discord: string, name: string) => {
      if (name !== "org/repo") throw new AccessError("not yours");
      return repo;
    }),
  };
  const installations = { config: () => ({ configured: true }) };
  const app = createManagementServer(store, control as unknown as Control, {
    bootstrap: false,
    publicUrl: "https://bridge.example",
    accounts,
    webAuth,
    userAccess: access as unknown as UserAccess,
    installations: installations as GitHubInstallations,
  });
  const mapping: Mapping = {
    id: "mine",
    owner: "org",
    repo: "repo",
    channel: "333333",
    enabled: true,
    roles: [],
    backfill: false,
    guildId: "222222",
    repositoryId: 10,
    installation: 1,
  };
  return {
    app,
    store,
    route,
    headers,
    webAuth,
    control,
    access,
    accounts,
    mapping,
  };
}
describe("self-service mapping boundaries", () => {
  it("completes Discord OAuth into a user-only session and rejects callback replay", async () => {
    const { app, headers, webAuth } = setup();
    Reflect.set(webAuth, "api", {
      exchange: async () => ({
        access_token: "discord-access",
        scope: "identify",
      }),
      identity: async () => ({ id: "444444", username: "bob" }),
    });
    const start = await request(app)
      .get("/auth/discord/login")
      .set({ Host: "bridge.example" });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.location).searchParams.get("state");
    const browser = start.headers["set-cookie"][0].split(";")[0];
    const path =
      "/auth/discord/callback?code=code&iss=" +
      encodeURIComponent("https://discord.com") +
      "&state=" +
      state;
    const response = await request(app)
      .get(path)
      .set({ Host: "bridge.example", Cookie: browser });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/dashboard");
    const sessionCookie = response.headers["set-cookie"].find((s: string) =>
      s.startsWith("bridge_user="),
    );
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    const session = await request(app)
      .get("/user-api/session")
      .set({ Host: "bridge.example", Cookie: sessionCookie.split(";")[0] });
    expect(session.body.user).toEqual({ discord: "444444", name: "bob" });
    expect(
      (
        await request(app)
          .get(path)
          .set({ Host: "bridge.example", Cookie: browser })
      ).status,
    ).toBe(400);
  });
  it("returns browser-authorized GitHub links to the dashboard for an explicit account review", async () => {
    const { app, headers, accounts, store } = setup();
    store.saveSecret("githubAppSecret", "private-client-secret");
    Reflect.set(accounts, "api", {
      oauth: async () => ({
        access_token: "github-user-token",
        expires_in: 28800,
      }),
      identity: async () => ({ id: "11", login: "alice" }),
    });
    const url = new URL(accounts.begin("111111"));
    const flow = accounts.start(url.searchParams.get("ticket")!);
    const state = new URL(flow.url).searchParams.get("state");
    const response = await request(app)
      .get("/auth/github/callback?code=code&state=" + state)
      .set({
        ...headers,
        Cookie: headers.Cookie + "; bridge_oauth=" + flow.browser,
      });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/dashboard");
    const pending = accounts.pending("111111")!;
    expect(pending.login).toBe("alice");
    expect(
      (
        await request(app)
          .post("/user-api/github/confirm")
          .set(headers)
          .send({ id: pending.id })
      ).status,
    ).toBe(200);
  });
  it("never turns a user session into administrator access or accepts an admin session as user identity", async () => {
    const { app, headers, store } = setup();
    expect((await request(app).get("/api/state").set(headers)).status).toBe(
      401,
    );
    expect(
      (
        await request(app)
          .get("/user-api/state")
          .set({ ...headers, Cookie: `bridge_session=${store.session()}` })
      ).status,
    ).toBe(401);
  });
  it("requires a session-bound CSRF token for every mutation", async () => {
    const { app, headers } = setup();
    expect(
      (
        await request(app)
          .post("/user-api/github/unlink")
          .set({ ...headers, "X-CSRF-Token": "" })
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/user-api/github/unlink")
          .set({ ...headers, Origin: "https://other.example" })
          .send({})
      ).status,
    ).toBe(403);
  });
  it("only lists mappings and audit rows when both provider checks pass", async () => {
    const { app, headers, store, mapping } = setup();
    store.saveMapping(mapping);
    store.saveMapping({
      ...mapping,
      id: "other",
      owner: "other",
      repo: "secret",
      channel: "999999",
      guildId: "999998",
    });
    store.audit("admin", "created mapping", mapping);
    store.audit("admin", "secret action", store.mapping("other"));
    const state = await request(app).get("/user-api/state").set(headers);
    expect(state.status).toBe(200);
    expect(state.body.mappings.map((m: Mapping) => m.id)).toEqual(["mine"]);
    expect(state.text).not.toContain("secret");
    expect(state.body.activity).toHaveLength(1);
    expect(state.text).not.toContain("private-discord-secret");
  });
  it("checks GitHub and Discord permissions again for each mapping mutation, including scans and retries", async () => {
    const { app, headers, store, mapping, control, access, route } = setup();
    store.saveMapping(mapping);
    for (const action of ["", "/scan", "/retry"]) {
      control.authorizeForum.mockRejectedValueOnce(new Error("role removed"));
      expect(
        (
          await request(app)
            .post("/user-api/mappings/mine" + action)
            .set(headers)
            .send({ enabled: false })
        ).status,
      ).toBe(403);
    }
    expect(store.mapping("mine")?.enabled).toBe(true);
    expect(route.health().pending).toBe(0);
    access.authorize.mockRejectedValueOnce(new AccessError("admin removed"));
    expect(
      (
        await request(app)
          .post("/user-api/mappings/mine")
          .set(headers)
          .send({ enabled: false })
      ).status,
    ).toBe(403);
    expect(store.mapping("mine")?.enabled).toBe(true);
  });
  it("rejects guessed tenant IDs and prevents repository identity replacements", async () => {
    const { app, headers, store, mapping, access } = setup();
    store.saveMapping({ ...mapping, repositoryId: 999 });
    expect(
      (
        await request(app)
          .post("/user-api/mappings/mine")
          .set(headers)
          .send({ enabled: false })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/user-api/repositories?installation=999")
          .set(headers)
      ).status,
    ).toBe(403);
    expect(access.repositories).toHaveBeenCalledWith("111111", 999);
  });
  it("creates a mapping only after both checks and records stable IDs and an audit event", async () => {
    const { app, headers, store, control, access } = setup();
    const body = {
      installation: 1,
      repository: "org/repo",
      channel: "333333",
      backfill: false,
    };
    const result = await request(app)
      .post("/user-api/mappings")
      .set(headers)
      .send(body);
    expect(result.status).toBe(201);
    expect(access.repository).toHaveBeenCalledWith("111111", 1, "org/repo");
    expect(control.authorizeForum).toHaveBeenCalledWith("111111", "333333");
    expect(store.mappings()[0]).toMatchObject({
      repositoryId: 10,
      installation: 1,
      guildId: "222222",
      createdBy: "111111",
    });
    expect(store.activity()[0]).toMatchObject({
      actor: "discord:111111",
      action: "created mapping",
      repositoryId: 10,
    });
    expect(
      (await request(app).post("/user-api/mappings").set(headers).send(body))
        .status,
    ).toBe(409);
  });
  it("blocks mapping creation if either side is unauthorized", async () => {
    const { app, headers, store, control, access } = setup();
    const body = {
      installation: 1,
      repository: "org/repo",
      channel: "333333",
      backfill: false,
    };
    access.repository.mockRejectedValueOnce(new AccessError("not admin"));
    expect(
      (await request(app).post("/user-api/mappings").set(headers).send(body))
        .status,
    ).toBe(403);
    control.authorizeForum.mockRejectedValueOnce(new Error("no manage server"));
    expect(
      (await request(app).post("/user-api/mappings").set(headers).send(body))
        .status,
    ).toBe(403);
    expect(store.mappings()).toHaveLength(0);
  });
  it("requires GitHub confirmation to match the signed-in Discord user's pending authorization", async () => {
    const { app, headers, accounts } = setup();
    vi.spyOn(accounts, "pending").mockReturnValue({
      id: "own-attempt",
      login: "alice",
      github: "11",
    });
    const confirm = vi.spyOn(accounts, "confirm");
    expect(
      (
        await request(app)
          .post("/user-api/github/confirm")
          .set(headers)
          .send({ id: "other-attempt" })
      ).status,
    ).toBe(400);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("does not let a guessed guild ID bypass Discord checks", async () => {
    const { app, headers, control } = setup();
    control.userChannels.mockRejectedValueOnce(new Error("other guild"));
    expect(
      (await request(app).get("/user-api/channels?guild=999999").set(headers))
        .status,
    ).toBe(403);
    expect(control.userChannels).toHaveBeenCalledWith("111111", "999999");
  });
});
