import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { readGeo } from "../src/domain/geo.js";
import { matchOutlet, rankOutlets, validateExposures } from "../src/domain/match.js";
import type { HistoryEntry, MatchContext, MatchOutlet, MatchProfile, MatchWedding } from "../src/domain/match.js";
import { matchProfile } from "../src/domain/research/project.js";
import { parseResearchVocab, validatePublicationFile } from "../src/domain/research/schema.js";
import type { TagCategory } from "../src/domain/tags.js";

const here = dirname(fileURLToPath(import.meta.url));
const yaml = (path: string): unknown => parse(readFileSync(join(here, path), "utf8"));
const GEO_RAW = yaml("../../research/vocab/geo.yaml");
const TAGS_RAW = yaml("../../research/vocab/tags.yaml") as Record<TagCategory, string[]>;
const CATEGORIES = new Map(Object.entries(TAGS_RAW).flatMap(([category, ids]) => ids.map((id) => [id, category as TagCategory])));

const known = (overrides: Partial<MatchProfile> = {}): MatchProfile => ({
  coverage: { regions: ["WORLD"], basis: "wedding_location", destinationAccepted: true },
  content: { real_wedding: true, elopement: true, styled_shoot: true },
  seasons: "none",
  exclusivity: { policy: "non_exclusive", afterPublicationDays: null },
  exposure: { publications: "allowed", blogs: "allowed", social: "allowed" },
  freshnessMonths: 12,
  frequency: "none",
  fees: { submission: "none", publication: "none" },
  reach: { metric: "instagram_followers", value: 1_000_000 },
  ...overrides,
});

const unknownProfile: MatchProfile = {
  coverage: { regions: null, basis: null, destinationAccepted: null },
  content: { real_wedding: null, elopement: null, styled_shoot: null },
  seasons: null,
  exclusivity: null,
  exposure: { publications: null, blogs: null, social: null },
  freshnessMonths: null,
  frequency: null,
  fees: { submission: null, publication: null },
  reach: null,
};

const wedding = (overrides: Partial<MatchWedding> = {}): MatchWedding => ({
  id: "e1",
  eventDate: "2026-01-31",
  locationCode: "US-FL:florida-keys",
  contentType: "real_wedding",
  isDestination: false,
  tags: [],
  exposures: [],
  ...overrides,
});

const outlet = (id: string, profile: MatchProfile | null = known(), overrides: Partial<MatchOutlet> = {}): MatchOutlet => ({
  id,
  name: id.replace("pub-", "Outlet "),
  tier: "primary",
  tags: [],
  profile,
  ...overrides,
});

const context = (overrides: Partial<MatchContext> = {}): MatchContext => ({
  today: "2026-10-24",
  geo: readGeo(GEO_RAW),
  tagCategories: CATEGORIES,
  profileTags: [],
  history: [],
  ...overrides,
});

const match = (profile: MatchProfile | null, weddingOverrides: Partial<MatchWedding> = {}, contextOverrides: Partial<MatchContext> = {}) =>
  matchOutlet(wedding(weddingOverrides), outlet("pub-a", profile), context(contextOverrides));

const part = (result: ReturnType<typeof matchOutlet>, name: string) => result.parts.find((entry) => entry.part === name);

