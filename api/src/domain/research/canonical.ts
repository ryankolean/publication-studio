/**
 * Canonical JSON: keys sorted at every depth, so two payloads holding the same
 * data serialize, and hash, the same. The import uses the hash to skip an
 * outlet whose research has not changed since the last revision.
 */

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Lowercase hex SHA-256, through Web Crypto so it runs the same in Node and the Worker. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
