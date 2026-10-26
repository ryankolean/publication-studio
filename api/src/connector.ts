import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";

import { createApp } from "./app.js";
import { countConnector, logConnector } from "./connector-log.js";
import { capWindowStart, registrationLocked, registrationRefusal } from "./domain/connector.js";
import type { OAuthEnv, WorkerEnv } from "./env.js";
import { mcpHandler } from "./mcp/handler.js";
import { authorize } from "./routes/authorize.js";

/**
 * The Worker's front door -- spec docs/specs/claude-native.md section 3.
 *
 * An OAuth 2.1 provider sits in front of the web app. It owns discovery,
 * registration, the token endpoint and the bearer check on /mcp; /authorize
 * is ours (routes/authorize.ts); everything else falls through to the Hono
 * app exactly as before.
 *
 * DECISION: dynamic client registration only. Client ID Metadata Documents
 * stay off: the spec names DCR, and CIMD would have the Worker fetch any URL
 * a caller names as its client id. Turn it on only if Claude needs it, with
 * its client ids pinned to Claude's own domains.
 *
 * DECISION: the library's handler types come from @cloudflare/workers-types,
 * which this repo leaves out (its globals collide with @types/node). They
 * resolve to `any` under skipLibCheck, so the boundary below is typed by hand.
 */

const app = createApp();

export function connectorOptions(origin: string): OAuthProviderOptions<OAuthEnv> {
  return {
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler: {
      fetch: (request: Request, env: OAuthEnv, ctx: unknown) =>
        new URL(request.url).pathname === "/authorize"
          ? authorize(request, env)
          : app.fetch(request, env, ctx as never),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["studio"],
    requiredScopes: ["studio"],
    // Short-lived access; the grant slides while Claude keeps using it, so
    // she reconnects only after a month without it, not every month.
    accessTokenTTL: 15 * 60,
    refreshTokenIdleTTL: 30 * 24 * 60 * 60,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: "Publication Studio",
    },
    clientRegistrationCallback: ({ clientMetadata }) => {
      const refusal = registrationRefusal(clientMetadata);
      return refusal === null ? undefined : { description: refusal };
    },
  };
}

// The provider fixes its resource at construction, and the origin is
// configuration (PUBLIC_ORIGIN), so one is built per origin and kept.
const providers = new Map<string, OAuthProvider<OAuthEnv>>();

export const connectorWorker = {
  fetch(request: Request, env: WorkerEnv, ctx: unknown): Promise<Response> {
    let provider = providers.get(env.PUBLIC_ORIGIN);
    if (provider === undefined) {
      provider = new OAuthProvider(connectorOptions(env.PUBLIC_ORIGIN));
      providers.set(env.PUBLIC_ORIGIN, provider);
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/oauth/register") {
      return register(provider, request, env, ctx);
    }
    // The provider adds OAUTH_PROVIDER before any handler sees env.
    return provider.fetch(request, env as OAuthEnv, ctx as never);
  },
};

/**
 * Dynamic registration, capped per hour (domain/connector.ts). The provider
 * owns the endpoint, so the cap is checked in front of it, and only a
 * registration it accepted, which stored a client in KV, counts.
 */
async function register(
  provider: OAuthProvider<OAuthEnv>,
  request: Request,
  env: WorkerEnv,
  ctx: unknown,
): Promise<Response> {
  if (registrationLocked(await countConnector(env.DB, "register", "registered", capWindowStart(Date.now())))) {
    return Response.json(
      {
        error: "temporarily_unavailable",
        error_description: "Too many new connections in the last hour. Try again in an hour.",
      },
      { status: 429, headers: { "Retry-After": "3600", "Cache-Control": "no-store" } },
    );
  }

  const response = await provider.fetch(request, env as OAuthEnv, ctx as never);
  if (response.status === 201) {
    const { client_id: client } = (await response.clone().json()) as { client_id?: string };
    await logConnector(env.DB, "register", "registered", { detail: { client: client ?? null } });
  }
  return response;
}
