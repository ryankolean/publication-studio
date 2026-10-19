import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { migratedDb } from "./helpers/schema-db.js";
import { TAG_CATEGORIES, tagLabel } from "../src/domain/tags.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, "../migrations/0006_publication_research.sql");
const PROVENANCE = join(here, "../../docs/research/publications-2026-10-19.json");

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
});

afterEach(() => {
  db.close();
});

const tags = () =>
  db.prepare("SELECT id, category, sort_order FROM tags ORDER BY category, sort_order").all() as Array<{
    id: string;
    category: string;
    sort_order: number;
  }>;

describe("tag vocabulary", () => {
  it("covers every category and nothing outside the fixed list", () => {
    const categories = new Set(tags().map((tag) => tag.category));
    expect([...categories].sort()).toEqual([...TAG_CATEGORIES].sort());
  });

  it("keeps each category between 6 and 15 values, enough to match on, few enough to pick from", () => {
    for (const category of TAG_CATEGORIES) {
      const count = tags().filter((tag) => tag.category === category).length;
      expect(count, category).toBeGreaterThanOrEqual(6);
      expect(count, category).toBeLessThanOrEqual(15);
    }
  });

  it("uses snake_case ids that read as labels", () => {
    for (const tag of tags()) {
      expect(tag.id).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
      expect(tagLabel(tag.id)).not.toMatch(/_/);
    }
  });

  it("rejects a category outside the list", () => {
    expect(() =>
      db.prepare("INSERT INTO tags (id, category) VALUES ('x', 'mood')").run(),
    ).toThrow();
  });
});

describe("publication tags", () => {
  it("tags every outlet with a public route from the shared vocabulary", () => {
    const untagged = db
      .prepare(
        `SELECT id FROM publications WHERE method IS NOT NULL
         AND id NOT IN (SELECT publication_id FROM publication_tags)`,
      )
      .all() as Array<{ id: string }>;
    expect(untagged).toEqual([]);
  });

  it("refuses a tag the vocabulary does not have", () => {
    expect(() =>
      db
        .prepare("INSERT INTO publication_tags (publication_id, tag_id) VALUES ('pub-loverly', 'nope')")
        .run(),
    ).toThrow();
  });

  it("drops an outlet's tags with the outlet", () => {
    db.prepare("DELETE FROM publication_tags WHERE publication_id = 'pub-vogue-weddings'").run();
    db.prepare("DELETE FROM publications WHERE id = 'pub-vogue-weddings'").run();
    const left = db
      .prepare("SELECT COUNT(*) AS n FROM publication_tags WHERE publication_id = 'pub-vogue-weddings'")
      .get() as { n: number };
    expect(left.n).toBe(0);
  });

  it("marks Michigan as its own region so a local event matches outlets that ran one", () => {
    const michigan = db
      .prepare("SELECT publication_id FROM publication_tags WHERE tag_id = 'michigan'")
      .all() as Array<{ publication_id: string }>;
    expect(michigan.length).toBeGreaterThan(0);
  });
});

describe("research provenance", () => {
  it("ships the source file the migration was generated from", () => {
    const doc = JSON.parse(readFileSync(PROVENANCE, "utf8")) as {
      verified: string;
      publications: Array<{ id: string; sources: Array<{ url: string; quote: string }> }>;
    };
    expect(doc.verified).toBe("2026-10-19");
    const ids = db.prepare("SELECT id FROM publications ORDER BY id").all() as Array<{ id: string }>;
    expect(doc.publications.map((p) => p.id).sort()).toEqual(ids.map((row) => row.id));
    for (const publication of doc.publications) {
      for (const source of publication.sources) {
        expect(source.url).toMatch(/^https?:\/\//);
        expect(source.quote.split(/\s+/).length, publication.id).toBeLessThan(16);
      }
    }
  });

  it("carries no email address into the public repo", () => {
    expect(readFileSync(MIGRATION, "utf8")).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(readFileSync(PROVENANCE, "utf8")).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});
