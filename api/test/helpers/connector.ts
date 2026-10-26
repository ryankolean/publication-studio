import { createHash, randomBytes } from "node:crypto";

import worker from "../../src/index.js";
import { CLAUDE_CALLBACKS } from "../../src/domain/connector.js";
import { hashPassword } from "../../src/domain/password.js";
import type { TestD1 } from "./d1.js";
import { createTestR2 } from "./r2.js";
import { TestKV } from "./kv.js";

/**
 * Drives the Worker entry point the way Claude does: register, open the
 * sign-in page, sign in, exchange the code, then call /mcp with the token.
 */

export const ORIGIN = "https://studio.example.com";
export const CALLBACK = CLAUDE_CALLBACKS[0];
export const JWT_SECRET = "connector-test-secret";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };

export function connectorEnv(db: TestD1) {
  return {
    DB: db,
    IMAGES: createTestR2(),
    JWT_SECRET,
    ALLOWED_ORIGIN: "https://ryankolean.github.io",
    OAUTH_KV: new TestKV(),
    PUBLIC_ORIGIN: ORIGIN,
  };
}

export type ConnectorEnv = ReturnType<typeof connectorEnv>;

export async function seedUser(db: TestD1, id: string, email: string, password: string, role = "photographer") {
  await db
    .prepare("INSERT INTO users (id, email, name, role, pw_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, id, role, await hashPassword(password, { iterations: 1000 }))
    .run();
}

export function send(env: ConnectorEnv, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }), env, ctx);
}

export async function register(env: ConnectorEnv, redirectUris: string[] = [CALLBACK], clientName = "Claude") {
  return send(env, "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
}

export async function registeredClient(env: ConnectorEnv): Promise<string> {
  return ((await (await register(env)).json()) as { client_id: string }).client_id;
}

export interface SignInPage {
  response: Response;
  html: string;
  cookie: string;
  handle: string;
  verifier: string;
}

const unescapeHtml = (value: string) => value.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

export function hiddenField(html: string, name: string): string {
  return unescapeHtml(new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "");
}

export async function openSignIn(
  env: ConnectorEnv,
  clientId: string,
  options: { redirectUri?: string; state?: string } = {},
): Promise<SignInPage> {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: options.redirectUri ?? CALLBACK,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: options.state ?? "state-1",
    scope: "studio",
    resource: `${ORIGIN}/mcp`,
  });
  const response = await send(env, `/authorize?${query}`);
  const html = await response.text();
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { response, html, cookie, handle: hiddenField(html, "handle"), verifier };
}

export function submitSignIn(env: ConnectorEnv, page: { html: string; cookie: string }, fields: Record<string, string>) {
  return send(env, "/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: page.cookie },
    body: new URLSearchParams({ handle: hiddenField(page.html, "handle"), host: hiddenField(page.html, "host"), ...fields }).toString(),
  });
}

export function token(env: ConnectorEnv, fields: Record<string, string>) {
  return send(env, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

export interface Connection {
  clientId: string;
  accessToken: string;
  refreshToken: string;
}

/** The whole flow, for tests about what comes after it. */
export async function connect(env: ConnectorEnv, email: string, password: string): Promise<Connection> {
  const clientId = await registeredClient(env);
  const page = await openSignIn(env, clientId);
  const approved = await submitSignIn(env, page, { email, password, decision: "approve" });
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const response = await token(env, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: CALLBACK,
    code_verifier: page.verifier,
  });
  const body = (await response.json()) as { access_token: string; refresh_token: string };
  return { clientId, accessToken: body.access_token, refreshToken: body.refresh_token };
}

let rpcId = 0;

export function mcp(env: ConnectorEnv, accessToken: string, method: string, params?: unknown) {
  return send(env, "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params === undefined ? {} : { params }) }),
  });
}

export function initialize(env: ConnectorEnv, accessToken: string) {
  return mcp(env, accessToken, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
}
