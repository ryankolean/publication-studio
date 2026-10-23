/**
 * Checks publication research files against the schema, the way CI does.
 *
 *   npm run research:check --workspace @publication-studio/api
 *   npm run research:check --workspace @publication-studio/api -- /path/to/pub-x.yaml ...
 *
 * With no arguments it checks every file in research/publications. With file
 * arguments it checks those, wherever they are, together with the files
 * already in research/publications, so a draft can be checked before it is
 * moved into the repo. Exits 1 if anything fails.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { checkResearchSet, parseResearchVocab, validatePublicationFile } from "../src/domain/research/schema.js";
import type { PublicationFile } from "../src/domain/research/schema.js";

const RESEARCH_DIR = fileURLToPath(new URL("../../research/", import.meta.url));
const PUBLICATIONS_DIR = join(RESEARCH_DIR, "publications");

const loadYaml = (path: string): unknown => parse(readFileSync(path, "utf8"));

const vocab = parseResearchVocab(
  loadYaml(join(RESEARCH_DIR, "vocab/tags.yaml")),
  loadYaml(join(RESEARCH_DIR, "vocab/geo.yaml")),
);
if (!vocab.ok) {
  for (const error of vocab.errors) console.error(`${error.field}: ${error.message}`);
  process.exit(1);
}

const inRepo = readdirSync(PUBLICATIONS_DIR)
  .filter((name) => name.endsWith(".yaml"))
  .map((name) => join(PUBLICATIONS_DIR, name));
const named = process.argv.slice(2).filter((arg) => arg !== "--").map((arg) => resolve(arg));

// A named file stands in for the repo file of the same name.
const byName = new Map<string, string>();
for (const path of [...inRepo, ...named]) byName.set(basename(path), path);
const toCheck = named.length > 0 ? named : inRepo;

const today = new Date().toISOString().slice(0, 10);
const valid: Array<{ fileName: string; file: PublicationFile }> = [];
let failed = false;

for (const [fileName, path] of byName) {
  let raw: unknown;
  try {
    raw = loadYaml(path);
  } catch (error) {
    if (toCheck.includes(path)) {
      console.error(`${fileName}: not valid YAML: ${(error as Error).message}`);
      failed = true;
    }
    continue;
  }
  const result = validatePublicationFile(raw, vocab.value, today);
  if (result.ok) {
    valid.push({ fileName, file: result.value });
  } else if (toCheck.includes(path)) {
    failed = true;
    for (const error of result.errors) console.error(`${fileName}: ${error.field}: ${error.message}`);
  }
}

for (const error of checkResearchSet(valid)) {
  const fileName = error.field.split(":")[0] ?? "";
  if (toCheck.includes(byName.get(fileName) ?? "")) {
    failed = true;
    console.error(`${error.field}: ${error.message}`);
  }
}

const passed = toCheck.filter((path) => valid.some(({ fileName }) => byName.get(fileName) === path)).length;
console.log(`${passed} of ${toCheck.length} file(s) pass.`);
process.exit(failed ? 1 : 0);
