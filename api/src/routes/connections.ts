import { Hono } from "hono";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Env } from "../env.js";
import { fail } from "../errors.js";

/**
 * Her Claude connections, and turning one off -- spec section 9, "instant
 * revocation from studio settings". The settings screen arrives in a later
 * phase; these are the routes it will call. Signed in with the web app's own
 * token, never a connector token.
 */

function helpers(env: Env): OAuthHelpers {
  // Injected by the OAuth provider in front of the app (src/connector.ts).
  if (env.OAUTH_PROVIDER === undefined) throw new Error("the OAuth provider is not in front of this app");
  return env.OAUTH_PROVIDER;
}

function isoSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const connectionRoutes = new Hono<AppContext>();

connectionRoutes.use("*", requireAuth);

connectionRoutes.get("/", async (c) => {
  const { items } = await helpers(c.env).listUserGrants(c.get("user").id);
  return c.json({
    connections: items.map((grant) => ({
      id: grant.id,
      name: typeof grant.metadata?.name === "string" ? grant.metadata.name : "Claude",
      connectedAt: isoSeconds(grant.createdAt),
    })),
  });
});

connectionRoutes.delete("/:id", async (c) => {
  const userId = c.get("user").id;
  const id = c.req.param("id");
  const oauth = helpers(c.env);

  // Only her own: a grant id belonging to anyone else reads as not found.
  const { items } = await oauth.listUserGrants(userId);
  if (!items.some((grant) => grant.id === id)) {
    return fail(c, 404, "NOT_FOUND", "That connection could not be found.");
  }

  await oauth.revokeGrant(id, userId);
  await c.env.DB.prepare(
    "INSERT INTO audit_log (id, user_id, entity, entity_id, action) VALUES (?, ?, 'connector', ?, 'disconnected')",
  )
    .bind(crypto.randomUUID(), userId, id)
    .run();
  return c.body(null, 204);
});
