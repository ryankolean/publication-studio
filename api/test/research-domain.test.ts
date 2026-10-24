import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { canonicalJson, sha256Hex } from "../src/domain/research/canonical.js";
import { parseContacts } from "../src/domain/research/contacts.js";
import { conflictsWith, diffResearch } from "../src/domain/research/diff.js";
import { projectPublication } from "../src/domain/research/project.js";
import { parseResearchVocab, validateFactEdit, validatePublicationFile } from "../src/domain/research/schema.js";
import type { PublicationFile, ResearchVocab } from "../src/domain/research/schema.js";
import { parsePublicationSpec } from "../src/domain/publication-spec.js";

const here = dirname(fileURLToPath(import.meta.url));
const RESEARCH = join(here, "../../research");
const TODAY = "2026-10-23";
const loadYaml = (path: string): unknown => parse(readFileSync(path, "utf8"));

function vocab(): ResearchVocab {
  const result = parseResearchVocab(loadYaml(join(RESEARCH, "vocab/tags.yaml")), loadYaml(join(RESEARCH, "vocab/geo.yaml")));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function fileFrom(path: string, change: (raw: Record<string, any>) => void = () => {}): PublicationFile {
  const raw = loadYaml(path) as Record<string, any>;
  change(raw);
  const result = validatePublicationFile(raw, vocab(), TODAY);
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.value;
}

const fixture = (change?: (raw: Record<string, any>) => void) =>
  fileFrom(join(here, "fixtures/research/pub-example-weddings.yaml"), change);
const outlet = (id: string) => fileFrom(join(RESEARCH, `publications/${id}.yaml`));

describe("canonical JSON and its hash", () => {
  it("orders keys at every depth, so equal data hashes equal", async () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(await sha256Hex(canonicalJson({ a: 1, b: 2 }))).toBe(await sha256Hex(canonicalJson({ b: 2, a: 1 })));
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("the private contacts overlay", () => {
  const good = {
    id: "pub-example-weddings",
    submission_inbox: { email: "weddings@example.com", source: "https://example.com/submit", read: "2026-10-20" },
    editors: [{ name: "Jordan Example", role: "Weddings Editor", email: "jordan@example.com", source: "https://example.com/about", read: "2026-10-21" }],
  };

  it("reads an inbox and editors, and fills in what is left out", () => {
    expect(parseContacts(good, TODAY)).toEqual({ ok: true, value: good });
    expect(parseContacts({ id: "pub-example-weddings" }, TODAY)).toEqual({
      ok: true,
      value: { id: "pub-example-weddings", submission_inbox: null, editors: [] },
    });
    const noRole = { ...good, editors: [{ ...good.editors[0], role: undefined }] };
    expect(parseContacts(noRole, TODAY)).toMatchObject({ ok: true, value: { editors: [{ role: null }] } });
  });

  const cases: Array<[string, unknown, string]> = [
    ["a file that is not a mapping", "weddings@example.com", "contacts"],
    ["a bad outlet id", { ...good, id: "Example" }, "id"],
    ["an address that is not an email", { ...good, submission_inbox: { ...good.submission_inbox, email: "weddings" } }, "submission_inbox.email"],
    ["a source that is not a web page", { ...good, submission_inbox: { ...good.submission_inbox, source: "mailto:x" } }, "submission_inbox.source"],
    ["a read date after today", { ...good, submission_inbox: { ...good.submission_inbox, read: "2026-10-24" } }, "submission_inbox.read"],
    ["an inbox that is not a mapping", { ...good, submission_inbox: "weddings@example.com" }, "submission_inbox"],
    ["editors that are not a list", { ...good, editors: {} }, "editors"],
    ["an editor with no name", { ...good, editors: [{ ...good.editors[0], name: " " }] }, "editors[0].name"],
    ["an unknown field", { ...good, phone: "555" }, "phone"],
    ["an editor that is not a mapping", { ...good, editors: ["Jordan"] }, "editors[0].name"],
  ];
  for (const [name, raw, field] of cases) {
    it(`rejects ${name}`, () => {
      const result = parseContacts(raw, TODAY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((error) => error.field)).toContain(field);
    });
  }
});

describe("projecting research onto the publication columns", () => {
  it("fills every column the wizard and the checklist already read", () => {
    const projected = projectPublication(fixture(), {
      id: "pub-example-weddings",
      submission_inbox: { email: "weddings@example.com", source: "https://example.com/submit", read: "2026-10-20" },
      editors: [],
    });
    expect(projected.columns).toEqual({
      id: "pub-example-weddings",
      name: "Example Weddings",
      tier: "primary",
      kind: "regional_magazine",
      method: "web_form",
      submission_url: "https://example.com/submit/form",
      contact_email: "weddings@example.com",
      spec_json: expect.any(String),
      exclusivity_policy: "exclusive_required",
      counts_own_blog_as_published: 0,
      typical_response_days: 42,
      response_window_note: "If you have not heard from us in six weeks, we have passed.",
      earned_or_paid: "earned",
      taste_notes: "Light-filled lakeside and garden weddings with full vendor detail.",
      last_verified: "2026-10-21",
      match_json: expect.any(String),
    });
    expect(projected.tags).toEqual(["lakefront", "garden_botanical", "romantic"]);
  });

  it("writes a spec the existing parser reads, with checklist items from the facts", () => {
    const spec = parsePublicationSpec(projectPublication(fixture(), null).columns.spec_json);
    expect(spec).toEqual({
      imgMin: 40,
      imgMax: null,
      size: "web",
      watermarksAllowed: false,
      videoAccepted: null,
      videoNotes: null,
      requirements: [
        "no_watermarks",
        "full_vendor_credits",
        "event_description",
        "unpublished_only",
        "Images in the order the day happened.",
      ],
      notes: null,
    });
  });

  it("keeps unknown as unknown in every column that can say so", () => {
    const projected = projectPublication(
      fixture((raw) => {
        raw["routes"] = { value: "unknown", checked: ["guidelines"] };
        raw["rules"].exclusivity = { value: "unknown", checked: ["guidelines"] };
        raw["rules"].prior_exposure.blogs = { value: "unknown", checked: ["guidelines"] };
        raw["timing"].response_window = { value: "unknown", checked: ["guidelines"] };
        raw["economics"].publication_fee = { value: "unknown", checked: ["guidelines"] };
        raw["content"].style_tags = { value: "unknown", checked: ["feature_lake"] };
        raw["package"].size = { value: "unknown", checked: ["form"] };
        raw["package"].image_min = { value: "none", cite: [{ source: "form", quote: "No minimum." }] };
        delete raw["taste_summary"];
      }),
      null,
    );
    expect(projected.columns).toMatchObject({
      method: null,
      submission_url: null,
      contact_email: null,
      exclusivity_policy: "unknown",
      counts_own_blog_as_published: null,
      typical_response_days: null,
      response_window_note: null,
      earned_or_paid: "mixed",
      taste_notes: null,
    });
    expect(projected.tags).toEqual([]);
    expect(parsePublicationSpec(projected.columns.spec_json)).toMatchObject({ imgMin: null, size: "unknown" });
  });

  it("reads the outlet's own fee, blog and route rules", () => {
    const paid = projectPublication(
      fixture((raw) => {
        raw["economics"].publication_fee = { value: { amount: "undisclosed", currency: "USD" }, cite: [{ source: "kit", quote: "A fee applies." }] };
        raw["rules"].prior_exposure.blogs.value = "disqualifies";
        raw["package"].size.value = "both";
        raw["routes"].value[0].preferred = false;
        raw["routes"].value[1].preferred = true;
      }),
      null,
    );
    expect(paid.columns).toMatchObject({ earned_or_paid: "paid", counts_own_blog_as_published: 1, method: "email", submission_url: null });
    expect(parsePublicationSpec(paid.columns.spec_json).size).toBe("unknown");
  });

  it("maps every route platform onto the existing method column", () => {
    expect(projectPublication(outlet("pub-the-knot"), null).columns.method).toBe("aggregator");
    expect(projectPublication(outlet("pub-junebug-weddings"), null).columns.method).toBe("portal");
    const pitch = projectPublication(
      fixture((raw) => {
        raw["routes"].value = [{ platform: "pitch_only", account_required: "unknown", steps: ["Pitch an editor."] }];
      }),
      null,
    );
    expect(pitch.columns.method).toBeNull();
  });

  it("projects every outlet on file", () => {
    for (const id of ["pub-brides", "pub-loverly", "pub-marry-me-tampa-bay", "pub-vogue-weddings"]) {
      const { columns } = projectPublication(outlet(id), null);
      expect(columns.id).toBe(id);
      expect(columns.last_verified).toMatch(/^2026-10-\d\d$/);
    }
  });
});

describe("what changed between two research versions", () => {
  it("lists every fact of a new outlet as added", () => {
    const changes = diffResearch(null, fixture());
    expect(changes.length).toBeGreaterThan(40);
    expect(changes).toContainEqual({ field: "rules.freshness_window_months", before: null, after: 12 });
    expect(changes).toContainEqual({ field: "content.styled_shoot", before: null, after: "unknown" });
  });

  it("reports no change when only the pages were re-read", () => {
    const reread = fixture((raw) => {
      raw["sources"].guidelines.read = "2026-10-23";
      raw["content"].real_wedding.cite[0].quote = "We publish real weddings year round.";
      raw["content"].styled_shoot.note = "Re-checked.";
    });
    expect(diffResearch(fixture(), reread)).toEqual([]);
  });

  it("names each fact, judgment and insight list that changed", () => {
    const after = fixture((raw) => {
      raw["tier"] = "secondary";
      raw["rules"].freshness_window_months = { value: "unknown", checked: ["guidelines"] };
      raw["timing"].response_window.value.days = 60;
      raw["insight"].secret_sauce = [];
      delete raw["sources"].editor_interview;
    });
    expect(diffResearch(fixture(), after)).toEqual([
      { field: "tier", before: "primary", after: "secondary" },
      { field: "rules.freshness_window_months", before: 12, after: "unknown" },
      { field: "timing.response_window", before: { days: 42, replies: "success_only" }, after: { days: 60, replies: "success_only" } },
      { field: "insight.secret_sauce", before: ["Lead with the couple's story; the editor reads it before opening the gallery."], after: [] },
    ]);
  });

  it("flags a change to a field the photographer corrected", () => {
    const changes = diffResearch(fixture(), fixture((raw) => (raw["tier"] = "dream")));
    expect(conflictsWith(changes, ["tier", "timing.response_window"])).toEqual([
      { field: "tier", before: "primary", after: "dream" },
    ]);
  });
});

describe("validating a correction to one fact", () => {
  const check = (field: string, value: unknown) => validateFactEdit(field, value, vocab(), TODAY);

  it("accepts a value the research file itself would accept", () => {
    expect(check("timing.response_window", { days: 30, replies: "all" })).toEqual({ ok: true, value: { days: 30, replies: "all" } });
    expect(check("rules.prior_exposure.social", "allowed")).toEqual({ ok: true, value: "allowed" });
    expect(check("package.image_max", "none")).toEqual({ ok: true, value: "none" });
  });

  it("rejects a value the research file would reject", () => {
    expect(check("timing.response_window", { days: -1, replies: "all" })).toMatchObject({
      ok: false,
      errors: [{ field: "timing.response_window.days" }],
    });
    expect(check("content.style_tags", ["sparkly"])).toMatchObject({ ok: false });
  });

  it("refuses unknown, email addresses, and anything that is not a fact", () => {
    expect(check("tier", "unknown")).toMatchObject({ ok: false, errors: [{ message: expect.stringMatching(/not a fact/) }] });
    expect(check("content.real_wedding", "unknown")).toMatchObject({ ok: false, errors: [{ message: expect.stringMatching(/research/) }] });
    expect(check("rights.credit_format", "Email jo@example.com")).toMatchObject({ ok: false, errors: [{ message: expect.stringMatching(/contacts/) }] });
    expect(check("rules.nope", 1)).toMatchObject({ ok: false });
    expect(check("insight.secret_sauce", [])).toMatchObject({ ok: false });
    expect(check("content.real_wedding.value", true)).toMatchObject({ ok: false });
  });
});

describe("applying the photographer's corrections over the research", () => {
  it("replaces each corrected fact and leaves the rest, without touching the original", async () => {
    const { applyEdits } = await import("../src/domain/research/edits.js");
    const original = fixture();
    const corrected = applyEdits(original, [
      { field: "timing.response_window", value: { days: 30, replies: "all" } },
      { field: "rules.prior_exposure.social", value: "disqualifies" },
    ]);
    expect(corrected.timing.response_window).toEqual({ known: true, value: { days: 30, replies: "all" }, cite: [], note: "Corrected by the photographer." });
    expect(corrected.rules.prior_exposure.social).toMatchObject({ known: true, value: "disqualifies" });
    expect(corrected.package).toEqual(original.package);
    expect(original.timing.response_window).toMatchObject({ value: { days: 42 } });
    expect(projectPublication(corrected, null).columns.typical_response_days).toBe(30);
  });

  it("ignores a correction whose field the research no longer has", async () => {
    const { applyEdits } = await import("../src/domain/research/edits.js");
    expect(applyEdits(fixture(), [{ field: "rules.gone_rule", value: 1 }])).toEqual(fixture());
  });
});
