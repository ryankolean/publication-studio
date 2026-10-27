import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { UPLOAD_LINK_PHOTO_LIMIT, createLinkToken, isoSeconds } from "../src/domain/upload-link.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2, type TestR2 } from "./helpers/r2.js";

const JWT_SECRET = "test-signing-secret";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PREVIEW = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 9, 9]);

let db: TestD1;
let r2: TestR2;
let env: Env;
const app = createApp();

async function seedEvent(id: string, rights = "own_contract", consent = "granted") {
  await db
    .prepare(
      `INSERT INTO events (id, slug, couple_names, event_date, rights_status, consent_status)
       VALUES (?, ?, 'Casey & Jordan', '2026-06-14', ?, ?)`,
    )
    .bind(id, id, rights, consent)
    .run();
}

async function seedLink(eventId: string, options: { expiresAt?: string; closedAt?: string; photos?: number } = {}) {
  const { token, id } = await createLinkToken();
  await db
    .prepare("INSERT INTO upload_links (id, user_id, event_id, photos, expires_at, closed_at) VALUES (?, 'user-1', ?, ?, ?, ?)")
    .bind(id, eventId, options.photos ?? 0, options.expiresAt ?? isoSeconds(Date.now() + 3_600_000), options.closedAt ?? null)
    .run();
  return token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const addPhoto = (token: string, body: Uint8Array = JPEG, type = "image/jpeg", name?: string) =>
  app.request(
    "/upload/photos",
    {
      method: "POST",
      headers: { ...bearer(token), "content-type": type, ...(name === undefined ? {} : { "x-file-name": name }) },
      body,
    },
    env,
  );

const addPreview = (token: string, file: string, body: Uint8Array = PREVIEW, type = "image/jpeg") =>
  app.request(`/upload/photos/${file}/preview`, { method: "PUT", headers: { ...bearer(token), "content-type": type }, body }, env);

async function linkRow() {
  return db.prepare("SELECT photos, closed_at FROM upload_links").first<{ photos: number; closed_at: string | null }>();
}

beforeEach(async () => {
  db = createTestD1();
  r2 = createTestR2();
  env = { DB: db, IMAGES: r2, JWT_SECRET, ALLOWED_ORIGIN: "https://studio.example.com" };
  await db
    .prepare("INSERT INTO users (id, email, name, role, pw_hash) VALUES ('user-1', 'p@example.com', 'P', 'photographer', 'x')")
    .run();
  await seedEvent("w1");
});

afterEach(() => {
  db.close();
});

describe("the upload page", () => {
  it("is a static page that runs only its own script and style", async () => {
    const res = await app.request("/upload", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    const policy = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1] ?? "";
    expect(nonce.length).toBeGreaterThanOrEqual(20);
    expect(policy).toContain(`style-src 'nonce-${nonce}'`);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain("var EDGE = 256");
  });

  it("cannot be framed, cached or leak its address", async () => {
    const res = await app.request("/upload", {}, env);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("gets a fresh nonce every time", async () => {
    const one = (await app.request("/upload", {}, env)).headers.get("content-security-policy");
    const two = (await app.request("/upload", {}, env)).headers.get("content-security-policy");
    expect(one).not.toBe(two);
  });
});

describe("GET /upload/link", () => {
  it("names the wedding and what the link takes", async () => {
    const token = await seedLink("w1", { photos: 5 });
    await db.prepare("INSERT INTO event_images (key, event_id, content_type, bytes) VALUES ('events/w1/a.jpg', 'w1', 'image/jpeg', 1)").run();
    const res = await app.request("/upload/link", { headers: bearer(token) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      couple: "Casey & Jordan",
      date: "2026-06-14",
      photos: 1,
      room: UPLOAD_LINK_PHOTO_LIMIT - 5,
      maxBytes: 12 * 1024 * 1024,
      types: ["image/jpeg", "image/png", "image/webp"],
    });
  });

  it("refuses no token, an unknown token, and a malformed header", async () => {
    await seedLink("w1");
    for (const headers of [{}, bearer("x".repeat(43)), { authorization: "Bearer short" }]) {
      const res = await app.request("/upload/link", { headers }, env);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { message: string }).message).toBe("This link has expired or has been closed. Ask Claude for a new one.");
    }
  });

  it("refuses an expired link and a closed one", async () => {
    const expired = await seedLink("w1", { expiresAt: isoSeconds(Date.now() - 1000) });
    const closed = await seedLink("w1", { closedAt: isoSeconds(Date.now()) });
    for (const token of [expired, closed]) {
      expect((await app.request("/upload/link", { headers: bearer(token) }, env)).status).toBe(401);
    }
  });

  it("stops once the wedding's permission answers no longer say yes", async () => {
    const token = await seedLink("w1");
    await db.prepare("UPDATE events SET consent_status = 'declined' WHERE id = 'w1'").run();
    const res = await app.request("/upload/link", { headers: bearer(token) }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "RIGHTS_BLOCKED" });
  });
});

