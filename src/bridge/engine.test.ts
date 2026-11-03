import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine";
import { Store } from "./database";
import { chunks, issueMarker, issueSummary, messageMarker } from "./content";
import { Comment, Issue, Link, Message, Platforms, Post } from "./types";

class Fake implements Platforms {
  gh: Issue[] = [];
  dc: Post[] = [];
  commentsByIssue = new Map<number, Comment[]>();
  messagesByThread = new Map<string, Message[]>();
  seq = 1000;
  state = vi.fn(async (number: number, state: "open" | "closed") => {
    this.gh.find((i) => i.number === number)!.state = state;
  });
  issues = vi.fn(async (_since?: string) => structuredClone(this.gh));
  getIssue = vi.fn(async (number: number) => {
    const issue = this.gh.find((i) => i.number === number);
    if (!issue) throw Object.assign(new Error("Not found"), { status: 404 });
    return structuredClone(issue);
  });
  createIssue = vi.fn(async (post: Post, marker: string) =>
    this.addIssue({ body: `${post.starter.body}\n${marker}`, own: true }),
  );
  editIssue = vi.fn(async (number: number, body: string) => {
    this.gh.find((i) => i.number === number)!.body = body;
  });
  comments = vi.fn(async (number: number) =>
    structuredClone(this.commentsByIssue.get(number) ?? []),
  );
  createComment = vi.fn(async (number: number, body: string) => {
    const id = String(++this.seq);
    const comments = this.commentsByIssue.get(number) ?? [];
    comments.push({
      id,
      body,
      own: true,
      author: "bridge",
      url: `https://github.com/o/r/issues/${number}#issuecomment-${id}`,
    });
    this.commentsByIssue.set(number, comments);
    return id;
  });
  editComment = vi.fn(async (id: string, body: string) => {
    const comment = [...this.commentsByIssue.values()]
      .flat()
      .find((c) => c.id === id);
    if (!comment) throw Object.assign(new Error("Not found"), { status: 404 });
    comment.body = body;
  });
  posts = vi.fn(async () => structuredClone(this.dc));
  getPost = vi.fn(async (thread: string) => {
    const post = this.dc.find((p) => p.id === thread);
    if (!post) throw Object.assign(new Error("Not found"), { status: 404 });
    return structuredClone(post);
  });
  createPost = vi.fn(async (issue: Issue) =>
    this.addPost({
      bot: true,
      own: true,
      body: chunks(issueSummary(issue), issue.url)[0],
    }),
  );
  updatePost = vi.fn(async (_link: Link, _issue: Issue) => {});
  messages = vi.fn(async (thread: string) =>
    structuredClone(this.messagesByThread.get(thread) ?? []),
  );
  send = vi.fn(
    async (thread: string, body: string, _nonce: string) =>
      this.addMessage(thread, body, true).id,
  );
  edit = vi.fn(async (thread: string, id: string, body: string) => {
    const message = this.messagesByThread.get(thread)?.find((m) => m.id === id);
    if (!message) throw Object.assign(new Error("Not found"), { status: 404 });
    message.body = body;
  });
  addIssue(overrides: Partial<Issue> = {}) {
    const number = ++this.seq;
    const issue: Issue = {
      number,
      title: "Bug",
      body: "Details",
      url: `https://github.com/o/r/issues/${number}`,
      author: "alice",
      state: "open",
      labels: [],
      locked: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
    this.gh.push(issue);
    return issue;
  }
  addPost(overrides: Partial<Message> = {}) {
    const id = String(++this.seq);
    const starter: Message = {
      id,
      thread: id,
      body: "Report",
      author: "bob",
      url: `https://discord.com/channels/1/${id}/${id}`,
      bot: false,
      ...overrides,
    };
    const post: Post = {
      id,
      title: "Report",
      starter,
      tags: [],
      createdAt: new Date().toISOString(),
    };
    this.dc.push(post);
    this.messagesByThread.set(id, [starter]);
    return post;
  }
  addMessage(thread: string, body: string, bot = false) {
    const id = String(++this.seq);
    const message: Message = {
      id,
      thread,
      body,
      author: bot ? "bridge" : "bob",
      bot,
      own: bot,
      url: `https://discord.com/channels/1/${thread}/${id}`,
    };
    this.messagesByThread.get(thread)!.push(message);
    return message;
  }
  addComment(number: number, body: string) {
    const id = String(++this.seq);
    const comment: Comment = {
      id,
      body,
      author: "alice",
      own: false,
      url: `https://github.com/o/r/issues/${number}#issuecomment-${id}`,
    };
    const comments = this.commentsByIssue.get(number) ?? [];
    comments.push(comment);
    this.commentsByIssue.set(number, comments);
    return comment;
  }
}

const stores: Store[] = [];
const dirs: string[] = [];
function setup() {
  const store = new Store(":memory:", "test");
  stores.push(store);
  const api = new Fake();
  return { store, api, engine: new Engine(store, api, false) };
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("durable bridge", () => {
  it("repairs a deleted mirror even when the source content hash has not changed", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    const comment = api.addComment(issue.number, "Keep this reply");
    await engine.github(issue.number);
    const link = store.link(issue.number)!;
    const mirror = store.mirror(`github:${comment.id}`)!;
    const deleted = mirror.ids[0];
    api.messagesByThread.set(
      link.thread,
      api.messagesByThread.get(link.thread)!.filter((m) => m.id !== deleted),
    );
    await engine.github(issue.number);
    const replacement = store.mirror(mirror.key)!;
    expect(replacement.ids[0]).not.toBe(deleted);
    expect(
      api.messagesByThread
        .get(link.thread)!
        .find((m) => m.id === replacement.ids[0])!.body,
    ).toContain("Keep this reply");
  });
  it("turns deleted GitHub source comments into notices without removing the thread", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    const comment = api.addComment(issue.number, "Delete me");
    await engine.github(issue.number);
    api.commentsByIssue.set(issue.number, []);
    await engine.github(issue.number);
    const link = store.link(issue.number)!;
    const mirror = store.mirror(`github:${comment.id}`)!;
    expect(
      api.messagesByThread
        .get(link.thread)!
        .find((m) => m.id === mirror.ids[0])!.body,
    ).toContain("deleted on GitHub");
    expect(link.disabled).not.toBe(true);
  });
  it("retries permission failures without disabling mappings", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    api.updatePost.mockRejectedValueOnce(
      Object.assign(new Error("Missing permissions"), { status: 403 }),
    );
    await expect(engine.github(issue.number)).rejects.toThrow(
      "Missing permissions",
    );
    expect(store.link(issue.number)!.disabled).not.toBe(true);
    await engine.github(issue.number);
  });

