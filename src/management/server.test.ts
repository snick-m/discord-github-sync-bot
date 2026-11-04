import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createManagementServer, Control } from "./server";
import { ManagementStore } from "./store";
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
  };
  const providers = {
    validateDiscord: vi.fn(async () => "Bot"),
    validateGithub: vi.fn(async () => ({
      login: "alice",
      repositories: [
        { fullName: "org/one", name: "one", private: true },
        { fullName: "org/two", name: "two", private: true },
      ],
    })),
  };
  const publicApp = createManagementServer(
    store,
    control,
    { bootstrap: false, publicUrl: "https://gitissues.example.com" },
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
  it("rejects forged webhooks and ignores paused or unmapped repositories", async () => {
    const { store, publicApp, headers } = setup();
    store.saveSecret("webhook", "shared-webhook-secret");
    store.saveMapping({
      id: "paused",
      owner: "org",
      repo: "one",
      channel: "123456",
      credential: "credential",
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
  it("never saves rejected credentials", async () => {
    const { publicApp, auth, headers, providers, store } = setup();
    const cookie = auth();
    providers.validateGithub.mockRejectedValueOnce(
      new Error("remote rejected private-token"),
    );
    const response = await request(publicApp)
      .post("/api/credentials")
      .set({ ...headers, Cookie: cookie })
      .send({ label: "Org", owner: "org", token: "private-token" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain("private-token");
    expect(store.credentials()).toHaveLength(0);
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
    const token = "github_pat_never-return-this";
    const saved = await request(publicApp)
      .post("/api/credentials")
      .set({ ...headers, Cookie: cookie })
      .send({ label: "Org token", owner: "org", token });
    expect(saved.status).toBe(201);
    expect(JSON.stringify(saved.body)).not.toContain(token);
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
    expect(JSON.stringify(state.body)).not.toContain(token);
    expect(JSON.stringify(state.body)).not.toContain(botToken);
    expect(JSON.stringify(state.body)).not.toContain("webhook-private-secret");
    expect(store.secret(`github:${saved.body.credential.id}`)).toBe(token);
  });
  it("validates repository access and prevents duplicate channel mappings", async () => {
    const { publicApp, auth, headers, store } = setup();
    const cookie = auth();
    const credential = store.saveCredential({
      label: "Org",
      owner: "org",
      login: "alice",
      token: "private",
    });
    const body = {
      credential: credential.id,
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
        credential: "credential",
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
