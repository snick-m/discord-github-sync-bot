import { describe, expect, it } from "vitest";
import { settings } from "./settings";
describe("configuration", () => {
  it("starts the management UI without repository, channel, or token environment variables", () => {
    expect(settings({})).toMatchObject({
      port: 5000,
      setupPort: 5001,
      interval: 300_000,
      publicUrl: "http://localhost:5000",
    });
  });
  it("rejects invalid ports, intervals, public origins, and partial R2 configuration", () => {
    expect(() => settings({ PORT: "0" })).toThrow("PORT");
    expect(() => settings({ SETUP_PORT: "5000" })).toThrow("must differ");
    expect(() => settings({ RECONCILE_SECONDS: "0" })).toThrow(
      "RECONCILE_SECONDS",
    );
    expect(() => settings({ PUBLIC_URL: "https://example.com/admin" })).toThrow(
      "PUBLIC_URL",
    );
    expect(() => settings({ R2_BUCKET: "bucket" })).toThrow("all four R2");
  });
});
