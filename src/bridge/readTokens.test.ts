import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "discord.js";
import { LivePlatforms } from "./platforms";
afterEach(() => vi.unstubAllGlobals());
describe("installation read-token lifecycle", () => {
  it("retrieves a current token on each request and refreshes a rejected token once", async () => {
    const headers: string[] = [];
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, options: RequestInit) => {
        headers.push(String(new Headers(options.headers).get("authorization")));
        requests++;
        return new Response(
          JSON.stringify(requests === 1 ? { message: "Bad credentials" } : []),
          {
            status: requests === 1 ? 401 : 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    const token = vi
        .fn()
        .mockResolvedValueOnce("expired-installation")
        .mockResolvedValue("fresh-installation"),
      invalidate = vi.fn();
    const api = new LivePlatforms({} as Client, {
      owner: "org",
      repo: "one",
      forum: "forum",
      readToken: token,
      invalidateReadToken: invalidate,
    });
    await api.issues();
    expect(headers).toEqual([
      "Bearer expired-installation",
      "Bearer fresh-installation",
    ]);
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it("does not refresh a permission failure using different credentials", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ message: "Resource not accessible by integration" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const invalidate = vi.fn();
    const api = new LivePlatforms({} as Client, {
      owner: "org",
      repo: "one",
      forum: "forum",
      readToken: async () => "installation-read",
      invalidateReadToken: invalidate,
    });
    await expect(api.issues()).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
