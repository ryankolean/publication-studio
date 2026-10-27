/**
 * Smoke tests against the real Workers runtime.
 *
 * The unit suite drives the Hono app in-process, which is fast but is not
 * workerd. That gap is not theoretical: a CORS preflight that returned correct
 * headers under Hono's test harness returned a bare 204 with no headers at all
 * on workerd, which would have broken every authenticated request from the
 * browser while the whole suite stayed green.
 *
 * So the handful of behaviours that depend on runtime semantics -- CORS
 * preflight, empty-body responses, routing and status codes -- are asserted
 * here against `wrangler dev`.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "https://ryankolean.github.io";

/**
 * A state directory of its own, so this never reads or writes the local
 * database a developer is using, and so CI starts from nothing every run.
 */
const STATE_DIR = ".wrangler/smoke-state";
const DB_NAME = "publication-studio-db";

const failures = [];
let checks = 0;

function check(name, condition, detail = "") {
  checks++;
  if (!condition) failures.push(`${name}${detail === "" ? "" : ` -- ${detail}`}`);
}

// Without this the schema is absent and every query fails as a 500, which is
// how CI first caught this script trusting a database somebody else migrated.
try {
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      DB_NAME,
      "--local",
      "--persist-to",
      STATE_DIR,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
} catch (error) {
  console.error("Could not migrate the smoke database.");
  console.error(String(error.stderr ?? error).slice(-1500));
  process.exit(1);
}

