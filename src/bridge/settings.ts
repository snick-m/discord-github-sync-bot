import "dotenv/config";
import path from "node:path";

export function settings(env = process.env) {
  const required = [
    "DISCORD_TOKEN",
    "DISCORD_CHANNEL_ID",
    "GITHUB_ACCESS_TOKEN",
    "GITHUB_USERNAME",
    "GITHUB_REPOSITORY",
    "GITHUB_WEBHOOK_SECRET",
  ] as const;
  const absent = required.filter((key) => !env[key]?.trim());
  if (absent.length)
    throw new Error(
      `Missing required environment variables: ${absent.join(", ")}`,
    );
  if (!/^\d+$/.test(env.DISCORD_CHANNEL_ID!))
    throw new Error("DISCORD_CHANNEL_ID must be a numeric forum ID");
  const interval = Number(env.RECONCILE_SECONDS ?? 300);
  const port = Number(env.PORT ?? 5000);
  if (!Number.isInteger(interval) || interval < 60)
    throw new Error("RECONCILE_SECONDS must be an integer >= 60");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  if (env.BACKFILL && !["none", "open"].includes(env.BACKFILL))
    throw new Error("BACKFILL must be none or open");
  const r2 = [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "R2_BUCKET",
    "R2_CDN_BASE_URL",
  ];
  if (r2.some((key) => env[key]) && !r2.every((key) => env[key]))
    throw new Error("Set all four R2 settings or leave all four empty");
  return {
    discordToken: env.DISCORD_TOKEN!,
    forum: env.DISCORD_CHANNEL_ID!,
    token: env.GITHUB_ACCESS_TOKEN!,
    owner: env.GITHUB_USERNAME!,
    repo: env.GITHUB_REPOSITORY!,
    secret: env.GITHUB_WEBHOOK_SECRET!,
    port,
    interval: interval * 1000,
    backfill: env.BACKFILL === "open",
    file: path.join(env.DATA_DIR || "data", "sync.sqlite"),
    roles: (env.MANAGER_ROLE_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
