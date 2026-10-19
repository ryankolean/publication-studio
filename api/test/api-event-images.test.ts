import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { hashPassword } from "../src/domain/password.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2, type TestR2 } from "./helpers/r2.js";

/**
 * The event image pool: the board lists everything uploaded for an event, not
 * only what a package happens to have selected (SUMMIT-304).
 */

const JWT_SECRET = "test-signing-secret";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);

let db: TestD1;
let r2: TestR2;
let env: Env;
let auth: Record<string, string>;
const app = createApp();

async function seedEvent(id: string) {
  await db
    .prepare(
      `INSERT INTO events (id, slug, couple_names, event_date, rights_status, consent_status)
       VALUES (?, ?, 'A and B', '2026-06-01', 'own_contract', 'granted')`,
    )
    .bind(id, id)
    .run();
}

beforeEach(async () => {
  db = createTestD1();
  r2 = createTestR2();
  env = { DB: db, IMAGES: r2, JWT_SECRET, ALLOWED_ORIGIN: "https://studio.example.com" };
  await db
    .prepare("INSERT INTO users (id, email, name, role, pw_hash) VALUES (?, ?, ?, ?, ?)")
    .bind("user-1", "p@example.com", "P", "photographer", await hashPassword("pw", { iterations: 1000 }))
    .run();
  auth = {
    authorization: `Bearer ${await signAccessToken(JWT_SECRET, {
      userId: "user-1",
      role: "photographer",
    })}`,
  };
});

afterEach(() => {
  db.close();
});

const grantFor = async (eventId: string, contentType = "image/jpeg") => {
  const res = await app.request(
    `/events/${eventId}/images`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ contentType }),
    },
    env,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { key: string; uploadUrl: string };
};

const put = (uploadUrl: string, body: Uint8Array, contentType = "image/jpeg") =>
  app.request(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body }, env);

const uploaded = async (eventId: string, body = JPEG, contentType = "image/jpeg") => {
  const grant = await grantFor(eventId, contentType);
  expect((await put(grant.uploadUrl, body, contentType)).status).toBe(201);
  return grant.key;
};

const listPool = (eventId: string, headers = auth) =>
  app.request(`/events/${eventId}/images`, { headers }, env);

const removeImage = (eventId: string, key: string, headers = auth) =>
  app.request(`/events/${eventId}/images/${key}`, { method: "DELETE", headers }, env);

const poolRows = async () =>
  (
    await db
      .prepare("SELECT key, event_id, content_type, bytes FROM event_images ORDER BY key")
      .all<{ key: string; event_id: string; content_type: string; bytes: number }>()
  ).results;

interface PoolItem {
  key: string;
  contentType: string;
  bytes: number;
  createdAt: string;
  readUrl: string;
  expiresIn: number;
}

describe("an upload records the image in the event's pool", () => {
  it("writes a row once the bytes are stored", async () => {
    await seedEvent("w1");
    const key = await uploaded("w1");
    expect(await poolRows()).toEqual([
      { key, event_id: "w1", content_type: "image/jpeg", bytes: JPEG.byteLength },
    ]);
  });

  it("writes no row when the upload is refused", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    expect((await put(grant.uploadUrl, new Uint8Array())).status).toBe(400);
    expect(await poolRows()).toEqual([]);
  });

  it("replaces rather than duplicates when the same grant is used twice", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    expect((await put(grant.uploadUrl, JPEG)).status).toBe(201);
    const larger = new Uint8Array(JPEG.byteLength + 6);
    expect((await put(grant.uploadUrl, larger)).status).toBe(201);
    expect(await poolRows()).toEqual([
      { key: grant.key, event_id: "w1", content_type: "image/jpeg", bytes: larger.byteLength },
    ]);
  });

  it("404s, and stores nothing, when the event was deleted after the grant", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    await db.prepare("DELETE FROM events WHERE id = 'w1'").run();

    const res = await put(grant.uploadUrl, JPEG);
    expect(res.status).toBe(404);
    expect(r2.contents()).toEqual([]);
    expect(await poolRows()).toEqual([]);
  });
});

