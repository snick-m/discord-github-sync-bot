import { describe, expect, it, vi } from "vitest";
import { Client } from "discord.js";
const calls = vi.hoisted(
  () => [] as { token: string; method: string; args: unknown }[],
);
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    issues: Record<string, (args: unknown) => Promise<unknown>>;
    constructor(options: { auth: string }) {
      this.issues = Object.fromEntries(
        [
          "create",
          "update",
          "createComment",
          "updateComment",
          "listLabelsForRepo",
        ].map((method) => [
          method,
          async (args: unknown) => {
            calls.push({ token: options.auth, method, args });
            if (options.auth === "denied")
              throw Object.assign(new Error("denied"), { status: 403 });
            return {
              data:
                method === "createComment"
                  ? { id: 10 }
                  : {
                      number: 1,
                      title: "test",
                      body: "",
                      state: "open",
                      user: { id: 456, login: "alice" },
                      labels: [],
                      html_url: "https://github.com/o/r/issues/1",
                      created_at: new Date().toISOString(),
                    },
            };
          },
        ]),
      );
    }
    async paginate() {
      return [];
    }
  },
}));
import { LivePlatforms } from "./platforms";
import { Authorship, WriteBlocked } from "./authorship";
const source = {
  id: "789",
  thread: "789",
  authorId: "123",
  body: "hello",
  author: "alice",
  url: "https://discord.com/message",
  bot: false,
};
const writer = { kind: "user" as const, discordId: "123", githubId: "456" };
function setup(token?: string) {
  calls.length = 0;
  const authorship: Authorship = {
    access: vi.fn(async () =>
      token ? { token, githubId: "456", login: "alice" } : undefined,
    ),
    invalidate: vi.fn(),
    sign: () => "signed-marker",
    verify: () => undefined,
  };
  const api = new LivePlatforms(
    {} as Client,
    { owner: "o", repo: "r", forum: "f", token: "shared-pat" },
    authorship,
  );
  return { api, authorship };
}
describe("strict Discord user writes", () => {
  it("blocks every GitHub mutation without a linked user, without touching the shared PAT", async () => {
    const { api } = setup();
    const operations = [
      () =>
        api.createIssue(
          {
            id: "789",
            title: "test",
            starter: source,
            tags: [],
            createdAt: "",
          },
          "marker",
        ),
      () => api.createComment(1, "body", source),
      () => api.editComment("10", "body", writer, source),
      () => api.editIssue(1, "body", writer, source),
      () => api.state(1, "closed", "123"),
    ];
    for (const operation of operations)
      await expect(operation()).rejects.toBeInstanceOf(WriteBlocked);
    expect(calls).toEqual([]);
  });
  it("uses only the linked user's token for all mutation types", async () => {
    const { api } = setup("user-token");
    await api.createIssue(
      { id: "789", title: "test", starter: source, tags: [], createdAt: "" },
      "marker",
    );
    await api.createComment(1, "body", source);
    await api.editComment("10", "body", writer, source);
    await api.editIssue(1, "body", writer, source);
    await api.state(1, "closed", "123");
    expect(calls.map((c) => c.method)).toEqual([
      "create",
      "createComment",
      "updateComment",
      "update",
      "update",
    ]);
    expect(calls.every((c) => c.token === "user-token")).toBe(true);
  });
  it("does not retry permission failures using shared credentials", async () => {
    const { api } = setup("denied");
    await expect(api.createComment(1, "body", source)).rejects.toMatchObject({
      reason: "permission",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBe("denied");
  });
  it("pins edits to the original linked identity", async () => {
    const { api, authorship } = setup("user-token");
    await api.editComment("10", "body", writer, source);
    expect(authorship.access).toHaveBeenCalledWith("123", "456");
    await expect(
      api.editComment("10", "body", writer, { ...source, authorId: "999" }),
    ).rejects.toMatchObject({ reason: "original-author" });
    expect(calls).toHaveLength(1);
  });
});
