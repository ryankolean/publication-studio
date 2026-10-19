/**
 * Seeds events from a JSON file through the real API, as the intake form would.
 *
 *   node scripts/seed-events.mjs --remote --file /path/outside/the/repo.json --item <1password id>
 *   node scripts/seed-events.mjs --local  --file /path/outside/the/repo.json --item <1password id>
 *
 * The file is an array of intake bodies (the shape POST /events accepts). It
 * lives outside the repo because it carries gallery links, which are
 * credentials. Nothing from the file is printed; only couple names and the
 * outcome per record. The operator password is read from 1Password and posted
 * to /auth/login, never printed or passed as an argument.
 *
 * Idempotent: a record whose couple names and date already exist is skipped,
 * so re-running after a partial failure is safe.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const VAULT = "Dev Secrets";
const DEPLOYED_API = "https://publication-studio-api.ryan-kolean.workers.dev";

function parseArgs(argv) {
  const args = { api: null, file: null, item: null, email: "ryan.kolean@gmail.com" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remote") args.api = DEPLOYED_API;
    else if (arg === "--local") args.api = "http://127.0.0.1:8787";
    else if (arg === "--api") args.api = argv[++i];
    else if (arg === "--file") args.file = argv[++i];
    else if (arg === "--item") args.item = argv[++i];
    else if (arg === "--email") args.email = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  for (const [name, value] of Object.entries({ "--remote or --local": args.api, "--file": args.file, "--item": args.item })) {
    if (value === null) {
      console.error(`${name} is required.`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const records = JSON.parse(readFileSync(args.file, "utf8"));
if (!Array.isArray(records)) {
  console.error("The file must hold a JSON array of intake records.");
  process.exit(1);
}

const password = execFileSync(
  "op",
  ["item", "get", args.item, "--vault", VAULT, "--fields", "password", "--reveal"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

const login = await fetch(`${args.api}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: args.email, password }),
});
if (login.status !== 200) {
  console.error(`Sign-in failed (${login.status}).`);
  process.exit(1);
}
const { access_token: accessToken } = await login.json();
const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

const existingRes = await fetch(`${args.api}/events`, { headers });
if (existingRes.status !== 200) {
  console.error(`Listing events failed (${existingRes.status}).`);
  process.exit(1);
}
const { events: existing } = await existingRes.json();
const seen = new Set(existing.map((e) => `${e.coupleNames}|${e.eventDate}`));

let created = 0;
let skipped = 0;
for (const record of records) {
  const key = `${record.coupleNames}|${record.eventDate}`;
  if (seen.has(key)) {
    console.log(`skip    ${record.coupleNames} (${record.eventDate}) already exists`);
    skipped += 1;
    continue;
  }
  const res = await fetch(`${args.api}/events`, { method: "POST", headers, body: JSON.stringify(record) });
  if (res.status !== 201) {
    const body = await res.text();
    // The error body never echoes the gallery link; the validator reports field names only.
    console.error(`FAILED  ${record.coupleNames}: ${res.status} ${body.slice(0, 300)}`);
    process.exit(1);
  }
  const view = await res.json();
  console.log(`created ${record.coupleNames} (${record.eventDate}) id=${view.id} gallery=${view.hasGalleryUrl ? "on file" : "none"}`);
  created += 1;
}
console.log(`\n${created} created, ${skipped} skipped.`);
