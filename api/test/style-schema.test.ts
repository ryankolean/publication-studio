import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { columnNames, migratedDb, migrationFiles } from "./helpers/schema-db.js";
import {
  EVENT_TAG_SOURCES,
  EVENT_TAG_STATES,
  FEATURE_ROLES,
  SETTING_KEYS,
  STYLE_RUN_STATUSES,
  TAG_CONFIDENCES,
} from "../src/domain/style.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  db.exec(`INSERT INTO users (id, email, name, role, pw_hash) VALUES ('u1', 'a@example.com', 'A', 'photographer', 'x');
    INSERT INTO events (id, slug, couple_names, event_date) VALUES ('e1', 'e1', 'Ada and Bo', '2026-07-01');
    INSERT INTO style_runs (id, event_id, model, image_keys_json, photo_set_hash, status) VALUES ('r1', 'e1', 'm', '[]', 'h', 'ok');`);
});

afterEach(() => db.close());

const acceptsOnly = (values: readonly string[], write: (value: string) => void) => {
  for (const value of values) expect(() => write(value), `expected ${value} to be accepted`).not.toThrow();
  expect(() => write("not_a_real_value")).toThrow(/CHECK constraint failed/);
};

const tagRow = (state = "suggested", source = "analysis", confidence: string | null = null, tag = "romantic") =>
  db
    .prepare("INSERT OR REPLACE INTO event_tags (event_id, tag_id, state, source, confidence) VALUES ('e1', ?, ?, ?, ?)")
    .run(tag, state, source, confidence);

describe("migration 0009: the style profile", () => {
  it("drops the intake form's free-text style tags from events", () => {
    expect(columnNames(db, "events")).not.toContain("style_tags");
  });

  it("keeps one row per wedding and tag", () => {
    expect(columnNames(db, "event_tags")).toEqual([
      "event_id",
      "tag_id",
      "state",
      "source",
      "confidence",
      "reason",
      "run_id",
      "updated_by",
      "updated_at",
    ]);
    tagRow();
    expect(() =>
      db.prepare("INSERT INTO event_tags (event_id, tag_id, state, source) VALUES ('e1', 'romantic', 'confirmed', 'photographer')").run(),
    ).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("records what each analysis sent and what it cost", () => {
    expect(columnNames(db, "style_runs")).toEqual([
      "id",
      "event_id",
      "model",
      "image_keys_json",
      "photo_set_hash",
      "status",
      "input_tokens",
      "output_tokens",
      "error",
      "created_by",
      "created_at",
    ]);
  });

  it("keeps past features with an optional outlet and wedding link", () => {
    expect(columnNames(db, "past_features")).toEqual([
      "id",
      "publication_id",
      "outlet_name",
      "event_id",
      "feature_url",
      "published_on",
      "role",
      "notes",
      "created_by",
      "created_at",
      "updated_at",
    ]);
    db.prepare("INSERT INTO past_features (id, outlet_name) VALUES ('f1', 'Somewhere')").run();
    expect(db.prepare("SELECT role FROM past_features WHERE id = 'f1'").get()).toEqual({ role: "lead" });
  });

  it("refuses a tag that is not in the vocabulary, or a wedding that does not exist", () => {
    expect(() => tagRow("suggested", "analysis", null, "not_a_tag")).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare("INSERT INTO event_tags (event_id, tag_id, state, source) VALUES ('nope', 'romantic', 'suggested', 'analysis')").run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("deletes a wedding's tags and runs with the wedding, and unlinks its features", () => {
    tagRow();
    db.prepare("INSERT INTO past_features (id, outlet_name, event_id) VALUES ('f1', 'Somewhere', 'e1')").run();
    db.prepare("DELETE FROM events WHERE id = 'e1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_tags").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM style_runs").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT event_id FROM past_features WHERE id = 'f1'").get()).toEqual({ event_id: null });
  });

  it("keeps a tag when the run that suggested it is deleted", () => {
    db.prepare("INSERT INTO event_tags (event_id, tag_id, state, source, run_id) VALUES ('e1', 'romantic', 'suggested', 'analysis', 'r1')").run();
    db.prepare("DELETE FROM style_runs WHERE id = 'r1'").run();
    expect(db.prepare("SELECT run_id FROM event_tags").get()).toEqual({ run_id: null });
  });

  it("moves intake tags that name vocabulary tags into confirmed tags", () => {
    const before = migratedDbBefore("0009");
    before.exec(`INSERT INTO events (id, slug, couple_names, event_date, style_tags)
      VALUES ('old', 'old', 'Cy and Di', '2025-05-01', '["romantic","editorial","romantic"]')`);
    before.exec(readFileSync(join(MIGRATIONS, migrationFiles().find((name) => name.startsWith("0009")) as string), "utf8"));
    expect(before.prepare("SELECT event_id, tag_id, state, source FROM event_tags").all()).toEqual([
      { event_id: "old", tag_id: "romantic", state: "confirmed", source: "photographer" },
    ]);
    before.close();
  });
});

function migratedDbBefore(prefix: string): DatabaseSync {
  const { DatabaseSync: Sqlite } = process.getBuiltinModule("node:sqlite");
  const fresh = new Sqlite(":memory:");
  fresh.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles().filter((name) => name < prefix)) {
    fresh.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return fresh;
}

describe("enum drift between the style unions and their CHECK constraints", () => {
  it("event_tags.state matches EVENT_TAG_STATES", () => {
    acceptsOnly(EVENT_TAG_STATES, (value) => tagRow(value));
  });

  it("event_tags.source matches EVENT_TAG_SOURCES", () => {
    acceptsOnly(EVENT_TAG_SOURCES, (value) => tagRow("suggested", value));
  });

  it("event_tags.confidence matches TAG_CONFIDENCES", () => {
    acceptsOnly(TAG_CONFIDENCES, (value) => tagRow("suggested", "analysis", value));
  });

  it("style_runs.status matches STYLE_RUN_STATUSES", () => {
    acceptsOnly(STYLE_RUN_STATUSES, (value) =>
      db
        .prepare("INSERT INTO style_runs (id, event_id, model, image_keys_json, photo_set_hash, status) VALUES (?, 'e1', 'm', '[]', 'h', ?)")
        .run(`r-${value}`, value),
    );
  });

  it("past_features.role matches FEATURE_ROLES", () => {
    acceptsOnly(FEATURE_ROLES, (value) =>
      db.prepare("INSERT INTO past_features (id, outlet_name, role) VALUES (?, 'X', ?)").run(`f-${value}`, value),
    );
  });

  it("app_settings.key matches SETTING_KEYS", () => {
    acceptsOnly(SETTING_KEYS, (value) =>
      db.prepare("INSERT INTO app_settings (key, value) VALUES (?, 'on')").run(value),
    );
  });
});