describe("POST /upload/photos", () => {
  it("stores the photo in the link's wedding under a key it chose, with her file name", async () => {
    const token = await seedLink("w1");
    const res = await addPhoto(token, JPEG, "image/jpeg", encodeURIComponent("C:\\fakepath\\Ceremony 01.jpg"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { photo: string; ref: string; bytes: number };
    expect(body.photo).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(body.ref).toBe(body.photo.slice(0, 8));
    expect(body.bytes).toBe(JPEG.byteLength);
    expect(r2.contents()).toEqual([`events/w1/${body.photo}`]);
    const row = await db.prepare("SELECT event_id, content_type, bytes, original_name, preview_key FROM event_images").first();
    expect(row).toEqual({ event_id: "w1", content_type: "image/jpeg", bytes: JPEG.byteLength, original_name: "Ceremony 01.jpg", preview_key: null });
    expect(await linkRow()).toEqual({ photos: 1, closed_at: null });
  });

  it("keeps the extension of the type sent", async () => {
    const token = await seedLink("w1");
    const res = await addPhoto(token, JPEG, "image/webp");
    expect(((await res.json()) as { photo: string }).photo).toMatch(/\.webp$/);
  });

  it("refuses an unsupported type, an empty body and one over 12 MB, storing nothing", async () => {
    const token = await seedLink("w1");
    const refused = [
      await addPhoto(token, JPEG, "image/gif"),
      await addPhoto(token, new Uint8Array(0)),
      await addPhoto(token, new Uint8Array(12 * 1024 * 1024 + 1)),
    ];
    expect(refused.map((res) => res.status)).toEqual([400, 400, 400]);
    expect(r2.contents()).toEqual([]);
    expect(await linkRow()).toEqual({ photos: 0, closed_at: null });
  });

  it("takes exactly 12 MB", async () => {
    const token = await seedLink("w1");
    expect((await addPhoto(token, new Uint8Array(12 * 1024 * 1024))).status).toBe(201);
  });

  it("refuses a closed or expired link", async () => {
    const closed = await seedLink("w1", { closedAt: isoSeconds(Date.now()) });
    const expired = await seedLink("w1", { expiresAt: isoSeconds(Date.now() - 1000) });
    expect((await addPhoto(closed)).status).toBe(401);
    expect((await addPhoto(expired)).status).toBe(401);
    expect(r2.contents()).toEqual([]);
  });

  it("keeps to the rights gate for every photo", async () => {
    const token = await seedLink("w1");
    expect((await addPhoto(token)).status).toBe(201);
    await db.prepare("UPDATE events SET rights_status = 'second_shooter' WHERE id = 'w1'").run();
    const res = await addPhoto(token);
    expect(res.status).toBe(403);
    expect(r2.contents()).toHaveLength(1);
    expect(await linkRow()).toEqual({ photos: 1, closed_at: null });
  });

  it("stops at the link's limit", async () => {
    const token = await seedLink("w1", { photos: UPLOAD_LINK_PHOTO_LIMIT - 1 });
    expect((await addPhoto(token)).status).toBe(201);
    const full = await addPhoto(token);
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: "UPLOAD_LINK_FULL" });
    expect(r2.contents()).toHaveLength(1);
    expect(await linkRow()).toEqual({ photos: UPLOAD_LINK_PHOTO_LIMIT, closed_at: null });
  });
});

