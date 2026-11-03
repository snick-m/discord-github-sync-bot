import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verifies a GitHub webhook X-Hub-Signature-256 header value against the raw
 * request body using HMAC-SHA256 and a constant-time comparison.
 *
 * Returns false (never throws) when the signature is missing, malformed, or
 * has a different length than the expected digest — all of which indicate an
 * invalid or absent signature.
 */
export function verifySignature(secret: string, body: string, sig: string): boolean {
  if (!sig) return false;

  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);

  // timingSafeEqual throws when buffers differ in length — guard first so a
  // truncated or missing header returns false rather than crashing the handler.
  if (sigBuf.length !== expBuf.length) return false;

  return timingSafeEqual(sigBuf, expBuf);
}
