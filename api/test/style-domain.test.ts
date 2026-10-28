import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  lookTags,
  planSuggestions,
  seasonTags,
  validatePastFeature,
  validateSuggestions,
  validateTagAnswers,
} from "../src/domain/style.js";
import type { EventTagRow } from "../src/domain/style.js";
import type { TagCategory } from "../src/domain/tags.js";

const here = dirname(fileURLToPath(import.meta.url));
const TAGS = parse(readFileSync(join(here, "../../research/vocab/tags.yaml"), "utf8")) as Record<TagCategory, string[]>;
const VOCABULARY = Object.entries(TAGS).flatMap(([category, ids]) =>
  ids.map((id) => ({ id, category: category as TagCategory })),
);

describe("seasonTags", () => {
  it.each([
    ["2026-01-31", ["winter"]],
    ["2026-04-11", ["spring"]],
    ["2026-06-20", ["early_summer"]],
    ["2026-07-04", ["high_summer"]],
    ["2026-08-15", ["late_summer"]],
    ["2026-09-19", ["early_fall"]],
    ["2026-10-17", ["late_fall"]],
    ["2026-12-12", ["winter", "holiday_season"]],
  ])("%s suggests %j", (date, tags) => {
    expect(seasonTags(date)).toEqual(tags);
  });

  it("suggests nothing for a date that is not one", () => {
    expect(seasonTags("2026-02-30")).toEqual([]);
    expect(seasonTags("")).toEqual([]);
  });

  it("only ever suggests vocabulary tags", () => {
    for (let month = 1; month <= 12; month++) {
      for (const tag of seasonTags(`2026-${String(month).padStart(2, "0")}-01`)) expect(TAGS.season).toContain(tag);
    }
  });
});

const row = (tag_id: string, state: EventTagRow["state"], source: EventTagRow["source"] = "operator"): EventTagRow => ({
  tag_id,
  state,
  source,
  confidence: null,
  reason: null,
});

describe("planSuggestions", () => {
  const suggest = (...tags: string[]) => tags.map((tag) => ({ tag, confidence: "high" as const, reason: "Photo 1." }));

  it("never touches a tag she has confirmed or rejected", () => {
    const plan = planSuggestions([row("romantic", "confirmed"), row("bohemian", "rejected")], suggest("romantic", "bohemian", "whimsical"));
    expect(plan.write.map((entry) => entry.tag)).toEqual(["whimsical"]);
    expect(plan.drop).toEqual([]);
  });

  it("drops earlier operator suggestions the new set leaves out, and never a date or state tag", () => {
    const plan = planSuggestions(
      [row("romantic", "suggested"), row("whimsical", "suggested"), row("winter", "suggested", "derived")],
      suggest("whimsical"),
    );
    expect(plan.drop).toEqual(["romantic"]);
    expect(plan.write.map((entry) => entry.tag)).toEqual(["whimsical"]);
  });
});

describe("lookTags", () => {
  it("adds date and state suggestions without a row, in vocabulary order", () => {
    const tags = lookTags(
      [row("romantic", "confirmed"), row("not_in_vocabulary", "suggested")],
      [
        { tag: "winter", reason: "From the wedding date." },
        { tag: "michigan", reason: "From where the wedding was." },
      ],
      VOCABULARY,
    );
    expect(tags.map((tag) => [tag.id, tag.state, tag.source])).toEqual([
      ["michigan", "suggested", "derived"],
      ["romantic", "confirmed", "operator"],
      ["winter", "suggested", "derived"],
    ]);
  });

  it("shows her answer, not the suggestion, once a date or state tag has a row", () => {
    const tags = lookTags([row("winter", "rejected", "derived")], [{ tag: "winter", reason: "From the wedding date." }], VOCABULARY);
    expect(tags).toEqual([{ id: "winter", category: "season", state: "rejected", source: "derived", confidence: null, reason: null }]);
  });
});

