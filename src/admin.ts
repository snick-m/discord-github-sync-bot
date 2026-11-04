import "dotenv/config";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import { ManagementStore } from "./management/store";

async function main() {
  const action = process.argv[2] ?? "setup";
  if (!["setup", "reset"].includes(action))
    throw new Error("Usage: pnpm admin [setup|reset]");
  if (!process.stdin.isTTY)
    throw new Error(
      "Run this command interactively in a terminal. Do not pass passwords as arguments.",
    );
  process.umask(0o077);
  const store = new ManagementStore(
    path.resolve(process.env.DATA_DIR || "data"),
  );
  try {
    if (action === "setup" && store.hasAdmin())
      throw new Error(
        "Administrator already exists. Use reset only to deliberately replace the password.",
      );
    const hidden = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const line = readline.createInterface({
      input: process.stdin,
      output: hidden,
      terminal: true,
    });
    process.stdout.write(
      "New administrator password (at least 12 characters; input hidden): ",
    );
    const password = await new Promise<string>((resolve) =>
      line.question("", resolve),
    );
    line.close();
    process.stdout.write("\n");
    if (password.length < 12 || password.length > 256)
      throw new Error("Use a password between 12 and 256 characters.");
    store.db.exec("BEGIN IMMEDIATE");
    try {
      if (action === "reset") {
        store.db.exec(
          "DELETE FROM sessions; DELETE FROM settings WHERE key='admin'",
        );
      }
      store.createAdmin(password);
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    console.log("Administrator password saved. Sign in through the web page.");
  } finally {
    store.close();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Administrator setup failed",
  );
  process.exit(1);
});
