import { createApp } from "../app.js";
import type { ErrorBody } from "../errors.js";
import type { OAuthEnv } from "../env.js";
import { signAccessToken } from "../domain/tokens.js";
import type { UserRole } from "../domain/user.js";

/**
 * Calls the web app's own routes, in process, as the person behind the
 * connector token -- spec section 3: "web UI and Claude share code paths".
 * Validation, the rights gate and the audit rows are the routes' own; a tool
 * that writes goes through here rather than repeating any of them.
 *
 * DECISION: a fresh fifteen-minute web token, signed per call, is the
 * credential. The route's requireAuth then loads the user and role from the
 * database exactly as it does for the web app.
 */

const app = createApp();

export type AppResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: ErrorBody };

export async function callApp(
  env: OAuthEnv,
  userId: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<AppResult> {
  const user = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(userId).first<{ role: UserRole }>();
  if (user === null) return { ok: false, status: 401, error: { code: "UNAUTHORIZED", message: "Authentication required." } };

  const token = await signAccessToken(env.JWT_SECRET, { userId, role: user.role });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await app.request(`${env.PUBLIC_ORIGIN}${path}`, init, env);
  const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.ok) return { ok: true, status: response.status, body: payload };
  const error = (payload as Partial<ErrorBody> | null) ?? {};
  return {
    ok: false,
    status: response.status,
    error: { code: error.code ?? "INTERNAL", message: error.message ?? "Something went wrong.", ...(error.details === undefined ? {} : { details: error.details }) },
  };
}