  it("creates from either side, mirrors replies, and ignores its own echoes", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    const link = store.link(issue.number)!;
    const reply = api.addMessage(link.thread, "A Discord reply");
    await engine.discord(link.thread);
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(api.createComment).toHaveBeenCalledOnce();
    const ghReply = api.addComment(
      issue.number,
      "A GitHub reply with https://discord.com/channels/1/2/3",
    );
    await engine.github(issue.number);
    await engine.github(issue.number);
    await engine.discord(link.thread);
    expect(api.createComment).toHaveBeenCalledOnce();
    expect(store.mirror(`discord:${reply.id}`)).toBeDefined();
    expect(store.mirror(`github:${ghReply.id}`)?.ids).toHaveLength(1);
    expect(api.createPost).toHaveBeenCalledOnce();

    const post = api.addPost();
    await engine.discord(post.id);
    await engine.discord(post.id);
    expect(api.createIssue).toHaveBeenCalledOnce();
    expect(store.thread(post.id)?.origin).toBe("discord");
  });

  it("recovers a successful issue creation whose response was lost", async () => {
    const { engine, api, store } = setup();
    const post = api.addPost();
    api.createIssue.mockImplementationOnce(async (p, marker) => {
      api.addIssue({ body: `${p.starter.body}\n${marker}`, own: true });
      throw new Error("Connection lost after write");
    });
    await expect(engine.discord(post.id)).rejects.toThrow("Connection lost");
    await engine.discord(post.id);
    expect(api.createIssue).toHaveBeenCalledOnce();
    expect(store.thread(post.id)).toBeDefined();
  });

  it("recovers a successful forum creation whose response was lost", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    api.createPost.mockImplementationOnce(async (i) => {
      api.addPost({
        bot: true,
        own: true,
        body: chunks(issueSummary(i), i.url)[0],
      });
      throw new Error("Lost response");
    });
    await expect(engine.github(issue.number)).rejects.toThrow("Lost response");
    await engine.github(issue.number);
    expect(api.createPost).toHaveBeenCalledOnce();
    expect(store.link(issue.number)).toBeDefined();
  });

  it("recovers interrupted comment sends after the nonce window", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    const link = store.link(issue.number)!;
    const dc = api.addMessage(link.thread, "hello");
    api.createComment.mockImplementationOnce(async (number, body) => {
      api.addComment(number, body).own = true;
      throw new Error("Lost response");
    });
    await expect(engine.discord(link.thread)).rejects.toThrow();
    await engine.discord(link.thread);
    expect(api.createComment).toHaveBeenCalledOnce();
    expect(store.mirror(`discord:${dc.id}`)).toBeDefined();
    const gh = api.addComment(issue.number, "hi back");
    api.send.mockImplementationOnce(async (thread, body) => {
      api.addMessage(thread, body, true);
      throw new Error("Lost response");
    });
    await expect(engine.github(issue.number)).rejects.toThrow();
    await engine.github(issue.number);
    expect(api.send).toHaveBeenCalledOnce();
    expect(store.mirror(`github:${gh.id}`)).toBeDefined();
  });

  it("retains GitHub-origin mappings across database close/reopen and propagates edits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sync-"));
    dirs.push(directory);
    const file = join(directory, "sync.sqlite");
    let store = new Store(file, "test");
    const api = new Fake();
    const issue = api.addIssue();
    let engine = new Engine(store, api, false);
    await engine.github(issue.number);
    const comment = api.addComment(issue.number, "before");
    await engine.github(issue.number);
    const ids = store.mirror(`github:${comment.id}`)!.ids;
    store.close();
    store = new Store(file, "test");
    stores.push(store);
    engine = new Engine(store, api, false);
    comment.body = "after";
    await engine.github(issue.number);
    expect(api.createPost).toHaveBeenCalledOnce();
    expect(store.mirror(`github:${comment.id}`)!.ids).toEqual(ids);
    expect(
      api.messagesByThread
        .get(store.link(issue.number)!.thread)!
        .find((m) => m.id === ids[0])!.body,
    ).toContain("after");
  });

  it("propagates Discord edits and replaces deleted source messages with tombstones", async () => {
    const { engine, api, store } = setup();
    const post = api.addPost();
    await engine.discord(post.id);
    const reply = api.addMessage(post.id, "before");
    await engine.discord(post.id);
    reply.body = "after";
    await engine.discord(post.id);
    const mirror = store.mirror(`discord:${reply.id}`)!;
    expect(
      api.commentsByIssue
        .get(mirror.issue)!
        .find((c) => c.id === mirror.ids[0])!.body,
    ).toContain("after");
    api.messagesByThread.set(post.id, [post.starter]);
    await engine.discord(post.id);
    expect(api.commentsByIssue.get(mirror.issue)![0].body).toContain(
      "deleted on Discord",
    );
  });

  it("splits long comments, preserves every part, and updates them in place", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    const comment = api.addComment(issue.number, "😀".repeat(3000));
    await engine.github(issue.number);
    const mirror = store.mirror(`github:${comment.id}`)!;
    expect(mirror.ids.length).toBeGreaterThan(3);
    const messages = api.messagesByThread.get(
      store.link(issue.number)!.thread,
    )!;
    for (const id of mirror.ids)
      expect(
        messages.find((m) => m.id === id)!.body.length,
      ).toBeLessThanOrEqual(2000);
    comment.body = "short";
    await engine.github(issue.number);
    expect(store.mirror(mirror.key)!.ids).toEqual(mirror.ids);
    expect(messages.find((m) => m.id === mirror.ids[1])!.body).toContain(
      "shortened",
    );
  });

  it("ignores foreign markers and never treats a pasted source URL as a bridge echo", async () => {
    const { engine, api, store } = setup();
    const post = api.addPost();
    api.addIssue({ body: issueMarker(post.id), own: false });
    await engine.discord(post.id);
    expect(api.createIssue).toHaveBeenCalledOnce();
    const issue = store.thread(post.id)!.issue;
    const comment = api.addComment(
      issue,
      `${messageMarker("555")} https://discord.com/channels/1/2/3`,
    );
    await engine.github(issue);
    expect(store.mirror(`github:${comment.id}`)).toBeDefined();
  });

  it("does not delete issues when threads disappear and does not recreate disabled mappings", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    const link = store.link(issue.number)!;
    await engine.run({ type: "unlink", thread: link.thread });
    await engine.github(issue.number);
    await engine.discord(link.thread);
    expect(api.gh).toHaveLength(1);
    expect(api.createPost).toHaveBeenCalledOnce();
    expect(api.state).not.toHaveBeenCalled();
  });

  it("only explicit commands change GitHub state", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    await engine.discord(store.link(issue.number)!.thread);
    expect(api.state).not.toHaveBeenCalled();
    await engine.run({ type: "state", issue: issue.number, state: "closed" });
    expect(api.state).toHaveBeenCalledWith(issue.number, "closed");
  });

  it("reconciles missed events without importing old issues by default", async () => {
    const { engine, api, store } = setup();
    store.setMeta("started", "2026-01-01T00:00:00.000Z");
    const old = api.addIssue({ createdAt: "2025-01-01T00:00:00.000Z" });
    const recent = api.addIssue({ createdAt: "2026-01-02T00:00:00.000Z" });
    const closed = api.addIssue({ state: "closed" });
    await engine.scan();
    const tasks = [];
    for (;;) {
      const job = store.next();
      if (!job) break;
      tasks.push(job.task);
      store.complete(job.id);
    }
    expect(tasks).toContainEqual({ type: "github", issue: recent.number });
    expect(tasks).not.toContainEqual({ type: "github", issue: old.number });
    expect(tasks).not.toContainEqual({ type: "github", issue: closed.number });
  });
});
