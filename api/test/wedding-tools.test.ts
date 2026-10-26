import { describe, expect, it } from "vitest";

import {
  matchPlace,
  mergeWedding,
  permissionsPreview,
  permissionsRecord,
  stillNeeded,
  toolField,
  weddingChanges,
} from "../src/domain/wedding-tools.js";
import type { CurrentWedding } from "../src/domain/wedding-tools.js";

describe("permissionsRecord", () => {
  it.each([
    [true, "yes", undefined, { rightsStatus: "own_contract", consentStatus: "granted", consentNotes: null }],
    [true, "yes_with_limits", "First names only", { rightsStatus: "own_contract", consentStatus: "granted_limited", consentNotes: "First names only" }],
    [true, "not_yet", undefined, { rightsStatus: "own_contract", consentStatus: "unverified", consentNotes: null }],
    [false, "no", "They want privacy", { rightsStatus: "second_shooter", consentStatus: "declined", consentNotes: "They want privacy" }],
  ] as const)("lead %s, couple %s, limits %s", (leadPhotographer, coupleAgreed, limits, record) => {
    expect(permissionsRecord({ leadPhotographer, coupleAgreed, limits })).toEqual({ ok: true, record });
  });

  it("drops limits when the couple agreed without any", () => {
    expect(permissionsRecord({ leadPhotographer: true, coupleAgreed: "yes", limits: "ignored" })).toMatchObject({ record: { consentNotes: null } });
  });

  it("needs the limits spelled out when there are some", () => {
    expect(permissionsRecord({ leadPhotographer: true, coupleAgreed: "yes_with_limits", limits: "  " })).toEqual({
      ok: false,
      message: "Say what the couple's limits are, for example first names only.",
    });
  });
});

describe("permissionsPreview", () => {
  it("says in plain words exactly what will be recorded", () => {
    expect(
      permissionsPreview("Blake & Anne", { rightsStatus: "own_contract", consentStatus: "granted_limited", consentNotes: "First names only" }),
    ).toEqual([
      "For Blake & Anne:",
      "You were the lead photographer, under your own contract.",
      "The couple agreed to a submission, with these limits: First names only",
    ]);
  });

  it.each([
    ["second_shooter", "granted", "You were not the lead photographer under your own contract.", "The couple agreed to a submission."],
    ["own_contract", "unverified", "You were the lead photographer, under your own contract.", "The couple has not answered yet."],
    ["own_contract", "declined", "You were the lead photographer, under your own contract.", "The couple said no."],
  ] as const)("%s and %s", (rightsStatus, consentStatus, rights, consent) => {
    expect(permissionsPreview("A & B", { rightsStatus, consentStatus, consentNotes: null }).slice(1)).toEqual([rights, consent]);
  });
});

describe("weddingChanges", () => {
  it("maps the tool's plain argument names onto the record and leaves out what was not given", () => {
    expect(
      weddingChanges({
        couple_names: "Blake & Anne",
        date: "2026-01-31",
        venue: "Hawks Cay",
        story: "They met sailing.",
        names_in_print: "Blake and Anne",
        destination: true,
        kind: "elopement",
        vendors: [
          { role: "Florist", business: "Petal & Stem", instagram: "@petal" },
          { role: "Planner", business: "Keys Events", website: "https://keys.example" },
        ],
        video_link: "https://vimeo.com/1",
        outlet_notes: "Coastal outlets",
        hero_picks: "1, 4, 9",
        angle: "Sunrise on the water",
        city: "Duck Key",
        state: "FL",
        country: "US",
      }),
    ).toEqual({
      coupleNames: "Blake & Anne",
      eventDate: "2026-01-31",
      venueName: "Hawks Cay",
      coupleStory: "They met sailing.",
      nameDisplay: "Blake and Anne",
      isDestination: true,
      contentType: "elopement",
      vendorCredits: [
        { role: "Florist", businessName: "Petal & Stem", website: null, instagram: "@petal" },
        { role: "Planner", businessName: "Keys Events", website: "https://keys.example", instagram: null },
      ],
      videoUrl: "https://vimeo.com/1",
      targetOutletNotes: "Coastal outlets",
      heroPicks: "1, 4, 9",
      uniqueAngle: "Sunrise on the water",
      city: "Duck Key",
      state: "FL",
      country: "US",
    });
    expect(weddingChanges({})).toEqual({});
  });
});

