import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run from an empty directory/environment so a developer's real .env cannot be loaded.
const directory = mkdtempSync(join(tmpdir(), "sync-smoke-"));
try {
  const image = process.argv[2];
  const result = image
    ? spawnSync("docker", ["run", "--rm", "--network", "none", image], {
        encoding: "utf8",
        timeout: 30_000,
      })
    : spawnSync(process.execPath, [resolve("dist/index.js")], {
        cwd: directory,
        env: {},
        encoding: "utf8",
        timeout: 10_000,
      });
  assert.equal(result.status, 1, result.stderr || String(result.error));
  assert.match(result.stderr, /Missing required environment variables:/);
  console.log(
    `${image ? "Production container" : "Built entry point"}: imports successfully and refuses to start without credentials.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
