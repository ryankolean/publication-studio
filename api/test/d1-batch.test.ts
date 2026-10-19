import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestD1, type TestD1 } from "./helpers/d1.js";

/**
 * The route layer relies on batch being transactional. The shim stands in for
 * D1 in every other API test, so its batch has to behave like D1's: all the
 * statements land, or none do.
 */
let db: TestD1;

beforeEach(() => {
  db = createTestD1();
});

afterEach(() => {
  db.close();
});

const insertEvent = (id: string) =>
  db
    .prepare(
      "INSERT INTO events (id, slug, couple_names, event_date) VALUES (?, ?, 'A and B', '2026-06-01')",
    )
    .bind(id, id);

const eventCount = async () =>
  (await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>())?.n;

describe("batch", () => {
  it("commits every statement on success", async () => {
    await db.batch([insertEvent("w1"), insertEvent("w2")]);
    expect(await eventCount()).toBe(2);
  });

  it("rolls the earlier statements back when a later one fails", async () => {
    const duplicateSlug = db
      .prepare(
        "INSERT INTO events (id, slug, couple_names, event_date) VALUES ('w3', 'w1', 'C and D', '2026-07-01')",
      )
      .bind();

    await expect(db.batch([insertEvent("w1"), duplicateSlug])).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    expect(await eventCount()).toBe(0);
  });

  it("rolls back a foreign key violation in a later statement", async () => {
    const orphanVendor = db
      .prepare(
        "INSERT INTO vendor_credits (id, event_id, role, business_name) VALUES ('v1', 'ghost', 'Florist', 'Stems')",
      )
      .bind();

    await expect(db.batch([insertEvent("w1"), orphanVendor])).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(await eventCount()).toBe(0);
  });

  it("leaves the connection usable after a rollback", async () => {
    const bad = db.prepare("INSERT INTO events (id) VALUES ('incomplete')").bind();
    await expect(db.batch([bad])).rejects.toThrow();

    await db.batch([insertEvent("w9")]);
    expect(await eventCount()).toBe(1);
  });
});
