/**
 * Creates a user and mints a single-use password invite, or, with
 * --reinvite, mints a fresh invite for a user who already exists.
 *
 * This is the only way a user row comes into existence. There is no signup
 * endpoint and no seeded user in any migration -- the repo is public, so real
 * email addresses stay out of it. Running this requires D1 credentials, which
 * is the access control.
 *
 *   node scripts/seed-user.mjs --email someone@example.com --name "Their Name" \
 *     --role photographer --local
 *
 *   node scripts/seed-user.mjs --email someone@example.com --reinvite --remote
 *
 * --reinvite is for a first link that lapsed or was lost: older unused links
 * stop working and only the new one is live. Used on someone who already set
 * a password, the new link lets them choose a new one.
 *
 * The link points at the live app for --remote and the dev server for
 * --local; --app-url overrides either. It is printed once and not written
 * anywhere; if it is lost, run the script again.
 */
import { execFileSync } from "node:child_process";

import { appUrlFor, newUserSql, q, reinviteSql } from "./invite-sql.mjs";

const DB_NAME = "publication-studio-db";
const TOKEN_BYTES = 32;
const INVITE_TTL_DAYS = 7;
const ROLES = ["admin", "photographer"];

function parseArgs(argv) {
  const args = { role: "photographer", appUrl: undefined, target: null, reinvite: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local") args.target = "--local";
    else if (arg === "--remote") args.target = "--remote";
    else if (arg === "--reinvite") args.reinvite = true;
    else if (arg === "--email") args.email = argv[++i];
    else if (arg === "--name") args.name = argv[++i];
    else if (arg === "--role") args.role = argv[++i];
    else if (arg === "--app-url") args.appUrl = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const required = args.reinvite ? ["email"] : ["email", "name"];
const missing = required.filter((key) => !args[key]);
if (missing.length > 0) {
  console.error(`Missing required argument(s): ${missing.map((m) => `--${m}`).join(", ")}`);
  process.exit(1);
}
if (args.target === null) {
  console.error("Pass --local or --remote so the target database is explicit.");
  process.exit(1);
}
if (!args.reinvite && !ROLES.includes(args.role)) {
  console.error(`--role must be one of: ${ROLES.join(", ")}`);
  process.exit(1);
}

function d1(sql, { json = false } = {}) {
  const extra = json ? ["--json"] : [];
  return execFileSync("npx", ["wrangler", "d1", "execute", DB_NAME, args.target, ...extra, "--command", sql], {
    stdio: ["ignore", json ? "pipe" : "ignore", "inherit"],
    encoding: "utf8",
  });
}

if (args.reinvite) {
  let count;
  try {
    const out = JSON.parse(d1(`SELECT COUNT(*) AS n FROM users WHERE email = ${q(args.email.trim().toLowerCase())};`, { json: true }));
    count = Number(out[0]?.results?.[0]?.n ?? 0);
  } catch {
    console.error("\nCould not read the users table. Nothing was changed.");
    process.exit(1);
  }
  if (count !== 1) {
    console.error(`No account with ${args.email} on the ${args.target.slice(2)} database. Run without --reinvite to create one.`);
    process.exit(1);
  }
}

const base64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const token = base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
const tokenHash = Buffer.from(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
).toString("hex");

const inviteId = crypto.randomUUID();
const now = new Date().toISOString();
const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString();

const sql = args.reinvite
  ? reinviteSql({ email: args.email, inviteId, tokenHash, expiresAt, now })
  : newUserSql({
      userId: crypto.randomUUID(),
      email: args.email,
      name: args.name,
      role: args.role,
      inviteId,
      tokenHash,
      expiresAt,
    });

try {
  d1(sql);
} catch {
  console.error("\nThe database write failed. Nothing was created.");
  process.exit(1);
}

const link = `${appUrlFor(args.target, args.appUrl)}/#/set-password?token=${token}`;

console.log(
  args.reinvite
    ? `New invite for ${args.email} on the ${args.target.slice(2)} database; any older unused link no longer works.`
    : `Created ${args.email} as ${args.role} on the ${args.target.slice(2)} database.`,
);
console.log(`\nInvite link, valid for ${INVITE_TTL_DAYS} days and usable once:\n\n  ${link}\n`);
console.log("Send it over a channel you trust. It is not stored anywhere.");
