import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  checkResearchSet,
  parseResearchVocab,
  validatePublicationFile,
} from "../src/domain/research/schema.js";
import type { PublicationFile, ResearchVocab } from "../src/domain/research/schema.js";
import type { FieldError } from "../src/domain/event-intake.js";

const here = dirname(fileURLToPath(import.meta.url));
const VOCAB_DIR = join(here, "../../research/vocab");
const FIXTURE = join(here, "fixtures/research/pub-example-weddings.yaml");

const TODAY = "2026-10-23";

const loadYaml = (path: string): unknown => parse(readFileSync(path, "utf8"));

const rawTags = () => loadYaml(join(VOCAB_DIR, "tags.yaml")) as Record<string, unknown>;
const rawGeo = () => loadYaml(join(VOCAB_DIR, "geo.yaml")) as Record<string, any>;

function vocab(): ResearchVocab {
  const result = parseResearchVocab(rawTags(), rawGeo());
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

/** A fresh copy of the fixture, as plain data, for each test to change. */
const fixture = (): Record<string, any> => loadYaml(FIXTURE) as Record<string, any>;

function validate(raw: unknown) {
  return validatePublicationFile(raw, vocab(), TODAY);
}

function errorsFor(change: (file: Record<string, any>) => void): FieldError[] {
  const file = fixture();
  change(file);
  const result = validate(file);
  if (result.ok) throw new Error("expected the changed file to be rejected");
  return result.errors;
}

function parsed(): PublicationFile {
  const result = validate(fixture());
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.value;
}

describe("a complete research file", () => {
  it("validates", () => {
    expect(validate(fixture())).toMatchObject({ ok: true });
  });

  it("marks found facts known and keeps their cites", () => {
    expect(parsed().content.real_wedding).toEqual({
      known: true,
      value: true,
      cite: [{ source: "guidelines", quote: "We publish real weddings year round." }],
      note: null,
    });
  });

  it("keeps an unknown fact apart from a known no, with the pages that were read", () => {
    expect(parsed().content.styled_shoot).toEqual({
      known: false,
      checked: ["guidelines", "form"],
      note: "The form has a styled shoot option but the guidelines never mention them.",
    });
    expect(parsed().coverage.destination_accepted).toMatchObject({ known: true, value: false });
  });

  it("reads none as a stated absence, not as unknown", () => {
    expect(parsed().package.image_max).toMatchObject({ known: true, value: "none" });
    expect(parsed().economics.submission_fee).toMatchObject({ known: true, value: "none" });
  });

  it("lets a feature source stand without a quote", () => {
    expect(parsed().content.style_tags).toMatchObject({
      known: true,
      cite: [{ source: "feature_lake", quote: null }],
    });
  });

  it("fills optional fields it was not given with null", () => {
    expect(parsed().notes).toBeNull();
    const [, email] = (parsed().routes as { known: true; value: Array<Record<string, unknown>> }).value;
    expect(email).toMatchObject({ platform: "email", url: null, preferred: null, account_required: "unknown" });
  });

  it("accepts a country code from the vocabulary", () => {
    const file = fixture();
    file["coverage"].regions.value = ["IT", "WORLD"];
    expect(validate(file)).toMatchObject({ ok: true });
  });
});

describe("rejecting a file", () => {
  const cases: Array<[string, (file: Record<string, any>) => void, string, RegExp]> = [
    ["a missing fact, pointing at value: unknown", (f) => delete f["rules"].freshness_window_months, "rules.freshness_window_months", /value: unknown/],
    ["a missing plain field", (f) => delete f["name"], "name", /^Missing\.$/],
    ["an unknown field", (f) => (f["extra"] = 1), "extra", /Unknown field/],
    ["a fact written as a bare value", (f) => (f["content"].real_wedding = true), "content.real_wedding", /value and cite/],
    ["a fact with no value", (f) => delete f["content"].real_wedding.value, "content.real_wedding.value", /needs a value/],
    ["a blank fact value", (f) => (f["content"].real_wedding.value = null), "content.real_wedding.value", /true or false/],
    ["a stray key on a fact", (f) => (f["content"].real_wedding.source = "x"), "content.real_wedding.source", /Unknown field/],
    ["an unknown fact that cites", (f) => (f["content"].styled_shoot.cite = [{ source: "form", quote: "x" }]), "content.styled_shoot.cite", /checked/],
    ["an unknown fact that names no pages", (f) => delete f["content"].styled_shoot.checked, "content.styled_shoot.checked", /pages/],
    ["an empty checked list", (f) => (f["content"].styled_shoot.checked = []), "content.styled_shoot.checked", /at least 1/],
    ["checked on a known fact", (f) => (f["content"].real_wedding.checked = ["form"]), "content.real_wedding.checked", /only for value: unknown/],
    ["a known fact without a cite", (f) => delete f["content"].real_wedding.cite, "content.real_wedding.cite", /at least one cite/],
    ["a cite of a source that is not listed", (f) => (f["content"].real_wedding.cite[0].source = "nowhere"), "content.real_wedding.cite[0].source", /No source named nowhere/],
    ["a checked page that is not listed", (f) => (f["content"].styled_shoot.checked = ["nowhere"]), "content.styled_shoot.checked[0]", /No source named nowhere/],
    ["a quote missing from a non-feature cite", (f) => delete f["content"].real_wedding.cite[0].quote, "content.real_wedding.cite[0].quote", /needs a quote/],
    ["a blank quote", (f) => (f["content"].real_wedding.cite[0].quote = " "), "content.real_wedding.cite[0].quote", /blank/],
    ["a quote over 25 words", (f) => (f["content"].real_wedding.cite[0].quote = Array(26).fill("word").join(" ")), "content.real_wedding.cite[0].quote", /25 words/],
    ["a blank note", (f) => (f["content"].styled_shoot.note = "  "), "content.styled_shoot.note", /blank/],
    ["a source nothing cites", (f) => (f["sources"].spare = { url: "https://example.com/x", read: "2026-10-20", kind: "other" }), "sources.spare", /never cited/],
    ["a source that is not a web address", (f) => (f["sources"].about.url = "javascript:alert(1)"), "sources.about.url", /http or https/],
    ["a source read after today", (f) => (f["sources"].about.read = "2026-10-24"), "sources.about.read", /after today/],
    ["a source with an impossible read date", (f) => (f["sources"].about.read = "2026-02-30"), "sources.about.read", /YYYY-MM-DD/],
    ["a source id that is not snake case", (f) => (f["sources"]["Bad-Id"] = f["sources"].about), "sources.Bad-Id", /lowercase/],
    ["a source of an unlisted kind", (f) => (f["sources"].about.kind = "rumor"), "sources.about.kind", /Expected one of/],
    ["sources that are not a mapping", (f) => (f["sources"] = []), "sources", /mapping/],
    ["an id outside the pub- pattern", (f) => (f["id"] = "Example"), "id", /pub-/],
    ["a kind outside the list", (f) => (f["kind"] = "newspaper"), "kind", /Expected one of/],
    ["blank text", (f) => (f["name"] = "   "), "name", /blank/],
    ["text that is not text", (f) => (f["name"] = 7), "name", /Expected text/],
    ["a recheck interval that is not a whole number", (f) => (f["recheck_every_days"] = 2.5), "recheck_every_days", /whole number/],
    ["a recheck interval below one", (f) => (f["recheck_every_days"] = 0), "recheck_every_days", /at least 1/],
    ["a tag outside the vocabulary", (f) => (f["content"].style_tags.value = ["lakefront", "sparkly"]), "content.style_tags.value[1]", /tags\.yaml/],
    ["a tag listed twice", (f) => (f["content"].style_tags.value = ["lakefront", "lakefront"]), "content.style_tags.value[1]", /twice/],
    ["a list that is not a list", (f) => (f["content"].style_tags.value = "lakefront"), "content.style_tags.value", /Expected a list/],
    ["a location outside the vocabulary", (f) => (f["coverage"].regions.value = ["US-MI:mackinac"]), "coverage.regions.value[0]", /geo\.yaml/],
    ["a location that is not text", (f) => (f["coverage"].regions.value = [1]), "coverage.regions.value[0]", /geo\.yaml/],
    ["a season window wanting a non-season tag", (f) => (f["content"].seasonality.value[0].wants = ["lakefront"]), "content.seasonality.value[0].wants[0]", /season tag/],
    ["a submit month past December", (f) => (f["content"].seasonality.value[0].submit_months = [13]), "content.seasonality.value[0].submit_months[0]", /1 to 12/],
    ["none where none is not allowed", (f) => (f["package"].watermarks_allowed.value = "none"), "package.watermarks_allowed.value", /true or false/],
    ["a negative image count", (f) => (f["package"].image_min.value = -1), "package.image_min.value", /at least 0/],
    ["a resolution with no limits", (f) => (f["package"].resolution.value = {}), "package.resolution.value", /at least one of/],
    ["a negative file size", (f) => (f["package"].resolution.value.max_file_mb = -2), "package.resolution.value.max_file_mb", /positive number/],
    ["a lead time whose min passes its max", (f) => (f["timing"].publish_lead_days.value = { min: 90, max: 30 }), "timing.publish_lead_days.value", /min.*max/],
    ["a story whose min words pass its max", (f) => (f["package"].story.value.max_words = 100), "package.story.value", /min_words.*max_words/],
    ["a gallery host outside the list", (f) => (f["package"].gallery_hosts.value = ["flickr"]), "package.gallery_hosts.value[0]", /Expected one of/],
    ["a fee with no amount", (f) => (f["economics"].priority_paid_tier.value.price.amount = 0), "economics.priority_paid_tier.value.price.amount", /positive number/],
    ["a currency that is not a code", (f) => (f["economics"].priority_paid_tier.value.price.currency = "usd"), "economics.priority_paid_tier.value.price.currency", /three-letter/],
    ["a route answer that is neither yes, no nor unknown", (f) => (f["routes"].value[0].account_required = "maybe"), "routes.value[0].account_required", /true, false or unknown/],
    ["a route url that is not a web address", (f) => (f["routes"].value[0].url = "example.com/form"), "routes.value[0].url", /http or https/],
    ["a known route list that is empty", (f) => (f["routes"].value = []), "routes.value", /at least 1/],
    ["a nested value that is not a mapping", (f) => (f["routes"].value[0] = "web_form"), "routes.value[0]", /mapping/],
    ["a reach figure with a bad date", (f) => (f["economics"].reach.value[0].as_of = "Oct 2026"), "economics.reach.value[0].as_of", /YYYY-MM-DD/],
    ["a shared inbox named by title, not id", (f) => (f["identity"].shared_inbox_with = { value: ["Brides"], cite: [{ source: "about", quote: "x" }] }), "identity.shared_inbox_with.value[0]", /publication id/],
    ["a recent feature cited to a non-feature page", (f) => (f["insight"].recent_features[0].source = "about"), "insight.recent_features[0].source", /feature source/],
    ["a recent feature cited to an unlisted page", (f) => (f["insight"].recent_features[0].source = "nowhere"), "insight.recent_features[0].source", /No source named nowhere/],
    ["insight lists that are not lists", (f) => (f["insight"].secret_sauce = "Be nice."), "insight.secret_sauce", /Expected a list/],
    ["an empty file", (f) => Object.keys(f).forEach((key) => delete f[key]), "id", /Missing/],
  ];

  for (const [name, change, field, message] of cases) {
    it(`rejects ${name}`, () => {
      const errors = errorsFor(change);
      const match = errors.find((error) => error.field === field);
      expect(match, JSON.stringify(errors, null, 2)).toBeDefined();
      expect(match!.message).toMatch(message);
    });
  }

  it("rejects a document that is not a mapping at all", () => {
    expect(validate(["not", "a", "file"])).toEqual({
      ok: false,
      errors: [{ field: "file", message: "Expected a mapping." }],
    });
  });

  it("rejects an email address anywhere, quotes included", () => {
    const errors = errorsFor((f) => {
      f["notes"] = "Write to editor@example.com for anything urgent.";
      f["content"].real_wedding.cite[0].quote = "Email weddings@example.com today.";
    });
    const fields = errors.filter((error) => /private contacts overlay/.test(error.message)).map((error) => error.field);
    expect(fields.sort()).toEqual(["content.real_wedding.cite[0].quote", "notes"]);
  });
});

describe("checking a set of files together", () => {
  const entry = (fileName: string, change: (file: Record<string, any>) => void = () => {}) => {
    const raw = fixture();
    change(raw);
    const result = validate(raw);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return { fileName, file: result.value };
  };

  it("passes a file whose name matches its id", () => {
    expect(checkResearchSet([entry("pub-example-weddings.yaml")])).toEqual([]);
  });

  it("rejects a file named differently from its id", () => {
    expect(checkResearchSet([entry("example.yaml")])).toEqual([
      { field: "example.yaml: id", message: "The file must be named pub-example-weddings.yaml." },
    ]);
  });

  it("resolves shared inboxes against the other files", () => {
    const sharing = (inbox: string[]) => (f: Record<string, any>) =>
      (f["identity"].shared_inbox_with = { value: inbox, cite: [{ source: "about", quote: "One inbox for both titles." }] });
    const other = entry("pub-example-home.yaml", (f) => {
      f["id"] = "pub-example-home";
    });

    expect(checkResearchSet([entry("pub-example-weddings.yaml", sharing(["pub-example-home"])), other])).toEqual([]);
    expect(checkResearchSet([entry("pub-example-weddings.yaml", sharing(["pub-missing"]))])).toEqual([
      {
        field: "pub-example-weddings.yaml: identity.shared_inbox_with.value[0]",
        message: "No research file for pub-missing.",
      },
    ]);
  });
});

describe("the vocabulary files", () => {
  it("parse, and name every tag, state, metro, region and country", () => {
    const parsedVocab = vocab();
    expect(parsedVocab.tags.get("florida")).toBe("region");
    expect(parsedVocab.tags.get("winter")).toBe("season");
    for (const code of ["WORLD", "US", "INTL", "US:midwest", "US-MI", "US-FL:tampa-bay", "IT"]) {
      expect(parsedVocab.geo.has(code), code).toBe(true);
    }
  });

  const vocabErrors = (tags: unknown, geo: unknown): FieldError[] => {
    const result = parseResearchVocab(tags, geo);
    if (result.ok) throw new Error("expected the vocabulary to be rejected");
    return result.errors;
  };

  const tagCases: Array<[string, (tags: Record<string, any>) => unknown, string, RegExp]> = [
    ["a tags file that is not a mapping", () => [], "tags.yaml", /mapping/],
    ["a missing category", (t) => (delete t["season"], t), "tags.yaml: season", /Missing/],
    ["an unknown category", (t) => ((t["mood"] = ["calm"]), t), "tags.yaml: mood", /Unknown category/],
    ["a category that is not a list", (t) => ((t["season"] = "winter"), t), "tags.yaml: season", /Expected a list/],
    ["a tag id that is not snake case", (t) => ((t["season"] = ["Winter"]), t), "tags.yaml: season[0]", /snake_case/],
    ["a tag in two categories", (t) => ((t["season"] = [...t["season"], "michigan"]), t), "tags.yaml: season[9]", /already listed/],
  ];

  for (const [name, change, field, message] of tagCases) {
    it(`rejects ${name}`, () => {
      const errors = vocabErrors(change(rawTags()), rawGeo());
      expect(errors.find((error) => error.field === field)?.message, JSON.stringify(errors)).toMatch(message);
    });
  }

  const geoCases: Array<[string, (geo: Record<string, any>) => unknown, string, RegExp]> = [
    ["a geo file that is not a mapping", () => "US", "geo.yaml", /mapping/],
    ["a missing section", (g) => (delete g["metros"], g), "geo.yaml: metros", /Missing/],
    ["an unknown section", (g) => ((g["cities"] = {}), g), "geo.yaml: cities", /Unknown section/],
    ["scopes other than WORLD, US and INTL", (g) => ((g["scopes"] = { WORLD: "Anywhere", US: "United States" }), g), "geo.yaml: scopes", /WORLD, US, INTL/],
    ["a state code outside the pattern", (g) => ((g["states"]["MI"] = "Michigan"), g), "geo.yaml: states.MI", /US-XX/],
    ["a region code outside the pattern", (g) => ((g["us_regions"]["midwest"] = g["us_regions"]["US:midwest"]), g), "geo.yaml: us_regions.midwest", /US:/],
    ["a region that is not a mapping", (g) => ((g["us_regions"]["US:midwest"] = "Midwest"), g), "geo.yaml: us_regions.US:midwest", /name and states/],
    ["a region naming an unknown state", (g) => (g["us_regions"]["US:midwest"].states.push("US-XX"), g), "geo.yaml: us_regions.US:midwest.states[12]", /No state US-XX/],
    ["a region with no states", (g) => ((g["us_regions"]["US:midwest"].states = []), g), "geo.yaml: us_regions.US:midwest.states", /at least 1/],
    ["metros under an unknown state", (g) => ((g["metros"]["US-XX"] = { here: "Here" }), g), "geo.yaml: metros.US-XX", /No state US-XX/],
    ["a metro slug outside the pattern", (g) => ((g["metros"]["US-MI"]["Ann Arbor"] = "Ann Arbor"), g), "geo.yaml: metros.US-MI.Ann Arbor", /kebab-case/],
    ["metros that are not a mapping", (g) => ((g["metros"]["US-MI"] = ["detroit"]), g), "geo.yaml: metros.US-MI", /mapping/],
    ["a country code outside ISO 3166", (g) => ((g["countries"]["ZZ"] = "Nowhere"), g), "geo.yaml: countries.ZZ", /ISO 3166/],
    ["a country code in the wrong case", (g) => ((g["countries"]["it"] = "Italy"), g), "geo.yaml: countries.it", /ISO 3166/],
    ["a blank place name", (g) => ((g["countries"]["IT"] = ""), g), "geo.yaml: countries.IT", /blank/],
  ];

  for (const [name, change, field, message] of geoCases) {
    it(`rejects ${name}`, () => {
      const errors = vocabErrors(rawTags(), change(rawGeo()));
      expect(errors.find((error) => error.field === field)?.message, JSON.stringify(errors)).toMatch(message);
    });
  }
});
