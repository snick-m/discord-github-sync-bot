import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";

// ac_id: AC-1
// Import the function under test — will be created in webhookSignature.ts
import { verifySignature } from "./webhookSignature";

describe("verifySignature", () => {
  const SECRET = "test-secret-key-32-chars-minimum!";

  function makeSignature(secret: string, body: string): string {
    return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  }

  it("AC-1: returns true when signature matches the body HMAC", () => {
    // ac_id: AC-1

    // Arrange
    const body = '{"action":"opened","issue":{"number":1}}';
    const sig = makeSignature(SECRET, body);

    // Act
    const result = verifySignature(SECRET, body, sig);

    // Assert
    expect(result).toBe(true);
  });

  it("AC-1: returns false when signature header is missing (empty string)", () => {
    // ac_id: AC-1

    // Arrange
    const body = '{"action":"opened"}';

    // Act
    const result = verifySignature(SECRET, body, "");

    // Assert
    expect(result).toBe(false);
  });

  it("AC-1: returns false when signature is wrong (tampered body)", () => {
    // ac_id: AC-1

    // Arrange
    const originalBody = '{"action":"opened","issue":{"number":1}}';
    const tamperedBody = '{"action":"opened","issue":{"number":999}}';
    const sig = makeSignature(SECRET, originalBody);

    // Act
    const result = verifySignature(SECRET, tamperedBody, sig);

    // Assert
    expect(result).toBe(false);
  });

  it("AC-1: returns false when signature uses wrong secret", () => {
    // ac_id: AC-1

    // Arrange
    const body = '{"action":"opened"}';
    const sigWithWrongSecret = makeSignature("wrong-secret", body);

    // Act
    const result = verifySignature(SECRET, body, sigWithWrongSecret);

    // Assert
    expect(result).toBe(false);
  });

  it("AC-1: returns false when signature has wrong length (guards timingSafeEqual)", () => {
    // ac_id: AC-1

    // Arrange
    const body = '{"action":"opened"}';

    // Act — a signature that is not the full sha256 hex length
    const result = verifySignature(SECRET, body, "sha256=deadbeef");

    // Assert — must not throw despite length mismatch; timingSafeEqual throws on mismatched lengths
    expect(result).toBe(false);
  });

  it("AC-1 edge: returns false for a completely malformed signature string", () => {
    // ac_id: AC-1

    // Arrange
    const body = '{"action":"opened"}';

    // Act
    const result = verifySignature(SECRET, body, "not-a-valid-signature-at-all");

    // Assert
    expect(result).toBe(false);
  });

  it("AC-1 edge: is timing-safe (function exists and returns boolean, not throwing)", () => {
    // ac_id: AC-1
    // This test verifies the function handles all inputs gracefully — no throws

    // Arrange
    const inputs = [
      { body: "", sig: "" },
      { body: "body", sig: "sha256=" + "a".repeat(64) },
      { body: "body", sig: makeSignature(SECRET, "body") },
    ];

    // Act & Assert — none of these should throw
    for (const { body, sig } of inputs) {
      expect(() => verifySignature(SECRET, body, sig)).not.toThrow();
    }
  });
});
