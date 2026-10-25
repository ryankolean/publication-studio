/**
 * Ranks the outlets in research/publications for one wedding, from the
 * research files alone (SUMMIT-336), so a ranking can be reviewed before
 * the research is approved in the app.
 *
 *   npm run match:report --workspace @publication-studio/api -- \
 *     --date 2026-01-31 --location US-FL:florida-keys [--type real_wedding] \
 *     [--tags romantic,beach_coastal] [--today 2026-10-24] [--destination]
 *
 * Reads no database and no wedding record: pass the wedding's facts. Her
 * history and profile are not included, so the relationship part is neutral.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { readGeo } from "../src/domain/geo.js";
import { rankOutlets } from "../src/domain/match.js";
import type { ContentType, MatchOutlet, MatchWedding } from "../src/domain/match.js";
import { matchProfile } from "../src/domain/research/project.js";
import { parseResearchVocab, validatePublicationFile } from "../src/domain/research/schema.js";
import type { TagCategory } from "../src/domain/tags.js";

const RESEARCH = fileURLToPath(new URL("../../research/", import.meta.url));

function parseArgs(argv: string[]) {
  const args = { date: "", location: null as string | null, type: "real_wedding" as ContentType, tags: [] as string[], today: new Date().toISOString().slice(0, 10), destination: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--date") args.date = argv[++i] ?? "";
    else if (arg === "--location") args.location = argv[++i] ?? null;
    else if (arg === "--type") args.type = (argv[++i] ?? "real_wedding") as ContentType;
    else if (arg === "--tags") args.tags = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--today") args.today = argv[++i] ?? args.today;
    else if (arg === "--destination") args.destination = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (args.date === "") {
    console.error("Pass --date YYYY-MM-DD.");
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const yaml = (path: string): unknown => parse(readFileSync(join(RESEARCH, path), "utf8"));
const tagsRaw = yaml("vocab/tags.yaml") as Record<TagCategory, string[]>;
const geoRaw = yaml("vocab/geo.yaml");
const vocab = parseResearchVocab(tagsRaw, geoRaw);
if (!vocab.ok) throw new Error("The research vocabulary does not validate.");

const outlets: MatchOutlet[] = readdirSync(join(RESEARCH, "publications"))
  .filter((name) => name.endsWith(".yaml"))
  .map((name) => {
    const result = validatePublicationFile(yaml(`publications/${name}`), vocab.value, args.today);
    if (!result.ok) throw new Error(`${name} does not validate; run research:check.`);
    const file = result.value;
    return {
      id: file.id,
      name: file.name,
      tier: file.tier,
      tags: file.content.style_tags.known ? file.content.style_tags.value : [],
      profile: matchProfile(file),
    };
  });

const wedding: MatchWedding = {
  id: "report",
  eventDate: args.date,
  locationCode: args.location,
  contentType: args.type,
  isDestination: args.destination,
  tags: args.tags,
  exposures: [],
};
const ranked = rankOutlets(wedding, outlets, {
  today: args.today,
  geo: readGeo(geoRaw),
  tagCategories: new Map(Object.entries(tagsRaw).flatMap(([category, ids]) => ids.map((id) => [id, category as TagCategory]))),
  profileTags: [],
  history: [],
});

const names = new Map(outlets.map((outlet) => [outlet.id, outlet.name]));
let group = "";
for (const [index, result] of ranked.entries()) {
  if (result.group !== group) {
    group = result.group;
    console.log(`\n## ${{ fits: "Best fits", check: "Check first", excluded: "Not for this wedding" }[group]}`);
  }
  const why = result.group === "excluded" ? result.excluded : [...result.reasons, ...result.checks.map((line) => `Check: ${line}`)];
  console.log(`${index + 1}. ${names.get(result.outletId)} - ${result.score} (${result.label})${result.deadline === null ? "" : ` - ${result.deadline}`}`);
  for (const line of why) console.log(`   - ${line}`);
}
