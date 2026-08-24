import { describe, expect, it } from "vitest";

import { buildChecklist, evaluatePackage } from "../src/domain/package-checklist.js";
import { EMPTY_SPEC } from "../src/domain/publication-spec.js";
import type { PublicationSpec } from "../src/domain/publication-spec.js";

const spec = (overrides: Partial<PublicationSpec> = {}): PublicationSpec => ({
  ...EMPTY_SPEC,
  ...overrides,
});

const pkg = (overrides: Partial<Parameters<typeof buildChecklist>[1]> = {}) => ({
  imageKeys: ["a.jpg"],
  descriptionMd: null,
  creditsBlockMd: null,
  attestations: {},
  ...overrides,
});

const ids = (items: ReturnType<typeof buildChecklist>) => items.map((item) => item.id);
const byId = (items: ReturnType<typeof buildChecklist>, id: string) =>
  items.find((item) => item.id === id);

describe("every package needs at least one image", () => {
  it("fails an empty selection", () => {
    const item = byId(buildChecklist(spec(), pkg({ imageKeys: [] })), "images_present");
    expect(item?.satisfied).toBe(false);
  });

  it("passes once an image is selected", () => {
    expect(byId(buildChecklist(spec(), pkg()), "images_present")?.satisfied).toBe(true);
  });

  it("applies even when the outlet publishes no image count", () => {
    expect(ids(buildChecklist(spec(), pkg()))).toContain("images_present");
  });
});

describe("image count against the outlet spec", () => {
  it("adds no count item when the outlet publishes neither bound", () => {
    expect(ids(buildChecklist(spec(), pkg()))).not.toContain("image_count");
  });

  it("fails below the minimum", () => {
    const items = buildChecklist(spec({ imgMin: 25, imgMax: 40 }), pkg({ imageKeys: ["a"] }));
    const item = byId(items, "image_count");
    expect(item?.satisfied).toBe(false);
    expect(item?.detail).toMatch(/25/);
  });

  it("fails above the maximum", () => {
    const many = Array.from({ length: 41 }, (_, i) => `${i}.jpg`);
    const items = buildChecklist(spec({ imgMin: 25, imgMax: 40 }), pkg({ imageKeys: many }));
    expect(byId(items, "image_count")?.satisfied).toBe(false);
  });

  it("passes at each boundary", () => {
    for (const count of [25, 40]) {
      const images = Array.from({ length: count }, (_, i) => `${i}.jpg`);
      const items = buildChecklist(spec({ imgMin: 25, imgMax: 40 }), pkg({ imageKeys: images }));
      expect(byId(items, "image_count")?.satisfied, `count ${count}`).toBe(true);
    }
  });

  it("honours a minimum with no maximum", () => {
    const items = buildChecklist(spec({ imgMin: 3 }), pkg({ imageKeys: ["a", "b", "c"] }));
    expect(byId(items, "image_count")?.satisfied).toBe(true);
  });

  it("honours a maximum with no minimum", () => {
    const items = buildChecklist(spec({ imgMax: 2 }), pkg({ imageKeys: ["a", "b", "c"] }));
    expect(byId(items, "image_count")?.satisfied).toBe(false);
  });
});

describe("requirements the package data can answer", () => {
  it("satisfies event_description from the description", () => {
    const withText = buildChecklist(
      spec({ requirements: ["event_description"] }),
      pkg({ descriptionMd: "They met at a bus stop." }),
    );
    expect(byId(withText, "req:event_description")?.satisfied).toBe(true);

    const without = buildChecklist(spec({ requirements: ["event_description"] }), pkg());
    expect(byId(without, "req:event_description")?.satisfied).toBe(false);
  });

  it("does not accept a whitespace-only description", () => {
    const items = buildChecklist(
      spec({ requirements: ["event_description"] }),
      pkg({ descriptionMd: "   \n  " }),
    );
    expect(byId(items, "req:event_description")?.satisfied).toBe(false);
  });

  it("satisfies full_vendor_credits from the credits block", () => {
    const items = buildChecklist(
      spec({ requirements: ["full_vendor_credits"] }),
      pkg({ creditsBlockMd: "Florist: Stems" }),
    );
    expect(byId(items, "req:full_vendor_credits")?.satisfied).toBe(true);
  });

  it("satisfies couple_love_story from the description", () => {
    const items = buildChecklist(
      spec({ requirements: ["couple_love_story"] }),
      pkg({ descriptionMd: "How they met." }),
    );
    expect(byId(items, "req:couple_love_story")?.satisfied).toBe(true);
  });

  it("ignores an attestation for a requirement the data answers", () => {
    // Ticking a box must not substitute for the description actually existing.
    const items = buildChecklist(
      spec({ requirements: ["event_description"] }),
      pkg({ attestations: { "req:event_description": true } }),
    );
    expect(byId(items, "req:event_description")?.satisfied).toBe(false);
  });
});

