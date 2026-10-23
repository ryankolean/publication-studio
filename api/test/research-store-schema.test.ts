import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { columnNames, migratedDb } from "./helpers/schema-db.js";
import { PUBLICATION_KINDS } from "../src/domain/research/schema.js";
import {
  PUBLICATION_TAG_ORIGINS,
  REVISION_STATUSES,
  TAG_ORIGINS,
  VOCAB_KINDS,
} from "../src/domain/research/store.js";

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
});

afterEach(() => {
  db.close();
});

const acceptsOnly = (values: readonly string[], write: (value: string) => void) => {
  for (const value of values) {
    expect(() => write(value), `expected ${value} to be accepted`).not.toThrow();
  }
  expect(() => write("not_a_real_value")).toThrow(/CHECK constraint failed/);
};

const insertRevision = (id: string, publicationId = "pub-new", status = "pending") =>
  db
    .prepare(
      `INSERT INTO research_revisions (id, publication_id, payload_json, content_hash, status)
       VALUES (?, ?, '{}', ?, ?)`,
    )
    .run(id, publicationId, `hash-${id}`, status);

describe("migration 0008: the research store", () => {
  it("keeps each imported version of an outlet as a revision", () => {
    expect(columnNames(db, "research_revisions")).toEqual([
      "id",
      "publication_id",
      "payload_json",
      "content_hash",
      "changes_json",
      "git_sha",
      "status",
      "proposed_by",
      "proposed_at",
      "reviewed_by",
      "reviewed_at",
      "review_note",
    ]);
  });

  it("lets a revision name an outlet that has no publications row yet", () => {
    expect(() => insertRevision("r1", "pub-not-yet-approved")).not.toThrow();
  });

  it("defaults a revision to pending and stamps when it was proposed", () => {
    insertRevision("r1");
    const row = db.prepare("SELECT status, proposed_at FROM research_revisions WHERE id = 'r1'").get() as Record<string, string>;
    expect(row["status"]).toBe("pending");
    expect(row["proposed_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("adds the outlet kind, the approved research and its revision to publications", () => {
    expect(columnNames(db, "publications")).toEqual(
      expect.arrayContaining(["kind", "research_json", "research_revision_id"]),
    );
    const seeded = db.prepare("SELECT kind, research_json, research_revision_id FROM publications LIMIT 1").get();
    expect(seeded).toEqual({ kind: null, research_json: null, research_revision_id: null });
  });

  it("holds the photographer's own corrections, one per outlet and field", () => {
    expect(columnNames(db, "publication_edits")).toEqual([
      "publication_id",
      "field",
      "value_json",
      "note",
      "updated_by",
      "updated_at",
    ]);
    const edit = db.prepare(
      "INSERT INTO publication_edits (publication_id, field, value_json) VALUES ('pub-brides', 'timing.response_window', '60')",
    );
    edit.run();
    expect(() => edit.run()).toThrow(/UNIQUE/);
  });

  it("drops an outlet's corrections with the outlet", () => {
    db.prepare(
      "INSERT INTO publications (id, name, tier, exclusivity_policy, earned_or_paid, last_verified) VALUES ('pub-x', 'X', 'primary', 'unknown', 'earned', '2026-10-23')",
    ).run();
    db.prepare("INSERT INTO publication_edits (publication_id, field, value_json) VALUES ('pub-x', 'tier', '\"dream\"')").run();
    db.prepare("DELETE FROM publications WHERE id = 'pub-x'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM publication_edits").get()).toEqual({ n: 0 });
  });

  it("marks every tag the earlier migrations seeded as research and seed", () => {
    expect(db.prepare("SELECT DISTINCT origin FROM publication_tags").all()).toEqual([{ origin: "research" }]);
    expect(db.prepare("SELECT DISTINCT origin FROM tags").all()).toEqual([{ origin: "seed" }]);
  });

  it("stores each vocabulary file once, by kind", () => {
    expect(columnNames(db, "research_vocab")).toEqual(["kind", "json", "content_hash", "updated_at"]);
  });

  it("refuses a publication pointing at a revision that does not exist", () => {
    expect(() =>
      db.prepare("UPDATE publications SET research_revision_id = 'missing' WHERE id = 'pub-brides'").run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("enum drift: research store", () => {
  it("research_revisions.status matches REVISION_STATUSES", () => {
    let n = 0;
    acceptsOnly(REVISION_STATUSES, (value) => insertRevision(`s${n++}`, "pub-new", value));
  });

  it("publication_tags.origin matches PUBLICATION_TAG_ORIGINS", () => {
    const tags = ["romantic", "whimsical", "modern_minimal", "bohemian"];
    let n = 0;
    acceptsOnly(PUBLICATION_TAG_ORIGINS, (value) =>
      db
        .prepare("INSERT INTO publication_tags (publication_id, tag_id, origin) VALUES ('pub-people-weddings', ?, ?)")
        .run(tags[n++] ?? "winter", value),
    );
  });

  it("tags.origin matches TAG_ORIGINS", () => {
    let n = 0;
    acceptsOnly(TAG_ORIGINS, (value) =>
      db.prepare("INSERT INTO tags (id, category, origin) VALUES (?, 'aesthetic', ?)").run(`t${n++}`, value),
    );
  });

  it("research_vocab.kind matches VOCAB_KINDS", () => {
    acceptsOnly(VOCAB_KINDS, (value) =>
      db.prepare("INSERT INTO research_vocab (kind, json, content_hash) VALUES (?, '{}', 'h')").run(value),
    );
  });

  it("publications.kind matches PUBLICATION_KINDS, and NULL until research is approved", () => {
    let n = 0;
    acceptsOnly(PUBLICATION_KINDS, (value) =>
      db
        .prepare(
          "INSERT INTO publications (id, name, tier, exclusivity_policy, earned_or_paid, last_verified, kind) VALUES (?, 'X', 'primary', 'unknown', 'earned', '2026-10-23', ?)",
        )
        .run(`k${n++}`, value),
    );
  });
});