describe("hard filters: where it covers", () => {
  it("lets an outlet that covers anywhere through", () => {
    expect(match(known())).toMatchObject({ group: "fits", excluded: [], checks: [] });
  });

  it("excludes an outlet that covers only somewhere else, by wedding location", () => {
    const result = match(known({ coverage: { regions: ["US-MI"], basis: "wedding_location", destinationAccepted: true } }));
    expect(result.group).toBe("excluded");
    expect(result.excluded).toEqual(["Covers only Michigan; this wedding was in Florida Keys, Florida."]);
  });

  it("excludes a metro outlet elsewhere in the same state", () => {
    const result = match(known({ coverage: { regions: ["US-FL:tampa-bay"], basis: "wedding_location", destinationAccepted: true } }));
    expect(result.excluded).toEqual(["Covers only Tampa Bay, Florida; this wedding was in Florida Keys, Florida."]);
  });

  it("never excludes when it does not say whether coverage means the wedding or the couple's home", () => {
    const result = match(known({ coverage: { regions: ["US-MI"], basis: null, destinationAccepted: true } }));
    expect(result.group).toBe("check");
    expect(result.checks).toEqual(["Covers only Michigan, and does not say whether that means the wedding or the couple's home."]);
  });

  it("asks about the couple's home when that is what it goes by", () => {
    const result = match(known({ coverage: { regions: ["US-FL"], basis: "couple_home", destinationAccepted: true } }));
    expect(result.checks).toEqual(["Goes by where the couple lives: Florida. Check that they live there."]);
  });

  it("counts a state outlet as covering its metros, and as local", () => {
    const result = match(known({ coverage: { regions: ["US-FL"], basis: "wedding_location", destinationAccepted: true } }));
    expect(result.group).toBe("fits");
    expect(part(result, "local")).toMatchObject({ points: 10, note: "Covers Florida specifically." });
  });

  it("asks for the place, or the metro, when the wedding's is missing or too broad", () => {
    const michigan = known({ coverage: { regions: ["US-MI"], basis: "wedding_location", destinationAccepted: true } });
    expect(match(michigan, { locationCode: null }).checks).toEqual(["Covers only Michigan. Add where the wedding was to check."]);
    const detroit = known({ coverage: { regions: ["US-MI:detroit"], basis: "wedding_location", destinationAccepted: true } });
    expect(match(detroit, { locationCode: "US-MI" }).checks).toEqual(["Covers only Metro Detroit, Michigan. Pick the wedding's metro to check."]);
  });

  it("asks when it does not say where it covers", () => {
    expect(match(known({ coverage: { regions: null, basis: null, destinationAccepted: true } })).checks).toEqual([
      "Does not say which places it covers.",
    ]);
  });

  it("excludes a destination wedding only where destinations are known to be refused", () => {
    const refuses = known({ coverage: { regions: ["WORLD"], basis: null, destinationAccepted: false } });
    expect(match(refuses, { isDestination: true }).excluded).toEqual(["Does not take destination weddings."]);
    expect(match(refuses).group).toBe("fits");
    const silent = known({ coverage: { regions: ["WORLD"], basis: null, destinationAccepted: null } });
    expect(match(silent, { isDestination: true }).checks).toEqual(["Does not say whether it takes destination weddings."]);
  });
});

describe("hard filters: content, sharing and history", () => {
  it("excludes a kind of wedding it does not publish, and asks when unknown", () => {
    expect(match(known({ content: { real_wedding: true, elopement: false, styled_shoot: null } }), { contentType: "elopement" }).excluded).toEqual([
      "Does not publish elopements.",
    ]);
    expect(match(known({ content: { real_wedding: true, elopement: false, styled_shoot: null } }), { contentType: "styled_shoot" }).checks).toEqual([
      "Does not say whether it publishes styled shoots.",
    ]);
  });

  it("excludes on sharing it disqualifies, and names who shared it", () => {
    const strict = known({ exposure: { publications: "disqualifies", blogs: "allowed", social: "disqualifies" } });
    const result = match(strict, {
      exposures: [
        { channel: "couple_social", detail: null, publicationId: null },
        { channel: "vendor_social", detail: "the florist", publicationId: null },
      ],
    });
    expect(result.excluded).toEqual([
      "Takes only weddings not already shared on social media. This wedding was shared by the couple on social media and by a vendor on social media (the florist).",
    ]);
  });

  it("asks when only sneak peeks are allowed, or when the rule is unknown", () => {
    const peeks = known({ exposure: { publications: "allowed", blogs: null, social: "sneak_peeks_only" } });
    const result = match(peeks, {
      exposures: [
        { channel: "own_social", detail: null, publicationId: null },
        { channel: "own_blog", detail: null, publicationId: null },
      ],
    });
    expect(result.group).toBe("check");
    expect(result.checks).toEqual([
      "Allows only a few sneak peeks before it publishes. This wedding was shared on your social media. Check it was only a few photos.",
      "Does not say whether a wedding shared on a blog counts. This wedding was shared on your blog.",
    ]);
  });

  it("excludes the outlet that already ran it", () => {
    expect(match(known(), { exposures: [{ channel: "publication", detail: null, publicationId: "pub-a" }] }).excluded).toEqual([
      "Has already run this wedding.",
    ]);
  });

  it("excludes an outlet that declined or is featuring this wedding", () => {
    const declined: HistoryEntry = { publicationId: "pub-a", eventId: "e1", kind: "declined", at: "2026-05-01" };
    expect(match(known(), {}, { history: [declined] }).excluded).toEqual(["Declined this wedding."]);
    const featured: HistoryEntry = { publicationId: "pub-a", eventId: "e1", kind: "feature", at: "2026-05-01" };
    expect(match(known(), {}, { history: [featured] }).excluded).toEqual(["Is already featuring this wedding."]);
  });

  it("excludes every other outlet while one that published it holds it exclusively", () => {
    const holder = outlet("pub-b", known({ exclusivity: { policy: "exclusive_required", afterPublicationDays: 30 } }), { name: "Outlet B" });
    const others = new Map([["pub-b", holder]]);
    const recent = context({ history: [{ publicationId: "pub-b", eventId: "e1", kind: "feature", at: "2026-10-10" }] });
    expect(matchOutlet(wedding(), outlet("pub-a"), recent, others).excluded).toEqual([
      "Outlet B published this wedding and holds it exclusively until November 9, 2026.",
    ]);
    const old = context({ history: [{ publicationId: "pub-b", eventId: "e1", kind: "feature", at: "2026-08-01" }] });
    expect(matchOutlet(wedding(), outlet("pub-a"), old, others).group).toBe("fits");
  });
});

