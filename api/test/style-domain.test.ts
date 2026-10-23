import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  MAX_ANALYSIS_BYTES,
  MAX_ANALYSIS_PHOTOS,
  lookTags,
  photoSetText,
  pickPhotos,
  planAnalysis,
  regionTags,
  seasonTags,
  validatePastFeature,
} from "../src/domain/style.js";
import type { EventTagRow } from "../src/domain/style.js";
import { STYLE_MODEL, buildSuggestRequest, parseSuggestions, photoVocabulary } from "../src/domain/style-analysis.js";
import type { TagCategory } from "../src/domain/tags.js";

const here = dirname(fileURLToPath(import.meta.url));
const GEO = parse(readFileSync(join(here, "../../research/vocab/geo.yaml"), "utf8"));
const TAGS = parse(readFileSync(join(here, "../../research/vocab/tags.yaml"), "utf8")) as Record<TagCategory, string[]>;
const VOCABULARY = Object.entries(TAGS).flatMap(([category, ids]) =>
  ids.map((id) => ({ id, category: category as TagCategory })),
);

const photos = (count: number, bytes = 1000) =>
  Array.from({ length: count }, (_, index) => ({ key: `events/e1/${String(index).padStart(3, "0")}.jpg`, bytes }));

describe("pickPhotos", () => {
  it("sends every photo when there are 20 or fewer", () => {
    expect(pickPhotos(photos(3))).toEqual(photos(3).map((photo) => photo.key));
  });

  it("spreads 20 picks evenly across a bigger set, first photo included", () => {
    const picked = pickPhotos(photos(39));
    expect(picked).toHaveLength(MAX_ANALYSIS_PHOTOS);
    expect(new Set(picked).size).toBe(MAX_ANALYSIS_PHOTOS);
    expect(picked[0]).toBe("events/e1/000.jpg");
    expect(picked.at(-1)).toBe("events/e1/037.jpg");
  });

  it("skips photos too large to send", () => {
    const pool = [...photos(2), { key: "events/e1/huge.jpg", bytes: MAX_ANALYSIS_BYTES + 1 }];
    expect(pickPhotos(pool)).not.toContain("events/e1/huge.jpg");
    expect(pickPhotos([{ key: "k", bytes: MAX_ANALYSIS_BYTES }])).toEqual(["k"]);
  });

  it("compares photo sets by their keys, whatever the order", () => {
    expect(photoSetText(["b", "a"])).toBe(photoSetText(["a", "b"]));
  });
});

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

describe("regionTags", () => {
  it("names Michigan and its region from the code or the name", () => {
    expect(regionTags("MI", "USA", GEO)).toEqual(["michigan", "midwest_us"]);
    expect(regionTags("michigan", null, GEO)).toEqual(["michigan", "midwest_us"]);
    expect(regionTags(" Mi ", "United States", GEO)).toEqual(["michigan", "midwest_us"]);
  });

  it("gives a state the vocabulary does not name only its region", () => {
    expect(regionTags("TX", "US", GEO)).toEqual(["south_central_us"]);
    expect(regionTags("Florida", "U.S.", GEO)).toEqual(["florida", "southeast_us"]);
  });

  it("gives California its own tag even though no US region lists it", () => {
    expect(regionTags("CA", null, GEO)).toEqual(["california"]);
  });

  it("leaves weddings outside the US, unknown states and a missing vocabulary alone", () => {
    expect(regionTags("Tuscany", "Italy", GEO)).toEqual([]);
    expect(regionTags("ZZ", "USA", GEO)).toEqual([]);
    expect(regionTags(null, "USA", GEO)).toEqual([]);
    expect(regionTags("MI", "USA", null)).toEqual([]);
  });

  it("only ever suggests vocabulary tags", () => {
    for (const code of Object.keys(GEO.states as Record<string, string>)) {
      for (const tag of regionTags(code.slice(3), "USA", GEO)) expect(TAGS.region).toContain(tag);
    }
  });
});

const row = (tag_id: string, state: EventTagRow["state"], source: EventTagRow["source"] = "analysis"): EventTagRow => ({
  tag_id,
  state,
  source,
  confidence: null,
  reason: null,
});

