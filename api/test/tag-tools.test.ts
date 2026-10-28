import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import type { LookTag } from "../src/domain/style.js";
import { checkTagAnswers, closeTags, tagChoices, tagId, tagStanding } from "../src/domain/tag-tools.js";
import type { TagCategory } from "../src/domain/tags.js";

const here = dirname(fileURLToPath(import.meta.url));
const TAGS = parse(readFileSync(join(here, "../../research/vocab/tags.yaml"), "utf8")) as Record<TagCategory, string[]>;
const VOCABULARY = Object.entries(TAGS).flatMap(([category, ids]) =>
  ids.map((id) => ({ id, category: category as TagCategory })),
);
const IDS = VOCABULARY.map((tag) => tag.id);

const look = (id: string, category: TagCategory, state: LookTag["state"], reason: string | null = null): LookTag => ({
  id,
  category,
  state,
  source: "photographer",
  confidence: null,
  reason,
});

describe("tagId", () => {
  it.each([
    ["Late fall", "late_fall"],
    ["  late-fall ", "late_fall"],
    ["LAKEFRONT", "lakefront"],
    ["farm  ranch - countryside", "farm_ranch_countryside"],
    ["lakefront", "lakefront"],
  ])("%j -> %s", (text, id) => {
    expect(tagId(text)).toBe(id);
  });
});

describe("closeTags", () => {
  it("finds tags sharing a word, or the start of one, with what was asked for", () => {
    expect(closeTags("mountains", IDS)).toEqual(["mountain_west_us", "mountain_alpine"]);
    expect(closeTags("fall", IDS)).toEqual(["early_fall", "late_fall"]);
    expect(closeTags("rustic_barn", IDS)).toEqual(["rustic_barn_timber"]);
    expect(closeTags("beach_wedding", IDS)).toEqual(["beach_coastal"]);
  });

  it("ignores short words and gives at most four", () => {
    expect(closeTags("us", IDS)).toEqual([]);
    expect(closeTags("a_b", IDS)).toEqual([]);
    expect(closeTags("xyzzy", IDS)).toEqual([]);
    expect(closeTags("the_wedding_style", IDS)).toEqual([]);
    expect(closeTags("wedding_suit", IDS)).toEqual(["wedding_suit_pantsuit"]);
    expect(closeTags("summer_us", IDS)).toEqual(["early_summer", "high_summer", "late_summer"]);
    expect(closeTags("modern_classic_romantic_vintage", IDS)).toHaveLength(4);
  });

  it("needs four letters before a start counts", () => {
    expect(closeTags("bal", IDS)).toEqual([]);
    expect(closeTags("ball", IDS)).toEqual(["ballroom_grand_hall", "ball_gown"]);
  });
});

describe("checkTagAnswers", () => {
  it("spells each tag the vocabulary's way and lists it once", () => {
    expect(checkTagAnswers(["Lakefront", "lakefront", "Late fall"], ["winter", "Winter"], IDS)).toEqual({
      ok: true,
      confirmed: ["lakefront", "late_fall"],
      rejected: ["winter"],
    });
    expect(checkTagAnswers([], ["winter"], IDS)).toEqual({ ok: true, confirmed: [], rejected: ["winter"] });
  });

  it("needs at least one tag", () => {
    expect(checkTagAnswers([], [], IDS)).toMatchObject({ ok: false, result: "needs_tags" });
  });

  it("refuses the set over any unknown tag, offering the closest ones and saying nothing was saved", () => {
    const result = checkTagAnswers(["lakefront", "Mountains", "xyzzy"], ["xyzzy"], IDS);
    expect(result).toEqual({
      ok: false,
      result: "unknown_tag",
      message:
        "Not in the tag list: mountains (closest: mountain_west_us, mountain_alpine); xyzzy. Call get_wedding with tag_choices set to true for the list. Nothing was saved.",
    });
  });

  it("refuses a tag both kept and dropped", () => {
    const result = checkTagAnswers(["romantic", "Lakefront"], ["lakefront"], IDS);
    expect(result).toMatchObject({ ok: false, result: "kept_and_dropped" });
    expect(result.ok ? "" : result.message).toBe("In both keep and drop: lakefront. Ask her which she meant. Nothing was saved.");
  });
});

describe("tagStanding", () => {
  it("splits the tags into kept, not kept and waiting, in the order given", () => {
    const tags = [
      look("michigan", "region", "suggested", "From where the wedding was."),
      look("lakefront", "landscape_venue", "confirmed"),
      look("romantic", "aesthetic", "rejected"),
      look("ball_gown", "dress_style", "confirmed"),
      look("winter", "season", "suggested", null),
    ];
    expect(tagStanding(tags)).toEqual({
      kept: ["lakefront", "ball_gown"],
      notKept: ["romantic"],
      toAnswer: [
        { tag: "michigan", why: "From where the wedding was." },
        { tag: "winter", why: "Suggested earlier." },
      ],
    });
  });

  it("always says what is kept, and leaves out empty groups", () => {
    expect(tagStanding([])).toEqual({ kept: [] });
    expect(tagStanding([look("lakefront", "landscape_venue", "confirmed")])).toEqual({ kept: ["lakefront"] });
  });
});

describe("tagChoices", () => {
  it("lists every tag by group as one line, leaving out the ones she has answered", () => {
    const choices = tagChoices(VOCABULARY, [
      look("lakefront", "landscape_venue", "confirmed"),
      look("winter", "season", "rejected"),
      look("spring", "season", "suggested", "From the wedding date."),
    ]);
    expect(Object.keys(choices)).toEqual(["region", "landscape_venue", "architecture", "aesthetic", "dress_style", "season"]);
    expect(choices.landscape_venue?.split(", ")).toEqual(TAGS.landscape_venue.filter((id) => id !== "lakefront"));
    expect(choices.season?.split(", ")).toEqual(TAGS.season.filter((id) => id !== "winter"));
    expect(choices.region).toBe(TAGS.region.join(", "));
  });

  it("drops a group once every tag in it is answered", () => {
    const answered = TAGS.season.map((id) => look(id, "season", "rejected"));
    expect(tagChoices(VOCABULARY, answered)).not.toHaveProperty("season");
  });
});