describe("hard filters: freshness and frequency", () => {
  it("excludes a wedding older than the window, and warns as the window closes", () => {
    expect(match(known({ freshnessMonths: 6 })).excluded).toEqual(["Takes weddings up to 6 months old; this one is 8 months old."]);
    const closing = match(known({ freshnessMonths: 9 }));
    expect(closing.group).toBe("fits");
    expect(closing.deadline).toBe("Its 9-month window for this wedding closes around November 1, 2026.");
    const elsewhere = known({ freshnessMonths: 9, coverage: { regions: ["US-MI"], basis: "wedding_location", destinationAccepted: true } });
    expect(match(elsewhere).deadline).toBeNull();
    expect(match(known({ freshnessMonths: 12 })).deadline).toBeNull();
  });

  it("asks about an unknown window only once a wedding is over a year old", () => {
    expect(match(known({ freshnessMonths: null })).checks).toEqual([]);
    expect(match(known({ freshnessMonths: null }), { eventDate: "2025-06-01" }).checks).toEqual([
      "Does not say how recent a wedding must be; this one is 16 months old.",
    ]);
  });

  it("excludes past its limit on features of the same photographer", () => {
    const history: HistoryEntry[] = [{ publicationId: "pub-a", eventId: "e9", kind: "feature", at: "2026-03" }];
    expect(match(known({ frequency: { max: 1, perMonths: 12 } }), {}, { history }).excluded).toEqual([
      "Features the same photographer at most 1 times in 12 months; you have 1.",
    ]);
    expect(match(known({ frequency: null }), {}, { history }).checks).toEqual([
      "Featured you in the last year, and does not say how often it features the same photographer.",
    ]);
  });

  it("puts an outlet with no research in check first, with one line", () => {
    expect(match(null)).toMatchObject({ group: "check", checks: ["Not researched yet: its coverage, rules and fees are unknown."] });
  });
});

describe("soft scores", () => {
  it("gives every unknown part half its points, and says so", () => {
    const result = match(unknownProfile, { locationCode: null });
    expect(result.parts.filter((entry) => entry.part !== "relationship").every((entry) => entry.unknown)).toBe(true);
    expect(result.score).toBe(50);
    expect(result.label).toBe("Worth a look");
  });

  it("scores style from the wedding's own tags, else her profile", () => {
    const tagged = matchOutlet(wedding({ tags: ["romantic", "lakefront", "winter"] }), outlet("pub-a", known(), { tags: ["romantic"] }), context());
    expect(part(tagged, "style")).toMatchObject({ points: 17.5, note: "Shares Romantic.", unknown: false });
    const fromProfile = matchOutlet(wedding(), outlet("pub-a", known(), { tags: ["romantic", "lakefront"] }), context({ profileTags: ["romantic", "lakefront"] }));
    expect(part(fromProfile, "style")).toMatchObject({ points: 35, note: "From your style profile: Shares Romantic and Lakefront." });
    expect(part(match(known()), "style")).toMatchObject({ points: 17.5, unknown: true });
  });

  it("raises the relationship with features and lowers it with declines and silence", () => {
    const history = (kinds: HistoryEntry["kind"][]): HistoryEntry[] =>
      kinds.map((kind, index) => ({ publicationId: "pub-a", eventId: `x${index}`, kind, at: "2026-06-01" }));
    expect(part(match(known()), "relationship")).toMatchObject({ points: 10, note: "No history with you yet." });
    expect(part(match(known(), {}, { history: history(["feature", "accepted"]) }), "relationship")).toMatchObject({
      points: 20,
      note: "Featured or accepted your work 2 times.",
    });
    expect(part(match(known(), {}, { history: history(["declined", "no_reply"]) }), "relationship")?.points).toBe(6);
  });

  it("scores reach on a log scale and fees by who pays", () => {
    expect(part(match(known({ reach: { metric: "monthly_visitors", value: 10_000 } })), "reach")?.points).toBe(0);
    expect(part(match(known({ reach: { metric: "instagram_followers", value: 4_000_000 } })), "reach")).toMatchObject({
      points: 15,
      note: "About 4 million Instagram followers.",
    });
    expect(part(match(known({ fees: { submission: "none", publication: "some" } })), "fees")).toMatchObject({ points: 7.5, note: "Charges to publish." });
    expect(part(match(known()), "fees")).toMatchObject({ points: 15, note: "Free to submit and publish." });
  });

  it("scores the season against what it asks for", () => {
    expect(part(match(known({ seasons: ["winter"] })), "season")?.points).toBe(5);
    expect(part(match(known({ seasons: ["spring"] })), "season")?.points).toBe(1);
  });

  it("names a national outlet as such, and rewards one that tags the wedding's region", () => {
    expect(part(match(known()), "local")).toMatchObject({ points: 0, note: "A national or international outlet." });
    const tagged = matchOutlet(wedding(), outlet("pub-a", known(), { tags: ["florida"] }), context());
    expect(part(tagged, "local")).toMatchObject({ points: 10, note: "Features Florida weddings." });
  });

  it("labels the total and lists the strongest known parts as reasons", () => {
    const strong = matchOutlet(
      wedding({ tags: ["romantic"] }),
      outlet("pub-a", known({ coverage: { regions: ["US-FL"], basis: "wedding_location", destinationAccepted: true } }), { tags: ["romantic"] }),
      context(),
    );
    expect(strong.label).toBe("Strong match");
    expect(strong.reasons).toEqual(["Shares Romantic.", "Free to submit and publish.", "About 1 million Instagram followers."]);
  });
});

