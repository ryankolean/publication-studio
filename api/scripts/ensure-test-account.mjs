/**
 * Makes the development sign-in usable, idempotently, from 1Password.
 *
 *   node scripts/ensure-test-account.mjs --remote
 *   node scripts/ensure-test-account.mjs --local --api http://127.0.0.1:8787
 *   node scripts/ensure-test-account.mjs --remote --reset
 *   node scripts/ensure-test-account.mjs --local --item <1password item id>
 *
 * Creates the 1Password login item if it does not exist, generating the
 * password there, then makes the account in D1 match it: seeds the user if
 * absent, mints a single-use invite, spends it through the real
 * /auth/set-password endpoint, and confirms the credentials actually log in.
 *
 * The password is read into memory and posted as JSON. It is never printed,
 * never passed as a command-line argument where the process list would expose
 * it, and never written anywhere but 1Password.
 *
 * Safe to re-run. Without --reset it leaves an account that already works
 * alone, so it can be a precondition for any test run.
 */
import { execFileSync } from "node:child_process";

const VAULT = "Dev Secrets";
const ITEM = "Publication Studio (dev)";
const DB_NAME = "publication-studio-db";
const DEPLOYED_API = "https://publication-studio-api.ryan-kolean.workers.dev";
const APP_URL = "https://ryankolean.github.io/publication-studio";
const INVITE_TTL_DAYS = 7;

function parseArgs(argv) {
  const args = { target: null, api: null, reset: false, email: "ryan.kolean@gmail.com", name: "Ryan Kolean", role: "admin" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local") args.target = "--local";
    else if (arg === "--remote") args.target = "--remote";
    else if (arg === "--reset") args.reset = true;
    else if (arg === "--api") args.api = argv[++i];
    else if (arg === "--email") args.email = argv[++i];
    else if (arg === "--name") args.name = argv[++i];
    else if (arg === "--role") args.role = argv[++i];
    else if (arg === "--item") args.item = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (args.target === null) {
    console.error("Pass --local or --remote so the target database is explicit.");
    process.exit(1);
  }
  args.api ??= args.target === "--remote" ? DEPLOYED_API : "http://127.0.0.1:8787";
  return args;
}

const args = parseArgs(process.argv.slice(2));

const op = (opArgs, options = {}) =>
  execFileSync("op", opArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();

const sql = (statement) => {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB_NAME, args.target, "--json", "--command", statement],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  // wrangler prints a banner before the JSON payload.
  const start = out.indexOf("[");
  return JSON.parse(out.slice(start))[0].results;
};

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

// 1. The password lives in 1Password. Create the item on first run.
//
// The item is resolved by listing the vault, not by a get that is caught.
// A transient op failure (locked app, slow prompt) must abort, not read as
// "no item" and create a second one with a password nobody has. Two items
// with this title is itself an error: op cannot pick between them, so stop
// and say which ids exist. --item <id> bypasses the title lookup.
let itemId = args.item ?? null;
if (itemId === null) {
  const matches = JSON.parse(op(["item", "list", "--vault", VAULT, "--format", "json"])).filter(
    (item) => item.title === ITEM,
  );
  if (matches.length > 1) {
    console.error(
      `${matches.length} items titled "${ITEM}" exist in ${VAULT}: ${matches
        .map((item) => item.id)
        .join(", ")}. Archive the extras, or pass --item <id>.`,
    );
    process.exit(1);
  }
  if (matches.length === 1) {
    itemId = matches[0].id;
    console.log(`Using the existing 1Password item "${ITEM}" in ${VAULT}.`);
  } else {
    const created = JSON.parse(
      op([
        "item", "create",
        "--category", "login",
        "--title", ITEM,
        "--vault", VAULT,
        "--generate-password=letters,digits,symbols,32",
        "--format", "json",
        `username=${args.email}`,
        `website=${APP_URL}`,
      ]),
    );
    itemId = created.id;
    console.log(`Created the 1Password item "${ITEM}" in ${VAULT} with a generated password.`);
  }
}

// op read secret references reject characters that are legal in item titles,
// so the field is fetched through op item get by id instead.
const password = op(["item", "get", itemId, "--vault", VAULT, "--fields", "password", "--reveal"]);
if (password.length < 12) {
  console.error("The stored password is shorter than the server will accept.");
  process.exit(1);
}

// 2. Make sure the user row exists.
const existing = sql(`SELECT id, pw_hash FROM users WHERE email = ${quote(args.email)}`);
let userId;

if (existing.length === 0) {
  userId = crypto.randomUUID();
  sql(
    `INSERT INTO users (id, email, name, role, pw_hash) VALUES (${quote(userId)}, ${quote(
      args.email,
    )}, ${quote(args.name)}, ${quote(args.role)}, 'unset')`,
  );
  console.log(`Created ${args.email} as ${args.role}.`);
} else {
  userId = existing[0].id;
  console.log(`Found ${args.email}.`);
}

// 3. Does the stored password already work?
const login = async () => {
  const response = await fetch(`${args.api}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: args.email, password }),
  });
  return response.status;
};

if (!args.reset && (await login()) === 200) {
  const revoked = sql(
    `UPDATE password_invites SET used_at = ${quote(new Date().toISOString())} WHERE user_id = ${quote(
      userId,
    )} AND used_at IS NULL RETURNING id`,
  );
  if (revoked.length > 0) {
    console.log(`Revoked ${revoked.length} outstanding invite link(s).`);
  }
  console.log("The stored password already signs in. Nothing to do.");
  console.log(`\nSign in at ${APP_URL}/#/login with the credentials in 1Password.`);
  process.exit(0);
}

// 4. Mint an invite and spend it through the real endpoint, so this exercises
//    the same path a person uses rather than writing a hash directly.
const toBase64Url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const tokenHash = Buffer.from(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
).toString("hex");
const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString();

sql(
  `INSERT INTO password_invites (id, user_id, token_hash, expires_at) VALUES (${quote(
    crypto.randomUUID(),
  )}, ${quote(userId)}, ${quote(tokenHash)}, ${quote(expiresAt)})`,
);

const setResponse = await fetch(`${args.api}/auth/set-password`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token, password }),
});

if (setResponse.status !== 204) {
  const body = await setResponse.text();
  console.error(`Setting the password failed (${setResponse.status}): ${body}`);
  process.exit(1);
}

// 5. Any other outstanding invite for this user is a live credential that can
//    reset the password. Once the account works, they are spent.
sql(
  `UPDATE password_invites SET used_at = ${quote(new Date().toISOString())} WHERE user_id = ${quote(
    userId,
  )} AND used_at IS NULL`,
);

// 6. Prove it, rather than assuming.
const status = await login();
if (status !== 200) {
  console.error(`The password was set but signing in returned ${status}.`);
  process.exit(1);
}

console.log("Password set from 1Password and sign-in verified.");
console.log(`\nSign in at ${APP_URL}/#/login with the credentials in 1Password.`);
