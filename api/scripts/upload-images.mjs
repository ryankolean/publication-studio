/**
 * Uploads a folder of web-size images to an event's pool through the real API:
 * one upload grant per file (POST /events/:id/images), then the bytes to the
 * capability url it returns. The same two calls the curation board makes.
 *
 *   node scripts/upload-images.mjs --remote --event <event id> --dir /path/to/folder --item <1password id>
 *
 * Files are sent in name order so the pool keeps the order you sorted them in.
 * Only .jpg, .jpeg, .png and .webp are considered. Nothing secret is printed.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const VAULT = "Dev Secrets";
const DEPLOYED_API = "https://publication-studio-api.ryan-kolean.workers.dev";
const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function parseArgs(argv) {
  const args = { api: null, event: null, dir: null, item: null, email: "ryan.kolean@gmail.com" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remote") args.api = DEPLOYED_API;
    else if (arg === "--local") args.api = "http://127.0.0.1:8787";
    else if (arg === "--api") args.api = argv[++i];
    else if (arg === "--event") args.event = argv[++i];
    else if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--item") args.item = argv[++i];
    else if (arg === "--email") args.email = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  for (const [name, value] of Object.entries({ "--remote or --local": args.api, "--event": args.event, "--dir": args.dir, "--item": args.item })) {
    if (value === null) {
      console.error(`${name} is required.`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const files = readdirSync(args.dir)
  .filter((name) => TYPES[extname(name).toLowerCase()] !== undefined)
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
if (files.length === 0) {
  console.error("No image files in that folder.");
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
const auth = { authorization: `Bearer ${accessToken}` };

let total = 0;
for (const name of files) {
  const path = join(args.dir, name);
  const contentType = TYPES[extname(name).toLowerCase()];
  const bytes = readFileSync(path);

  const grant = await fetch(`${args.api}/events/${args.event}/images`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ contentType }),
  });
  if (grant.status !== 201) {
    console.error(`FAILED  ${name}: grant ${grant.status} ${(await grant.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const { uploadUrl, maxBytes } = await grant.json();
  if (bytes.byteLength > maxBytes) {
    console.error(`FAILED  ${name}: ${bytes.byteLength} bytes exceeds the ${maxBytes} byte limit`);
    process.exit(1);
  }

  const put = await fetch(`${args.api}${uploadUrl}`, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: bytes,
  });
  if (put.status !== 201) {
    console.error(`FAILED  ${name}: put ${put.status} ${(await put.text()).slice(0, 200)}`);
    process.exit(1);
  }
  total += bytes.byteLength;
  console.log(`uploaded ${name} (${Math.round(bytes.byteLength / 1024)} KB)`);
}
console.log(`\n${files.length} files, ${Math.round(total / 1024 / 1024)} MB.`);