describe("the photographer's file name", () => {
  // The name travels grant -> client -> PUT header, because the capability
  // token's format must not change and the row is only written once the
  // bytes land (see the grant route).
  const grantNamed = async (eventId: string, fileName: unknown) =>
    app.request(
      `/events/${eventId}/images`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ contentType: "image/jpeg", fileName }),
      },
      env,
    );

  const putNamed = (uploadUrl: string, header: string | undefined, body = JPEG) =>
    app.request(
      uploadUrl,
      {
        method: "PUT",
        headers: {
          "content-type": "image/jpeg",
          ...(header === undefined ? {} : { "x-file-name": header }),
        },
        body,
      },
      env,
    );

  const names = async () =>
    (await db.prepare("SELECT original_name FROM event_images ORDER BY key").all<{ original_name: string | null }>())
      .results.map((row) => row.original_name);

  it("echoes the sanitized name on the grant", async () => {
    await seedEvent("w1");
    const res = await grantNamed("w1", "  C:\\fakepath\\..\\.IMG_2041.jpg ");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ fileName: "IMG_2041.jpg" });
  });

  it("echoes null when no name was sent, or nothing usable was", async () => {
    await seedEvent("w1");
    expect(await (await grantNamed("w1", undefined)).json()).toMatchObject({ fileName: null });
    expect(await (await grantNamed("w1", "../")).json()).toMatchObject({ fileName: null });
    expect(await (await grantNamed("w1", null)).json()).toMatchObject({ fileName: null });
  });

  it("refuses a name that is not text", async () => {
    await seedEvent("w1");
    const res = await grantNamed("w1", 42);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION",
      details: [{ field: "fileName", message: "Expected text." }],
    });
  });

  it("stores the name sent with the upload, sanitized the same way", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    const res = await putNamed(grant.uploadUrl, encodeURIComponent("galleries/june/Première danse.jpg"));
    expect(res.status).toBe(201);
    expect(await names()).toEqual(["Première danse.jpg"]);
  });

  it("caps a long name at 200 characters", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    await putNamed(grant.uploadUrl, encodeURIComponent(`${"b".repeat(300)}.jpg`));
    expect(await names()).toEqual(["b".repeat(200)]);
  });

  it("stores no name without the header, or with one that does not decode", async () => {
    await seedEvent("w1");
    const first = await grantFor("w1");
    expect((await putNamed(first.uploadUrl, undefined)).status).toBe(201);
    const second = await grantFor("w1");
    expect((await putNamed(second.uploadUrl, "%E0%A4%A")).status).toBe(201);
    expect(await names()).toEqual([null, null]);
  });

  it("keeps the name when the same grant uploads again without one", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    await putNamed(grant.uploadUrl, "first.jpg");
    await putNamed(grant.uploadUrl, undefined);
    expect(await names()).toEqual(["first.jpg"]);
    await putNamed(grant.uploadUrl, "second.jpg");
    expect(await names()).toEqual(["second.jpg"]);
  });

  it("lists the name with the pool", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    await putNamed(grant.uploadUrl, "IMG_7.jpg");
    await uploaded("w1");
    const body = (await (await listPool("w1")).json()) as { images: Array<PoolItem & { originalName: string | null }> };
    expect(body.images.map((image) => image.originalName)).toEqual([null, "IMG_7.jpg"]);
  });
});

