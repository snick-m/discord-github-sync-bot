import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./database";

describe("persistent queue", () => {
  it("retains retry timing and job order across a restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "queue-"));
    const file = join(directory, "sync.sqlite");
    let store = new Store(file, "test");
    try {
      store.enqueue({ type: "github", issue: 1 });
      store.enqueue({ type: "github", issue: 2 });
      const job = store.next()!;
      store.fail(job.id, 0, "upstream unavailable", 60_000);
      store.close();
      store = new Store(file, "test");
      expect(store.next()).toBeUndefined();
      expect(store.next(Date.now() + 61_000)?.task).toEqual({
        type: "github",
        issue: 1,
      });
      expect(store.next(Date.now() + 61_000)?.attempts).toBe(1);
      store.complete(job.id);
      expect(store.next()?.task).toEqual({ type: "github", issue: 2 });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("retains failed jobs for inspection without blocking unrelated work forever", () => {
    const store = new Store(":memory:", "test");
    try {
      store.enqueue({ type: "github", issue: 1 });
      store.enqueue({ type: "github", issue: 2 });
      const job = store.next()!;
      for (let i = 0; i < 10; i++) store.fail(job.id, i, "bad credentials", 0);
      expect(store.health()).toMatchObject({ failed: 1, pending: 1 });
      expect(store.next()?.task).toEqual({ type: "github", issue: 2 });
    } finally {
      store.close();
    }
  });
  it("refuses to reuse mappings for another repository or forum", () => {
    const directory = mkdtempSync(join(tmpdir(), "scope-"));
    const file = join(directory, "sync.sqlite");
    const store = new Store(file, "owner/repo:forum");
    store.close();
    try {
      expect(() => new Store(file, "other/repo:forum")).toThrow(
        "different repository/forum",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
