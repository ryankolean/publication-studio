/**
 * Uploads a folder of web-size images to an event's pool through the real API:
 * one upload grant per file (POST /events/:id/images), then the bytes to the
 * capability url it returns. The same two calls the curation board makes.
 *
 *   node scripts/upload-images.mjs --remote --event <event id> --dir /path/to/folder --item <1password id>
 *   node scripts/upload-images.mjs --remote --event <event id> --dir /path/to/folder --item <1password id> --replace
 *
 * Files are sent in name order so the pool keeps the order you sorted them in,
 * and each file's name travels with it (the grant echoes it sanitized, the PUT
 * carries it as x-file-name) so the send step can zip them under real names.
 * --replace first deletes every image already in the event's pool that no
 * package uses. Only .jpg, .jpeg, .png and .webp are considered. Nothing
 * secret is printed.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const VAULT = "Dev Secrets";
const DEPLOYED_API = "https://publication-studio-api.ryan-kolean.workers.dev";
const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function parseArgs(argv) {
  const args = { api: null, event: null, dir: null, item: null, email: "ryan.kolean@gmail.com", replace: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remote") args.api = DEPLOYED_API;
    else if (arg === "--local") args.api = "http://127.0.0.1:8787";
    else if (arg === "--api") args.api = argv[++i];
    else if (arg === "--event") args.event = argv[++i];
    else if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--item") args.item = argv[++i];
    else if (arg === "--email") args.email = argv[++i];
    else if (arg === "--replace") args.replace = true;
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

if (args.replace) {
  const listed = await fetch(`${args.api}/events/${args.event}/images`, { headers: auth });
  if (listed.status !== 200) {
    console.error(`Listing the pool failed (${listed.status}).`);
    process.exit(1);
  }
  const { images } = await listed.json();
  let removed = 0;
  for (const image of images) {
    const res = await fetch(`${args.api}/events/${args.event}/images/${image.key}`, { method: "DELETE", headers: auth });
    if (res.status === 200) removed += 1;
    else if (res.status === 409) console.log(`kept    an image a package still uses`);
    else {
      console.error(`FAILED  removing a pool image: ${res.status}`);
      process.exit(1);
    }
  }
  console.log(`removed ${removed} of ${images.length} pool images\n`);
}

let total = 0;
for (const name of files) {
  const path = join(args.dir, name);
  const contentType = TYPES[extname(name).toLowerCase()];
  const bytes = readFileSync(path);

  const grant = await fetch(`${args.api}/events/${args.event}/images`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ contentType, fileName: name }),
  });
  if (grant.status !== 201) {
    console.error(`FAILED  ${name}: grant ${grant.status} ${(await grant.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const { uploadUrl, maxBytes, fileName } = await grant.json();
  if (bytes.byteLength > maxBytes) {
    console.error(`FAILED  ${name}: ${bytes.byteLength} bytes exceeds the ${maxBytes} byte limit`);
    process.exit(1);
  }

  const put = await fetch(`${args.api}${uploadUrl}`, {
    method: "PUT",
    headers: { "content-type": contentType, "x-file-name": encodeURIComponent(fileName ?? name) },
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
