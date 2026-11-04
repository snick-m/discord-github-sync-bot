import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import { ManagementStore } from "./store";

export interface Installation {
  id: number;
  owner: string;
  selection: string;
  suspended: boolean;
}
export interface InstalledRepository {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
}
type Request = (
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown,
) => Promise<any>;
const request: Request = async (method, path, token, body) => {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw Object.assign(
      new Error(
        `GitHub App request failed (HTTP ${response.status}). Check app installation, permissions, and private key.`,
      ),
      { status: response.status },
    );
  return response.json();
};

export class GitHubInstallations {
  private cache = new Map<string, { token: string; expires: number }>();
  private pending = new Map<string, Promise<string>>();
  constructor(
    readonly store: ManagementStore,
    private api: Request = request,
  ) {}
  config() {
    const config = JSON.parse(this.store.get("githubInstallation") ?? "{}");
    const app = JSON.parse(this.store.get("githubApp") ?? "{}");
    return {
      appId: config.appId ?? "",
      configured: Boolean(
        config.appId &&
        config.clientId === app.clientId &&
        this.store.secret("githubAppPrivateKey"),
      ),
      generation: config.generation ?? "",
    };
  }
  private jwt(appId: string, privateKey: string) {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: appId, iat: now - 60, exp: now + 540 })}`;
    return `${payload}.${createSign("RSA-SHA256").update(payload).sign(privateKey, "base64url")}`;
  }
  async configure(appId: string, privateKey?: string) {
    if (!/^\d{1,20}$/.test(appId))
      throw new Error("Enter the numeric GitHub App ID, not the client ID.");
    const app = JSON.parse(this.store.get("githubApp") ?? "{}");
    if (!app.clientId)
      throw new Error("Save the GitHub App client ID and secret first.");
    const key =
      privateKey ||
      (this.config().appId === appId
        ? this.store.secret("githubAppPrivateKey")
        : undefined);
    if (!key)
      throw new Error("Paste the GitHub App RSA private key in PEM format.");
    try {
      const parsed = createPrivateKey(key);
      if (
        parsed.asymmetricKeyType !== "rsa" ||
        (parsed.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new Error("key");
    } catch {
      throw new Error("Use a valid RSA private key with at least 2048 bits.");
    }
    const identity = await this.api("GET", "/app", this.jwt(appId, key));
    if (
      String(identity.id) !== appId ||
      identity.client_id !== app.clientId ||
      identity.slug !== app.slug
    )
      throw new Error(
        "The App ID and private key must belong to the same GitHub App as the saved client ID and slug.",
      );
    // A concurrent client-ID change must not attach a key to the wrong app.
    if (
      JSON.parse(this.store.get("githubApp") ?? "{}").clientId !== app.clientId
    )
      throw new Error("App settings changed; save the key again.");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.saveSecret("githubAppPrivateKey", key);
      this.store.set(
        "githubInstallation",
        JSON.stringify({
          appId,
          clientId: app.clientId,
          generation: randomUUID(),
        }),
      );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    this.cache.clear();
  }
  private appJwt() {
    const config = this.config();
    if (!config.configured)
      throw new Error(
        "Configure the GitHub App ID and private key in the dashboard to enable repository sync.",
      );
    return this.jwt(config.appId, this.store.secret("githubAppPrivateKey")!);
  }
  async installations(): Promise<Installation[]> {
    const result: Installation[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.api(
        "GET",
        `/app/installations?per_page=100&page=${page}`,
        this.appJwt(),
      );
      for (const row of rows)
        if (row.account?.login)
          result.push({
            id: row.id,
            owner: row.account.login,
            selection: row.repository_selection,
            suspended: Boolean(row.suspended_at),
          });
      if (rows.length < 100) break;
    }
    return result;
  }
  private async cached(
    key: string,
    create: () => Promise<{ token: string; expires_at: string }>,
  ): Promise<string> {
    const generation = this.config().generation;
    const cacheKey = `${generation}:${key}`;
    // Check configured on every request, including cached tokens after a client change.
    if (!this.config().configured)
      throw new Error(
        "Configure the GitHub App ID and private key in the dashboard.",
      );
    const saved = this.cache.get(cacheKey);
    if (saved && saved.expires > Date.now() + 60_000) return saved.token;
    const existing = this.pending.get(cacheKey);
    if (existing) return existing;
    const pending = (async () => {
      const result = await create(),
        expires = Date.parse(result.expires_at);
      if (
        typeof result.token !== "string" ||
        !result.token ||
        !Number.isFinite(expires) ||
        expires <= Date.now() + 60_000
      )
        throw new Error("GitHub returned an invalid installation token.");
      if (this.config().generation !== generation || !this.config().configured)
        throw new Error("GitHub App configuration changed. Retry the request.");
      this.cache.set(cacheKey, { token: result.token, expires });
      return result.token;
    })().finally(() => this.pending.delete(cacheKey));
    this.pending.set(cacheKey, pending);
    return pending;
  }
  private mint(installation: number, repositories?: string[]) {
    return this.api(
      "POST",
      `/app/installations/${installation}/access_tokens`,
      this.appJwt(),
      {
        permissions: { issues: "read", metadata: "read" },
        ...(repositories ? { repositories } : {}),
      },
    );
  }
  async repositories(installation: number): Promise<InstalledRepository[]> {
    if (!Number.isSafeInteger(installation) || installation < 1)
      throw new Error("Select a valid GitHub App installation.");
    // Require a currently installed, unsuspended account before discovery.
    const selected = (await this.installations()).find(
      (i) => i.id === installation && !i.suspended,
    );
    if (!selected)
      throw new Error(
        "Installation is unavailable. Install the app on this account and approve its permissions.",
      );
    const token = await this.cached(`installation:${installation}`, () =>
      this.mint(installation),
    );
    const result: InstalledRepository[] = [];
    for (let page = 1; ; page++) {
      let data;
      try {
        data = await this.api(
          "GET",
          `/installation/repositories?per_page=100&page=${page}`,
          token,
        );
      } catch (error) {
        if ((error as { status?: number }).status === 401) this.cache.clear();
        throw error;
      }
      for (const r of data.repositories)
        if (
          r.has_issues &&
          !r.archived &&
          r.owner?.login?.toLowerCase() === selected.owner.toLowerCase()
        )
          result.push({
            id: r.id,
            fullName: r.full_name,
            name: r.name,
            private: r.private,
          });
      if (data.repositories.length < 100) break;
    }
    return result;
  }
  repositoryToken(owner: string, repo: string) {
    const key = `repo:${owner.toLowerCase()}/${repo.toLowerCase()}`;
    return this.cached(key, async () => {
      const installation = await this.api(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
        this.appJwt(),
      );
      if (installation.suspended_at)
        throw new Error("The GitHub App installation is suspended.");
      return this.mint(installation.id, [repo]);
    });
  }
  clear() {
    this.cache.clear();
  }
  invalidate(owner: string, repo: string) {
    this.cache.delete(
      `${this.config().generation}:repo:${owner.toLowerCase()}/${repo.toLowerCase()}`,
    );
  }
}
