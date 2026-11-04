import { GitHubAccounts } from "./accounts";
export class AccessError extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
  }
}
export interface UserInstallation {
  id: number;
  owner: string;
}
export interface UserRepository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  installation: number;
}
type Get = (path: string, token: string) => Promise<any>;
const get: Get = async (path, token) => {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok)
    throw Object.assign(new Error("GitHub access check failed."), {
      status: r.status,
    });
  return r.json();
};
export class UserAccess {
  constructor(
    private accounts: GitHubAccounts,
    private api: Get = get,
  ) {}
  private async request(discord: string, path: string) {
    const access = await this.accounts.access(discord);
    if (!access) throw new AccessError("Connect your GitHub account first.");
    try {
      return await this.api(path, access.token);
    } catch (error) {
      if ((error as { status?: number }).status === 401)
        this.accounts.invalidate(discord, access.githubId);
      throw new AccessError(
        "GitHub access could not be verified. Reconnect your account or check app installation.",
      );
    }
  }
  async installations(discord: string): Promise<UserInstallation[]> {
    const result: UserInstallation[] = [];
    for (let page = 1; ; page++) {
      const data = await this.request(
        discord,
        `/user/installations?per_page=100&page=${page}`,
      );
      if (!Array.isArray(data.installations))
        throw new AccessError("Invalid installation response.");
      for (const i of data.installations)
        if (i.account?.login && !i.suspended_at)
          result.push({ id: i.id, owner: i.account.login });
      if (data.installations.length < 100) break;
    }
    return result;
  }
  async repository(
    discord: string,
    installation: number,
    fullName: string,
  ): Promise<UserRepository> {
    if (
      !Number.isSafeInteger(installation) ||
      installation < 1 ||
      !/^[a-zA-Z0-9-]+\/[-.\w]+$/.test(fullName)
    )
      throw new AccessError("Invalid repository selection.", 400);
    if (!(await this.installations(discord)).some((i) => i.id === installation))
      throw new AccessError("You cannot access this app installation.");
    let found: any;
    for (let page = 1; ; page++) {
      const data = await this.request(
        discord,
        `/user/installations/${installation}/repositories?per_page=100&page=${page}`,
      );
      if (!Array.isArray(data.repositories))
        throw new AccessError("Invalid repository response.");
      found = data.repositories.find(
        (r: any) => r.full_name?.toLowerCase() === fullName.toLowerCase(),
      );
      if (found || data.repositories.length < 100) break;
    }
    if (!found)
      throw new AccessError("The app is not authorized for this repository.");
    const repo = await this.request(discord, `/repos/${fullName}`);
    if (
      repo.id !== found.id ||
      repo.permissions?.admin !== true ||
      !repo.has_issues ||
      repo.archived
    )
      throw new AccessError("Repository Admin permission is required.");
    return {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      private: Boolean(repo.private),
      installation,
    };
  }
  async repositories(
    discord: string,
    installation: number,
  ): Promise<UserRepository[]> {
    if (!Number.isSafeInteger(installation) || installation < 1)
      throw new AccessError("Select an installation.", 400);
    if (!(await this.installations(discord)).some((i) => i.id === installation))
      throw new AccessError("You cannot access this app installation.");
    const candidates: any[] = [];
    for (let page = 1; ; page++) {
      const data = await this.request(
        discord,
        `/user/installations/${installation}/repositories?per_page=100&page=${page}`,
      );
      if (!Array.isArray(data.repositories))
        throw new AccessError("Invalid repository response.");
      candidates.push(
        ...data.repositories.filter((r: any) => r.has_issues && !r.archived),
      );
      if (data.repositories.length < 100) break;
    }
    const result: UserRepository[] = [];
    for (let offset = 0; offset < candidates.length; offset += 5) {
      const values = await Promise.all(
        candidates.slice(offset, offset + 5).map(async (r) => {
          const repo = await this.request(discord, `/repos/${r.full_name}`);
          return repo.id === r.id && repo.permissions?.admin === true
            ? {
                id: r.id,
                name: r.name,
                fullName: r.full_name,
                private: Boolean(r.private),
                installation,
              }
            : undefined;
        }),
      );
      for (const repo of values) if (repo) result.push(repo);
    }
    return result;
  }
  async authorize(discord: string, fullName: string, installation?: number) {
    // An existing mapping is always re-checked against the user's own accessible installation list.
    const available = await this.installations(discord);
    const owner = fullName.split("/")[0].toLowerCase();
    const candidate = available.find(
      (i) =>
        i.owner.toLowerCase() === owner &&
        (!installation || installation === i.id),
    );
    if (!candidate)
      throw new AccessError(
        "You cannot administer this repository installation.",
      );
    return this.repository(discord, candidate.id, fullName);
  }
}
