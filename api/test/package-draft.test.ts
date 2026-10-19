import { describe, expect, it } from "vitest";

import { buildCreditsBlock, buildDescriptionDraft } from "../src/domain/package-draft.js";

const event = {
  coupleNames: "Sarah and James",
  eventDate: "2026-06-14",
  venueName: "The Barn",
  city: "Detroit",
  state: "MI",
  country: null,
  coupleStory: null,
  uniqueAngle: null,
};

describe("buildCreditsBlock", () => {
  it("is empty when there are no vendors", () => {
    expect(buildCreditsBlock([])).toBe("");
  });

  it("lists role and business name", () => {
    expect(
      buildCreditsBlock([{ role: "Florist", businessName: "Stems", website: null, instagram: null }]),
    ).toBe("- Florist: Stems");
  });

  it("appends a website when there is one", () => {
    expect(
      buildCreditsBlock([
        { role: "Venue", businessName: "The Barn", website: "https://barn.example", instagram: null },
      ]),
    ).toBe("- Venue: The Barn — https://barn.example");
  });

  it("appends an instagram handle with an at sign", () => {
    expect(
      buildCreditsBlock([
        { role: "Florist", businessName: "Stems", website: null, instagram: "stems" },
      ]),
    ).toBe("- Florist: Stems — @stems");
  });

  it("includes both when both exist", () => {
    expect(
      buildCreditsBlock([
        {
          role: "Florist",
          businessName: "Stems",
          website: "https://stems.example",
          instagram: "stems",
        },
      ]),
    ).toBe("- Florist: Stems — https://stems.example — @stems");
  });

  it("keeps the given order, because vendor order is curated", () => {
    const block = buildCreditsBlock([
      { role: "Venue", businessName: "The Barn", website: null, instagram: null },
      { role: "Florist", businessName: "Stems", website: null, instagram: null },
    ]);
    expect(block).toBe("- Venue: The Barn\n- Florist: Stems");
  });

  it("skips a row with no business name rather than emitting a dangling role", () => {
    expect(
      buildCreditsBlock([
        { role: "Florist", businessName: "  ", website: null, instagram: null },
        { role: "Venue", businessName: "The Barn", website: null, instagram: null },
      ]),
    ).toBe("- Venue: The Barn");
  });
});

describe("buildDescriptionDraft", () => {
  it("opens with the couple, the date, and the place", () => {
    expect(buildDescriptionDraft(event)).toBe(
      "Sarah and James were married on 2026-06-14 at The Barn in Detroit, MI.",
    );
  });

  it("omits the venue when there is none", () => {
    expect(buildDescriptionDraft({ ...event, venueName: null })).toBe(
      "Sarah and James were married on 2026-06-14 in Detroit, MI.",
    );
  });

  it("omits the place entirely when nothing is known", () => {
    expect(
      buildDescriptionDraft({ ...event, venueName: null, city: null, state: null }),
    ).toBe("Sarah and James were married on 2026-06-14.");
  });

  it("includes the country when there is no state", () => {
    expect(
      buildDescriptionDraft({ ...event, city: "Lisbon", state: null, country: "Portugal" }),
    ).toBe("Sarah and James were married on 2026-06-14 at The Barn in Lisbon, Portugal.");
  });

  it("adds the couple story as its own paragraph", () => {
    expect(
      buildDescriptionDraft({ ...event, coupleStory: "They met at a bus stop." }),
    ).toBe(
      "Sarah and James were married on 2026-06-14 at The Barn in Detroit, MI.\n\nThey met at a bus stop.",
    );
  });

  it("adds the unique angle after the story", () => {
    const draft = buildDescriptionDraft({
      ...event,
      coupleStory: "They met at a bus stop.",
      uniqueAngle: "It rained the whole day.",
    });
    expect(draft.split("\n\n")).toEqual([
      "Sarah and James were married on 2026-06-14 at The Barn in Detroit, MI.",
      "They met at a bus stop.",
      "It rained the whole day.",
    ]);
  });

  it("ignores whitespace-only story text", () => {
    expect(buildDescriptionDraft({ ...event, coupleStory: "   " })).toBe(
      "Sarah and James were married on 2026-06-14 at The Barn in Detroit, MI.",
    );
  });

  it("is a draft, not a submission: it never invents detail it was not given", () => {
    const draft = buildDescriptionDraft({ ...event, coupleStory: null, uniqueAngle: null });
    expect(draft).not.toMatch(/beautiful|stunning|magical|perfect/i);
  });
});