describe("planAnalysis", () => {
  const suggest = (...tags: string[]) => tags.map((tag) => ({ tag, confidence: "high" as const, reason: "Photo 1." }));

  it("never touches a tag she has confirmed or rejected", () => {
    const plan = planAnalysis([row("romantic", "confirmed"), row("bohemian", "rejected")], suggest("romantic", "bohemian", "whimsical"));
    expect(plan.write.map((entry) => entry.tag)).toEqual(["whimsical"]);
    expect(plan.drop).toEqual([]);
  });

  it("drops the last analysis's suggestions it no longer makes", () => {
    const plan = planAnalysis([row("romantic", "suggested"), row("whimsical", "suggested")], suggest("whimsical"));
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
      ["romantic", "confirmed", "analysis"],
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

describe("buildSuggestRequest", () => {
  const vocabulary = photoVocabulary(VOCABULARY);
  const request = buildSuggestRequest({ vocabulary, photoUrls: ["https://api.example.com/images/a?token=t1", "https://api.example.com/images/b?token=t2"] });

  it("asks only about what photos can show", () => {
    expect(new Set(vocabulary.map((tag) => tag.category))).toEqual(
      new Set(["landscape_venue", "architecture", "aesthetic", "dress_style"]),
    );
  });

  it("uses Opus 5.5 at low effort, with the server-side fallback", () => {
    expect(request.model).toBe(STYLE_MODEL);
    expect(STYLE_MODEL).toBe("claude-opus-5-5");
    expect(request.output_config?.effort).toBe("low");
    expect(request.fallbacks).toBe("default");
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  it("sends each photo by its link, numbered, before the question", () => {
    const content = request.messages[0]?.content as Array<Record<string, any>>;
    expect(content.slice(0, 4)).toEqual([
      { type: "text", text: "Photo 1:" },
      { type: "image", source: { type: "url", url: "https://api.example.com/images/a?token=t1" } },
      { type: "text", text: "Photo 2:" },
      { type: "image", source: { type: "url", url: "https://api.example.com/images/b?token=t2" } },
    ]);
    expect(content.at(-1)?.["text"]).toContain("aesthetic: classic_timeless, romantic");
  });

  it("constrains every answered tag to the vocabulary", () => {
    const schema = request.output_config?.format?.schema as Record<string, any>;
    const item = schema["properties"]["tags"]["items"];
    expect(item["properties"]["tag"]["enum"]).toEqual(vocabulary.map((tag) => tag.id));
    expect(item["properties"]["confidence"]["enum"]).toEqual(["high", "medium", "low"]);
    expect(item["additionalProperties"]).toBe(false);
  });

  it("tells Claude never to identify anyone", () => {
    expect(String(request.system)).toContain("Never identify anyone");
  });
});

describe("parseSuggestions", () => {
  const allowed = new Set(["romantic", "bohemian", "lakefront"]);
  const answer = (tags: unknown, stop_reason: any = "end_turn") => ({
    stop_reason,
    content: [{ type: "text", text: JSON.stringify({ tags }), citations: null } as any],
  });

  it("keeps vocabulary tags once each, with a trimmed reason", () => {
    const outcome = parseSuggestions(
      answer([
        { tag: "romantic", confidence: "high", reason: "  Photos 2 and 5: candlelit tables.  " },
        { tag: "romantic", confidence: "low", reason: "again" },
        { tag: "made_up", confidence: "high", reason: "x" },
        { tag: "lakefront", confidence: "certain", reason: "x" },
        { tag: "bohemian", confidence: "medium", reason: "r".repeat(300) },
      ]),
      allowed,
    );
    expect(outcome).toEqual({
      ok: true,
      suggestions: [
        { tag: "romantic", confidence: "high", reason: "Photos 2 and 5: candlelit tables." },
        { tag: "bohemian", confidence: "medium", reason: "r".repeat(200) },
      ],
    });
  });

  it("reports a refusal, a cut-off answer and an answer that is not JSON", () => {
    expect(parseSuggestions(answer([], "refusal"), allowed)).toMatchObject({ ok: false, status: "refused" });
    expect(parseSuggestions(answer([], "max_tokens"), allowed)).toMatchObject({ ok: false, status: "failed" });
    expect(
      parseSuggestions({ stop_reason: "end_turn", content: [{ type: "text", text: "Sure!", citations: null } as any] }, allowed),
    ).toMatchObject({ ok: false, status: "failed", error: "answer was not JSON" });
    expect(parseSuggestions(answer("nope"), allowed)).toMatchObject({ ok: false, status: "failed" });
  });

  it("reads past a fallback block to the text", () => {
    const message = {
      stop_reason: "end_turn" as const,
      content: [
        { type: "fallback", from: { model: "a" }, to: { model: "b" } } as any,
        { type: "text", text: JSON.stringify({ tags: [{ tag: "romantic", confidence: "high", reason: "r" }] }), citations: null } as any,
      ],
    };
    expect(parseSuggestions(message, allowed)).toMatchObject({ ok: true, suggestions: [{ tag: "romantic" }] });
  });
});
