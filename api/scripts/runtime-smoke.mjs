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

if (failures.length > 0) {
  console.error(`Runtime smoke failed (${failures.length} of ${checks} checks):`);
  for (const failure of failures) console.error(`  ${failure}`);
  finish(1);
}

console.log(`Runtime smoke passed: ${checks} checks against workerd.`);
finish(0);
