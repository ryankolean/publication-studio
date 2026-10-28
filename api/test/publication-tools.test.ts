import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { readGeo } from "../src/domain/geo.js";
import type { MatchProfile, MatchResult } from "../src/domain/match.js";
import {
  factCard,
  filterOutlet,
  firstSentence,
  outletDetail,
  outletLine,
  publicationPage,
  rankPage,
  sharpenHints,
} from "../src/domain/publication-tools.js";
import type { CardOutlet } from "../src/domain/publication-tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const GEO = readGeo(parse(readFileSync(join(here, "../../research/vocab/geo.yaml"), "utf8")));
const TODAY = "2026-10-27";

const profile = (overrides: Partial<MatchProfile> = {}): MatchProfile => ({
  coverage: { regions: ["US:southeast"], basis: "wedding_location", destinationAccepted: true },
  content: { real_wedding: true, elopement: true, styled_shoot: false },
  seasons: "none",
  exclusivity: { policy: "exclusive_required", afterPublicationDays: 30 },
  exposure: { publications: "disqualifies", blogs: "allowed", social: "allowed" },
  freshnessMonths: 12,
  frequency: "none",
  fees: { submission: "none", publication: "none" },
  reach: { metric: "instagram_followers", value: 1_200_000 },
  ...overrides,
});

const outlet = (overrides: Partial<CardOutlet> = {}): CardOutlet => ({
  id: "pub-coastal",
  name: "Coastal Weddings",
  tier: "secondary",
  method: "web_form",
  submissionUrl: "https://coastal.example/submit",
  contactEmail: "editors@coastal.example",
  spec: {
    imgMin: 20,
    imgMax: 60,
    size: "web",
    watermarksAllowed: false,
    videoAccepted: true,
    videoNotes: null,
    requirements: ["no_watermarks", "some_new_rule"],
    notes: null,
  },
  exclusivityPolicy: "exclusive_required",
  typicalResponseDays: 30,
  responseWindowNote: "Replies only if selected.",
  earnedOrPaid: "earned",
  tasteNotes: "Sunny coastal weddings across the Southeast. Light and airy.",
  lastVerified: "2026-10-23",
  tags: ["southeast_us", "beach_coastal", "romantic"],
  matchProfile: profile(),
  ...overrides,
});

describe("firstSentence", () => {
  it.each([
    [null, null],
    ["   ", null],
    ["One. Two.", "One."],
    ["Is it? Yes.", "Is it?"],
    ["No full stop at all", "No full stop at all"],
    ["v1.2 release notes. More.", "v1.2 release notes."],
  ])("%j -> %j", (text, expected) => {
    expect(firstSentence(text)).toBe(expected);
  });
});

describe("outletLine", () => {
  it("is the id, name, tier and first sentence, flagging unresearched outlets and unsure filters", () => {
    expect(outletLine(outlet())).toEqual({ id: "pub-coastal", name: "Coastal Weddings", tier: "secondary", about: "Sunny coastal weddings across the Southeast." });
    expect(outletLine(outlet({ matchProfile: null, tasteNotes: null }), ["place"])).toEqual({
      id: "pub-coastal",
      name: "Coastal Weddings",
      tier: "secondary",
      about: null,
      unresearched: true,
      unsure: ["place"],
    });
  });
});

describe("outletLine about", () => {
  it("keeps a long first sentence to about a line", () => {
    const line = outletLine(outlet({ tasteNotes: `${"Long words ".repeat(30)}end. Second sentence.` }));
    expect(line.about?.length).toBeLessThanOrEqual(110);
    expect(line.about).toMatch(/\.\.\.$/);
  });
});

