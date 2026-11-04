import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { ManagementStore } from "./store";
import { Authorship, Relay, UserAccess } from "../bridge/authorship";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
const lifetime = 10 * 60_000;
export interface GitHubIdentity {
  id: string;
  login: string;
}
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
  clientId: string;
}
interface Attempt {
  id: string;
  discord: string;
  expires: number;
  stage: string;
  state?: string;
  browser?: string;
  github?: string;
  login?: string;
}
export interface AccountLink {
  discord: string;
  github: string;
  login: string;
  generation: string;
  status: string;
  client: string;
  linkedAt: number;
}
interface Transport {
  oauth(parameters: Record<string, string>): Promise<Record<string, unknown>>;
  identity(token: string): Promise<GitHubIdentity>;
}
export class OAuthFailure extends Error {
  constructor(readonly code: string) {
    super("GitHub authorization failed; restart account linking.");
  }
}
const transport: Transport = {
  async oauth(parameters) {
    const response = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parameters),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok)
      throw new Error("GitHub authorization is temporarily unavailable.");
    const data = (await response.json()) as Record<string, unknown>;
    if (typeof data.error === "string") throw new OAuthFailure(data.error);
    return data;
  },
  async identity(token) {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new OAuthFailure("identity_rejected");
    const user = (await response.json()) as { id?: number; login?: string };
    if (
      !Number.isSafeInteger(user.id) ||
      !user.login ||
      !/^[a-zA-Z0-9-]+$/.test(user.login)
    )
      throw new OAuthFailure("identity_rejected");
    return { id: String(user.id), login: user.login };
  },
};