describe("validatePastFeature", () => {
  const errorFields = (raw: unknown) => {
    const result = validatePastFeature(raw);
    return result.ok ? [] : result.errors.map((error) => error.field);
  };

  it("accepts a named outlet with a link, a month and the defaults", () => {
    expect(validatePastFeature({ outletName: " Somewhere ", featureUrl: "https://example.com/a", publishedOn: "2025-06" })).toEqual({
      ok: true,
      value: {
        publicationId: null,
        outletName: "Somewhere",
        eventId: null,
        featureUrl: "https://example.com/a",
        publishedOn: "2025-06",
        role: "lead",
        notes: null,
      },
    });
  });

  it("needs an outlet, by link or by name", () => {
    expect(errorFields({})).toEqual(["outletName"]);
    expect(errorFields({ publicationId: "pub-x" })).toEqual([]);
  });

  it("rejects a bad link, date, role or overlong text", () => {
    expect(errorFields({ outletName: "X", featureUrl: "javascript:alert(1)" })).toEqual(["featureUrl"]);
    expect(errorFields({ outletName: "X", publishedOn: "2025-13" })).toEqual(["publishedOn"]);
    expect(errorFields({ outletName: "X", publishedOn: "2025-02-30" })).toEqual(["publishedOn"]);
    expect(errorFields({ outletName: "X", role: "assistant" })).toEqual(["role"]);
    expect(errorFields({ outletName: "X".repeat(121) })).toEqual(["outletName"]);
    expect(errorFields({ outletName: "X", notes: "n".repeat(1001) })).toEqual(["notes"]);
    expect(errorFields({ outletName: 7 })).toContain("outletName");
  });
});

describe("validateSuggestions", () => {
  const vocabulary = new Set(VOCABULARY.map((tag) => tag.id));

  it("accepts vocabulary tags with a confidence and a reason, trimmed", () => {
    expect(validateSuggestions({ tags: [{ tag: "romantic", confidence: "high", reason: "  Photo 2: candles. " }] }, vocabulary)).toEqual({
      ok: true,
      value: [{ tag: "romantic", confidence: "high", reason: "Photo 2: candles." }],
    });
    expect(validateSuggestions({ tags: [] }, vocabulary)).toEqual({ ok: true, value: [] });
  });

  it("refuses the set over any unknown, repeated or incomplete entry, naming each", () => {
    const result = validateSuggestions(
      {
        tags: [
          { tag: "romantic", confidence: "high", reason: "r" },
          { tag: "romantic", confidence: "high", reason: "r" },
          { tag: "made_up", confidence: "certain", reason: "" },
          { tag: "lakefront", confidence: "low", reason: "r".repeat(201) },
        ],
      },
      vocabulary,
    );
    expect(result.ok ? [] : result.errors.map((error) => error.field)).toEqual([
      "tags.1.tag",
      "tags.2.tag",
      "tags.2.confidence",
      "tags.2.reason",
      "tags.3.reason",
    ]);
  });

  it("needs a list", () => {
    expect(validateSuggestions({}, vocabulary)).toMatchObject({ ok: false, errors: [{ field: "tags" }] });
    expect(validateSuggestions(null, vocabulary)).toMatchObject({ ok: false });
  });
});

describe("validateTagAnswers", () => {
  const vocabulary = new Set(VOCABULARY.map((tag) => tag.id));

  it("accepts tags she keeps and tags she says no to, either list alone", () => {
    expect(validateTagAnswers({ confirmed: ["romantic", "lakefront"], rejected: ["winter"] }, vocabulary)).toEqual({
      ok: true,
      value: { confirmed: ["romantic", "lakefront"], rejected: ["winter"] },
    });
    expect(validateTagAnswers({ rejected: ["winter"] }, vocabulary)).toEqual({ ok: true, value: { confirmed: [], rejected: ["winter"] } });
    expect(validateTagAnswers({ confirmed: ["romantic"] }, vocabulary)).toEqual({ ok: true, value: { confirmed: ["romantic"], rejected: [] } });
  });

  it("refuses the set over any unknown tag, or one listed twice in either list, naming each", () => {
    const result = validateTagAnswers(
      { confirmed: ["romantic", "made_up", "romantic", 7], rejected: ["lakefront", "romantic"] },
      vocabulary,
    );
    expect(result.ok ? [] : result.errors.map((error) => `${error.field} ${error.message}`)).toEqual([
      "confirmed.1 Not a vocabulary tag: made_up.",
      "confirmed.2 Listed twice: romantic.",
      "confirmed.3 Not a vocabulary tag: 7.",
      "rejected.1 Listed twice: romantic.",
    ]);
  });

  it("needs lists, and at least one tag in them", () => {
    expect(validateTagAnswers({ confirmed: "romantic" }, vocabulary)).toMatchObject({ ok: false, errors: [{ field: "confirmed" }] });
    expect(validateTagAnswers({ confirmed: [], rejected: [] }, vocabulary)).toEqual({
      ok: false,
      errors: [{ field: "confirmed", message: "Answer at least one tag." }],
    });
    expect(validateTagAnswers(null, vocabulary)).toMatchObject({ ok: false });
  });
});
