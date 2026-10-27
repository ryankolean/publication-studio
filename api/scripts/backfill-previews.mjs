/**
 * Makes the small preview review_photos shows Claude, for every pooled photo
 * that has none (SUMMIT-344 slice 2). Photos added through an upload link get
 * one from her browser; photos stored before that, or added in the web app,
 * get one here. Run it once per environment after migration 0012, and again
 * whenever photos were added in the web app.
 *
 *   node scripts/backfill-previews.mjs --remote --item <1password id>
 *   node scripts/backfill-previews.mjs --staging --email staging@example.com   (password in STUDIO_PASSWORD)
 *   node scripts/backfill-previews.mjs --local --event <event id> --dry-run
 *
 * Each photo is read through its short-lived read url, resized by the local
 * ImageMagick (`magick`) to a JPEG 256 pixels on its long edge, the way the
 * upload page makes them, and stored with PUT /events/:id/images/:file/preview.
 * Photos that already have a preview are skipped, so a second run does
 * nothing, and a run cut short (sign-in and read urls last 15 minutes) is
 * finished by running it again. Nothing secret is printed.
 */
import { execFileSync } from "node:child_process";

const VAULT = "Dev Secrets";
const APIS = {
  "--remote": "https://publication-studio-api.ryan-kolean.workers.dev",
  "--staging": "https://publication-studio-api-staging.ryan-kolean.workers.dev",
  "--local": "http://127.0.0.1:8787",
};

function parseArgs(argv) {
  const args = { api: null, event: null, item: null, email: "ryan.kolean@gmail.com", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (APIS[arg] !== undefined) args.api = APIS[arg];
    else if (arg === "--api") args.api = argv[++i];
    else if (arg === "--event") args.event = argv[++i];
    else if (arg === "--item") args.item = argv[++i];
    else if (arg === "--email") args.email = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (args.api === null) {
    console.error("--remote, --staging, --local or --api is required.");
    process.exit(1);
  }
  if (args.item === null && process.env.STUDIO_PASSWORD === undefined) {
    console.error("--item <1password id> or STUDIO_PASSWORD is required.");
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

function password() {
  if (args.item === null) return process.env.STUDIO_PASSWORD;
  return execFileSync("op", ["item", "get", args.item, "--vault", VAULT, "--fields", "password", "--reveal"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function json(response, what) {
  if (!response.ok) {
    console.error(`FAILED  ${what}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    process.exit(1);
  }
  return response.json();
}

const login = await fetch(`${args.api}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: args.email, password: password() }),
});
const { access_token: accessToken } = await json(login, "sign-in");
const auth = { authorization: `Bearer ${accessToken}` };

const events =
  args.event === null
    ? (await json(await fetch(`${args.api}/events`, { headers: auth }), "listing weddings")).events
    : [{ id: args.event, slug: args.event }];

let made = 0;
let had = 0;
for (const event of events) {
  const { images } = await json(await fetch(`${args.api}/events/${event.id}/images`, { headers: auth }), `listing ${event.slug}`);
  const missing = images.filter((image) => image.hasPreview !== true);
  had += images.length - missing.length;
  if (missing.length === 0) continue;
  console.log(`${event.slug}: ${missing.length} of ${images.length} photos need a preview`);
  if (args.dryRun) continue;

  for (const image of missing) {
    const original = await fetch(`${args.api}${image.readUrl}`);
    if (!original.ok) {
      console.error(`FAILED  reading ${image.originalName ?? image.key}: ${original.status}`);
      process.exit(1);
    }
    const preview = execFileSync(
      "magick",
      ["-", "-auto-orient", "-thumbnail", "256x256>", "-background", "white", "-flatten", "-strip", "-quality", "80", "jpg:-"],
      { input: Buffer.from(await original.arrayBuffer()), stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
    );
    const file = image.key.split("/").pop();
    const stored = await fetch(`${args.api}/events/${event.id}/images/${file}/preview`, {
      method: "PUT",
      headers: { ...auth, "content-type": "image/jpeg" },
      body: preview,
    });
    await json(stored, `storing the preview of ${image.originalName ?? image.key}`);
    made += 1;
  }
}

const photos = (n) => (n === 1 ? "1 photo" : `${n} photos`);
console.log(
  args.dryRun
    ? `\nDry run: nothing stored. ${photos(had)} already had a preview.`
    : `\n${made === 1 ? "1 preview" : `${made} previews`} made; ${photos(had)} already had one.`,
);
