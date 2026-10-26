import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";

import { createApp } from "../src/app.js";
import { connectorOptions } from "../src/connector.js";
import { REGISTRATION_LIMIT, SIGNIN_FAILURE_LIMIT, SIGNIN_PAGE_LIMIT } from "../src/domain/connector.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { createTestD1 } from "./helpers/d1.js";
import type { TestD1 } from "./helpers/d1.js";
import {
  CALLBACK,
  JWT_SECRET,
  ORIGIN,
  connect,
  connectorEnv,
  hiddenField,
  initialize,
  openSignIn,
  register,
  registeredClient,
  seedUser,
  send,
  submitSignIn,
  token,
} from "./helpers/connector.js";
import type { ConnectorEnv } from "./helpers/connector.js";

let db: TestD1;
let env: ConnectorEnv;

const EMAIL = "partner@example.com";
const PASSWORD = "a-long-studio-password";

beforeEach(async () => {
  db = createTestD1();
  env = connectorEnv(db);
  await seedUser(db, "user-1", EMAIL, PASSWORD);
});

afterEach(() => {
  db.close();
});

async function auditActions(): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT action FROM audit_log WHERE entity = 'connector' AND action NOT IN ('registered', 'page_opened') ORDER BY rowid")
    .all<{ action: string }>();
  return results.map((row) => row.action);
}