// A user to connect Claude as. The hash is built here in the format
// domain/password.ts writes, at a low work factor, since this script is plain JS.
const SMOKE_EMAIL = "smoke@example.com";
const SMOKE_PASSWORD = "runtime-smoke-password";
{
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(SMOKE_PASSWORD, salt, 1000, 32, "sha256");
  const hash = `pbkdf2-sha256$1000$${salt.toString("base64")}$${digest.toString("base64")}`;
  try {
    execFileSync(
      "npx",
      [
        "wrangler", "d1", "execute", DB_NAME, "--local", "--persist-to", STATE_DIR, "--command",
        `INSERT OR REPLACE INTO users (id, email, name, role, pw_hash) VALUES ('smoke-user', '${SMOKE_EMAIL}', 'Smoke', 'photographer', '${hash}')`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (error) {
    console.error("Could not seed the smoke user.");
    console.error(String(error.stderr ?? error).slice(-1500));
    process.exit(1);
  }
}

/**
 * detached, so the whole process group can be signalled. Killing the npx
 * wrapper alone leaves workerd running with its pipes open, which kept this
 * script alive forever on a CI runner while exiting cleanly on a laptop.
 */
const wrangler = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--port",
    String(PORT),
    "--var",
    `ALLOWED_ORIGIN:${ORIGIN}`,
    "--var",
    "JWT_SECRET:runtime-smoke-secret",
    // Tokens are bound to this origin, so it has to be the one requests use.
    "--var",
    `PUBLIC_ORIGIN:${BASE}`,
    "--persist-to",
    STATE_DIR,
  ],
  { stdio: ["ignore", "ignore", "pipe"], detached: true },
);

let stderr = "";
wrangler.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  try {
    // Negative pid signals the group, which is what actually reaches workerd.
    process.kill(-wrangler.pid, "SIGTERM");
  } catch {
    try {
      wrangler.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
};

/** Exits the process outright: lingering child pipes must not hold CI open. */
const finish = (code) => {
  stop();
  process.exit(code);
};

process.on("SIGINT", () => finish(130));

// A hung runtime should fail the build, not stall it until the job timeout.
const watchdog = setTimeout(() => {
  console.error("Runtime smoke timed out after 120s.");
  console.error(stderr.slice(-2000));
  finish(1);
}, 120_000);
watchdog.unref();

async function waitForReady() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

if (!(await waitForReady())) {
  console.error("wrangler dev never became ready.");
  console.error(stderr.slice(-2000));
  finish(1);
}

const preflight = (origin) =>
  fetch(`${BASE}/health`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });

// CORS preflight from the configured SPA origin.
{
  const response = await preflight(ORIGIN);
  const allowOrigin = response.headers.get("access-control-allow-origin");
  const allowHeaders = response.headers.get("access-control-allow-headers") ?? "";

  check("preflight status is 204", response.status === 204, `got ${response.status}`);
  check("preflight allows the SPA origin", allowOrigin === ORIGIN, `got ${allowOrigin}`);
  // Without this the browser refuses to send the bearer token at all.
  check(
    "preflight allows the authorization header",
    allowHeaders.toLowerCase().includes("authorization"),
    `got ${allowHeaders}`,
  );
}

// The curation board uploads with PUT and removes images with DELETE; both
// preflight, so each has to be in the allowed methods on workerd too.
for (const method of ["PUT", "DELETE"]) {
  const response = await fetch(`${BASE}/health`, {
    method: "OPTIONS",
    headers: { origin: ORIGIN, "access-control-request-method": method },
  });
  const allowMethods = response.headers.get("access-control-allow-methods") ?? "";
  check(`preflight allows ${method}`, allowMethods.includes(method), `got ${allowMethods}`);
}

// The upload PUT carries the photographer's file name in x-file-name.
{
  const response = await fetch(`${BASE}/health`, {
    method: "OPTIONS",
    headers: {
      origin: ORIGIN,
      "access-control-request-method": "PUT",
      "access-control-request-headers": "content-type,x-file-name",
    },
  });
  const allowHeaders = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  check("preflight allows the x-file-name header", allowHeaders.includes("x-file-name"), `got ${allowHeaders}`);
}

// CORS preflight from anywhere else.
{
  const response = await preflight("https://evil.example");
  check(
    "preflight does not echo a foreign origin",
    response.headers.get("access-control-allow-origin") === null,
    `got ${response.headers.get("access-control-allow-origin")}`,
  );
}

// Actual requests carry the header too.
{
  const response = await fetch(`${BASE}/health`, { headers: { origin: ORIGIN } });
  check(
    "a real response allows the SPA origin",
    response.headers.get("access-control-allow-origin") === ORIGIN,
  );
}

// Routing and auth.
{
  const health = await fetch(`${BASE}/health`);
  check("health responds 200", health.status === 200);
  check("health reports ok", (await health.json()).status === "ok");

  const events = await fetch(`${BASE}/events`);
  check("events rejects anonymous", events.status === 401, `got ${events.status}`);

  const publications = await fetch(`${BASE}/publications`);
  check("publications rejects anonymous", publications.status === 401);

  const pool = await fetch(`${BASE}/events/smoke/images`);
  check("image pool rejects anonymous", pool.status === 401, `got ${pool.status}`);

  const removal = await fetch(`${BASE}/events/smoke/images/events/smoke/a.jpg`, { method: "DELETE" });
  check("image delete rejects anonymous", removal.status === 401, `got ${removal.status}`);

  const packageImages = await fetch(`${BASE}/packages/smoke/images`);
  check("package images rejects anonymous", packageImages.status === 401, `got ${packageImages.status}`);

  const eventPackages = await fetch(`${BASE}/events/smoke/packages`);
  check("event packages rejects anonymous", eventPackages.status === 401, `got ${eventPackages.status}`);

  const eventEdit = await fetch(`${BASE}/events/smoke`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ coupleNames: "Smoke", eventDate: "2026-01-01" }),
  });
  check("event edit rejects anonymous", eventEdit.status === 401, `got ${eventEdit.status}`);

  const walkthrough = await fetch(`${BASE}/events/smoke/walkthrough`);
  check("walkthrough rejects anonymous", walkthrough.status === 401, `got ${walkthrough.status}`);

  const submissions = await fetch(`${BASE}/submissions`);
  check("submissions rejects anonymous", submissions.status === 401, `got ${submissions.status}`);

  const suggestions = await fetch(`${BASE}/style/events/smoke/suggestions`, { method: "PUT" });
  check("tag suggestions reject anonymous", suggestions.status === 401, `got ${suggestions.status}`);

  const locations = await fetch(`${BASE}/locations`);
  check("locations reject anonymous", locations.status === 401, `got ${locations.status}`);

  const markSent = await fetch(`${BASE}/submissions/smoke`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "sent" }),
  });
  check("mark sent rejects anonymous", markSent.status === 401, `got ${markSent.status}`);

  const signup = await fetch(`${BASE}/auth/signup`, { method: "POST" });
  check("no signup route exists", signup.status === 404, `got ${signup.status}`);
}

