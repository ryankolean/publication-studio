import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { hashPassword } from "../src/domain/password.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2, type TestR2 } from "./helpers/r2.js";

const JWT_SECRET = "test-signing-secret";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

let db: TestD1;
let r2: TestR2;
let env: Env;
let auth: Record<string, string>;
const app = createApp();

async function seedEvent(
  id: string,
  rights = "own_contract",
  consent = "granted",
) {
  await db
    .prepare(
      `INSERT INTO events (id, slug, couple_names, event_date, rights_status, consent_status)
       VALUES (?, ?, 'A and B', '2026-06-01', ?, ?)`,
    )
    .bind(id, id, rights, consent)
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

const requestUpload = (eventId: string, contentType = "image/jpeg", headers = auth) =>
  app.request(
    `/events/${eventId}/images`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ contentType }),
    },
    env,
  );

const grantFor = async (eventId: string) => {
  const res = await requestUpload(eventId);
  expect(res.status).toBe(201);
  return (await res.json()) as { key: string; uploadUrl: string; expiresIn: number };
};

const upload = (uploadUrl: string, body: Uint8Array, contentType = "image/jpeg") =>
  app.request(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body }, env);

describe("requesting an upload", () => {
  it("requires authentication", async () => {
    await seedEvent("w1");
    expect((await requestUpload("w1", "image/jpeg", {})).status).toBe(401);
  });

  it("404s for an event that does not exist", async () => {
    expect((await requestUpload("ghost")).status).toBe(404);
  });

  it("returns a key the server chose", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    expect(grant.key).toMatch(/^events\/w1\/[0-9a-f-]{36}\.jpg$/);
  });

  it("rejects a content type outside the allowlist", async () => {
    await seedEvent("w1");
    for (const type of ["image/gif", "application/pdf", "text/html", "image/svg+xml"]) {
      const res = await requestUpload("w1", type);
      expect(res.status, type).toBe(400);
    }
  });

  it("rejects a missing content type", async () => {
    await seedEvent("w1");
    const res = await app.request(
      "/events/w1/images",
      { method: "POST", headers: { "content-type": "application/json", ...auth }, body: "{}" },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("the rights gate governs curation, not just packaging", () => {
  it("refuses an upload for an event with unverified rights", async () => {
    await seedEvent("w1", "unverified", "granted");
    const res = await requestUpload("w1");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; details: Array<{ code: string }> };
    expect(body.code).toBe("RIGHTS_BLOCKED");
    expect(body.details.map((d) => d.code)).toContain("RIGHTS_UNVERIFIED");
  });

  it("refuses an upload for a second-shooter event", async () => {
    await seedEvent("w1", "second_shooter", "granted");
    expect((await requestUpload("w1")).status).toBe(403);
  });

  it("refuses an upload when consent was declined", async () => {
    await seedEvent("w1", "own_contract", "declined");
    expect((await requestUpload("w1")).status).toBe(403);
  });

  it("allows an upload once rights and consent are green", async () => {
    await seedEvent("w1", "own_contract", "granted_limited");
    expect((await requestUpload("w1")).status).toBe(201);
  });
});

describe("uploading bytes", () => {
  it("stores the object", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    const res = await upload(grant.uploadUrl, JPEG);
    expect(res.status).toBe(201);
    expect(r2.contents()).toEqual([grant.key]);
    expect(r2.bytesOf(grant.key)).toBe(JPEG.byteLength);
  });

  it("needs no bearer token, because the capability is the credential", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    expect((await upload(grant.uploadUrl, JPEG)).status).toBe(201);
  });

  it("refuses an upload with no token", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    const res = await upload(grant.uploadUrl.split("?")[0] as string, JPEG);
    expect(res.status).toBe(401);
    expect(r2.contents()).toEqual([]);
  });

  it("refuses a token minted for a different object", async () => {
    await seedEvent("w1");
    const first = await grantFor("w1");
    const second = await grantFor("w1");
    const swapped = `/images/${second.key}?${first.uploadUrl.split("?")[1]}`;

    expect((await upload(swapped, JPEG)).status).toBe(401);
    expect(r2.contents()).toEqual([]);
  });

  it("refuses an empty body", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    expect((await upload(grant.uploadUrl, new Uint8Array())).status).toBe(400);
  });

  it("refuses a body over the size limit", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    const huge = new Uint8Array(13 * 1024 * 1024);
    expect((await upload(grant.uploadUrl, huge)).status).toBe(400);
    expect(r2.contents()).toEqual([]);
  });

  it("refuses a content type the grant did not cover", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    expect((await upload(grant.uploadUrl, JPEG, "text/html")).status).toBe(400);
  });
});

describe("reading bytes back", () => {
  const readUrlFor = async (key: string) => {
    const res = await app.request(
      `/images/${key}/read-url`,
      { method: "POST", headers: auth },
      env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { url: string; expiresIn: number };
  };

  it("serves the bytes with the stored content type", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    await upload(grant.uploadUrl, JPEG);

    const { url } = await readUrlFor(grant.key);
    const res = await app.request(url, {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
  });

  it("refuses a read with no token", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    await upload(grant.uploadUrl, JPEG);
    expect((await app.request(`/images/${grant.key}`, {}, env)).status).toBe(401);
  });

  it("refuses an upload token used to read", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    await upload(grant.uploadUrl, JPEG);
    const res = await app.request(grant.uploadUrl, {}, env);
    expect(res.status).toBe(401);
  });

  it("requires authentication to mint a read url", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    await upload(grant.uploadUrl, JPEG);
    const res = await app.request(`/images/${grant.key}/read-url`, { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("404s a read url for an object that does not exist", async () => {
    const res = await app.request(
      "/images/events/w1/nope.jpg/read-url",
      { method: "POST", headers: auth },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("does not cache beyond the life of the token", async () => {
    await seedEvent("w1");
    const grant = await grantFor("w1");
    await upload(grant.uploadUrl, JPEG);
    const { url, expiresIn } = await readUrlFor(grant.key);
    const res = await app.request(url, {}, env);
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("private");
    expect(cacheControl).toContain(String(expiresIn));
  });
});