describe("factCard", () => {
  it("says every known fact in plain words", () => {
    expect(factCard(outlet(), GEO)).toEqual({
      id: "pub-coastal",
      name: "Coastal Weddings",
      tier: "secondary",
      about: "Sunny coastal weddings across the Southeast. Light and airy.",
      takes: "real weddings and elopements",
      where: "Southeast, by where the wedding was",
      send: "a form on its site",
      fees: "free to submit, no fee to be featured",
      exclusive: "wants it unpublished elsewhere, and holds it for 30 days after it runs",
      fresh: "weddings up to 12 months old",
      replies: "usually replies within 30 days",
      reach: "About 1.2 million Instagram followers",
      doesNotTake: "styled shoots",
      styles: ["southeast_us", "beach_coastal", "romantic"],
      checked: "2026-10-23",
    });
  });

  it("names what an unresearched outlet does not say, and keeps what its columns do", () => {
    const card = factCard(
      outlet({ matchProfile: null, method: null, typicalResponseDays: null, responseWindowNote: null, earnedOrPaid: "mixed", exclusivityPolicy: "unknown", tags: [] }),
      GEO,
    );
    expect(card).toEqual({
      id: "pub-coastal",
      name: "Coastal Weddings",
      tier: "secondary",
      about: "Sunny coastal weddings across the Southeast. Light and airy.",
      unresearched: true,
      unknown: ["takes", "where", "send", "fees", "exclusive", "fresh", "replies", "reach"],
      checked: "2026-10-23",
    });
  });

  it("words coverage, fees, exclusivity, freshness and replies in each of their forms", () => {
    const card = (overrides: Partial<CardOutlet>, profileOverrides: Partial<MatchProfile> = {}) =>
      factCard(outlet({ ...overrides, matchProfile: profile(profileOverrides) }), GEO);

    expect(card({}, { coverage: { regions: ["WORLD"], basis: "couple_home", destinationAccepted: null } }).where).toBe("Anywhere");
    expect(card({}, { coverage: { regions: ["US-FL", "US-MI"], basis: null, destinationAccepted: false } }).where).toBe(
      "Florida and Michigan, no destination weddings",
    );
    expect(card({}, { coverage: { regions: ["US-MI:detroit"], basis: "either", destinationAccepted: true } }).where).toBe(
      "Metro Detroit, Michigan, by where the wedding was or where the couple lives",
    );
    expect(factCard(outlet({ matchProfile: profile({ coverage: { regions: ["US-FL"], basis: "couple_home", destinationAccepted: null } }) }), null).where).toBe(
      "US-FL, by where the couple lives",
    );
    expect(card({}, { coverage: { regions: [], basis: null, destinationAccepted: null } }).where).toBe("");
    expect(card({}, { coverage: { regions: null, basis: null, destinationAccepted: null } }).unknown).toEqual(["where"]);

    expect(card({}, { content: { real_wedding: null, elopement: null, styled_shoot: null } })).not.toHaveProperty("doesNotTake");
    expect(card({}, { content: { real_wedding: false, elopement: null, styled_shoot: null } }).unknown).toEqual(["takes"]);

    expect(card({}, { fees: { submission: "some", publication: "some" } }).fees).toBe("charges to submit, paid placement");
    expect(card({ earnedOrPaid: "paid" }, { fees: { submission: null, publication: null } }).fees).toBe("paid placement");
    expect(card({ earnedOrPaid: "earned" }, { fees: { submission: null, publication: null } }).fees).toBe("no fee to be featured");
    expect(card({ earnedOrPaid: "mixed" }, { fees: { submission: null, publication: null } }).unknown).toEqual(["fees"]);

    expect(card({}, { exclusivity: { policy: "exclusive_preferred", afterPublicationDays: null } }).exclusive).toBe("prefers it unpublished elsewhere");
    expect(card({}, { exclusivity: { policy: "non_exclusive", afterPublicationDays: null } }).exclusive).toBe("does not need it to be exclusive");
    expect(card({ exclusivityPolicy: "exclusive_preferred" }, { exclusivity: null }).exclusive).toBe("prefers it unpublished elsewhere");
    expect(card({ exclusivityPolicy: "unknown" }, { exclusivity: null }).unknown).toEqual(["exclusive"]);

    expect(card({}, { freshnessMonths: "none" }).fresh).toBe("any age of wedding");
    expect(card({}, { freshnessMonths: null }).unknown).toEqual(["fresh"]);
    expect(card({}, { reach: null }).unknown).toEqual(["reach"]);

    expect(card({ typicalResponseDays: null }).replies).toBe("Replies only if selected.");
    expect(card({ typicalResponseDays: null, responseWindowNote: `${"Long note ".repeat(20)}end` }).replies).toMatch(/^Long note .*\.\.\.$/);
    expect(card({ method: "aggregator" }).send).toBe("a submission service such as Two Bright Lights");
  });

  it("keeps a long description short, even one with no spaces", () => {
    expect(factCard(outlet({ tasteNotes: `${"word ".repeat(100)}end` }), GEO).about?.length).toBeLessThanOrEqual(300);
    expect(factCard(outlet({ tasteNotes: "x".repeat(400) }), GEO).about).toBe(`${"x".repeat(297)}...`);
    expect(factCard(outlet({ tags: Array.from({ length: 12 }, (_, i) => `tag_${i}`) }), GEO).styles).toHaveLength(8);
  });
});

