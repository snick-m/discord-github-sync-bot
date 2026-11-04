import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { once } from "node:events";

const directory = mkdtempSync(join(tmpdir(), "sync-smoke-"));
const image = process.argv[2];
let container, child;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  return port;
}
try {
  if (image) {
    const start = spawnSync(
      "docker",
      ["run", "-d", "--network", "none", image],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(start.status, 0, start.stderr);
    container = start.stdout.trim();
    const probe =
      "(async()=>{const r=await fetch('http://127.0.0.1:5000/api/session');const s=await r.json();if(!r.ok||!s.setupRequired||s.authenticated)process.exit(1);const p=await fetch('http://127.0.0.1:5000/api/state');if(p.status!==401)process.exit(1);})().catch(()=>process.exit(1))";
    let success = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = spawnSync(
        "docker",
        ["exec", container, "node", "-e", probe],
        { encoding: "utf8", timeout: 10_000 },
      );
      if (result.status === 0) {
        success = true;
        break;
      }
      await wait(100);
    }
    assert(
      success,
      "Production container did not start its locked management UI",
    );
  } else {
    const port = await freePort(),
      setupPort = await freePort();
    child = spawn(process.execPath, [resolve("dist/index.js")], {
      cwd: directory,
      env: {
        DATA_DIR: directory,
        PORT: String(port),
        SETUP_PORT: String(setupPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/session`);
        const state = await response.json();
        assert.equal(state.setupRequired, true);
        assert.equal(state.authenticated, false);
        ready = true;
        break;
      } catch {
        await wait(100);
      }
    }
    assert(ready, "Built service did not start its locked management UI");
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/state`)).status,
      401,
    );
    const local = await (
      await fetch(`http://127.0.0.1:${setupPort}/api/session`)
    ).json();
    assert.equal(local.bootstrap, true);
    const publicSetup = await fetch(`http://127.0.0.1:${port}/api/setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ password: "smoke-test-only-password" }),
    });
    assert.equal(publicSetup.status, 403);
  }
  console.log(
    `${image ? "Production container" : "Built service"}: management UI starts without credentials; private configuration is locked and public bootstrap is disabled.`,
  );
} finally {
  if (child) {
    const closed = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([closed, wait(5000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  }
  if (container)
    spawnSync("docker", ["rm", "-f", container], {
      stdio: "ignore",
      timeout: 15_000,
    });
  rmSync(directory, { recursive: true, force: true });
}
