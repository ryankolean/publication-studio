import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { migratedDb } from "./helpers/schema-db.js";
import { parsePublicationSpec } from "../src/domain/publication-spec.js";
import { buildChecklist, evaluatePackage } from "../src/domain/package-checklist.js";
import type { PackageInput } from "../src/domain/package-checklist.js";

/**
 * The synthetic tests prove the rules. These prove the rules produce something
 * sensible for the eight outlets actually seeded, which is where a mismatch
 * between spec vocabulary and checklist vocabulary would show up.
 */
let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
});

afterEach(() => {
  db.close();
});

const specFor = (id: string) => {
  const row = db.prepare("SELECT spec_json FROM publications WHERE id = ?").get(id) as {
    spec_json: string;
  };
  return parsePublicationSpec(row.spec_json);
};

const allSpecs = () =>
  (db.prepare("SELECT id, spec_json FROM publications ORDER BY id").all() as Array<{
    id: string;
    spec_json: string;
  }>).map((row) => ({ id: row.id, spec: parsePublicationSpec(row.spec_json) }));

const emptyPackage: PackageInput = {
  imageKeys: [],
  descriptionMd: null,
  creditsBlockMd: null,
  attestations: {},
};

describe("every seeded outlet produces a usable checklist", () => {
  it("gives each outlet at least one item", () => {
    for (const { id, spec } of allSpecs()) {
      expect(buildChecklist(spec, emptyPackage).length, id).toBeGreaterThan(0);
    }
  });

  it("blocks an empty package everywhere", () => {
    for (const { id, spec } of allSpecs()) {
      expect(evaluatePackage(spec, emptyPackage).complete, id).toBe(false);
    }
  });

  it("labels every item readably, with no leftover snake_case", () => {
    for (const { id, spec } of allSpecs()) {
      for (const item of buildChecklist(spec, emptyPackage)) {
        expect(item.label, `${id}/${item.id}`).not.toMatch(/_/);
      }
    }
  });
});

describe("Carats & Cake", () => {
  it("asks for the portal mechanics the live guidelines record", () => {
    const items = buildChecklist(specFor("pub-carats-and-cake"), emptyPackage);
    const ids = items.map((item) => item.id);
    expect(ids).toContain("no_watermarks");
    expect(ids).toContain("web_size");
    expect(ids).toContain("req:account_required");
    expect(ids).toContain("req:photographer_full_gallery_link");
    expect(items.find((item) => item.id === "req:full_vendor_credits")?.kind).toBe("derived");
  });

  it("sets no image count, because the outlet publishes none", () => {
    const ids = buildChecklist(specFor("pub-carats-and-cake"), emptyPackage).map((i) => i.id);
    expect(ids).not.toContain("image_count");
  });

  it("completes once the images exist and every attestation is ticked", () => {
    const spec = specFor("pub-carats-and-cake");
    const attestations: Record<string, boolean> = {};
    for (const item of buildChecklist(spec, emptyPackage)) {
      if (item.kind === "attested") attestations[item.id] = true;
    }

    const result = evaluatePackage(spec, {
      imageKeys: ["a.jpg", "b.jpg"],
      descriptionMd: "The story.",
      creditsBlockMd: "Florist: Stems",
      attestations,
    });
    expect(result.missing).toEqual([]);
    expect(result.complete).toBe(true);
  });
});

describe("Loverly", () => {
  it("enforces the published 30 to 40 image range", () => {
    const spec = specFor("pub-loverly");
    const under = evaluatePackage(spec, { ...emptyPackage, imageKeys: ["a"] });
    expect(under.missing).toContain("image_count");

    const images = Array.from({ length: 30 }, (_, i) => `${i}.jpg`);
    const inRange = buildChecklist(spec, { ...emptyPackage, imageKeys: images });
    expect(inRange.find((item) => item.id === "image_count")?.satisfied).toBe(true);
  });

  it("requires a description and a credits block, not a tick", () => {
    const spec = specFor("pub-loverly");
    const images = Array.from({ length: 30 }, (_, i) => `${i}.jpg`);

    const ticked = evaluatePackage(spec, {
      imageKeys: images,
      descriptionMd: null,
      creditsBlockMd: null,
      attestations: { "req:event_description": true, "req:full_vendor_credits": true },
    });
    expect(ticked.missing).toContain("req:event_description");
    expect(ticked.missing).toContain("req:full_vendor_credits");
  });
});

describe("Brides", () => {
  it("enforces the 100 to 200 image range and makes exclusivity an attestation", () => {
    const items = buildChecklist(specFor("pub-brides"), emptyPackage);
    const ids = items.map((i) => i.id);
    expect(ids).toContain("images_present");
    expect(ids).toContain("image_count");
    expect(items.find((i) => i.id === "req:exclusive_30_days_after_publication")?.kind).toBe("attested");
  });
});

describe("dream outlets", () => {
  it("still produce the one universal item when the spec is empty", () => {
    const ids = buildChecklist(specFor("pub-vogue-weddings"), emptyPackage).map((i) => i.id);
    expect(ids).toEqual(["images_present"]);
  });
});
