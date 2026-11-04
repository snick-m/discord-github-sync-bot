import { describe, expect, it, vi } from "vitest";
import { UserAccess } from "./userAccess";
import { GitHubAccounts } from "./accounts";
function setup() {
  const accounts = {
    access: vi.fn(async () => ({
      token: "alice-user-token",
      githubId: "11",
      login: "alice",
    })),
    invalidate: vi.fn(),
  };
  const get = vi.fn(async (path: string, token: string): Promise<any> => {
    expect(token).toBe("alice-user-token");
    if (path.startsWith("/user/installations?"))
      return { installations: [{ id: 1, account: { login: "org" } }] };
    if (path.startsWith("/user/installations/1/repositories?"))
      return {
        repositories: [
          {
            id: 10,
            name: "admin",
            full_name: "org/admin",
            has_issues: true,
            private: true,
          },
          {
            id: 20,
            name: "reader",
            full_name: "org/reader",
            has_issues: true,
            private: true,
          },
        ],
      };
    if (path === "/repos/org/admin")
      return {
        id: 10,
        name: "admin",
        full_name: "org/admin",
        has_issues: true,
        private: true,
        permissions: { admin: true },
      };
    if (path === "/repos/org/reader")
      return {
        id: 20,
        name: "reader",
        full_name: "org/reader",
        has_issues: true,
        permissions: { admin: false },
      };
    throw new Error("Unexpected endpoint");
  });
  return {
    accounts,
    get,
    access: new UserAccess(accounts as unknown as GitHubAccounts, get),
  };
}
describe("GitHub dashboard authorization", () => {
  it("uses only the linked user's accessible installations and filters repositories by actual Admin permission", async () => {
    const { access, get } = setup();
    expect(await access.installations("111111")).toEqual([
      { id: 1, owner: "org" },
    ]);
    expect(await access.repositories("111111", 1)).toEqual([
      {
        id: 10,
        name: "admin",
        fullName: "org/admin",
        private: true,
        installation: 1,
      },
    ]);
    expect(get.mock.calls.every(([url]) => !url.startsWith("/app/"))).toBe(
      true,
    );
  });
  it("rejects guessed installation IDs and repositories outside the user-authorized installation", async () => {
    const { access, get } = setup();
    await expect(access.repositories("111111", 2)).rejects.toThrow(
      "cannot access",
    );
    await expect(
      access.repository("111111", 1, "other/private"),
    ).rejects.toThrow("not authorized");
    expect(get.mock.calls.some(([url]) => url === "/repos/other/private")).toBe(
      false,
    );
  });
  it("denies mapping changes from members who can read but cannot administer the repository", async () => {
    const { access } = setup();
    await expect(access.authorize("111111", "org/reader", 1)).rejects.toThrow(
      "Admin",
    );
    expect(await access.authorize("111111", "org/admin", 1)).toMatchObject({
      id: 10,
      installation: 1,
    });
  });
  it("fails closed for unlinked or revoked GitHub identities", async () => {
    const { access, accounts, get } = setup();
    accounts.access.mockResolvedValueOnce(undefined as never);
    await expect(access.installations("111111")).rejects.toThrow("Connect");
    expect(get).not.toHaveBeenCalled();
    get.mockRejectedValueOnce(
      Object.assign(new Error("revoked"), { status: 401 }),
    );
    await expect(access.installations("111111")).rejects.toThrow("Reconnect");
    expect(accounts.invalidate).toHaveBeenCalledWith("111111", "11");
  });
  it("does not accept a repository identity replacement", async () => {
    const { access, get } = setup();
    const original = get.getMockImplementation()!;
    get.mockImplementation(async (url, token) =>
      url === "/repos/org/admin"
        ? { id: 999, permissions: { admin: true }, has_issues: true }
        : original(url, token),
    );
    await expect(access.repository("111111", 1, "org/admin")).rejects.toThrow(
      "Admin",
    );
  });
});
