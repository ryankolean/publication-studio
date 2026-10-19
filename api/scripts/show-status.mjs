/**
 * Prints the state of every event, its packages and submissions, read-only,
 * through the API as the operator. Names and statuses only; never a gallery
 * link or image key.
 *
 *   node scripts/show-status.mjs --remote --item <1password id>
 */
import { execFileSync } from "node:child_process";

const VAULT = "Dev Secrets";
const DEPLOYED_API = "https://publication-studio-api.ryan-kolean.workers.dev";

function parseArgs(argv) {
  const args = { api: null, item: null, email: "ryan.kolean@gmail.com" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remote") args.api = DEPLOYED_API;
    else if (arg === "--local") args.api = "http://127.0.0.1:8787";
    else if (arg === "--api") args.api = argv[++i];
    else if (arg === "--item") args.item = argv[++i];
    else if (arg === "--email") args.email = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (args.api === null || args.item === null) {
    console.error("--remote or --local, and --item <1password id>, are required.");
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

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
const headers = { authorization: `Bearer ${accessToken}` };
const get = async (path) => {
  const res = await fetch(`${args.api}${path}`, { headers });
  if (res.status !== 200) throw new Error(`${path} -> ${res.status}`);
  return res.json();
};

const { events } = await get("/events");
for (const event of events) {
  const gate = event.gate?.allowed ? "ready" : "blocked";
  console.log(`${event.coupleNames} (${event.eventDate}) gallery=${event.hasGalleryUrl ? "on file" : "none"} gate=${gate}`);
  const { images } = await get(`/events/${event.id}/images`);
  const { packages } = await get(`/events/${event.id}/packages`);
  console.log(`  pool: ${images.length} images, packages: ${packages.length}`);
  for (const pkg of packages) {
    const sub = pkg.submission ? `${pkg.submission.status}${pkg.submission.responseDueAt ? ` due ${pkg.submission.responseDueAt.slice(0, 10)}` : ""}` : "no submission";
    console.log(`    ${pkg.publicationName}: ${pkg.imageCount} images, ${pkg.complete ? "complete" : "incomplete"}, ${sub}`);
  }
}

const { submissions } = await get("/submissions");
console.log(`\nQueue: ${submissions.length} submission(s)`);
for (const s of submissions) {
  const days = s.daysRemaining === null ? "" : ` (${s.daysRemaining} days remaining)`;
  console.log(`  ${s.coupleNames} -> ${s.publicationName}: ${s.status}${s.sentAt ? ` sent ${s.sentAt.slice(0, 10)}` : ""}${days}`);
}