describe("PUT /upload/photos/:file/preview", () => {
  async function storedPhoto(token: string): Promise<string> {
    return ((await (await addPhoto(token)).json()) as { photo: string }).photo;
  }

  it("stores the preview beside the pool and records it on the photo", async () => {
    const token = await seedLink("w1");
    const photo = await storedPhoto(token);
    const res = await addPreview(token, photo);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ photo, preview: true });
    const previewKey = `previews/w1/${photo.replace(/\.\w+$/, ".jpg")}`;
    expect(r2.bytesOf(previewKey)).toBe(PREVIEW.byteLength);
    expect(await db.prepare("SELECT preview_key FROM event_images").first()).toEqual({ preview_key: previewKey });
  });

  it("refuses a preview that is not a JPEG, is empty, or is over 256 KB", async () => {
    const token = await seedLink("w1");
    const photo = await storedPhoto(token);
    const refused = [
      await addPreview(token, photo, PREVIEW, "image/png"),
      await addPreview(token, photo, new Uint8Array(0)),
      await addPreview(token, photo, new Uint8Array(256 * 1024 + 1)),
    ];
    expect(refused.map((res) => res.status)).toEqual([400, 400, 400]);
    expect(await db.prepare("SELECT preview_key FROM event_images").first()).toEqual({ preview_key: null });
    expect((await addPreview(token, photo, new Uint8Array(256 * 1024))).status).toBe(201);
  });

  it("cannot reach a photo of another wedding, or one that is not in the pool", async () => {
    await seedEvent("w2");
    const other = await storedPhoto(await seedLink("w2"));
    const token = await seedLink("w1");
    expect((await addPreview(token, other)).status).toBe(404);
    expect((await addPreview(token, "0f8e2b7c-1d2e-4a3b-9c4d-5e6f7a8b9c0d.jpg")).status).toBe(404);
    expect((await addPreview(token, "not-a-photo.jpg")).status).toBe(404);
    expect(r2.contents().filter((key) => key.startsWith("previews/"))).toEqual([]);
  });

  it("needs an open link", async () => {
    const token = await seedLink("w1");
    const photo = await storedPhoto(token);
    await db.prepare("UPDATE upload_links SET closed_at = ?").bind(isoSeconds(Date.now())).run();
    expect((await addPreview(token, photo)).status).toBe(401);
  });
});

describe("POST /upload/done", () => {
  it("closes the link, after which it takes nothing", async () => {
    const token = await seedLink("w1");
    await addPhoto(token);
    await addPhoto(token);
    const res = await app.request("/upload/done", { method: "POST", headers: bearer(token) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closed: true, added: 2, photos: 2 });
    expect((await linkRow())?.closed_at).not.toBeNull();
    expect((await addPhoto(token)).status).toBe(401);
    expect((await app.request("/upload/done", { method: "POST", headers: bearer(token) }, env)).status).toBe(401);
  });
});

describe("previews in the web app's pool routes", () => {
  let auth: Record<string, string>;
  let photo: string;

  beforeEach(async () => {
    auth = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" })}` };
    photo = ((await (await addPhoto(await seedLink("w1"))).json()) as { photo: string }).photo;
  });

  const operatorPreview = (headers: Record<string, string>, eventId = "w1", file = photo) =>
    app.request(
      `/events/${eventId}/images/${file}/preview`,
      { method: "PUT", headers: { ...headers, "content-type": "image/jpeg" }, body: PREVIEW },
      env,
    );

  it("lets the signed-in operator store a missing preview, and the pool says which have one", async () => {
    const before = (await (await app.request("/events/w1/images", { headers: auth }, env)).json()) as { images: Array<{ hasPreview: boolean }> };
    expect(before.images.map((image) => image.hasPreview)).toEqual([false]);

    expect((await operatorPreview({})).status).toBe(401);
    expect((await operatorPreview(auth)).status).toBe(201);

    const after = (await (await app.request("/events/w1/images", { headers: auth }, env)).json()) as { images: Array<{ hasPreview: boolean }> };
    expect(after.images.map((image) => image.hasPreview)).toEqual([true]);
  });

  it("keeps the operator's preview to the wedding in the path", async () => {
    await seedEvent("w2");
    expect((await operatorPreview(auth, "w2")).status).toBe(404);
  });

  it("removes the preview with the photo", async () => {
    await operatorPreview(auth);
    expect(r2.contents()).toHaveLength(2);
    const res = await app.request(`/events/w1/images/events/w1/${photo}`, { method: "DELETE", headers: auth }, env);
    expect(res.status).toBe(200);
    expect(r2.contents()).toEqual([]);
  });
});
