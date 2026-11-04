import "dotenv/config";
import path from "node:path";

export function settings(env = process.env) {
  const interval = Number(env.RECONCILE_SECONDS ?? 300),
    port = Number(env.PORT ?? 5000),
    setupPort = Number(env.SETUP_PORT ?? 5001);
  if (!Number.isInteger(interval) || interval < 60)
    throw new Error("RECONCILE_SECONDS must be an integer >= 60");
  for (const [name, value] of [
    ["PORT", port],
    ["SETUP_PORT", setupPort],
  ] as const)
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error(`Invalid ${name}`);
  if (port === setupPort) throw new Error("PORT and SETUP_PORT must differ");
  const r2 = [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "R2_BUCKET",
    "R2_CDN_BASE_URL",
  ];
  if (r2.some((key) => env[key]) && !r2.every((key) => env[key]))
    throw new Error("Set all four R2 settings or leave all four empty");
  const publicUrl = new URL(env.PUBLIC_URL || `http://localhost:${port}`);
  if (
    !["https:", "http:"].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/"
  )
    throw new Error(
      "PUBLIC_URL must be an HTTP(S) origin without credentials or a path",
    );
  return {
    port,
    setupPort,
    interval: interval * 1000,
    directory: path.resolve(env.DATA_DIR || "data"),
    publicUrl: publicUrl.origin,
  };
}
