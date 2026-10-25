/**
 * Loads the research files into the app (SUMMIT-335), through the real API.
 *
 *   npm run research:import --workspace @publication-studio/api -- --local
 *   npm run research:import --workspace @publication-studio/api -- --remote
 *   ... -- --local --only pub-brides,pub-the-knot
 *
 * Sends research/vocab first, then every file in research/publications with
 * its private contacts from ../publication-studio-private/research/contacts
 * (next to this checkout; never committed). Each changed outlet becomes a
 * pending revision that a person approves in the app; nothing goes live here.
 * An unchanged outlet is skipped, so re-running is safe.
 *
 * Signs in as the operator with the credentials in the 1Password item
 * "Publication Studio (dev)" (vault Dev Secrets), which the import reads
 * directly; nothing is printed or passed as an argument. Checks every file
 * locally first and sends nothing if any fails.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { checkResearchSet, parseResearchVocab, validatePublicationFile } from "../src/domain/research/schema.js";
import type { PublicationFile } from "../src/domain/research/schema.js";
import { parseContacts } from "../src/domain/research/contacts.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const RESEARCH = join(REPO, "research");
const CONTACTS = join(REPO, "../publication-studio-private/research/contacts");
const DEPLOYED_API = "https://publication-studio-api.ryan-kolean.workers.dev";
const VAULT = "Dev Secrets";
const ITEM = "Publication Studio (dev)";

function parseArgs(argv: string[]) {
  const args: { api: string | null; only: string[] | null; item: string } = { api: null, only: null, item: ITEM };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--remote") args.api = DEPLOYED_API;
    else if (arg === "--local") args.api = "http://127.0.0.1:8787";
    else if (arg === "--api") args.api = argv[++i] ?? null;
    else if (arg === "--only") args.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--item") args.item = argv[++i] ?? ITEM;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (args.api === null) {
    console.error("Pass --local, --remote or --api <url>.");
    process.exit(1);
  }
  return args as { api: string; only: string[] | null; item: string };
}

const args = parseArgs(process.argv.slice(2));
const loadYaml = (path: string): unknown => parse(readFileSync(path, "utf8"));
const today = new Date().toISOString().slice(0, 10);

// 1. Check everything locally before sending anything.
const tags = loadYaml(join(RESEARCH, "vocab/tags.yaml"));
const geo = loadYaml(join(RESEARCH, "vocab/geo.yaml"));
const vocab = parseResearchVocab(tags, geo);
if (!vocab.ok) {
  for (const error of vocab.errors) console.error(`${error.field}: ${error.message}`);
  process.exit(1);
}

const names = readdirSync(join(RESEARCH, "publications"))
  .filter((name) => name.endsWith(".yaml"))
  .sort();
const outlets: Array<{ fileName: string; raw: unknown; file: PublicationFile; contacts: unknown }> = [];
let failed = false;
for (const fileName of names) {
  const raw = loadYaml(join(RESEARCH, "publications", fileName));
  const result = validatePublicationFile(raw, vocab.value, today);
  if (!result.ok) {
    failed = true;
    for (const error of result.errors) console.error(`${fileName}: ${error.field}: ${error.message}`);
    continue;
  }
  const contactsPath = join(CONTACTS, fileName);
  const contacts = existsSync(contactsPath) ? loadYaml(contactsPath) : null;
  if (contacts !== null) {
    const parsed = parseContacts(contacts, today);
    if (!parsed.ok) {
      failed = true;
      for (const error of parsed.errors) console.error(`contacts/${fileName}: ${error.field}: ${error.message}`);
    }
  }
  outlets.push({ fileName, raw, file: result.value, contacts });
}
for (const error of checkResearchSet(outlets)) {
  failed = true;
  console.error(`${error.field}: ${error.message}`);
}
if (failed) {
  console.error("Nothing was sent.");
  process.exit(1);
}
const selected = args.only === null ? outlets : outlets.filter((outlet) => args.only?.includes(outlet.file.id));
if (args.only !== null && selected.length !== args.only.length) {
  console.error(`No research file for: ${args.only.filter((id) => !selected.some((o) => o.file.id === id)).join(", ")}`);
  process.exit(1);
}

// 2. Sign in as the operator; the credentials never leave 1Password and this process.
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
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

// 3. The vocabulary, then each outlet.
const vocabRes = await fetch(`${args.api}/research/vocab`, { method: "PUT", headers, body: JSON.stringify({ tags, geo }) });
if (vocabRes.status !== 200) {
  console.error(`Loading the vocabulary failed (${vocabRes.status}): ${await vocabRes.text()}`);
  process.exit(1);
}
console.log("Vocabulary loaded.");

let gitSha: string | null = null;
try {
  gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
} catch {
  gitSha = null;
}

const counts: Record<string, number> = {};
for (const outlet of selected) {
  const res = await fetch(`${args.api}/research/revisions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ file: outlet.raw, contacts: outlet.contacts, git_sha: gitSha }),
  });
  if (res.status !== 200 && res.status !== 201) {
    failed = true;
    console.error(`${outlet.fileName}: failed (${res.status}): ${await res.text()}`);
    continue;
  }
  const { status } = (await res.json()) as { status: string };
  counts[status] = (counts[status] ?? 0) + 1;
  console.log(`${outlet.file.id}: ${status}`);
}

// Outlets approved before a projected column existed get it filled in, a few per call.
for (;;) {
  const res = await fetch(`${args.api}/research/reproject`, { method: "POST", headers, body: "{}" });
  if (res.status !== 200) {
    failed = true;
    console.error(`Refreshing approved outlets failed (${res.status}).`);
    break;
  }
  const { reprojected, remaining } = (await res.json()) as { reprojected: number; remaining: number };
  if (reprojected > 0) console.log(`Refreshed ${reprojected} approved outlet(s); ${remaining} to go.`);
  if (remaining === 0 || reprojected === 0) break;
}

console.log(
  `${selected.length} outlet(s): ${Object.entries(counts)
    .map(([status, n]) => `${n} ${status}`)
    .join(", ")}. Pending research waits for approval in the app.`,
);
process.exit(failed ? 1 : 0);