describe("mergeWedding", () => {
  const current: CurrentWedding = {
    coupleNames: "Blake & Anne",
    eventDate: "2026-01-31",
    venueName: null,
    city: null,
    state: null,
    country: null,
    uniqueAngle: null,
    rightsStatus: "own_contract",
    consentStatus: "granted",
    consentNotes: null,
    nameDisplay: null,
    coupleStory: "Old story",
    isDestination: false,
    heroPicks: null,
    videoUrl: null,
    targetOutletNotes: null,
    locationCode: null,
    contentType: "real_wedding",
    vendorCredits: [{ role: "Florist", businessName: "Petal & Stem", website: null, instagram: null }],
  };

  it("starts a new wedding unanswered, with no gallery link, and applies the changes", () => {
    expect(mergeWedding(null, { coupleNames: "C & D", eventDate: "2026-05-01" })).toMatchObject({
      coupleNames: "C & D",
      eventDate: "2026-05-01",
      rightsStatus: "unverified",
      consentStatus: "unverified",
      galleryUrl: null,
      contentType: "real_wedding",
      isDestination: false,
      vendorCredits: [],
    });
  });

  it("changes only what was given, keeps the vendors unless new ones are given, and never touches permissions or the gallery link", () => {
    const merged = mergeWedding(current, { venueName: "Hawks Cay", coupleStory: "They met sailing." });
    expect(merged).toMatchObject({
      coupleNames: "Blake & Anne",
      venueName: "Hawks Cay",
      coupleStory: "They met sailing.",
      rightsStatus: "own_contract",
      consentStatus: "granted",
      galleryUrl: null,
      vendorCredits: current.vendorCredits,
    });
    expect(mergeWedding(current, { vendorCredits: [] })).toMatchObject({ vendorCredits: [] });
  });

  it("ignores any permission fields smuggled into the changes", () => {
    const smuggled = { rightsStatus: "blocked", consentStatus: "declined" } as unknown as Parameters<typeof mergeWedding>[1];
    expect(mergeWedding(current, smuggled)).toMatchObject({ rightsStatus: "own_contract", consentStatus: "granted" });
  });
});

describe("toolField", () => {
  it.each([
    ["coupleNames", "couple_names"],
    ["eventDate", "date"],
    ["venueName", "venue"],
    ["locationCode", "place"],
    ["vendorCredits.2.businessName", "vendors.2.business"],
    ["vendorCredits", "vendors"],
    ["somethingNew", "somethingNew"],
  ])("%s reads as %s", (field, name) => {
    expect(toolField(field)).toBe(name);
  });
});

describe("matchPlace", () => {
  const options = [
    { code: "US-FL", label: "Florida" },
    { code: "US-FL:miami", label: "Miami, Florida" },
    { code: "US-FL:florida-keys", label: "Florida Keys, Florida" },
    { code: "US-GA", label: "Georgia" },
    { code: "US-MI:detroit", label: "Metro Detroit, Michigan" },
    { code: "MX", label: "Mexico" },
  ];

  it("takes a code as given, in any case", () => {
    expect(matchPlace("us-fl:florida-keys", options)).toEqual({ code: "US-FL:florida-keys" });
  });

  it("resolves a name that fits one place", () => {
    expect(matchPlace("the Florida Keys", options)).toEqual({ code: "US-FL:florida-keys" });
    expect(matchPlace("Detroit", options)).toEqual({ code: "US-MI:detroit" });
    expect(matchPlace("mexico", options)).toEqual({ code: "MX" });
  });

  it("prefers the exact name when several places share a word", () => {
    expect(matchPlace("Florida", options)).toEqual({ code: "US-FL" });
  });

  it("asks rather than guesses when several places fit and none exactly", () => {
    const metros = options.filter((option) => option.code.includes(":") && option.code.startsWith("US-FL"));
    expect(matchPlace("Florida", metros)).toEqual({ candidates: metros });
  });

  it("offers close places when the name fits none exactly, closest first", () => {
    expect(matchPlace("Duck Key, Florida", options)).toEqual({
      candidates: [
        { code: "US-FL:florida-keys", label: "Florida Keys, Florida" },
        { code: "US-FL", label: "Florida" },
        { code: "US-FL:miami", label: "Miami, Florida" },
      ],
    });
  });

  it("offers nothing when no word matches", () => {
    expect(matchPlace("Atlantis", options)).toEqual({ candidates: [] });
  });

  it("caps the candidates at five", () => {
    const many = Array.from({ length: 9 }, (_, n) => ({ code: `US-TX:c${n}`, label: `City ${n}, Texas` }));
    expect((matchPlace("Texas ranch", many) as { candidates: unknown[] }).candidates).toHaveLength(5);
  });
});

describe("stillNeeded", () => {
  it("lists what is missing, leaving out the gallery link, which arrives another way", () => {
    expect(
      stillNeeded([
        { id: "couple_names", label: "Couple names", done: true },
        { id: "venue_or_city", label: "Venue or city", done: false },
        { id: "gallery_link", label: "Gallery link on file", done: false },
        { id: "story", label: "A story or unique angle", done: false },
      ]),
    ).toEqual(["Venue or city", "A story or unique angle"]);
  });
});
