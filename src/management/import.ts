import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ManagementStore } from "./store";

/** Seed the first administrator only; later restarts never replace an existing password. */
export function initializeAdmin(store: ManagementStore, env = process.env) {
  const password = env.ADMIN_PASSWORD;
  if (store.hasAdmin() || !password?.trim()) return false;
  if (password.length < 12 || password.length > 256)
    throw new Error(
      "ADMIN_PASSWORD must contain between 12 and 256 characters.",
    );
  store.createAdmin(password);
  return true;
}

/** Import legacy .env settings once, without modifying the user's environment file. */
export function importLegacy(store: ManagementStore, env = process.env) {
  if (env.DISCORD_TOKEN && !store.secret("discord"))
    store.saveSecret("discord", env.DISCORD_TOKEN);
  if (env.GITHUB_WEBHOOK_SECRET && !store.secret("webhook"))
    store.saveSecret("webhook", env.GITHUB_WEBHOOK_SECRET);
  const {
    GITHUB_ACCESS_TOKEN: token,
    GITHUB_USERNAME: owner,
    GITHUB_REPOSITORY: repo,
    DISCORD_CHANNEL_ID: channel,
  } = env;
  if (!token || !owner || !repo || !channel || store.get("legacyImported"))
    return;
  if (
    !/^[a-zA-Z0-9-]+$/.test(owner) ||
    !/^[-.\w]+$/.test(repo) ||
    !/^\d{5,25}$/.test(channel)
  )
    throw new Error("Legacy repository/forum configuration is invalid");
  // Leave identity validation to the normal worker so incomplete/revoked access cannot prevent UI startup.
  const existing = store
    .mappings()
    .find(
      (m) =>
        `${m.owner}/${m.repo}`.toLowerCase() ===
        `${owner}/${repo}`.toLowerCase(),
    );
  if (!existing) {
    const credential = store.saveCredential({
      label: "Imported GitHub credential",
      owner,
      login: "pending validation",
      token,
    });
    const legacyFile = path.join(store.directory, "sync.sqlite");
    store.saveMapping({
      id: randomUUID(),
      owner,
      repo,
      channel,
      credential: credential.id,
      backfill: env.BACKFILL === "open",
      enabled: true,
      roles: (env.MANAGER_ROLE_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      file: existsSync(legacyFile) ? legacyFile : undefined,
    });
  }
  store.set("legacyImported", "1");
}