export class GitHubAccounts implements Authorship {
  private refreshes = new Map<string, Promise<UserAccess | undefined>>();
  constructor(
    readonly store: ManagementStore,
    readonly publicUrl: string,
    private api: Transport = transport,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS github_links(discord TEXT PRIMARY KEY,github TEXT UNIQUE NOT NULL,login TEXT NOT NULL,generation TEXT NOT NULL,status TEXT NOT NULL,client TEXT NOT NULL,linkedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS github_attempts(id TEXT PRIMARY KEY,discord TEXT NOT NULL,expires INTEGER NOT NULL,stage TEXT NOT NULL,state TEXT UNIQUE,browser TEXT,github TEXT,login TEXT);`);
  }
  app(): { clientId: string; slug: string; configured: boolean } {
    const saved = JSON.parse(this.store.get("githubApp") ?? "{}");
    return {
      clientId: saved.clientId ?? "",
      slug: saved.slug ?? "",
      configured: Boolean(
        saved.clientId && this.store.secret("githubAppSecret"),
      ),
    };
  }
  saveApp(clientId: string, slug: string, secret?: string) {
    if (
      !/^[a-zA-Z0-9_.-]{8,100}$/.test(clientId) ||
      !/^[a-z0-9-]{1,100}$/.test(slug)
    )
      throw new Error("Enter a valid GitHub App client ID and app slug.");
    if (secret !== undefined && (secret.length < 16 || secret.length > 4096))
      throw new Error("Enter a valid GitHub App client secret.");
    const previous = this.app();
    if (!secret && (!previous.configured || previous.clientId !== clientId))
      throw new Error("A client secret is required for a new GitHub App.");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (previous.clientId && previous.clientId !== clientId) {
        for (const link of this.links())
          this.dropSecret(`github-user:${link.discord}`);
        this.store.db.exec("UPDATE github_links SET status='reauthorize'");
        for (const attempt of this.attempts()) this.removeAttempt(attempt.id);
      }
      if (secret) this.store.saveSecret("githubAppSecret", secret);
      this.store.set("githubApp", JSON.stringify({ clientId, slug }));
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  get callbackUrl() {
    return `${this.publicUrl}/auth/github/callback`;
  }
  links(): AccountLink[] {
    return this.store.db
      .prepare("SELECT * FROM github_links ORDER BY login")
      .all() as unknown as AccountLink[];
  }
  link(discord: string): AccountLink | undefined {
    return this.store.db
      .prepare("SELECT * FROM github_links WHERE discord=?")
      .get(discord) as unknown as AccountLink | undefined;
  }
  private attempts() {
    return this.store.db
      .prepare("SELECT * FROM github_attempts")
      .all() as unknown as Attempt[];
  }
  private dropSecret(id: string) {
    this.store.db.prepare("DELETE FROM vault WHERE id=?").run(id);
  }
  private removeAttempt(id: string) {
    this.dropSecret(`github-attempt:${id}`);
    this.store.db.prepare("DELETE FROM github_attempts WHERE id=?").run(id);
  }
  private prune() {
    for (const attempt of this.attempts())
      if (attempt.expires < Date.now()) this.removeAttempt(attempt.id);
  }
  begin(discord: string) {
    if (!this.app().configured)
      throw new Error(
        "Account linking is not configured. Ask an administrator to add a GitHub App in Issue Bridge.",
      );
    this.prune();
    for (const attempt of this.attempts())
      if (attempt.discord === discord) this.removeAttempt(attempt.id);
    const ticket = opaque(),
      id = hash(ticket);
    this.store.db
      .prepare(
        "INSERT INTO github_attempts(id,discord,expires,stage) VALUES (?,?,?,'new')",
      )
      .run(id, discord, Date.now() + lifetime);
    return `${this.publicUrl}/auth/github/start?ticket=${ticket}`;
  }
  validateStart(ticket: string) {
    if (!/^[a-zA-Z0-9_-]{43}$/.test(ticket))
      throw new Error("Invalid account-link request.");
    this.prune();
    const id = hash(ticket);
    const attempt = this.store.db
      .prepare("SELECT * FROM github_attempts WHERE id=?")
      .get(id) as unknown as Attempt | undefined;
    if (!attempt || attempt.stage !== "new" || !this.app().configured)
      throw new Error("Account-link request expired or already used.");
  }
  start(ticket: string) {
    this.validateStart(ticket);
    const id = hash(ticket);
    const state = opaque(),
      browser = opaque(),
      verifier = opaque(),
      app = this.app();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.store.db
        .prepare(
          "UPDATE github_attempts SET stage='authorizing',state=?,browser=? WHERE id=? AND stage='new'",
        )
        .run(hash(state), hash(browser), id);
      if (!result.changes)
        throw new Error("Account-link request already used.");
      this.store.saveSecret(
        `github-attempt:${id}`,
        JSON.stringify({ verifier, clientId: app.clientId }),
      );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: this.callbackUrl,
      state,
      scope: "offline_access",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      allow_signup: "false",
      prompt: "select_account",
    }).toString();
    return { url: url.toString(), browser };
  }
  private tokens(data: Record<string, unknown>, clientId: string): TokenSet {
    if (
      typeof data.access_token !== "string" ||
      !data.access_token ||
      data.access_token.length > 4096
    )
      throw new OAuthFailure("invalid_token_response");
    const expiry = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Date.now() + value * 1000
        : undefined;
    return {
      accessToken: data.access_token,
      refreshToken:
        typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresAt: expiry(data.expires_in),
      refreshExpiresAt: expiry(data.refresh_token_expires_in),
      clientId,
    };
  }
  async callback(state: string, browser: string, code: string) {
    this.prune();
    if (
      !/^[a-zA-Z0-9_-]{43}$/.test(state) ||
      !browser ||
      !code ||
      code.length > 1024
    )
      throw new Error("Invalid account-link callback.");
    const attempt = this.store.db
      .prepare(
        "SELECT * FROM github_attempts WHERE state=? AND stage='authorizing'",
      )
      .get(hash(state)) as unknown as Attempt | undefined;
    if (!attempt || attempt.browser !== hash(browser))
      throw new Error(
        "Account-link callback could not be verified. Run /github link again.",
      );
    const saved = JSON.parse(
      this.store.secret(`github-attempt:${attempt.id}`)!,
    );
    const app = this.app();
    if (saved.clientId !== app.clientId)
      throw new Error(
        "GitHub App configuration changed. Run /github link again.",
      );
    const claim = this.store.db
      .prepare(
        "UPDATE github_attempts SET stage='exchanging' WHERE id=? AND stage='authorizing'",
      )
      .run(attempt.id);
    if (!claim.changes) throw new Error("Account-link callback already used.");
    try {
      const data = await this.api.oauth({
        client_id: app.clientId,
        client_secret: this.store.secret("githubAppSecret")!,
        code,
        redirect_uri: this.callbackUrl,
        code_verifier: saved.verifier,
      });
      const tokens = this.tokens(data, app.clientId),
        identity = await this.api.identity(tokens.accessToken);
      // A second /github link, unlink, app change, or expiry invalidates in-flight callbacks too.
      const current = this.store.db
        .prepare("SELECT stage,expires FROM github_attempts WHERE id=?")
        .get(attempt.id);
      if (
        !current ||
        current.stage !== "exchanging" ||
        Number(current.expires) < Date.now() ||
        this.app().clientId !== app.clientId
      )
        throw new Error("Account-link request expired.");
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        this.store.saveSecret(
          `github-attempt:${attempt.id}`,
          JSON.stringify(tokens),
        );
        this.store.db
          .prepare(
            "UPDATE github_attempts SET stage='pending',github=?,login=? WHERE id=?",
          )
          .run(identity.id, identity.login, attempt.id);
        this.store.db.exec("COMMIT");
      } catch (error) {
        this.store.db.exec("ROLLBACK");
        throw error;
      }
      return { login: identity.login };
    } catch {
      this.removeAttempt(attempt.id);
      throw new Error(
        "GitHub authorization could not be completed. Run /github link again.",
      );
    }
  }
  pending(discord: string) {
    this.prune();
    return this.store.db
      .prepare(
        "SELECT id,login,github FROM github_attempts WHERE discord=? AND stage='pending'",
      )
      .get(discord) as unknown as
      { id: string; login: string; github: string } | undefined;
  }
  confirm(discord: string, id: string) {
    this.prune();
    const attempt = this.store.db
      .prepare(
        "SELECT * FROM github_attempts WHERE id=? AND discord=? AND stage='pending'",
      )
      .get(id, discord) as unknown as Attempt | undefined;
    if (!attempt)
      throw new Error(
        "No pending link for your Discord account. Run /github link again.",
      );
    const other = this.store.db
      .prepare("SELECT discord FROM github_links WHERE github=? AND discord<>?")
      .get(attempt.github!, discord);
    if (other)
      throw new Error(
        "This GitHub account is already linked to another Discord account. Unlink it there first.",
      );
    const tokens = JSON.parse(
      this.store.secret(`github-attempt:${id}`)!,
    ) as TokenSet;
    if (tokens.clientId !== this.app().clientId)
      throw new Error("GitHub App changed. Run /github link again.");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.saveSecret(`github-user:${discord}`, JSON.stringify(tokens));
      this.store.db
        .prepare(
          "INSERT INTO github_links VALUES (?,?,?,?,?,?,?) ON CONFLICT(discord) DO UPDATE SET github=excluded.github,login=excluded.login,generation=excluded.generation,status=excluded.status,client=excluded.client,linkedAt=excluded.linkedAt",
        )
        .run(
          discord,
          attempt.github!,
          attempt.login!,
          randomUUID(),
          "active",
          tokens.clientId,
          Date.now(),
        );
      this.removeAttempt(id);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return this.link(discord)!;
  }
  unlink(discord: string) {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const attempt of this.attempts())
        if (attempt.discord === discord) this.removeAttempt(attempt.id);
      this.dropSecret(`github-user:${discord}`);
      this.store.db
        .prepare("DELETE FROM github_links WHERE discord=?")
        .run(discord);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  invalidate(discord: string, github: string) {
    const link = this.link(discord);
    if (!link || link.github !== github) return;
    this.store.db
      .prepare("UPDATE github_links SET status='reauthorize' WHERE discord=?")
      .run(discord);
    this.dropSecret(`github-user:${discord}`);
  }
  revokeGithub(github: string) {
    for (const attempt of this.attempts())
      if (attempt.github === github) this.removeAttempt(attempt.id);
    for (const link of this.links())
      if (link.github === github) this.invalidate(link.discord, github);
  }
  async access(
    discord: string,
    expectedGithubId?: string,
  ): Promise<UserAccess | undefined> {
    const link = this.link(discord);
    if (
      !link ||
      link.status !== "active" ||
      (expectedGithubId && expectedGithubId !== link.github) ||
      link.client !== this.app().clientId
    )
      return;
    const saved = this.store.secret(`github-user:${discord}`);
    if (!saved) return;
    const tokens = JSON.parse(saved) as TokenSet;
    if (!tokens.expiresAt || tokens.expiresAt > Date.now() + 60_000)
      return {
        token: tokens.accessToken,
        githubId: link.github,
        login: link.login,
      };
    let refresh = this.refreshes.get(discord);
    if (!refresh) {
      refresh = this.refresh(link, tokens).finally(() => {
        this.refreshes.delete(discord);
      });
      this.refreshes.set(discord, refresh);
    }
    const result = await refresh;
    const current = this.link(discord);
    return current?.generation === link.generation &&
      (!expectedGithubId || result?.githubId === expectedGithubId)
      ? result
      : undefined;
  }
  private async refresh(
    link: AccountLink,
    tokens: TokenSet,
  ): Promise<UserAccess | undefined> {
    const invalidate = () => {
      if (this.link(link.discord)?.generation === link.generation)
        this.invalidate(link.discord, link.github);
    };
    if (
      !tokens.refreshToken ||
      (tokens.refreshExpiresAt && tokens.refreshExpiresAt <= Date.now())
    ) {
      invalidate();
      return;
    }
    let data;
    try {
      data = await this.api.oauth({
        client_id: tokens.clientId,
        client_secret: this.store.secret("githubAppSecret")!,
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      });
    } catch (error) {
      if (
        error instanceof OAuthFailure &&
        ["bad_refresh_token", "expired_token", "invalid_grant"].includes(
          error.code,
        )
      ) {
        invalidate();
        return;
      }
      throw new Error(
        "GitHub user-token refresh failed. Check GitHub App configuration and try again.",
      );
    }
    const next = this.tokens(data, tokens.clientId);
    let identity: GitHubIdentity;
    try {
      identity = await this.api.identity(next.accessToken);
    } catch (error) {
      if (error instanceof OAuthFailure) {
        invalidate();
        return;
      }
      throw error;
    }
    const current = this.link(link.discord);
    if (
      !current ||
      current.generation !== link.generation ||
      current.status !== "active"
    )
      return;
    if (identity.id !== link.github) {
      invalidate();
      return;
    }
    this.store.saveSecret(`github-user:${link.discord}`, JSON.stringify(next));
    return {
      token: next.accessToken,
      githubId: link.github,
      login: identity.login,
    };
  }
  sign(relay: Relay, repository: string) {
    const { writer } = relay;
    if (
      !/^\d+$/.test(writer.discordId ?? "") ||
      !/^\d+$/.test(writer.githubId ?? "")
    )
      return "";
    const payload = [
      relay.kind,
      relay.sourceId,
      writer.kind,
      writer.discordId!,
      writer.githubId!,
    ].join(":");
    return `<!-- gd-sync:auth:v1:${payload}:${this.store.sign(`relay:${repository.toLowerCase()}:${payload}`)} -->`;
  }
  verify(
    body: string,
    githubAuthorId: string,
    repository: string,
  ): Relay | undefined {
    const match = body.match(
      /<!-- gd-sync:auth:v1:(thread|message):(\d+):(bridge|user):(\d+):(\d+):([a-f0-9]{64}) -->/,
    );
    if (!match || match[5] !== githubAuthorId) return;
    const payload = match.slice(1, 6).join(":"),
      expected = this.store.sign(
        `relay:${repository.toLowerCase()}:${payload}`,
      );
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[6]))) return;
    return {
      kind: match[1] as Relay["kind"],
      sourceId: match[2],
      writer: {
        kind: match[3] as "bridge" | "user",
        discordId: match[4],
        githubId: match[5],
      },
    };
  }
}
