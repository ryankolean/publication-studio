import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { migratedDb } from "./helpers/schema-db.js";
import { EMPTY_SPEC, parsePublicationSpec } from "../src/domain/publication-spec.js";

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
});

afterEach(() => {
  db.close();
});

const rows = () =>
  db.prepare("SELECT * FROM publications ORDER BY id").all() as Array<Record<string, unknown>>;

const byId = (id: string) =>
  db.prepare("SELECT * FROM publications WHERE id = ?").get(id) as Record<string, unknown>;

describe("publication seed", () => {
  it("seeds the eight target outlets plus the two dream outlets", () => {
    expect(rows()).toHaveLength(10);
  });

  it("seeds them under stable ids", () => {
    expect(rows().map((row) => row["id"])).toEqual([
      "pub-brides",
      "pub-carats-and-cake",
      "pub-loverly",
      "pub-over-the-moon",
      "pub-people-weddings",
      "pub-the-anti-bride",
      "pub-the-lane",
      "pub-vogue-weddings",
      "pub-wed-vibes",
      "pub-wezoree",
    ]);
  });

  it("splits five primary, three secondary and two dream outlets", () => {
    const tiers = rows().map((row) => row["tier"]);
    expect(tiers.filter((tier) => tier === "primary")).toHaveLength(5);
    expect(tiers.filter((tier) => tier === "secondary")).toHaveLength(3);
    expect(tiers.filter((tier) => tier === "dream")).toHaveLength(2);
  });

  it("marks every seeded outlet active", () => {
    expect(rows().every((row) => row["active"] === 1)).toBe(true);
  });
});

describe("honesty of the seed", () => {
  it("dates last_verified to the research pass that read each live page", () => {
    // Migration 0006 re-verified every outlet on 2026-10-19 and replaced the
    // design-doc transcription dated 2026-08-16. The date is a claim that a
    // person read the page that day, not the migration time.
    expect(rows().every((row) => row["last_verified"] === "2026-10-19")).toBe(true);
  });

  it("records exclusivity only where the outlet states it", () => {
    const policy = Object.fromEntries(rows().map((row) => [row["id"], row["exclusivity_policy"]]));
    expect(policy).toMatchObject({
      "pub-brides": "exclusive_required",
      "pub-the-anti-bride": "exclusive_required",
      "pub-wed-vibes": "exclusive_preferred",
      "pub-loverly": "non_exclusive",
      "pub-carats-and-cake": "unknown",
      "pub-over-the-moon": "unknown",
      "pub-the-lane": "unknown",
      "pub-wezoree": "unknown",
      "pub-people-weddings": "unknown",
      "pub-vogue-weddings": "unknown",
    });
  });

  it("knows only Brides counts a website or social post as prior publication", () => {
    expect(byId("pub-brides")["counts_own_blog_as_published"]).toBe(1);
    const others = rows().filter((row) => row["id"] !== "pub-brides");
    expect(others.every((row) => row["counts_own_blog_as_published"] === null)).toBe(true);
  });

  it("records no submission method for the dream outlets, which publish none", () => {
    expect(byId("pub-people-weddings")["method"]).toBeNull();
    expect(byId("pub-vogue-weddings")["method"]).toBeNull();
    expect(byId("pub-people-weddings")["submission_url"]).toBeNull();
  });

  it("flags pay-to-publish and partnership-gated outlets, and leaves the rest earned", () => {
    expect(byId("pub-wezoree")["earned_or_paid"]).toBe("paid");
    expect(byId("pub-brides")["earned_or_paid"]).toBe("mixed");
    expect(byId("pub-the-anti-bride")["earned_or_paid"]).toBe("mixed");
    const rest = rows().filter(
      (row) => !["pub-wezoree", "pub-brides", "pub-the-anti-bride"].includes(String(row["id"])),
    );
    expect(rest.every((row) => row["earned_or_paid"] === "earned")).toBe(true);
  });

  it("stores a response window only with the outlet's own wording beside it", () => {
    for (const row of rows()) {
      if (row["typical_response_days"] !== null) {
        expect(row["response_window_note"], String(row["id"])).toEqual(expect.any(String));
      }
    }
    expect(rows().filter((row) => row["typical_response_days"] !== null)).toHaveLength(7);
    expect(byId("pub-carats-and-cake")["typical_response_days"]).toBeNull();
  });

  it("converts business-day windows to calendar days", () => {
    expect(byId("pub-the-lane")["typical_response_days"]).toBe(14);
    expect(byId("pub-wed-vibes")["typical_response_days"]).toBe(29);
  });

  it("keeps every contact email out of the public repo", () => {
    expect(rows().every((row) => row["contact_email"] === null)).toBe(true);
    for (const row of rows()) {
      expect(String(row["spec_json"])).not.toMatch(/@/);
      expect(String(row["taste_notes"] ?? "")).not.toMatch(/@/);
    }
  });
});

describe("seeded specs parse", () => {
  it("produces a usable spec for every outlet with a public route", () => {
    for (const row of rows()) {
      if (row["method"] === null) continue;
      const spec = parsePublicationSpec(String(row["spec_json"]));
      expect(spec, `${String(row["id"])} spec did not parse`).not.toEqual(EMPTY_SPEC);
    }
  });

  it("captures the Loverly image range and the requirements the checklist derives", () => {
    const spec = parsePublicationSpec(String(byId("pub-loverly")["spec_json"]));
    expect(spec.imgMin).toBe(30);
    expect(spec.imgMax).toBe(40);
    expect(spec.requirements).toContain("full_vendor_credits");
    expect(spec.requirements).toContain("event_description");
    expect(spec.requirements).toContain("couple_love_story");
    expect(spec.videoAccepted).toBe(true);
  });

  it("uses the checklist's names for requirements it can derive, never an alias", () => {
    const derived = ["event_description", "couple_love_story", "full_vendor_credits"];
    const aliases = ["couple_story", "wedding_notes_story", "full_vendor_list", "description"];
    for (const row of rows()) {
      const spec = parsePublicationSpec(String(row["spec_json"]));
      for (const alias of aliases) expect(spec.requirements, String(row["id"])).not.toContain(alias);
      void derived;
    }
  });

  it("captures the Carats & Cake watermark rule and leaves its unstated window null", () => {
    const row = byId("pub-carats-and-cake");
    const spec = parsePublicationSpec(String(row["spec_json"]));
    expect(spec.watermarksAllowed).toBe(false);
    expect(spec.size).toBe("web");
    expect(spec.requirements).toContain("full_vendor_credits");
    expect(row["typical_response_days"]).toBeNull();
  });

  it("leaves image counts null where the outlet publishes none", () => {
    const spec = parsePublicationSpec(String(byId("pub-carats-and-cake")["spec_json"]));
    expect(spec.imgMin).toBeNull();
    expect(spec.imgMax).toBeNull();
  });

  it("records the live submission url for every outlet with a public route", () => {
    expect(byId("pub-over-the-moon")["submission_url"]).toBe(
      "https://overthemoon.com/pages/wedding-submissions",
    );
    expect(byId("pub-loverly")["submission_url"]).toBe("https://loverly.com/tools/submit-wedding");
    expect(byId("pub-wed-vibes")["submission_url"]).toBe("https://wedvibes.media/submissions/");
    for (const row of rows()) {
      if (row["method"] !== null) expect(row["submission_url"], String(row["id"])).not.toBeNull();
    }
  });
});