// A 204 with no body is a runtime-semantics case, same family as the CORS bug.
{
  const response = await fetch(`${BASE}/auth/set-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "definitely-not-real", password: "correct horse battery" }),
  });
  check("an unusable invite is rejected", response.status === 400, `got ${response.status}`);
}

// The Claude connector end to end, as Claude drives it. Node tests cover the
// cases; this proves the OAuth provider and the MCP SDK run on workerd: no
// runtime code generation, Web Crypto, cookies and redirects as the runtime
// does them.
{
  const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
  const form = (fields) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

  const challenge = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
  check("mcp rejects a request without a token", challenge.status === 401, `got ${challenge.status}`);
  check(
    "mcp points at its resource metadata",
    (challenge.headers.get("www-authenticate") ?? "").includes(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    ),
    challenge.headers.get("www-authenticate") ?? "no challenge",
  );

  const resource = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  check("resource metadata names /mcp", (await resource.json()).resource === `${BASE}/mcp`);

  const server = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check("authorization server metadata offers registration", server.registration_endpoint === `${BASE}/oauth/register`);

  const register = (redirectUris) =>
    fetch(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris, token_endpoint_auth_method: "none" }),
    });

  const rogue = await register(["https://evil.example/cb"]);
  check("registration refuses a redirect that is not Claude's", rogue.status === 400, `got ${rogue.status}`);

  const registered = await register([CALLBACK]);
  check("registration accepts Claude", registered.status === 201, `got ${registered.status}`);
  const clientId = (await registered.json()).client_id;

  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "smoke",
    scope: "studio",
  });
  const page = await fetch(`${BASE}/authorize?${query}`, { redirect: "manual" });
  const html = await page.text();
  check("sign-in page renders", page.status === 200, `got ${page.status}`);
  check("sign-in page cannot be framed", page.headers.get("x-frame-options") === "DENY");
  const cookie = page.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const handle = /name="handle" value="([^"]*)"/.exec(html)?.[1] ?? "";

  const approved = await fetch(`${BASE}/authorize`, {
    ...form({ handle, host: "claude.ai", email: SMOKE_EMAIL, password: SMOKE_PASSWORD, decision: "approve" }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    redirect: "manual",
  });
  const location = new URL(approved.headers.get("location") ?? "about:blank");
  check("signing in sends a code to Claude", approved.status === 302 && location.searchParams.has("code"), `got ${approved.status}`);

  const tokens = await (
    await fetch(
      `${BASE}/oauth/token`,
      form({
        grant_type: "authorization_code",
        client_id: clientId,
        code: location.searchParams.get("code") ?? "",
        redirect_uri: CALLBACK,
        code_verifier: verifier,
      }),
    )
  ).json();
  check("the code exchanges for an access token", typeof tokens.access_token === "string");

  const rpc = (method, params) =>
    fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
    });

  const listed = await rpc("tools/list");
  const tools = listed.status === 200 ? (await listed.json()).result.tools.map((tool) => tool.name) : [];
  check("mcp lists its five tools", tools.length === 5, `got ${listed.status} ${tools.join(",")}`);

  const called = await rpc("tools/call", { name: "studio_overview", arguments: {} });
  const result = called.status === 200 ? (await called.json()).result : null;
  check("studio_overview answers on workerd", result !== null && result.isError !== true, `got ${called.status}`);

  // A write through the web app's own routes, and the two-step confirmation,
  // whose single-use redemption is an UPDATE ... RETURNING on real D1.
  const tool = async (name, args) => {
    const response = await rpc("tools/call", { name, arguments: args });
    const body = response.status === 200 ? (await response.json()).result : null;
    return { ok: body !== null && body.isError !== true, data: body?.isError ? {} : JSON.parse(body?.content?.[0]?.text ?? "{}") };
  };
  const saved = await tool("save_wedding", { couple_names: "Smoke and Test", date: "2026-06-14", venue: "Smoke Hall" });
  check("save_wedding creates a wedding on workerd", saved.ok && saved.data.wedding === "smoke-and-test-2026", JSON.stringify(saved.data));
  const answers = { wedding: "smoke-and-test-2026", lead_photographer: true, couple_agreed: "yes" };
  const preview = await tool("confirm_permissions", answers);
  check("confirm_permissions previews with a code", preview.ok && typeof preview.data.confirm === "string");
  const confirmed = await tool("confirm_permissions", { ...answers, confirmation: preview.data.confirm });
  check("the code records the answers on workerd", confirmed.ok && confirmed.data.onHold === undefined, JSON.stringify(confirmed.data));
  const reused = await tool("confirm_permissions", { ...answers, confirmation: preview.data.confirm });
  check("the code works once on workerd", !reused.ok);

  const connections = await fetch(`${BASE}/connections`);
  check("connections reject anonymous", connections.status === 401, `got ${connections.status}`);
}

if (failures.length > 0) {
  console.error(`Runtime smoke failed (${failures.length} of ${checks} checks):`);
  for (const failure of failures) console.error(`  ${failure}`);
  finish(1);
}

console.log(`Runtime smoke passed: ${checks} checks against workerd.`);
finish(0);