describe("listing the pool", () => {
  it("requires authentication", async () => {
    await seedEvent("w1");
    expect((await listPool("w1", {})).status).toBe(401);
  });

  it("404s an unknown event", async () => {
    expect((await listPool("ghost")).status).toBe(404);
  });

  it("returns an empty pool for an event with no uploads", async () => {
    await seedEvent("w1");
    const res = await listPool("w1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ images: [] });
  });

  it("lists only this event's images, newest first", async () => {
    await seedEvent("w1");
    await seedEvent("w2");
    const first = await uploaded("w1");
    const second = await uploaded("w1", PNG, "image/png");
    await uploaded("w2");

    const body = (await (await listPool("w1")).json()) as { images: PoolItem[] };
    expect(body.images.map((image) => image.key)).toEqual([second, first]);
    expect(body.images[0]).toMatchObject({ contentType: "image/png", bytes: PNG.byteLength });
  });

  it("orders by upload time, not by insertion accident", async () => {
    await seedEvent("w1");
    for (const [key, at] of [
      ["events/w1/old.jpg", "2026-01-01T00:00:00Z"],
      ["events/w1/new.jpg", "2026-03-01T00:00:00Z"],
      ["events/w1/mid.jpg", "2026-02-01T00:00:00Z"],
    ] as const) {
      await db
        .prepare(
          "INSERT INTO event_images (key, event_id, content_type, bytes, created_at) VALUES (?, 'w1', 'image/jpeg', 1, ?)",
        )
        .bind(key, at)
        .run();
    }
    const body = (await (await listPool("w1")).json()) as { images: PoolItem[] };
    expect(body.images.map((image) => image.key)).toEqual([
      "events/w1/new.jpg",
      "events/w1/mid.jpg",
      "events/w1/old.jpg",
    ]);
  });

  it("gives each image a read url that serves its bytes", async () => {
    await seedEvent("w1");
    const key = await uploaded("w1");
    const body = (await (await listPool("w1")).json()) as { images: PoolItem[] };
    const [image] = body.images;

    expect(image?.readUrl.startsWith(`/images/${key}?token=`)).toBe(true);
    expect(image?.expiresIn).toBe(15 * 60);

    const res = await app.request(image?.readUrl ?? "", {}, env);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
  });

  it("mints read urls that cannot be used to write", async () => {
    await seedEvent("w1");
    const key = await uploaded("w1");
    const body = (await (await listPool("w1")).json()) as { images: PoolItem[] };
    const token = body.images[0]?.readUrl.split("?")[1] ?? "";
    expect((await put(`/images/${key}?${token}`, PNG, "image/png")).status).toBe(401);
  });
});

describe("deleting from the pool", () => {
  it("requires authentication", async () => {
    await seedEvent("w1");
    const key = await uploaded("w1");
    expect((await removeImage("w1", key, {})).status).toBe(401);
    expect(r2.contents()).toEqual([key]);
  });

  it("removes the object and the row, and audit-logs it", async () => {
    await seedEvent("w1");
    const key = await uploaded("w1");

    const res = await removeImage("w1", key);
    expect(res.status).toBe(200);
    expect(r2.contents()).toEqual([]);
    expect(await poolRows()).toEqual([]);

    const audit = await db
      .prepare("SELECT user_id, entity, entity_id, action FROM audit_log WHERE entity = 'image'")
      .all();
    expect(audit.results).toEqual([
      { user_id: "user-1", entity: "image", entity_id: key, action: "delete" },
    ]);
  });

  it("404s a key that belongs to a different event", async () => {
    await seedEvent("w1");
    await seedEvent("w2");
    const key = await uploaded("w2");

    expect((await removeImage("w1", key)).status).toBe(404);
    expect(r2.contents()).toEqual([key]);
    expect(await poolRows()).toHaveLength(1);
  });

  it("404s a key that is not in the pool at all", async () => {
    await seedEvent("w1");
    expect((await removeImage("w1", "events/w1/nope.jpg")).status).toBe(404);
  });

  it("refuses an image a package still uses", async () => {
    await seedEvent("w1");
    const key = await uploaded("w1");
    const other = await uploaded("w1");
    await db
      .prepare(
        "INSERT INTO packages (id, event_id, publication_id, image_keys) VALUES ('pk1', 'w1', 'pub-loverly', ?)",
      )
      .bind(JSON.stringify([other, key]))
      .run();

    const res = await removeImage("w1", key);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("IMAGE_IN_USE");
    expect(r2.contents()).toContain(key);
    expect((await poolRows()).map((row) => row.key)).toContain(key);
  });

  it("does not mistake a key that merely contains this one for a use", async () => {
    await seedEvent("w1");
    const key = await uploaded("w1");
    await db
      .prepare(
        "INSERT INTO packages (id, event_id, publication_id, image_keys) VALUES ('pk1', 'w1', 'pub-loverly', ?)",
      )
      .bind(JSON.stringify([`${key}.bak`]))
      .run();

    expect((await removeImage("w1", key)).status).toBe(200);
  });
});
