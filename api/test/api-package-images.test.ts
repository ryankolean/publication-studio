import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { hashPassword } from "../src/domain/password.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2, type TestR2 } from "./helpers/r2.js";

/**
 * GET /packages/:id/images: the package's selection in its own order, so the
 * send step can download the files the outlet will receive.
 */

const JWT_SECRET = "test-signing-secret";
const ORIGIN = "https://studio.example.com";

let db: TestD1;
let r2: TestR2;
let env: Env;
let auth: Record<string, string>;
const app = createApp();

interface PackageImage {
  key: string;
  originalName: string | null;
  contentType: string | null;
  bytes: number | null;
  readUrl: string;
  expiresIn: number;
}

beforeEach(async () => {
  db = createTestD1();
  r2 = createTestR2();
  env = { DB: db, IMAGES: r2, JWT_SECRET, ALLOWED_ORIGIN: ORIGIN };
  await db
    .prepare("INSERT INTO users (id, email, name, role, pw_hash) VALUES (?, ?, ?, ?, ?)")
    .bind("user-1", "user-1-login", "P", "photographer", await hashPassword("pw", { iterations: 1000 }))
    .run();
  auth = {
    authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" })}`,
  };
  await db
    .prepare(
      `INSERT INTO events (id, slug, couple_names, event_date, rights_status, consent_status)
       VALUES ('w1', 'w1', 'A and B', '2026-06-01', 'own_contract', 'granted')`,
    )
    .run();
});

afterEach(() => {
  db.close();
});

const pool = async (key: string, name: string | null, contentType = "image/jpeg", bytes = 10) => {
  await db
    .prepare(
      "INSERT INTO event_images (key, event_id, content_type, bytes, original_name) VALUES (?, 'w1', ?, ?, ?)",
    )
    .bind(key, contentType, bytes, name)
    .run();
  await r2.put(key, new ArrayBuffer(bytes), { httpMetadata: { contentType } });
};

const packageWith = (keys: string[], id = "pk1") =>
  db
    .prepare("INSERT INTO packages (id, event_id, publication_id, image_keys) VALUES (?, 'w1', 'pub-loverly', ?)")
    .bind(id, JSON.stringify(keys))
    .run();

const imagesOf = (id: string, headers = auth) => app.request(`/packages/${id}/images`, { headers }, env);

describe("GET /packages/:id/images", () => {
  it("requires authentication", async () => {
    await packageWith([]);
    expect((await imagesOf("pk1", {})).status).toBe(401);
  });

  it("404s an unknown package", async () => {
    const res = await imagesOf("ghost");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND", message: "That submission could not be found." });
  });

  it("returns an empty list for a package with nothing selected", async () => {
    await packageWith([]);
    const res = await imagesOf("pk1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ images: [] });
  });

  it("lists the selection in the package's order, not the pool's", async () => {
    await pool("events/w1/a.jpg", "first-look.jpg");
    await pool("events/w1/b.png", "rings.png", "image/png", 20);
    await pool("events/w1/c.jpg", null);
    await pool("events/w1/unused.jpg", "unused.jpg");
    await packageWith(["events/w1/c.jpg", "events/w1/a.jpg", "events/w1/b.png"]);

    const body = (await (await imagesOf("pk1")).json()) as { images: PackageImage[] };
    expect(body.images.map((image) => image.key)).toEqual(["events/w1/c.jpg", "events/w1/a.jpg", "events/w1/b.png"]);
    expect(body.images[2]).toMatchObject({
      key: "events/w1/b.png",
      originalName: "rings.png",
      contentType: "image/png",
      bytes: 20,
      expiresIn: 15 * 60,
    });
    expect(body.images[0]?.originalName).toBeNull();
    for (const image of body.images) {
      expect(image.readUrl.startsWith(`/images/${image.key}?token=`)).toBe(true);
    }
  });

  it("gives read urls the SPA can fetch across origins", async () => {
    await pool("events/w1/a.jpg", "a.jpg");
    await packageWith(["events/w1/a.jpg"]);
    const body = (await (await imagesOf("pk1")).json()) as { images: PackageImage[] };

    const res = await app.request(body.images[0]?.readUrl ?? "", { headers: { origin: ORIGIN } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect((await res.arrayBuffer()).byteLength).toBe(10);
  });

  it("still lists a selected key the pool has no row for, without its details", async () => {
    // Packages predate the pool table (SUMMIT-304), so a selection can name
    // an object with no row. It is listed rather than dropped: leaving it out
    // would silently send the outlet fewer images than were chosen.
    await packageWith(["events/w1/legacy.jpg"]);
    const body = (await (await imagesOf("pk1")).json()) as { images: PackageImage[] };
    expect(body.images).toEqual([
      expect.objectContaining({ key: "events/w1/legacy.jpg", originalName: null, contentType: null, bytes: null }),
    ]);
  });

  it("does not take a pool row from another event for a key", async () => {
    await db
      .prepare(
        `INSERT INTO events (id, slug, couple_names, event_date) VALUES ('w2', 'w2', 'C and D', '2026-06-02')`,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO event_images (key, event_id, content_type, bytes, original_name) VALUES ('events/w2/x.jpg', 'w2', 'image/jpeg', 5, 'other.jpg')",
      )
      .run();
    await packageWith(["events/w2/x.jpg"]);
    const body = (await (await imagesOf("pk1")).json()) as { images: PackageImage[] };
    expect(body.images[0]).toMatchObject({ originalName: null, bytes: null });
  });
});
