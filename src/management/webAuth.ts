import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ManagementStore } from "./store";
const opaque = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export interface WebUser {
  discord: string;
  name: string;
}
interface AuthTransport {
  exchange(
    parameters: Record<string, string>,
  ): Promise<{ access_token: string; scope: string }>;
  identity(
    token: string,
  ): Promise<{ id: string; username: string; global_name?: string }>;
}
const transport: AuthTransport = {
  async exchange(parameters) {
    const r = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok)
      throw new Error(
        "Discord sign-in failed. Check the OAuth client settings.",
      );
    return r.json();
  },
  async identity(token) {
    const r = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error("Discord identity could not be verified.");
    return r.json();
  },
};
export class WebAuth {
  constructor(
    readonly store: ManagementStore,
    readonly publicUrl: string,
    private api: AuthTransport = transport,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS web_users(discord TEXT PRIMARY KEY,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS web_sessions(hash TEXT PRIMARY KEY,discord TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS web_oauth(state TEXT PRIMARY KEY,browser TEXT NOT NULL,expires INTEGER NOT NULL,client TEXT NOT NULL);`);
  }
  config() {
    const c = JSON.parse(this.store.get("discordOAuth") ?? "{}");
    return {
      clientId: c.clientId ?? "",
      configured: Boolean(
        c.clientId && this.store.secret("discordOAuthSecret"),
      ),
      callbackUrl: `${this.publicUrl}/auth/discord/callback`,
    };
  }
  configure(clientId: string, secret?: string) {
    if (!/^\d{5,25}$/.test(clientId))
      throw new Error("Enter the Discord application client ID.");
    if (secret && (secret.length < 16 || secret.length > 4096))
      throw new Error("Enter a valid Discord OAuth client secret.");
    const previous = this.config();
    if (!secret && (!previous.configured || previous.clientId !== clientId))
      throw new Error(
        "A client secret is required for a new Discord application.",
      );
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (previous.clientId !== clientId)
        this.store.db.exec("DELETE FROM web_sessions; DELETE FROM web_oauth");
      if (secret) this.store.saveSecret("discordOAuthSecret", secret);
      this.store.set("discordOAuth", JSON.stringify({ clientId }));
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  start() {
    const c = this.config();
    if (!c.configured)
      throw new Error(
        "Discord sign-in has not been configured by the administrator.",
      );
    this.prune();
    const state = opaque(),
      browser = opaque();
    this.store.db
      .prepare("INSERT INTO web_oauth VALUES (?,?,?,?)")
      .run(hash(state), hash(browser), Date.now() + 600_000, c.clientId);
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: c.clientId,
      redirect_uri: c.callbackUrl,
      scope: "identify",
      state,
      prompt: "consent",
    }).toString();
    return { url: url.toString(), browser };
  }
  async callback(state: string, browser: string, code: string, issuer: string) {
    if (
      !/^[a-zA-Z0-9_-]{43}$/.test(state) ||
      !browser ||
      !code ||
      code.length > 2048 ||
      issuer !== "https://discord.com"
    )
      throw new Error("Discord callback could not be verified.");
    this.prune();
    const row = this.store.db
      .prepare("SELECT * FROM web_oauth WHERE state=?")
      .get(hash(state));
    if (
      !row ||
      row.browser !== hash(browser) ||
      row.client !== this.config().clientId
    )
      throw new Error("Discord sign-in expired. Start again.");
    this.store.db
      .prepare("DELETE FROM web_oauth WHERE state=?")
      .run(hash(state));
    const c = this.config();
    const result = await this.api.exchange({
      grant_type: "authorization_code",
      client_id: c.clientId,
      client_secret: this.store.secret("discordOAuthSecret")!,
      redirect_uri: c.callbackUrl,
      code,
    });
    if (
      typeof result.access_token !== "string" ||
      !result.scope?.split(" ").includes("identify")
    )
      throw new Error("Discord did not authorize identity access.");
    const identity = await this.api.identity(result.access_token);
    if (
      !/^\d{5,25}$/.test(identity.id) ||
      !identity.username ||
      this.config().clientId !== c.clientId
    )
      throw new Error("Discord identity could not be verified.");
    const user = {
      discord: identity.id,
      name: (identity.global_name || identity.username).slice(0, 100),
    };
    this.store.db
      .prepare(
        "INSERT INTO web_users VALUES (?,?) ON CONFLICT(discord) DO UPDATE SET name=excluded.name",
      )
      .run(user.discord, user.name);
    return { user, session: this.session(user.discord) };
  }
  session(discord: string) {
    const token = opaque();
    this.store.db
      .prepare("INSERT INTO web_sessions VALUES (?,?,?)")
      .run(hash(token), discord, Date.now() + 12 * 3600_000);
    return token;
  }
  user(token: string): WebUser | undefined {
    if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) return;
    return this.store.db
      .prepare(
        "SELECT u.discord,u.name FROM web_users u JOIN web_sessions s ON s.discord=u.discord WHERE s.hash=? AND s.expires>?",
      )
      .get(hash(token), Date.now()) as unknown as WebUser | undefined;
  }
  csrf(token: string) {
    return this.store.sign(`web-csrf:${hash(token)}`);
  }
  verifyCsrf(token: string, supplied: string) {
    return (
      /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(this.csrf(token)), Buffer.from(supplied))
    );
  }
  logout(token: string) {
    this.store.db
      .prepare("DELETE FROM web_sessions WHERE hash=?")
      .run(hash(token));
  }
  private prune() {
    this.store.db
      .prepare("DELETE FROM web_oauth WHERE expires<?")
      .run(Date.now());
    this.store.db
      .prepare("DELETE FROM web_sessions WHERE expires<?")
      .run(Date.now());
  }
}
