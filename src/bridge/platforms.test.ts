import { Client, Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { LivePlatforms } from "./platforms";
import { Issue, Link } from "./types";

function setup() {
  const client = { user: { id: "bot" }, channels: { fetch: vi.fn() } };
  const api = new LivePlatforms(client as unknown as Client, {
    owner: "owner",
    repo: "repo",
    forum: "forum",
    token: "test",
  });
  const forum = {
    availableTags: [],
    threads: { fetchActive: vi.fn(), fetchArchived: vi.fn() },
  };
  Reflect.set(api, "forum", forum);
  return { api, client, forum };
}
function channel(id = "thread") {
  const value = {
    id,
    parentId: "forum",
    isThread: () => true,
    name: "#42 Title",
    locked: false,
    archived: false,
    appliedTags: [] as string[],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    archiveTimestamp: Date.parse("2026-02-01T00:00:00Z"),
    fetchStarterMessage: vi.fn(async () => ({
      id,
      channelId: id,
      content: "starter",
      url: "https://discord.com/starter",
      author: { id: "human", username: "alice", bot: false },
      attachments: new Map(),
    })),
    setArchived: vi.fn(async (state: boolean) => {
      value.archived = state;
    }),
    edit: vi.fn(async (_options: unknown) => {}),
    send: vi.fn(async (_options: unknown) => ({ id: "sent" })),
    messages: { fetch: vi.fn(), edit: vi.fn() },
  };
  return value;
}
const issue: Issue = {
  number: 42,
  title: "Title",
  body: "body",
  author: "alice",
  url: "https://github.com/owner/repo/issues/42",
  state: "open",
  locked: false,
  labels: [],
  createdAt: "2026-01-01T00:00:00Z",
};
const link: Link = {
  issue: 42,
  thread: "thread",
  starter: "starter",
  origin: "github",
};

describe("Discord adapter", () => {
  it("keeps an inactive open issue archived instead of reopening it every scan", async () => {
    const { api, client } = setup();
    const thread = channel();
    thread.archived = true;
    client.channels.fetch.mockResolvedValue(thread);
    await api.updatePost(link, issue);
    expect(thread.setArchived).not.toHaveBeenCalled();
    expect(thread.edit).not.toHaveBeenCalled();
  });
  it("applies GitHub metadata before restoring the closed archived state", async () => {
    const { api, client } = setup();
    const thread = channel();
    thread.archived = true;
    client.channels.fetch.mockResolvedValue(thread);
    await api.updatePost(link, { ...issue, title: "Changed", state: "closed" });
    expect(thread.setArchived.mock.calls).toEqual([[false], [true]]);
    expect(thread.edit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "#42 Changed" }),
    );
  });
  it("disables mentions for both sends and edits and uses Discord nonce deduplication", async () => {
    const { api, client } = setup();
    const thread = channel();
    thread.archived = true;
    client.channels.fetch.mockResolvedValue(thread);
    await api.send(thread.id, "@everyone", "nonce");
    await api.edit(thread.id, "message", "@everyone");
    expect(thread.send).toHaveBeenCalledWith({
      content: "@everyone",
      allowedMentions: { parse: [] },
      nonce: "nonce",
      enforceNonce: true,
    });
    expect(thread.messages.edit).toHaveBeenCalledWith("message", {
      content: "@everyone",
      allowedMentions: { parse: [] },
    });
  });
  it("enumerates multiple archived pages with a correct before cursor", async () => {
    const { api, forum } = setup();
    const first = channel("1");
    const second = channel("2");
    forum.threads.fetchActive.mockResolvedValue({ threads: new Collection() });
    forum.threads.fetchArchived
      .mockResolvedValueOnce({
        threads: new Collection([[first.id, first]]),
        hasMore: true,
      })
      .mockResolvedValueOnce({
        threads: new Collection([[second.id, second]]),
        hasMore: false,
      });
    expect((await api.posts()).map((p) => p.id)).toEqual(["1", "2"]);
    expect(forum.threads.fetchArchived.mock.calls[1][0].before).toEqual(
      new Date(first.archiveTimestamp),
    );
  });
  it("reads all message pages in chronological order", async () => {
    const { api, client } = setup();
    const thread = channel();
    client.channels.fetch.mockResolvedValue(thread);
    const message = (id: number) => ({
      id: String(id),
      channelId: thread.id,
      content: `message ${id}`,
      type: 0,
      url: `https://discord.com/${id}`,
      author: { id: "human", username: "alice", bot: false },
      attachments: new Map(),
    });
    const page = new Collection(
      Array.from({ length: 100 }, (_, i) => [
        String(201 - i),
        message(201 - i),
      ]),
    );
    thread.messages.fetch
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(new Collection([["101", message(101)]]));
    const messages = await api.messages(thread.id);
    expect(messages).toHaveLength(101);
    expect(messages[0].id).toBe("101");
    expect(messages.at(-1)!.id).toBe("201");
    expect(thread.messages.fetch.mock.calls[1][0].before).toBe("102");
  });
  it("rejects channels outside the configured forum", async () => {
    const { api, client } = setup();
    const thread = channel();
    thread.parentId = "another-forum";
    client.channels.fetch.mockResolvedValue(thread);
    await expect(api.getPost(thread.id)).rejects.toMatchObject({ status: 404 });
  });
});
