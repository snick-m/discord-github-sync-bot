import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Link, Mirror, Task } from "./types";

export class Store {
  readonly db: DatabaseSync;
  constructor(file: string, scope: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS links (issue INTEGER PRIMARY KEY, thread TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mirrors (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mirrors_issue ON mirrors(json_extract(data,'$.issue'));
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT, failed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS blocked(source TEXT PRIMARY KEY,discord TEXT,reason TEXT NOT NULL,updated INTEGER NOT NULL,thread TEXT);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);`);
    const existing = this.meta("scope");
    if (existing && existing !== scope) {
      this.db.close();
      throw new Error(
        "This database belongs to a different repository/forum. Use a new DATA_DIR.",
      );
    }
    this.setMeta("scope", scope);
    if (!this.meta("started"))
      this.setMeta("started", new Date().toISOString());
  }
  meta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
  }
  setMeta(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, value);
  }
  links(): Link[] {
    return this.db
      .prepare("SELECT data FROM links")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  link(issue: number): Link | undefined {
    const row = this.db
      .prepare("SELECT data FROM links WHERE issue=?")
      .get(issue);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  thread(id: string): Link | undefined {
    const row = this.db
      .prepare("SELECT data FROM links WHERE thread=?")
      .get(id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  saveLink(link: Link) {
    // Never replace a different mapping silently: uniqueness violations need operator attention.
    const result = this.db
      .prepare(
        "INSERT INTO links VALUES (?,?,?) ON CONFLICT(issue) DO UPDATE SET data=excluded.data WHERE links.thread=excluded.thread",
      )
      .run(link.issue, link.thread, JSON.stringify(link));
    if (!result.changes)
      throw new Error(
        `Issue #${link.issue} is already mapped to another thread`,
      );
  }
  mirrors(issue: number): Mirror[] {
    return this.db
      .prepare("SELECT data FROM mirrors WHERE json_extract(data,'$.issue')=?")
      .all(issue)
      .map((r) => JSON.parse(r.data as string) as Mirror);
  }
  mirror(key: string): Mirror | undefined {
    const row = this.db
      .prepare("SELECT data FROM mirrors WHERE key=?")
      .get(key);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  saveMirror(mirror: Mirror) {
    this.db
      .prepare("INSERT OR REPLACE INTO mirrors VALUES (?,?)")
      .run(mirror.key, JSON.stringify(mirror));
  }
  enqueue(task: Task, key = JSON.stringify(task)) {
    this.db
      .prepare("INSERT OR IGNORE INTO jobs(key,payload) VALUES (?,?)")
      .run(key, JSON.stringify(task));
  }
  receive(id: string, task: Task) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare("INSERT OR IGNORE INTO deliveries VALUES (?,?)")
        .run(id, Date.now());
      if (inserted.changes) this.enqueue(task, `delivery:${id}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  next(
    now = Date.now(),
  ): { id: number; task: Task; attempts: number } | undefined {
    // A single consumer preserves order; a failed operation blocks later work until its retry.
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE failed=0 ORDER BY id LIMIT 1")
      .get();
    if (!row || Number(row.next_at) > now) return;
    return {
      id: Number(row.id),
      task: JSON.parse(row.payload as string),
      attempts: Number(row.attempts),
    };
  }
  complete(id: number) {
    this.db.prepare("DELETE FROM jobs WHERE id=?").run(id);
  }
  fail(id: number, attempts: number, error: string, delay?: number) {
    this.db
      .prepare(
        "UPDATE jobs SET attempts=attempts+1,failed=CASE WHEN attempts>=9 THEN 1 ELSE 0 END,next_at=?,error=? WHERE id=?",
      )
      .run(
        Date.now() +
          (delay ?? Math.min(300_000, 1000 * 2 ** Math.min(attempts, 9))),
        error.slice(0, 2000),
        id,
      );
  }
  health() {
    const row = this.db
      .prepare(
        "SELECT SUM(failed=0) AS pending, SUM(failed=1) AS failed, MAX(attempts) AS maxAttempts FROM jobs",
      )
      .get()!;
    const held = this.db.prepare("SELECT COUNT(*) AS n FROM blocked").get()!;
    return {
      blocked: Number(held.n),
      pending: Number(row.pending ?? 0),
      failed: Number(row.failed ?? 0),
      maxAttempts: Number(row.maxAttempts ?? 0),
    };
  }
  block(
    source: string,
    discord: string | undefined,
    reason: string,
    thread?: string,
  ) {
    this.db
      .prepare(
        "INSERT INTO blocked VALUES (?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET discord=excluded.discord,reason=excluded.reason,updated=excluded.updated,thread=excluded.thread",
      )
      .run(source, discord ?? null, reason, Date.now(), thread ?? null);
  }
  unblock(source: string) {
    this.db.prepare("DELETE FROM blocked WHERE source=?").run(source);
  }
  clearBlocked(thread: string, sourceIds?: Set<string>) {
    for (const row of this.db
      .prepare("SELECT source FROM blocked WHERE thread=?")
      .all(thread)) {
      const key = String(row.source);
      if (
        !sourceIds ||
        (key.startsWith("discord:") && !sourceIds.has(key.slice(8)))
      )
        this.unblock(key);
    }
  }
  prune() {
    this.db
      .prepare("DELETE FROM deliveries WHERE received_at<?")
      .run(Date.now() - 30 * 86400_000);
  }
  close() {
    this.db.close();
  }
}
