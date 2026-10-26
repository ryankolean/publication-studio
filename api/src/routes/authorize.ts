import { AuthorizationError } from "@cloudflare/workers-oauth-provider";

import { claudeHost, isClaudeCallback, isClaudeHost, signinLocked, signinWindowStart } from "../domain/connector.js";
import { verifyPassword } from "../domain/password.js";
import type { OAuthEnv } from "../env.js";
import { DUMMY_HASH } from "./auth.js";

/**
 * The page Claude opens when she connects the studio -- spec section 3 and
 * section 8 step 4: sign in with the studio account and approve, on one page.
 *
 * The OAuth provider validates the request, keeps it server-side between the
 * two requests and binds the form to this browser; this module signs her in
 * and decides. Only Claude's callback is ever approved (domain/connector.ts),
 * so the page names Claude itself rather than anything the client said about
 * itself.
 */

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const EXPIRED = "This link has expired. Start again from Claude.";
const NOT_CLAUDE = "Only Claude can connect to your studio.";
const WRONG = "That email or password did not match. Try again.";
const LOCKED = "Too many tries. Wait 15 minutes, then start again from Claude.";

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;color:#222}
label{display:block;margin:.75rem 0}input{display:block;width:100%;padding:.5rem;font:inherit;box-sizing:border-box}
button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}.error{color:#a00}`;

/** No framing, no caching: the page carries a sign-in form and a one-time handle. */
function guarded(headers: Headers = new Headers()): Headers {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  return headers;
}

function html(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
${body}
</html>`;
}

function signInPage(host: string, handle: string, error: string | null): string {
  return html(
    "Connect Claude",
    `<h1>Let Claude use your studio?</h1>
<p>Claude will be able to see your weddings and help you with them. Access goes to <strong>${escape(host)}</strong>.</p>
${error === null ? "" : `<p class="error" role="alert">${escape(error)}</p>`}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <input type="hidden" name="host" value="${escape(host)}">
  <label>Your studio email <input name="email" type="email" autocomplete="username" required></label>
  <label>Your studio password <input name="password" type="password" autocomplete="current-password" required></label>
  <p><button name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Not now</button></p>
</form>`,
  );
}

function notice(status: 400 | 429, message: string): Response {
  return new Response(html("Connect Claude", `<p>${escape(message)}</p>`), { status, headers: guarded() });
}

async function audit(env: OAuthEnv, userId: string | null, entityId: string, action: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log (id, user_id, entity, entity_id, action) VALUES (?, ?, 'connector', ?, ?)",
  )
    .bind(crypto.randomUUID(), userId, entityId, action)
    .run();
}

async function recentFailures(env: OAuthEnv): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'connector' AND entity_id = 'signin' AND action = 'signin_failed' AND at >= ?",
  )
    .bind(signinWindowStart(Date.now()))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function openPage(request: Request, env: OAuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  let authRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    // Send the error back only to Claude; anywhere else, say it here.
    if (error.redirectTo !== undefined && isClaudeCallback(error.redirectUri)) {
      return Response.redirect(error.redirectTo, 302);
    }
    return notice(400, EXPIRED);
  }

  const host = claudeHost(authRequest.redirectUri);
  if (host === null) return notice(400, NOT_CLAUDE);

  const consent = await oauth.beginConsent(authRequest);
  return new Response(signInPage(host, consent.handle, null), { headers: guarded(consent.headers) });
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function submit(request: Request, env: OAuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  // A clone, so the provider can still read the original request's cookie.
  const form = await request.clone().formData();
  const handle = field(form, "handle");

  if (field(form, "decision") !== "approve") {
    try {
      const denied = await oauth.denyConsent(request, handle);
      await audit(env, null, "signin", "declined");
      return new Response(null, { status: 302, headers: denied.headers });
    } catch (error) {
      if (error instanceof AuthorizationError) return notice(400, EXPIRED);
      throw error;
    }
  }

  if (signinLocked(await recentFailures(env))) return notice(429, LOCKED);

  const email = field(form, "email").trim().toLowerCase();
  const user = await env.DB.prepare("SELECT id, pw_hash FROM users WHERE email = ? COLLATE NOCASE")
    .bind(email)
    .first<{ id: string; pw_hash: string }>();
  // Always run the KDF, so an unknown email and a wrong password cost alike.
  const matches = await verifyPassword(field(form, "password"), user?.pw_hash ?? DUMMY_HASH);

  if (user === null || !matches) {
    await audit(env, null, "signin", "signin_failed");
    // The handle is unspent, so the same form can be shown again. The host
    // comes back from the form, so only a Claude host is ever echoed.
    const host = field(form, "host");
    if (!isClaudeHost(host)) return notice(400, EXPIRED);
    return new Response(signInPage(host, handle, WRONG), { status: 200, headers: guarded() });
  }

  let approved;
  try {
    approved = await oauth.approveConsent(request, handle, { scope: ["studio"] });
  } catch (error) {
    if (error instanceof AuthorizationError) return notice(400, EXPIRED);
    throw error;
  }
  if (!isClaudeCallback(approved.request.redirectUri)) return notice(400, NOT_CLAUDE);

  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: user.id,
    metadata: { name: "Claude" },
    scope: approved.request.scope,
    props: { userId: user.id },
  });
  await audit(env, user.id, approved.request.clientId, "connected");

  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

export function authorize(request: Request, env: OAuthEnv): Promise<Response> {
  if (request.method === "POST") return submit(request, env);
  return openPage(request, env);
}
