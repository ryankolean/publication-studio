/**
 * Short-lived capability tokens for image bytes.
 *
 * DECISION: the design doc calls for "Worker-issued signed URLs, 15-min TTL"
 * on R2. R2's Worker binding has no presign method -- presigning needs the
 * S3-compatible API and a separate pair of R2 access keys. Rather than
 * introduce a second long-lived credential to store and rotate, the Worker
 * proxies the bytes itself and gates them with a token minted here.
 *
 * The bucket therefore stays private with no keys outside Wrangler, and the
 * TTL the design asked for is preserved. The cost is Worker CPU per image,
 * which is acceptable for web-size derivatives and two users, and the trade is
 * reversible: swapping in real presigned URLs later changes how the URL is
 * produced, not how the rest of the app uses it.
 *
 * A token is a bearer capability, so it is bound to exactly one object and one
 * purpose. It exists at all because an <img> tag cannot send an Authorization
 * header; everything else on this API uses the bearer token instead.
 *
 * Format: base64url("<key>|<purpose>|<expiry>") "." base64url(hmac-sha256)
 */

export const READ_TOKEN_TTL_SECONDS = 15 * 60;
export const UPLOAD_TOKEN_TTL_SECONDS = 15 * 60;

export type ImagePurpose = "read" | "write";

export interface ImageTokenClaims {
  key: string;
  purpose: ImagePurpose;
}

export type ImageTokenFailure = "TOKEN_INVALID" | "TOKEN_EXPIRED";

export type ImageTokenResult = { ok: true } | { ok: false; code: ImageTokenFailure };

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sign(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

const ttlFor = (purpose: ImagePurpose): number =>
  purpose === "read" ? READ_TOKEN_TTL_SECONDS : UPLOAD_TOKEN_TTL_SECONDS;

export async function mintImageToken(
  secret: string,
  claims: ImageTokenClaims,
): Promise<string> {
  if (secret.length === 0) throw new Error("image token secret must not be empty");

  const expiry = Math.floor(Date.now() / 1000) + ttlFor(claims.purpose);
  const payload = `${claims.key}|${claims.purpose}|${expiry}`;
  const signature = await sign(secret, payload);

  return `${toBase64Url(encoder.encode(payload))}.${toBase64Url(signature)}`;
}

/**
 * Never throws. A malformed token is an unauthorised request, not a 500, and
 * the caller learns nothing about why beyond expired versus invalid.
 */
export async function verifyImageToken(
  secret: string,
  token: string,
  expected: ImageTokenClaims,
): Promise<ImageTokenResult> {
  if (secret.length === 0) throw new Error("image token secret must not be empty");

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, code: "TOKEN_INVALID" };

  const [encodedPayload, encodedSignature] = parts as [string, string];

  let payload: string;
  let signature: Uint8Array;
  try {
    payload = new TextDecoder().decode(fromBase64Url(encodedPayload));
    signature = fromBase64Url(encodedSignature);
  } catch {
    return { ok: false, code: "TOKEN_INVALID" };
  }

  // Signature first: nothing in the payload is trusted until it verifies.
  const expectedSignature = await sign(secret, payload);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return { ok: false, code: "TOKEN_INVALID" };
  }

  // The key may itself contain a separator, so split from the right.
  const lastPipe = payload.lastIndexOf("|");
  const secondPipe = payload.lastIndexOf("|", lastPipe - 1);
  if (lastPipe === -1 || secondPipe === -1) return { ok: false, code: "TOKEN_INVALID" };

  const key = payload.slice(0, secondPipe);
  const purpose = payload.slice(secondPipe + 1, lastPipe);
  const expiry = Number(payload.slice(lastPipe + 1));

  if (key !== expected.key || purpose !== expected.purpose) {
    return { ok: false, code: "TOKEN_INVALID" };
  }
  if (!Number.isFinite(expiry)) return { ok: false, code: "TOKEN_INVALID" };
  if (expiry < Math.floor(Date.now() / 1000)) return { ok: false, code: "TOKEN_EXPIRED" };

  return { ok: true };
}