describe("outletDetail", () => {
  it("adds where to submit, every style, and the package in the checklist's words", () => {
    expect(outletDetail(outlet(), GEO)).toMatchObject({
      styles: ["southeast_us", "beach_coastal", "romantic"],
      submitAt: "https://coastal.example/submit",
      email: "editors@coastal.example",
      repliesNote: "Replies only if selected.",
      package: {
        images: "20 to 60",
        size: "web-size files",
        watermarks: "not allowed",
        video: "accepted",
        requirements: ["Confirm no image carries a watermark", "Some new rule"],
      },
    });
  });

  it("leaves out what the outlet does not say", () => {
    const bare = outlet({
      submissionUrl: null,
      contactEmail: null,
      responseWindowNote: null,
      spec: { imgMin: null, imgMax: null, size: "unknown", watermarksAllowed: null, videoAccepted: null, videoNotes: null, requirements: [], notes: null },
    });
    const detail = outletDetail(bare, GEO);
    expect(detail.package).toEqual({});
    expect(detail).not.toHaveProperty("submitAt");
    expect(detail).not.toHaveProperty("email");
    expect(detail).not.toHaveProperty("repliesNote");

    const spec = (imgMin: number | null, imgMax: number | null) =>
      outletDetail(outlet({ spec: { ...bare.spec, imgMin, imgMax, size: "print", watermarksAllowed: true, videoAccepted: false } }), GEO).package;
    expect(spec(10, null)).toEqual({ images: "at least 10", size: "print-size files", watermarks: "allowed", video: "not accepted" });
    expect(spec(null, 40).images).toBe("at most 40");
  });
});

describe("filterOutlet", () => {
  it("keeps everything with no filters", () => {
    expect(filterOutlet(outlet(), {}, GEO, TODAY)).toEqual([]);
  });

  it("filters by style, any of them", () => {
    expect(filterOutlet(outlet(), { styles: ["romantic", "bohemian"] }, GEO, TODAY)).toEqual([]);
    expect(filterOutlet(outlet(), { styles: ["bohemian"] }, GEO, TODAY)).toBe("no");
    expect(filterOutlet(outlet(), { styles: [] }, GEO, TODAY)).toEqual([]);
  });

  it("filters by kind, keeping an outlet that does not say and marking it unsure", () => {
    expect(filterOutlet(outlet(), { kind: "elopement" }, GEO, TODAY)).toEqual([]);
    expect(filterOutlet(outlet(), { kind: "styled_shoot" }, GEO, TODAY)).toBe("no");
    expect(filterOutlet(outlet({ matchProfile: null }), { kind: "styled_shoot" }, GEO, TODAY)).toEqual(["kind"]);
  });

  it("filters by place, covering it or covering part of it", () => {
    expect(filterOutlet(outlet(), { place: "US-FL:florida-keys" }, GEO, TODAY)).toEqual([]);
    expect(filterOutlet(outlet(), { place: "US-MI" }, GEO, TODAY)).toBe("no");
    const keysOnly = outlet({ matchProfile: profile({ coverage: { regions: ["US-FL:florida-keys"], basis: null, destinationAccepted: null } }) });
    expect(filterOutlet(keysOnly, { place: "US-FL" }, GEO, TODAY)).toEqual([]);
    expect(filterOutlet(outlet({ matchProfile: null }), { place: "US-FL" }, GEO, TODAY)).toEqual(["place"]);
    expect(filterOutlet(outlet(), { place: "US-FL" }, null, TODAY)).toEqual(["place"]);
  });

  it("filters by how recent the wedding is", () => {
    expect(filterOutlet(outlet(), { marriedOn: "2026-01-10" }, GEO, TODAY)).toEqual([]);
    expect(filterOutlet(outlet(), { marriedOn: "2025-01-10" }, GEO, TODAY)).toBe("no");
    expect(filterOutlet(outlet(), { marriedOn: "2025-11-05" }, GEO, TODAY)).toEqual([]);
    expect(filterOutlet(outlet(), { marriedOn: "2025-09-01" }, GEO, TODAY)).toBe("no");
    expect(filterOutlet(outlet({ matchProfile: profile({ freshnessMonths: "none" }) }), { marriedOn: "2020-01-10" }, GEO, TODAY)).toEqual([]);
    expect(filterOutlet(outlet({ matchProfile: null }), { marriedOn: "2020-01-10", kind: "elopement" }, GEO, TODAY)).toEqual(["kind", "married_on"]);
  });
});

