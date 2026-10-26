/**
 * Who may connect to the studio as a Claude connector, and how hard a
 * password may be guessed at on the way -- spec docs/specs/claude-native.md
 * sections 3 and 9.
 *
 * The studio is single-tenant and only Claude connects, so a client is
 * trusted by where its tokens go: Claude's own callback, nothing else. That
 * is checked when a client registers and again when anyone signs in.
 */

export const CLAUDE_CALLBACKS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

const CALLBACK_HOSTS: ReadonlyMap<string, string> = new Map(
  CLAUDE_CALLBACKS.map((uri) => [uri, new URL(uri).host]),
);

/** Exact match only: no trailing slash, query, other scheme or look-alike host. */
export function isClaudeCallback(uri: unknown): boolean {
  return typeof uri === "string" && CALLBACK_HOSTS.has(uri);
}

/** The host the sign-in page names, or null for anything that is not a Claude callback. */
export function claudeHost(uri: unknown): string | null {
  return typeof uri === "string" ? (CALLBACK_HOSTS.get(uri) ?? null) : null;
}

/** Whether a value posted back by the sign-in form is one of the hosts above. */
export function isClaudeHost(value: unknown): value is string {
  return typeof value === "string" && [...CALLBACK_HOSTS.values()].includes(value);
}

/** Why a dynamic registration is refused, or null to allow it. Refused before anything is stored. */
export function registrationRefusal(metadata: Record<string, unknown>): string | null {
  const uris = metadata["redirect_uris"];
  const allowed = Array.isArray(uris) && uris.length > 0 && uris.every(isClaudeCallback);
  return allowed ? null : "Only Claude can connect to this studio.";
}

/**
 * DECISION: failed sign-ins are counted across the whole studio, not per
 * email. There are two users, so a per-email count adds nothing an attacker
 * cannot sidestep by guessing a different address; the cost is that a burst
 * of bad guesses also pauses the real user's connect for the window. The web
 * login (/auth/login) is a separate path and is not affected.
 */
export const SIGNIN_FAILURE_LIMIT = 10;
export const SIGNIN_WINDOW_MS = 15 * 60 * 1000;

export function signinLocked(recentFailures: number): boolean {
  return recentFailures >= SIGNIN_FAILURE_LIMIT;
}

/** A window's start as audit_log writes `at`: ISO-8601 UTC to the second. */
function windowStart(nowMs: number, windowMs: number): string {
  return new Date(nowMs - windowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function signinWindowStart(nowMs: number): string {
  return windowStart(nowMs, SIGNIN_WINDOW_MS);
}

/**
 * Registering a client and opening the sign-in page each write to the OAuth
 * KV namespace, whose free tier allows 1,000 writes a day; past that, sign-in
 * stops until midnight UTC. Both are open to anyone, so each is capped per
 * hour, studio-wide, low enough that a day at both caps leaves room for real
 * use (spec section 9, registration abuse). A real connect registers once and
 * opens one or two pages.
 */
export const CAP_WINDOW_MS = 60 * 60 * 1000;
export const REGISTRATION_LIMIT = 10;
export const SIGNIN_PAGE_LIMIT = 15;

export function registrationLocked(recentRegistrations: number): boolean {
  return recentRegistrations >= REGISTRATION_LIMIT;
}

export function signinPageLocked(recentPages: number): boolean {
  return recentPages >= SIGNIN_PAGE_LIMIT;
}

export function capWindowStart(nowMs: number): string {
  return windowStart(nowMs, CAP_WINDOW_MS);
}
