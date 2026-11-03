const CF_API_BASE = "https://api.cloudflare.com/client/v4";

function getCredentials(): {
  accountId: string;
  apiToken: string;
  bucket: string;
  cdnBaseUrl: string;
} | null {
  const {
    CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN,
    R2_BUCKET,
    R2_CDN_BASE_URL,
  } = process.env;
  if (
    !CLOUDFLARE_ACCOUNT_ID ||
    !CLOUDFLARE_API_TOKEN ||
    !R2_BUCKET ||
    !R2_CDN_BASE_URL
  )
    return null;
  return {
    accountId: CLOUDFLARE_ACCOUNT_ID,
    apiToken: CLOUDFLARE_API_TOKEN,
    bucket: R2_BUCKET,
    cdnBaseUrl: R2_CDN_BASE_URL,
  };
}

/**
 * Uploads a buffer to the R2 bucket under the given key and returns the
 * public CDN URL. Returns null when Cloudflare credentials or R2 config
 * (R2_BUCKET, R2_CDN_BASE_URL) are not configured so callers can degrade
 * gracefully, falling back to Discord attachment URLs.
 */
export async function uploadToR2(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<string | null> {
  const creds = getCredentials();
  if (!creds) return null;

  const { accountId, apiToken, bucket, cdnBaseUrl } = creds;
  // Encode each path segment individually so slashes are preserved as path
  // separators while special characters (spaces, etc.) in filenames are encoded.
  // encodeURIComponent(key) would encode the slashes too, producing a single
  // path segment that Cloudflare URL-decodes back to the correct key — this
  // works in practice but is non-obvious. Per-segment encoding is explicit.
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = `${CF_API_BASE}/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodedKey}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": contentType,
    },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`R2 upload failed: ${res.status} ${res.statusText}`);
  }

  return `${cdnBaseUrl}/${encodedKey}`;
}
