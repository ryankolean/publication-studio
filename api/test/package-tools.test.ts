import { describe, expect, it } from "vitest";

import type { ChecklistItem } from "../src/domain/package-checklist.js";
import { confirmItems, confirmPreview, packageReport, pickPhotos, withTicks } from "../src/domain/package-tools.js";
import type { PackageViewLike } from "../src/domain/package-tools.js";

const pool = [
  { key: "events/w1/3f9a1c2e-0000-4000-8000-000000000001.jpg" },
  { key: "events/w1/a1b2c3d4-0000-4000-8000-000000000002.jpg" },
  { key: "events/w1/0badf00d-0000-4000-8000-000000000003.png" },
];

describe("pickPhotos", () => {
  it("takes numbers, refs and 'Photo N', in the order given, each once", () => {
    expect(pickPhotos(pool, ["3", "3F9A1C2E", "Photo 2", "a1b2c3d4"])).toEqual({
      ok: true,
      keys: [pool[2]?.key, pool[0]?.key, pool[1]?.key],
    });
    expect(pickPhotos(pool, [])).toEqual({ ok: true, keys: [] });
  });

  it("refuses the set over any pick that names no photo", () => {
    expect(pickPhotos(pool, ["1", "4", "ffffffff", "the beach one", "0"])).toEqual({ ok: false, unknown: ["4", "ffffffff", "the beach one", "0"] });
  });
});

const item = (id: string, kind: ChecklistItem["kind"], satisfied: boolean, detail?: string): ChecklistItem => ({
  id,
  kind,
  label: `Label ${id}`,
  satisfied,
  ...(detail === undefined ? {} : { detail }),
});

describe("confirmItems", () => {
  const checklist = [item("image_count", "derived", false), item("no_watermarks", "attested", true), item("consent_names", "attested", false, "First names only")];

  it("finds her items by id or by their own words, ignoring case and spaces, each once", () => {
    expect(confirmItems(checklist, ["consent_names", " label CONSENT_NAMES "])).toEqual({ ok: true, items: [checklist[2]] });
  });

  it("refuses anything that is not hers to confirm", () => {
    expect(confirmItems(checklist, ["image_count", "made_up", "consent_names"])).toEqual({ ok: false, unknown: ["image_count", "made_up"] });
  });

  it("words the lines she says yes to, and keeps what is already ticked", () => {
    expect(confirmPreview("Casey & Jordan", "The Knot", [checklist[2] as ChecklistItem, checklist[1] as ChecklistItem])).toEqual([
      "For Casey & Jordan's package for The Knot, she confirms:",
      "- Label consent_names (First names only)",
      "- Label no_watermarks",
    ]);
    expect(withTicks(checklist, ["consent_names"])).toEqual({ no_watermarks: true, consent_names: true });
  });
});

describe("packageReport", () => {
  const view = (overrides: Partial<PackageViewLike> = {}): PackageViewLike => ({
    id: "pkg-1",
    publication: { name: "The Knot", spec: { imgMin: 20, imgMax: 60 } },
    imageKeys: ["a", "b"],
    descriptionMd: "A sunny day.",
    creditsBlockMd: "Florist: Petal and Stem",
    consent: { nameDisplay: "First names only", consentNotes: null },
    checklist: [item("image_count", "derived", false, "2 selected; this outlet expects 20 to 60."), item("no_watermarks", "attested", false), item("credits", "derived", true)],
    complete: false,
    ...overrides,
  });

  it("words the package and splits the checklist into done and to do", () => {
    expect(packageReport(view(), false)).toEqual({
      package: "pkg-1",
      outlet: "The Knot",
      photos: { chosen: 2, wanted: "20 to 60" },
      writeUp: "12 characters",
      credits: "set",
      coupleLimits: ["First names only"],
      done: ["Label credits"],
      toDo: [
        { id: "image_count", item: "Label image_count", detail: "2 selected; this outlet expects 20 to 60." },
        { id: "no_watermarks", item: "Label no_watermarks", sheConfirms: true },
      ],
      complete: false,
    });
  });

  it("returns the text on request, and words what is missing or open-ended", () => {
    const report = packageReport(
      view({ descriptionMd: null, creditsBlockMd: "  ", consent: { nameDisplay: " ", consentNotes: "No faces of guests" }, publication: null }),
      true,
    );
    expect(report).toMatchObject({ outlet: null, photos: { chosen: 2 }, writeUp: "none yet", credits: "none yet", coupleLimits: ["No faces of guests"] });
    expect(report).toHaveProperty("writeUpText", null);
    expect(report).toHaveProperty("creditsText", "  ");
    expect(packageReport(view({ consent: { nameDisplay: null, consentNotes: null } }), false)).not.toHaveProperty("coupleLimits");

    const range = (imgMin: number | null, imgMax: number | null) =>
      packageReport(view({ publication: { name: "X", spec: { imgMin, imgMax } } }), false).photos;
    expect(range(10, null)).toEqual({ chosen: 2, wanted: "at least 10" });
    expect(range(null, 40)).toEqual({ chosen: 2, wanted: "at most 40" });
    expect(range(null, null)).toEqual({ chosen: 2 });
  });
});