describe("discovery", () => {
  it("answers an unauthenticated /mcp with a challenge naming the resource metadata", async () => {
    const response = await send(env, "/mcp", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain('scope="studio"');
  });

  it("publishes the protected resource metadata", async () => {
    const body = (await (await send(env, "/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(body["resource"]).toBe(`${ORIGIN}/mcp`);
    expect(body["authorization_servers"]).toEqual([ORIGIN]);
  });

  it("publishes authorization server metadata with registration and PKCE, and without CIMD", async () => {
    const body = (await (await send(env, "/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(body["registration_endpoint"]).toBe(`${ORIGIN}/oauth/register`);
    expect(body["authorization_endpoint"]).toBe(`${ORIGIN}/authorize`);
    expect(body["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(body["client_id_metadata_document_supported"]).not.toBe(true);
  });

  it("leaves the web app's routes to the web app", async () => {
    expect((await send(env, "/health")).status).toBe(200);
    expect((await send(env, "/events")).status).toBe(401);
  });
});

describe("registration", () => {
  it("registers Claude", async () => {
    const response = await register(env);
    expect(response.status).toBe(201);
  });

  it("refuses any other redirect before storing anything", async () => {
    const before = env.OAUTH_KV.size;
    const response = await register(env, [CALLBACK, "https://evil.example/cb"]);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_client_metadata");
    expect(env.OAUTH_KV.size).toBe(before);
  });
});

describe("the sign-in page", () => {
  it("names where access goes and cannot be framed", async () => {
    const page = await openSignIn(env, await registeredClient(env));
    expect(page.response.status).toBe(200);
    expect(page.html).toContain("Let Claude use your studio?");
    expect(page.html).toContain("claude.ai");
    expect(page.handle).not.toBe("");
    expect(page.response.headers.get("x-frame-options")).toBe("DENY");
    expect(page.cookie).toContain("__Host-");
  });

  it("never shows a name the client chose for itself", async () => {
    const response = await register(env, [CALLBACK], "<script>alert(1)</script>");
    const { client_id } = (await response.json()) as { client_id: string };
    const page = await openSignIn(env, client_id);
    expect(page.html).not.toContain("<script>");
    expect(page.html).not.toContain("alert(1)");
  });

  it("refuses a client whose redirect is not Claude's, even one created outside registration", async () => {
    const helpers = getOAuthApi(connectorOptions(ORIGIN), env as never);
    const rogue = await helpers.createClient({
      redirectUris: ["https://evil.example/cb"],
      clientName: "Claude",
      tokenEndpointAuthMethod: "none",
    });
    const page = await openSignIn(env, rogue.clientId, { redirectUri: "https://evil.example/cb" });
    expect(page.response.status).toBe(400);
    expect(page.html).toContain("Only Claude can connect");
    expect(page.response.headers.get("location")).toBeNull();
    expect(page.cookie).toBe("");
  });

  it("sends a malformed request from Claude back to Claude with the error", async () => {
    const clientId = await registeredClient(env);
    const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK, state: "s-9", scope: "studio" });
    const response = await send(env, `/authorize?${query}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("s-9");
  });

  it("never sends an error anywhere but Claude", async () => {
    const helpers = getOAuthApi(connectorOptions(ORIGIN), env as never);
    const rogue = await helpers.createClient({ redirectUris: ["https://evil.example/cb"], tokenEndpointAuthMethod: "none" });
    const query = new URLSearchParams({ response_type: "code", client_id: rogue.clientId, redirect_uri: "https://evil.example/cb", scope: "studio" });
    const response = await send(env, `/authorize?${query}`);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("explains an unknown client without redirecting anywhere", async () => {
    const page = await openSignIn(env, "no-such-client");
    expect(page.response.status).toBe(400);
    expect(page.response.headers.get("location")).toBeNull();
    expect(page.html).toContain("Start again from Claude");
  });
});

describe("signing in", () => {
  it("sends a code back to Claude and records the connection", async () => {
    const page = await openSignIn(env, await registeredClient(env), { state: "s-42" });
    const response = await submitSignIn(env, page, { email: EMAIL, password: PASSWORD, decision: "approve" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("state")).toBe("s-42");
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
    expect(await auditActions()).toEqual(["connected"]);
  });

  it("shows the form again after a wrong password, and the same form still works", async () => {
    const page = await openSignIn(env, await registeredClient(env));
    const wrong = await submitSignIn(env, page, { email: EMAIL, password: "not-the-password", decision: "approve" });
    expect(wrong.status).toBe(200);
    const again = await wrong.text();
    expect(again).toContain("That email or password did not match");
    expect(again).toContain("claude.ai");
    expect(hiddenField(again, "handle")).toBe(page.handle);
    expect(wrong.headers.get("x-frame-options")).toBe("DENY");

    const right = await submitSignIn(env, { html: again, cookie: page.cookie }, { email: EMAIL, password: PASSWORD, decision: "approve" });
    expect(right.status).toBe(302);
    expect(await auditActions()).toEqual(["signin_failed", "connected"]);
  });

  it("treats an unknown email like a wrong password", async () => {
    const page = await openSignIn(env, await registeredClient(env));
    const response = await submitSignIn(env, page, { email: "nobody@example.com", password: PASSWORD, decision: "approve" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("That email or password did not match");
  });

  it("only ever names a Claude host, whatever the form posts back", async () => {
    const page = await openSignIn(env, await registeredClient(env));
    const response = await submitSignIn(
      env,
      { html: page.html.replace('name="host" value="claude.ai"', 'name="host" value="evil.example"'), cookie: page.cookie },
      { email: EMAIL, password: "wrong-password", decision: "approve" },
    );
    const html = await response.text();
    expect(html).not.toContain("evil.example");
    expect(html).toContain("Start again from Claude");
  });

  it("declines back to Claude when she says not now", async () => {
    const page = await openSignIn(env, await registeredClient(env));
    const response = await submitSignIn(env, page, { decision: "deny" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(await auditActions()).toEqual(["declined"]);
  });

  it("refuses a form posted without the browser that opened it", async () => {
    const page = await openSignIn(env, await registeredClient(env));
    const response = await submitSignIn(env, { html: page.html, cookie: "" }, { email: EMAIL, password: PASSWORD, decision: "approve" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("go back to Claude and connect again");
  });

  it("tells a second submit after connecting that she may already be done", async () => {
    const page = await openSignIn(env, await registeredClient(env));
    expect((await submitSignIn(env, page, { email: EMAIL, password: PASSWORD, decision: "approve" })).status).toBe(302);

    for (const decision of ["approve", "deny"]) {
      const again = await submitSignIn(env, page, { email: EMAIL, password: PASSWORD, decision });
      expect(again.status).toBe(400);
      expect(again.headers.get("location")).toBeNull();
      const html = await again.text();
      expect(html).toContain("This page has already been used, or it has expired.");
      expect(html).toContain("If Claude now shows Publication Studio as connected, you are all set");
      expect(html).not.toContain("—");
    }
    expect(await auditActions()).toEqual(["connected"]);
  });

  it("pauses sign-in after too many failures, without checking the password", async () => {
    for (let i = 0; i < SIGNIN_FAILURE_LIMIT; i++) {
      await db
        .prepare("INSERT INTO audit_log (id, entity, entity_id, action) VALUES (?, 'connector', 'signin', 'signin_failed')")
        .bind(`fail-${i}`)
        .run();
    }
    const page = await openSignIn(env, await registeredClient(env));
    const response = await submitSignIn(env, page, { email: EMAIL, password: PASSWORD, decision: "approve" });
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("Too many tries");
    expect(response.headers.get("location")).toBeNull();
  });

  it("forgets failures older than the window", async () => {
    for (let i = 0; i < SIGNIN_FAILURE_LIMIT; i++) {
      await db
        .prepare(
          "INSERT INTO audit_log (id, entity, entity_id, action, at) VALUES (?, 'connector', 'signin', 'signin_failed', '2020-01-01T00:00:00Z')",
        )
        .bind(`old-${i}`)
        .run();
    }
    const page = await openSignIn(env, await registeredClient(env));
    const response = await submitSignIn(env, page, { email: EMAIL, password: PASSWORD, decision: "approve" });
    expect(response.status).toBe(302);
  });
});

describe("KV write caps", () => {
  async function seedLog(entityId: string, action: string, count: number, at?: string) {
    for (let i = 0; i < count; i++) {
      await db
        .prepare(`INSERT INTO audit_log (id, entity, entity_id, action${at ? ", at" : ""}) VALUES (?, 'connector', ?, ?${at ? ", ?" : ""})`)
        .bind(...[`${entityId}-${action}-${i}`, entityId, action, ...(at ? [at] : [])])
        .run();
    }
  }

  it("records each registration with its client id", async () => {
    const clientId = await registeredClient(env);
    const row = await db
      .prepare("SELECT entity_id, action, detail_json FROM audit_log WHERE entity = 'connector'")
      .first<{ entity_id: string; action: string; detail_json: string }>();
    expect(row).toMatchObject({ entity_id: "register", action: "registered" });
    expect(JSON.parse(row?.detail_json ?? "{}")).toEqual({ client: clientId });
  });

  it("refuses registrations past the hourly cap, before storing anything", async () => {
    for (let i = 0; i < REGISTRATION_LIMIT; i++) expect((await register(env)).status).toBe(201);
    const before = env.OAUTH_KV.size;
    const refused = await register(env);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("3600");
    expect(((await refused.json()) as { error: string }).error).toBe("temporarily_unavailable");
    expect(env.OAUTH_KV.size).toBe(before);
  });

  it("counts only registrations that went through", async () => {
    for (let i = 0; i < REGISTRATION_LIMIT; i++) expect((await register(env, ["https://evil.example/cb"])).status).toBe(400);
    expect((await register(env)).status).toBe(201);
  });

  it("forgets registrations older than the hour", async () => {
    await seedLog("register", "registered", REGISTRATION_LIMIT, "2020-01-01T00:00:00Z");
    expect((await register(env)).status).toBe(201);
  });

  it("refuses sign-in pages past the hourly cap, before storing anything", async () => {
    const clientId = await registeredClient(env);
    await seedLog("signin", "page_opened", SIGNIN_PAGE_LIMIT - 1);
    expect((await openSignIn(env, clientId)).response.status).toBe(200);
    const before = env.OAUTH_KV.size;
    const refused = await openSignIn(env, clientId);
    expect(refused.response.status).toBe(429);
    expect(refused.html).toContain("Too many sign-in pages");
    expect(refused.cookie).toBe("");
    expect(env.OAUTH_KV.size).toBe(before);
  });

  it("does not count a page that was refused for not being Claude", async () => {
    const helpers = getOAuthApi(connectorOptions(ORIGIN), env as never);
    const rogue = await helpers.createClient({ redirectUris: ["https://evil.example/cb"], tokenEndpointAuthMethod: "none" });
    await openSignIn(env, rogue.clientId, { redirectUri: "https://evil.example/cb" });
    const opened = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = 'signin' AND action = 'page_opened'")
      .first<{ n: number }>();
    expect(opened?.n).toBe(0);
  });
});

describe("storage failures", () => {
  it.each(["approve", "deny"])("surface as an error on %s, never as a used page or a code", async (decision) => {
    const page = await openSignIn(env, await registeredClient(env));
    env.OAUTH_KV.get = async () => {
      throw new Error("storage down");
    };
    const outcome = await submitSignIn(env, page, { email: EMAIL, password: PASSWORD, decision }).then(
      (response) => response.status,
      (error: Error) => error.message,
    );
    expect([500, "storage down"]).toContain(outcome);
    expect(await auditActions()).not.toContain("connected");
  });
});

describe("tokens", () => {
  it("refuses a code exchanged with the wrong PKCE verifier", async () => {
    const clientId = await registeredClient(env);
    const page = await openSignIn(env, clientId);
    const approved = await submitSignIn(env, page, { email: EMAIL, password: PASSWORD, decision: "approve" });
    const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";

    const wrongVerifier = await token(env, { grant_type: "authorization_code", client_id: clientId, code, redirect_uri: CALLBACK, code_verifier: "x".repeat(43) });
    expect(wrongVerifier.status).toBe(400);
  });

  it("issues fifteen-minute access tokens scoped to the studio", async () => {
    const clientId = await registeredClient(env);
    const page = await openSignIn(env, clientId);
    const approved = await submitSignIn(env, page, { email: EMAIL, password: PASSWORD, decision: "approve" });
    const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const response = await token(env, { grant_type: "authorization_code", client_id: clientId, code, redirect_uri: CALLBACK, code_verifier: page.verifier });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["expires_in"]).toBe(900);
    expect(body["scope"]).toBe("studio");
    expect(typeof body["refresh_token"]).toBe("string");
  });

  it("lets the token through to /mcp", async () => {
    const connection = await connect(env, EMAIL, PASSWORD);
    expect((await initialize(env, connection.accessToken)).status).toBe(200);
  });

  it("rotates refresh tokens: the old one dies once its replacement is used", async () => {
    const { clientId, refreshToken } = await connect(env, EMAIL, PASSWORD);
    const first = await token(env, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    const rotated = ((await first.json()) as { refresh_token: string }).refresh_token;
    expect(rotated).not.toBe(refreshToken);
    expect((await token(env, { grant_type: "refresh_token", client_id: clientId, refresh_token: rotated })).status).toBe(200);
    expect((await token(env, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken })).status).toBe(400);
  });

  it("stops a revoked access token at once", async () => {
    const { clientId, accessToken } = await connect(env, EMAIL, PASSWORD);
    const revoked = await send(env, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, token: accessToken }).toString(),
    });
    expect(revoked.status).toBe(200);
    expect((await initialize(env, accessToken)).status).toBe(401);
  });
});

describe("/connections", () => {
  async function webAuth(userId = "user-1") {
    return { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId, role: "photographer" })}` };
  }

  it("needs the web app's sign-in", async () => {
    expect((await send(env, "/connections")).status).toBe(401);
  });

  it("lists her Claude connections without any token", async () => {
    await connect(env, EMAIL, PASSWORD);
    const response = await send(env, "/connections", { headers: await webAuth() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connections: Array<Record<string, unknown>> };
    expect(body.connections).toHaveLength(1);
    expect(Object.keys(body.connections[0] ?? {}).sort()).toEqual(["connectedAt", "id", "name"]);
    expect(body.connections[0]?.["name"]).toBe("Claude");
  });

  it("disconnects one, and its access token stops working", async () => {
    const { accessToken } = await connect(env, EMAIL, PASSWORD);
    const listed = (await (await send(env, "/connections", { headers: await webAuth() })).json()) as { connections: Array<{ id: string }> };
    const id = listed.connections[0]?.id ?? "";
    const response = await send(env, `/connections/${encodeURIComponent(id)}`, { method: "DELETE", headers: await webAuth() });
    expect(response.status).toBe(204);
    expect((await initialize(env, accessToken)).status).toBe(401);
    expect((await auditActions()).at(-1)).toBe("disconnected");
  });

  it("names a connection Claude when its grant carries no name", async () => {
    const helpers = getOAuthApi(connectorOptions(ORIGIN), env as never);
    const clientId = await registeredClient(env);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      scope: "studio",
    });
    const authRequest = await helpers.parseAuthRequest(new Request(`${ORIGIN}/authorize?${query}`));
    await helpers.completeAuthorization({ request: authRequest, userId: "user-1", metadata: {}, scope: ["studio"], props: { userId: "user-1" } });
    const body = (await (await send(env, "/connections", { headers: await webAuth() })).json()) as { connections: Array<{ name: string }> };
    expect(body.connections.map((connection) => connection.name)).toEqual(["Claude"]);
  });

  it("fails loudly if the OAuth provider is not in front of the app", async () => {
    const appOnly = { DB: env.DB, IMAGES: env.IMAGES, JWT_SECRET, ALLOWED_ORIGIN: env.ALLOWED_ORIGIN };
    const response = await createApp().request("/connections", { headers: await webAuth() }, appOnly);
    expect(response.status).toBe(500);
  });

  it("cannot disconnect someone else's connection", async () => {
    await seedUser(db, "user-2", "other@example.com", PASSWORD, "admin");
    const { accessToken } = await connect(env, EMAIL, PASSWORD);
    const listed = (await (await send(env, "/connections", { headers: await webAuth() })).json()) as { connections: Array<{ id: string }> };
    const id = listed.connections[0]?.id ?? "";
    const response = await send(env, `/connections/${encodeURIComponent(id)}`, { method: "DELETE", headers: await webAuth("user-2") });
    expect(response.status).toBe(404);
    expect((await initialize(env, accessToken)).status).toBe(200);
  });
});