describe("publicationPage", () => {
  const many = Array.from({ length: 12 }, (_, i) => outlet({ id: `pub-${i}`, name: `Outlet ${i}` }));

  it("pages the passing outlets ten at a time", () => {
    const first = publicationPage(many, {}, GEO, TODAY, undefined);
    expect(first).toMatchObject({ total: 12, next: "10" });
    expect("outlets" in first ? first.outlets.map((line) => line.id) : []).toHaveLength(10);
    const second = publicationPage(many, {}, GEO, TODAY, "10");
    expect(second).toMatchObject({ total: 12 });
    expect(second).not.toHaveProperty("next");
    expect(publicationPage([outlet(), outlet({ id: "pub-mi", tags: [] })], { styles: ["romantic"] }, GEO, TODAY, undefined)).toMatchObject({ total: 1 });
  });

  it("refuses a cursor it did not give", () => {
    expect(publicationPage(many, {}, GEO, TODAY, "abc")).toHaveProperty("error");
    expect(publicationPage(many, {}, GEO, TODAY, "13")).toHaveProperty("error");
  });
});

describe("rankPage", () => {
  const result = (id: string, group: MatchResult["group"], extra: Partial<MatchResult> = {}): MatchResult => ({
    outletId: id,
    group,
    score: 80,
    label: "Strong match",
    reasons: [],
    checks: [],
    excluded: [],
    deadline: null,
    parts: [],
    ...extra,
  });
  const names = new Map([
    ["a", { name: "A", tier: "primary" as const }],
    ["b", { name: "B", tier: "secondary" as const }],
    ["c", { name: "C", tier: "dream" as const }],
  ]);
  const ranked = [
    result("a", "fits", { reasons: ["Covers Florida."], deadline: "Closes soon." }),
    result("b", "check", { score: 55, label: "Worth a look", checks: ["Does not say its fees."] }),
    result("gone", "check"),
    result("c", "excluded", { excluded: ["Covers only Michigan."] }),
  ];

  it("shows the outlets she can send to, with why and what to check, and counts every group", () => {
    expect(rankPage(ranked, names, "open", undefined)).toEqual({
      counts: { fits: 1, check: 2, excluded: 1 },
      outlets: [
        { id: "a", name: "A", tier: "primary", match: "Strong match (80 of 100)", why: ["Covers Florida."], deadline: "Closes soon." },
        { id: "b", name: "B", tier: "secondary", match: "Worth a look (55 of 100)", check: ["Does not say its fees."] },
      ],
    });
  });

  it("shows the excluded ones with why on request", () => {
    expect(rankPage(ranked, names, "excluded", undefined)).toMatchObject({
      outlets: [{ id: "c", name: "C", tier: "dream", excluded: ["Covers only Michigan."] }],
    });
  });

  it("pages eight at a time and refuses a cursor it did not give", () => {
    const long = Array.from({ length: 10 }, (_, i) => result(`x${i}`, "fits"));
    const named = new Map(long.map((entry) => [entry.outletId, { name: entry.outletId, tier: "primary" as const }]));
    expect(rankPage(long, named, "open", undefined)).toMatchObject({ next: "8" });
    expect(rankPage(long, named, "open", "8")).not.toHaveProperty("next");
    expect(rankPage(long, named, "open", "x")).toHaveProperty("error");
    expect(rankPage(long, named, "open", "11")).toHaveProperty("error");
  });
});

describe("sharpenHints", () => {
  it("asks for the place and kept tags when the wedding has neither", () => {
    expect(sharpenHints({ locationCode: null, keptTags: 0 })).toHaveLength(2);
    expect(sharpenHints({ locationCode: "US-FL", keptTags: 3 })).toEqual([]);
  });
});
