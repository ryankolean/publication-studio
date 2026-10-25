import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { readGeo } from "../src/domain/geo.js";
import { rankOutlets } from "../src/domain/match.js";
import type { MatchOutlet } from "../src/domain/match.js";
import { matchProfile } from "../src/domain/research/project.js";
import { parseResearchVocab, validatePublicationFile } from "../src/domain/research/schema.js";
import type { TagCategory } from "../src/domain/tags.js";

/**
 * SUMMIT-336's acceptance check: the real 36 outlet files ranked for the
 * Blake & Anne Macon wedding as the tool knows it today. January 31, 2026,
 * a real wedding in the Florida Keys (from the drone photo's GPS; the
 * photographer confirms it in the app), no tags kept yet, nothing shared,
 * no history.
 */

const RESEARCH = join(dirname(fileURLToPath(import.meta.url)), "../../research");
const TODAY = "2026-10-24";
const yaml = (path: string): unknown => parse(readFileSync(join(RESEARCH, path), "utf8"));
const tagsRaw = yaml("vocab/tags.yaml") as Record<TagCategory, string[]>;
const geoRaw = yaml("vocab/geo.yaml");

function outlets(): MatchOutlet[] {
  const vocab = parseResearchVocab(tagsRaw, geoRaw);
  if (!vocab.ok) throw new Error("vocab");
  return readdirSync(join(RESEARCH, "publications"))
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => {
      const result = validatePublicationFile(yaml(`publications/${name}`), vocab.value, TODAY);
      if (!result.ok) throw new Error(name);
      const file = result.value;
      return {
        id: file.id,
        name: file.name,
        tier: file.tier,
        tags: file.content.style_tags.known ? file.content.style_tags.value : [],
        profile: matchProfile(file),
      };
    });
}

const all = outlets();
const ranked = rankOutlets(
  {
    id: "blake-anne",
    eventDate: "2026-01-31",
    locationCode: "US-FL:florida-keys",
    contentType: "real_wedding",
    isDestination: false,
    tags: [],
    exposures: [],
  },
  all,
  {
    today: TODAY,
    geo: readGeo(geoRaw),
    tagCategories: new Map(Object.entries(tagsRaw).flatMap(([category, ids]) => ids.map((id) => [id, category as TagCategory]))),
    profileTags: [],
    history: [],
  },
);
const group = (name: string) => ranked.filter((result) => result.group === name).map((result) => result.outletId);
const regionalOnly = (outlet: MatchOutlet) => {
  const regions = outlet.profile?.coverage.regions;
  return regions !== null && regions !== undefined && !regions.some((code) => ["WORLD", "US", "US-FL", "US:southeast"].includes(code));
};

describe("Blake & Anne: Florida Keys, January 31, 2026", () => {
  it("ranks all 36 outlets", () => {
    expect(all).toHaveLength(36);
    expect(ranked).toHaveLength(36);
  });

  it("rules out exactly the outlets that cover only somewhere else, by wedding location", () => {
    expect(group("excluded").sort()).toEqual([
      "pub-amelia-island-weddings",
      "pub-french-wedding-style",
      "pub-marry-me-tampa-bay",
      "pub-nearlywed",
    ]);
    for (const result of ranked.filter((entry) => entry.group === "excluded")) {
      expect(result.excluded).toHaveLength(1);
      expect(result.excluded[0]).toMatch(/^Covers only .+; this wedding was in Florida Keys, Florida\.$/);
    }
  });

  it("asks rather than excludes where coverage is unclear", () => {
    expect(group("check").sort()).toEqual(["pub-metro-detroit-weddings", "pub-offbeat-wed", "pub-people-weddings", "pub-vogue-weddings"]);
    expect(ranked.find((result) => result.outletId === "pub-metro-detroit-weddings")?.checks).toEqual([
      "Covers only Metro Detroit, Michigan, and does not say whether that means the wedding or the couple's home.",
    ]);
  });

  it("keeps every outlet that covers anywhere, and no regional outlet, in the best fits", () => {
    const fits = new Set(group("fits"));
    for (const outlet of all) {
      if (outlet.profile?.coverage.regions?.includes("WORLD")) expect(fits.has(outlet.id), outlet.id).toBe(true);
      if (regionalOnly(outlet)) expect(fits.has(outlet.id), outlet.id).toBe(false);
    }
    expect(fits.size).toBe(28);
  });

  it("orders the best fits by score, and calls none of them strong without style tags", () => {
    const scores = ranked.filter((result) => result.group === "fits").map((result) => result.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(ranked.every((result) => result.label !== "Strong match")).toBe(true);
    expect(ranked.every((result) => result.parts.find((part) => part.part === "style")?.unknown)).toBe(true);
  });

  it("excludes nothing for age: the wedding is inside every known freshness window it can still use", () => {
    expect(ranked.some((result) => result.excluded.some((line) => line.startsWith("Takes weddings up to")))).toBe(false);
  });
});
