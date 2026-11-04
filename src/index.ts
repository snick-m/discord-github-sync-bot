import { settings } from "./bridge/settings";
import { ManagementStore } from "./management/store";
import { Runtime } from "./management/runtime";
import { createManagementServer } from "./management/server";
import { importLegacy, initializeAdmin } from "./management/import";

import { GitHubAccounts } from "./management/accounts";

async function main() {
  process.umask(0o077);
  const options = settings();
  const store = new ManagementStore(options.directory);
  initializeAdmin(store);
  importLegacy(store);
  const accounts = new GitHubAccounts(
    store,
    options.publicUrl.replace(/\/$/, ""),
  );
  const runtime = new Runtime(store, options.interval, accounts);
  const publicServer = createManagementServer(store, runtime, {
    bootstrap: false,
    accounts,
    publicUrl: options.publicUrl,
  }).listen(options.port, "0.0.0.0");
  // Bootstrap is a separate loopback-only listener and is never routed through Cloudflare.
  const setupServer = createManagementServer(store, runtime, {
    bootstrap: true,
    accounts,
    publicUrl: options.publicUrl,
  }).listen(options.setupPort, "127.0.0.1");
  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    publicServer.close();
    setupServer.close();
    const timeout = setTimeout(() => process.exit(code || 1), 30_000);
    timeout.unref();
    await runtime.close();
    store.close();
    process.exit(code);
  };
  for (const server of [publicServer, setupServer])
    server.on("error", (error) => {
      console.error(error.message);
      void shutdown(1);
    });
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));
  process.once("unhandledRejection", () => {
    console.error("Unexpected service failure; stopping safely.");
    void shutdown(1);
  });
  runtime.start();
  console.log(
    `Issue Bridge: ${options.publicUrl}. Private initial setup: http://localhost:${options.setupPort}.`,
  );
  if (!store.hasAdmin())
    console.log(
      "Administrator not configured. Set ADMIN_PASSWORD and restart, or use the private setup page.",
    );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exit(1);
});
