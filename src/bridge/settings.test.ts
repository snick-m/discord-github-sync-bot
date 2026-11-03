import { describe, expect, it } from "vitest";
import { settings } from "./settings";
const env = {
  DISCORD_TOKEN: "test",
  DISCORD_CHANNEL_ID: "123",
  GITHUB_ACCESS_TOKEN: "test",
  GITHUB_USERNAME: "owner",
  GITHUB_REPOSITORY: "repo",
  GITHUB_WEBHOOK_SECRET: "test",
};
describe("configuration", () => {
  it("requires webhook authentication", () => {
    expect(() => settings({ ...env, GITHUB_WEBHOOK_SECRET: "" })).toThrow(
      "GITHUB_WEBHOOK_SECRET",
    );
  });
  it("rejects invalid intervals and partial attachment storage configuration", () => {
    expect(() => settings({ ...env, RECONCILE_SECONDS: "0" })).toThrow(
      "RECONCILE_SECONDS",
    );
    expect(() => settings({ ...env, R2_BUCKET: "bucket" })).toThrow(
      "all four R2",
    );
    expect(() => settings({ ...env, BACKFILL: "all" })).toThrow("BACKFILL");
  });
  it("defaults to incremental import and a five-minute reconciliation", () => {
    expect(settings(env)).toMatchObject({
      backfill: false,
      interval: 300_000,
      roles: [],
    });
  });
});
