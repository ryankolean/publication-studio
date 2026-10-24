import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { columnNames, migratedDb, migrationFiles } from "./helpers/schema-db.js";
import { EXPOSURE_CHANNELS } from "../src/domain/match.js";
import { CONTENT_TYPES } from "../src/domain/research/schema.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  db.exec(`INSERT INTO events (id, slug, couple_names, event_date) VALUES ('e1', 'e1', 'Ada and Bo', '2026-01-31')`);
});

afterEach(() => db.close());

const acceptsOnly = (values: readonly string[], write: (value: string) => void) => {
  for (const value of values) expect(() => write(value), `expected ${value} to be accepted`).not.toThrow();
  expect(() => write("not_a_real_value")).toThrow(/CHECK constraint failed/);
};

function migratedBefore(prefix: string): DatabaseSync {
  const { DatabaseSync: Sqlite } = process.getBuiltinModule("node:sqlite");
  const fresh = new Sqlite(":memory:");
  fresh.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles().filter((name) => name < prefix)) fresh.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  return fresh;
}

describe("migration 0010: matching", () => {
  it("gives a wedding a place code and a kind, a real wedding by default", () => {
    const columns = columnNames(db, "events");
    expect(columns).toEqual(expect.arrayContaining(["location_code", "content_type"]));
    expect(columns).not.toContain("prior_exposure");
    expect(db.prepare("SELECT location_code, content_type FROM events WHERE id = 'e1'").get()).toEqual({
      location_code: null,
      content_type: "real_wedding",
    });
  });

  it("keeps each place a wedding was shared, deleted with the wedding", () => {
    expect(columnNames(db, "event_exposures")).toEqual(["id", "event_id", "channel", "detail", "publication_id", "created_by", "created_at"]);
    db.prepare("INSERT INTO event_exposures (id, event_id, channel) VALUES ('x1', 'e1', 'couple_social')").run();
    db.prepare("DELETE FROM events WHERE id = 'e1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_exposures").get()).toEqual({ n: 0 });
  });

  it("gives every outlet a place for its matching facts, empty until research is approved", () => {
    expect(columnNames(db, "publications")).toContain("match_json");
  });

  it("moves the old prior-exposure answers into rows", () => {
    const before = migratedBefore("0010");
    before.exec(`INSERT INTO events (id, slug, couple_names, event_date, prior_exposure) VALUES
      ('old', 'old', 'Cy and Di', '2025-05-01', '{"ownBlog":true,"igPosted":true,"priorPubs":["Somewhere"," "]}'),
      ('quiet', 'quiet', 'Ed and Flo', '2025-05-01', '{"ownBlog":false,"igPosted":false,"priorPubs":[]}')`);
    before.exec(readFileSync(join(MIGRATIONS, migrationFiles().find((name) => name.startsWith("0010")) as string), "utf8"));
    expect(before.prepare("SELECT event_id, channel, detail FROM event_exposures ORDER BY channel").all()).toEqual([
      { event_id: "old", channel: "own_blog", detail: null },
      { event_id: "old", channel: "own_social", detail: null },
      { event_id: "old", channel: "publication", detail: "Somewhere" },
    ]);
    before.close();
  });
});

describe("enum drift between the matching unions and their CHECK constraints", () => {
  it("events.content_type matches CONTENT_TYPES", () => {
    acceptsOnly(CONTENT_TYPES, (value) => db.prepare("UPDATE events SET content_type = ? WHERE id = 'e1'").run(value));
  });

  it("event_exposures.channel matches EXPOSURE_CHANNELS", () => {
    let n = 0;
    acceptsOnly(EXPOSURE_CHANNELS, (value) =>
      db.prepare("INSERT INTO event_exposures (id, event_id, channel) VALUES (?, 'e1', ?)").run(`x${n++}`, value),
    );
  });
});