describe("rankOutlets", () => {
  it("lists fits, then check first, then excluded, best score first, then tier and name", () => {
    const ranked = rankOutlets(
      wedding(),
      [
        outlet("pub-excluded", known({ freshnessMonths: 3 })),
        outlet("pub-check", null),
        outlet("pub-small", known({ reach: { metric: "monthly_visitors", value: 20_000 } })),
        outlet("pub-dream", known(), { tier: "dream" }),
        outlet("pub-big", known()),
      ],
      context(),
    );
    expect(ranked.map((result) => [result.outletId, result.group])).toEqual([
      ["pub-big", "fits"],
      ["pub-dream", "fits"],
      ["pub-small", "fits"],
      ["pub-check", "check"],
      ["pub-excluded", "excluded"],
    ]);
  });
});

describe("matchProfile", () => {
  it("projects the matching facts of a research file, unknown as null", () => {
    const vocab = parseResearchVocab(TAGS_RAW, GEO_RAW);
    if (!vocab.ok) throw new Error("vocab");
    const file = validatePublicationFile(yaml("fixtures/research/pub-example-weddings.yaml"), vocab.value, "2026-10-24");
    if (!file.ok) throw new Error(JSON.stringify(file.errors));
    expect(matchProfile(file.value)).toEqual({
      coverage: { regions: ["US-MI", "US:midwest"], basis: "wedding_location", destinationAccepted: false },
      content: { real_wedding: true, elopement: true, styled_shoot: null },
      seasons: ["winter", "holiday_season"],
      exclusivity: { policy: "exclusive_required", afterPublicationDays: 30 },
      exposure: { publications: "disqualifies", blogs: "allowed", social: "sneak_peeks_only" },
      freshnessMonths: 12,
      frequency: null,
      fees: { submission: "none", publication: "none" },
      reach: { metric: "instagram_followers", value: 85000 },
    });
  });
});

describe("validateExposures", () => {
  it("accepts the places she ticked, trimmed", () => {
    expect(
      validateExposures({
        exposures: [
          { channel: "couple_social" },
          { channel: "publication", detail: " Old Blog ", publicationId: "pub-x" },
        ],
      }),
    ).toEqual({
      ok: true,
      value: [
        { channel: "couple_social", detail: null, publicationId: null },
        { channel: "publication", detail: "Old Blog", publicationId: "pub-x" },
      ],
    });
  });

  it("names each problem", () => {
    const result = validateExposures({
      exposures: [{ channel: "tv" }, { channel: "own_blog", publicationId: "pub-x" }, { channel: "vendor_social", detail: "d".repeat(121) }],
    });
    expect(result.ok ? [] : result.errors.map((error) => error.field)).toEqual([
      "exposures.0.channel",
      "exposures.1.publicationId",
      "exposures.2.detail",
    ]);
    expect(validateExposures({})).toMatchObject({ ok: false });
  });
});
