import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Credential {
  id: string;
  label: string;
  owner: string;
  login: string;
}
export interface Mapping {
  id: string;
  owner: string;
  repo: string;
  channel: string;
  credential: string;
  backfill: boolean;
  enabled: boolean;
  roles: string[];
  file?: string;
}
export class ManagementStore {
  readonly db: DatabaseSync;
  private readonly key: Buffer;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "management.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vault(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mappings(id TEXT PRIMARY KEY,repository TEXT UNIQUE NOT NULL,channel TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);`);
    const keyFile = path.join(directory, "master.key");
    if (!existsSync(keyFile)) {
      if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM vault").get()!.n)) {
        this.db.close();
        throw new Error(
          "Credential encryption key is missing. Restore master.key from backup.",
        );
      }
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    }
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32)
      throw new Error("Invalid credential encryption key");
  }
  get(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
  }
  set(key: string, value: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES (?,?)")
      .run(key, value);
  }
  secret(id: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM vault WHERE id=?").get(id);
    if (!row) return;
    const [iv, tag, encrypted] = (row.value as string)
      .split(".")
      .map((s) => Buffer.from(s, "base64"));
    const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString(
      "utf8",
    );
  }
  saveSecret(id: string, value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    this.db
      .prepare("INSERT OR REPLACE INTO vault VALUES (?,?)")
      .run(
        id,
        [iv, cipher.getAuthTag(), encrypted]
          .map((b) => b.toString("base64"))
          .join("."),
      );
  }
  credentials(): Credential[] {
    return this.db
      .prepare("SELECT data FROM credentials")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  credential(id: string) {
    return this.credentials().find((c) => c.id === id);
  }
  saveCredential(
    input: Omit<Credential, "id"> & { id?: string; token: string },
  ): Credential {
    const { token, ...data } = input;
    const credential = { ...data, id: input.id ?? randomUUID() };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.saveSecret(`github:${credential.id}`, token);
      this.db
        .prepare("INSERT OR REPLACE INTO credentials VALUES (?,?)")
        .run(credential.id, JSON.stringify(credential));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return credential;
  }
  removeCredential(id: string) {
    if (this.mappings().some((m) => m.credential === id))
      throw new Error("Remove or reassign this credential's mappings first.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM credentials WHERE id=?").run(id);
      this.db.prepare("DELETE FROM vault WHERE id=?").run(`github:${id}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  mappings(): Mapping[] {
    return this.db
      .prepare("SELECT data FROM mappings ORDER BY repository")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  mapping(id: string) {
    return this.mappings().find((m) => m.id === id);
  }
  saveMapping(mapping: Mapping) {
    const previous = this.mapping(mapping.id);
    if (
      previous &&
      (previous.owner.toLowerCase() !== mapping.owner.toLowerCase() ||
        previous.repo.toLowerCase() !== mapping.repo.toLowerCase() ||
        previous.channel !== mapping.channel)
    ) {
      throw new Error(
        "Repository and channel cannot change on an existing mapping. Pause it and create a new mapping.",
      );
    }
    this.db
      .prepare(
        "INSERT INTO mappings VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        mapping.id,
        `${mapping.owner}/${mapping.repo}`.toLowerCase(),
        mapping.channel,
        JSON.stringify(mapping),
      );
  }
  hasAdmin() {
    return Boolean(this.get("admin"));
  }
  createAdmin(password: string) {
    if (password.length < 12 || password.length > 256)
      throw new Error("Use a password between 12 and 256 characters.");
    const salt = randomBytes(16);
    const digest = scryptSync(password, salt, 32);
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES ('admin',?)")
      .run(`${salt.toString("hex")}:${digest.toString("hex")}`);
    if (!inserted.changes)
      throw new Error("An administrator is already configured.");
  }
  authenticate(password: string) {
    if (password.length > 256) return false;
    const stored = this.get("admin");
    if (!stored) return false;
    const [salt, digest] = stored.split(":");
    return timingSafeEqual(
      scryptSync(password, Buffer.from(salt, "hex"), 32),
      Buffer.from(digest, "hex"),
    );
  }
  session() {
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?)")
      .run(this.sessionHash(token), Date.now() + 12 * 3600_000);
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    return token;
  }
  validSession(token: string) {
    return Boolean(
      this.db
        .prepare("SELECT hash FROM sessions WHERE hash=? AND expires>?")
        .get(this.sessionHash(token), Date.now()),
    );
  }
  logout(token: string) {
    this.db
      .prepare("DELETE FROM sessions WHERE hash=?")
      .run(this.sessionHash(token));
  }
  private sessionHash(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
  close() {
    this.db.close();
  }
}