describe("requirements only a human can answer", () => {
  it("starts unsatisfied", () => {
    const items = buildChecklist(spec({ requirements: ["no_watermarks"] }), pkg());
    expect(byId(items, "req:no_watermarks")?.satisfied).toBe(false);
  });

  it("is satisfied once attested", () => {
    const items = buildChecklist(
      spec({ requirements: ["no_watermarks"] }),
      pkg({ attestations: { "req:no_watermarks": true } }),
    );
    expect(byId(items, "req:no_watermarks")?.satisfied).toBe(true);
  });

  it("treats an unrecognised requirement as needing attestation, never as met", () => {
    // A spec can gain a requirement nobody has taught this module about. The
    // safe default is to make a person look at it.
    const items = buildChecklist(spec({ requirements: ["some_new_outlet_rule"] }), pkg());
    const item = byId(items, "req:some_new_outlet_rule");
    expect(item?.kind).toBe("attested");
    expect(item?.satisfied).toBe(false);
  });

  it("renders an unrecognised requirement readably", () => {
    const items = buildChecklist(spec({ requirements: ["some_new_outlet_rule"] }), pkg());
    expect(byId(items, "req:some_new_outlet_rule")?.label).toBe("Some new outlet rule");
  });

  it("ignores a stored attestation for a requirement the outlet dropped", () => {
    const items = buildChecklist(
      spec({ requirements: ["no_watermarks"] }),
      pkg({ attestations: { "req:no_watermarks": true, "req:removed_rule": true } }),
    );
    expect(ids(items)).not.toContain("req:removed_rule");
  });

  it("treats a non-true attestation value as unchecked", () => {
    const items = buildChecklist(
      spec({ requirements: ["no_watermarks"] }),
      pkg({ attestations: { "req:no_watermarks": false } }),
    );
    expect(byId(items, "req:no_watermarks")?.satisfied).toBe(false);
  });
});

describe("watermark and size rules from the spec", () => {
  it("asks for confirmation when the outlet forbids watermarks", () => {
    const items = buildChecklist(spec({ watermarksAllowed: false }), pkg());
    expect(byId(items, "no_watermarks")?.kind).toBe("attested");
  });

  it("asks nothing when the outlet allows watermarks", () => {
    expect(ids(buildChecklist(spec({ watermarksAllowed: true }), pkg()))).not.toContain(
      "no_watermarks",
    );
  });

  it("asks nothing when the rule is unknown, rather than inventing one", () => {
    expect(ids(buildChecklist(spec(), pkg()))).not.toContain("no_watermarks");
  });

  it("asks for confirmation when the outlet wants web-size images", () => {
    expect(ids(buildChecklist(spec({ size: "web" }), pkg()))).toContain("web_size");
  });
});

describe("evaluatePackage", () => {
  it("is incomplete while anything is unsatisfied", () => {
    const result = evaluatePackage(spec({ requirements: ["no_watermarks"] }), pkg());
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["req:no_watermarks"]);
  });

  it("is complete when every item is satisfied", () => {
    const result = evaluatePackage(
      spec({ imgMin: 1, imgMax: 3, requirements: ["event_description", "no_watermarks"] }),
      pkg({
        imageKeys: ["a", "b"],
        descriptionMd: "The story.",
        attestations: { "req:no_watermarks": true },
      }),
    );
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("is incomplete for an empty package even with no outlet requirements", () => {
    expect(evaluatePackage(spec(), pkg({ imageKeys: [] })).complete).toBe(false);
  });

  it("lists every unsatisfied item, not just the first", () => {
    const result = evaluatePackage(
      spec({ imgMin: 10, requirements: ["event_description", "no_watermarks"] }),
      pkg({ imageKeys: ["a"] }),
    );
    expect(result.missing).toEqual([
      "image_count",
      "req:event_description",
      "req:no_watermarks",
    ]);
  });

  it("returns the items alongside the verdict, so the UI needs one call", () => {
    const result = evaluatePackage(spec(), pkg());
    expect(result.items.length).toBeGreaterThan(0);
  });
});

describe("checklist shape", () => {
  it("gives every item a stable id, a label, and a kind", () => {
    const items = buildChecklist(
      spec({ imgMin: 1, watermarksAllowed: false, size: "web", requirements: ["event_description"] }),
      pkg(),
    );
    for (const item of items) {
      expect(item.id).toMatch(/\S/);
      expect(item.label).toMatch(/\S/);
      expect(["derived", "attested"]).toContain(item.kind);
    }
  });

  it("does not repeat an id", () => {
    const items = buildChecklist(
      spec({ watermarksAllowed: false, requirements: ["no_watermarks"] }),
      pkg(),
    );
    expect(new Set(ids(items)).size).toBe(items.length);
  });
});

describe("the couple's limits become a checklist item", () => {
  const withConsent = (
    consent: { nameDisplay?: string | null; consentNotes?: string | null },
    attestations: Record<string, boolean> = {},
  ) =>
    buildChecklist(spec(), pkg({ attestations }), {
      nameDisplay: consent.nameDisplay ?? null,
      consentNotes: consent.consentNotes ?? null,
    });

  it("adds no item when the couple set no limits", () => {
    expect(ids(withConsent({}))).not.toContain("consent_limits");
  });

  it("adds an item when a name display preference exists", () => {
    const item = byId(withConsent({ nameDisplay: "first names only" }), "consent_limits");
    expect(item?.kind).toBe("attested");
    expect(item?.satisfied).toBe(false);
  });

  it("adds an item when there are consent notes", () => {
    expect(ids(withConsent({ consentNotes: "no family photos" }))).toContain("consent_limits");
  });

  it("quotes the couple's actual words, so the person ticking sees them", () => {
    const item = byId(
      withConsent({ nameDisplay: "first names only", consentNotes: "no family photos" }),
      "consent_limits",
    );
    expect(item?.detail).toContain("first names only");
    expect(item?.detail).toContain("no family photos");
  });

  it("is satisfied only once attested", () => {
    const item = byId(
      withConsent({ nameDisplay: "first names only" }, { consent_limits: true }),
      "consent_limits",
    );
    expect(item?.satisfied).toBe(true);
  });

  it("blocks completion until it is ticked", () => {
    const result = evaluatePackage(
      spec(),
      pkg({ imageKeys: ["a"] }),
      { nameDisplay: "first names only", consentNotes: null },
    );
    expect(result.missing).toContain("consent_limits");
  });

  it("ignores whitespace-only limits", () => {
    expect(ids(withConsent({ nameDisplay: "   ", consentNotes: "  " }))).not.toContain(
      "consent_limits",
    );
  });
});
