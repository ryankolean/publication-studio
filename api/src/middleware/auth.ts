import type { Context, Next } from "hono";

import type { Env } from "../env.js";
import { fail } from "../errors.js";
import { verifyAccessToken } from "../domain/tokens.js";
import type { UserRole } from "../domain/user.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export type AppContext = {
  Bindings: Env;
  Variables: { user: AuthenticatedUser };
};

/** Extracts a bearer token, tolerating no header and every malformed shape. */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (\S+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Every failure returns the same opaque 401. The caller learns that it is not
 * authenticated, not which of expiry, forgery, or a deleted user caused it.
 */
export async function requireAuth(c: Context<AppContext>, next: Next) {
  const token = bearerToken(c.req.header("authorization"));
  if (token === null) return fail(c, 401, "UNAUTHORIZED", "Authentication required.");

  const result = await verifyAccessToken(c.env.JWT_SECRET, token);
  if (!result.ok) return fail(c, 401, "UNAUTHORIZED", "Authentication required.");

  // The token proves the claim; the database decides whether the user still
  // exists and what role they hold now.
  const user = await c.env.DB.prepare(
    "SELECT id, email, name, role FROM users WHERE id = ?",
  )
    .bind(result.payload.sub)
    .first<AuthenticatedUser>();

  if (user === null) return fail(c, 401, "UNAUTHORIZED", "Authentication required.");

  c.set("user", user);
  await next();
}

/**
 * Runs after requireAuth. The research import is the operator's job; the
 * photographer approves, corrects and tags, but never loads research.
 */
export function requireRole(role: UserRole) {
  return async (c: Context<AppContext>, next: Next) => {
    if (c.get("user").role !== role) return fail(c, 403, "FORBIDDEN", "Only the operator can do this.");
    await next();
  };
}
