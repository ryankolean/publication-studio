import { createApp } from "../app.js";
import type { ErrorBody } from "../errors.js";
import type { OAuthEnv } from "../env.js";
import { IN_PROCESS_USER } from "../middleware/auth.js";
import type { AuthenticatedUser } from "../middleware/auth.js";

/**
 * Calls the web app's own routes, in process, as the person behind the
 * connector token -- spec section 3: "web UI and Claude share code paths".
 * Validation, the rights gate and the audit rows are the routes' own; a tool
 * that writes goes through here rather than repeating any of them.
 *
 * DECISION: the person's user row is loaded here, with the query and the
 * check requireAuth itself uses, and handed to the route's requireAuth under
 * a symbol only this Worker's code can set. No token is signed or checked:
 * that and a second load of the same row cost Worker CPU on every write, and
 * the free plan allows 10 ms a request (SUMMIT-344).
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
  const user = await env.DB.prepare("SELECT id, email, name, role FROM users WHERE id = ?")
    .bind(userId)
    .first<AuthenticatedUser>();
  if (user === null) return { ok: false, status: 401, error: { code: "UNAUTHORIZED", message: "Authentication required." } };

  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await app.request(`${env.PUBLIC_ORIGIN}${path}`, init, { ...env, [IN_PROCESS_USER]: user });
  const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.ok) return { ok: true, status: response.status, body: payload };
  const error = (payload as Partial<ErrorBody> | null) ?? {};
  return {
    ok: false,
    status: response.status,
    error: { code: error.code ?? "INTERNAL", message: error.message ?? "Something went wrong.", ...(error.details === undefined ? {} : { details: error.details }) },
  };
}
