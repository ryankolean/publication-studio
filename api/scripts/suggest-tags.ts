/**
 * Loads suggested tags for one wedding (SUMMIT-337), through the real API.
 *
 *   npm run style:suggest --workspace @publication-studio/api -- --local --file <path>
 *   npm run style:suggest --workspace @publication-studio/api -- --remote --file <path>
 *
 * The tool calls no AI service. Suggestions worked out from a wedding's
 * photos outside it go in a YAML file kept next to the private research
 * contacts, never in this public repo:
 *
 *   ../publication-studio-private/style/<wedding>.yaml
 *
 *   event: <the wedding's id>
 *   tags:
 *     - tag: lakefront
 *       confidence: high        # high, medium or low
 *       reason: "Photos 3 and 7: dock on the lake."
 *
 * The server checks every tag against the vocabulary and writes nothing if
 * any fails. The set replaces the operator's earlier suggestions for that
 * wedding; tags the photographer has already answered stay as she left them,
 * and she sees the rest on the wedding's Look step.
 *
 * Signs in as the operator with the credentials in the 1Password item
 * "Publication Studio (dev)" (vault Dev Secrets), as the research import does.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const DEPLOYED_API = "https://publication-studio-api.ryan-kolean.workers.dev";
const VAULT = "Dev Secrets";
const ITEM = "Publication Studio (dev)";

function parseArgs(argv: string[]) {
  const args: { api: string | null; file: string | null; item: string } = { api: null, file: null, item: ITEM };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--remote") args.api = DEPLOYED_API;
    else if (arg === "--local") args.api = "http://127.0.0.1:8787";
    else if (arg === "--api") args.api = argv[++i] ?? null;
    else if (arg === "--file") args.file = argv[++i] ?? null;
    else if (arg === "--item") args.item = argv[++i] ?? ITEM;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (args.api === null || args.file === null) {
    console.error("Pass --local, --remote or --api <url>, and --file <suggestions.yaml>.");
    process.exit(1);
  }
  return args as { api: string; file: string; item: string };
}

const args = parseArgs(process.argv.slice(2));
const raw = parse(readFileSync(args.file, "utf8")) as { event?: unknown; tags?: unknown } | null;
if (typeof raw?.event !== "string" || raw.event === "") {
  console.error(`${args.file}: name the wedding with "event: <id>".`);
  process.exit(1);
}

// The credentials never leave 1Password and this process.
const op = (opArgs: string[]) => execFileSync("op", opArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Two reads: a generated password may contain a comma, which a combined CSV read would split.
const email = op(["item", "get", args.item, "--vault", VAULT, "--fields", "username"]);
const password = op(["item", "get", args.item, "--vault", VAULT, "--fields", "password", "--reveal"]);
const login = await fetch(`${args.api}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (login.status !== 200) {
  console.error(`Sign-in failed (${login.status}).`);
  process.exit(1);
}
const { access_token: token } = (await login.json()) as { access_token: string };

const res = await fetch(`${args.api}/style/events/${encodeURIComponent(raw.event)}/suggestions`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ tags: raw.tags }),
});
const body = (await res.json()) as {
  message?: string;
  details?: Array<{ field: string; message: string }>;
  written?: number;
  dropped?: number;
  alreadyAnswered?: number;
};
if (res.status !== 200) {
  console.error(`Not loaded (${res.status}): ${body.message ?? "unknown error"}`);
  for (const detail of body.details ?? []) console.error(`  ${detail.field}: ${detail.message}`);
  process.exit(1);
}
console.log(
  `Loaded: ${body.written} suggested, ${body.dropped} earlier suggestions dropped, ${body.alreadyAnswered} already answered by the photographer.`,
);
