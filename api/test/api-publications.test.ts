import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { hashPassword } from "../src/domain/password.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2 } from "./helpers/r2.js";

const JWT_SECRET = "test-signing-secret";
let db: TestD1;
let env: Env;
let auth: Record<string, string>;
const app = createApp();

beforeEach(async () => {
  db = createTestD1();
  env = {
    DB: db,
    IMAGES: createTestR2(),
    JWT_SECRET,
    ALLOWED_ORIGIN: "https://studio.example.com",
  };
  await db
    .prepare("INSERT INTO users (id, email, name, role, pw_hash) VALUES (?, ?, ?, ?, ?)")
    .bind("user-1", "partner@example.com", "Partner", "photographer", await hashPassword("pw", { iterations: 1000 }))
    .run();
  const token = await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" });
  auth = { authorization: `Bearer ${token}` };
});

afterEach(() => {
  db.close();
});

const get = (path: string, headers: Record<string, string> = auth) =>
  app.request(path, { headers }, env);

describe("GET /publications", () => {
  it("requires authentication", async () => {
    const res = await get("/publications", {});
    expect(res.status).toBe(401);
  });

  it("returns the seeded outlets", async () => {
    const res = await get("/publications");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publications: unknown[] };
    expect(body.publications).toHaveLength(10);
  });

  it("orders primary, then secondary, then dream, alphabetically within a tier", async () => {
    const res = await get("/publications");
    const body = (await res.json()) as { publications: Array<{ name: string; tier: string }> };
    expect(body.publications.map((p) => `${p.tier}:${p.name}`)).toEqual([
      "primary:Brides",
      "primary:Carats & Cake",
      "primary:Over The Moon",
      "primary:The Anti-Bride",
      "primary:The Lane",
      "secondary:Loverly",
      "secondary:Wed Vibes",
      "secondary:Wezoree",
      "dream:People (Weddings)",
      "dream:Vogue Weddings",
    ]);
  });

  it("attaches each outlet's tags in category order, and an empty list where there are none", async () => {
    const res = await get("/publications");
    const body = (await res.json()) as { publications: Array<{ id: string; tags: string[] }> };
    const loverly = body.publications.find((p) => p.id === "pub-loverly");
    expect(loverly?.tags).toContain("classic_timeless");
    expect(loverly?.tags).toContain("garden_botanical");
    // Aesthetic values come before landscape values only if the category
    // order says so; here landscape_venue precedes aesthetic.
    expect(loverly?.tags.indexOf("garden_botanical")).toBeLessThan(
      loverly?.tags.indexOf("classic_timeless") ?? -1,
    );
    expect(body.publications.find((p) => p.id === "pub-people-weddings")?.tags).toEqual([]);
  });

  it("carries the outlet's own response-window wording beside the number", async () => {
    const res = await get("/publications");
    const body = (await res.json()) as {
      publications: Array<{ id: string; typicalResponseDays: number | null; responseWindowNote: string | null }>;
    };
    const otm = body.publications.find((p) => p.id === "pub-over-the-moon");
    expect(otm?.typicalResponseDays).toBe(60);
    expect(otm?.responseWindowNote).toMatch(/60 days/);
    const cc = body.publications.find((p) => p.id === "pub-carats-and-cake");
    expect(cc?.typicalResponseDays).toBeNull();
    expect(cc?.responseWindowNote).toBeNull();
  });

  it("returns the spec already parsed, so the client does not parse json twice", async () => {
    const res = await get("/publications");
    const body = (await res.json()) as {
      publications: Array<{ id: string; spec: Record<string, unknown> }>;
    };
    const loverly = body.publications.find((p) => p.id === "pub-loverly");
    expect(loverly?.spec).toMatchObject({ imgMin: 30, imgMax: 40, size: "web" });
    expect(loverly?.spec["requirements"]).toContain("full_vendor_credits");
    expect(loverly?.spec["requirements"]).toContain("event_description");
  });

  it("exposes last_verified so the view can show spec age", async () => {
    const res = await get("/publications");
    const body = (await res.json()) as { publications: Array<{ lastVerified: string }> };
    expect(body.publications.every((p) => p.lastVerified === "2026-10-19")).toBe(true);
  });

  it("reports an unknown submission method as null rather than omitting it", async () => {
    const res = await get("/publications");
    const body = (await res.json()) as {
      publications: Array<{ id: string; method: string | null }>;
    };
    const people = body.publications.find((p) => p.id === "pub-people-weddings");
    expect(people).toHaveProperty("method", null);
  });

  it("hides deactivated outlets by default", async () => {
    await db.prepare("UPDATE publications SET active = 0 WHERE id = 'pub-wed-vibes'").run();
    const res = await get("/publications");
    const body = (await res.json()) as { publications: Array<{ id: string }> };
    expect(body.publications.map((p) => p.id)).not.toContain("pub-wed-vibes");
    expect(body.publications).toHaveLength(9);
  });

  it("includes deactivated outlets when explicitly asked", async () => {
    await db.prepare("UPDATE publications SET active = 0 WHERE id = 'pub-wed-vibes'").run();
    const res = await get("/publications?include_inactive=1");
    const body = (await res.json()) as { publications: Array<{ id: string; active: boolean }> };
    expect(body.publications).toHaveLength(10);
    expect(body.publications.find((p) => p.id === "pub-wed-vibes")?.active).toBe(false);
  });

  it("returns active as a boolean, not the stored integer", async () => {
    const res = await get("/publications");
    const body = (await res.json()) as { publications: Array<{ active: unknown }> };
    expect(body.publications.every((p) => p.active === true)).toBe(true);
  });
});

describe("GET /publications/:id", () => {
  it("requires authentication", async () => {
    const res = await get("/publications/pub-loverly", {});
    expect(res.status).toBe(401);
  });

  it("returns one outlet with its parsed spec", async () => {
    const res = await get("/publications/pub-carats-and-cake");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "pub-carats-and-cake",
      name: "Carats & Cake",
      tier: "primary",
      method: "portal",
      typicalResponseDays: null,
      earnedOrPaid: "earned",
    });
    expect(body["spec"]).toMatchObject({ watermarksAllowed: false, size: "web" });
    expect(body["tags"]).toContain("garden_botanical");
  });

  it("returns a deactivated outlet when addressed directly", async () => {
    await db.prepare("UPDATE publications SET active = 0 WHERE id = 'pub-loverly'").run();
    const res = await get("/publications/pub-loverly");
    expect(res.status).toBe(200);
  });

  it("returns a typed 404 for an unknown id", async () => {
    const res = await get("/publications/pub-nope");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("GET /tags", () => {
  it("requires authentication", async () => {
    const res = await get("/tags", {});
    expect(res.status).toBe(401);
  });

  it("returns the whole vocabulary grouped by category in priority order", async () => {
    const res = await get("/tags");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: Array<{ id: string; category: string }> };
    const categories = [...new Set(body.tags.map((tag) => tag.category))];
    expect(categories).toEqual([
      "region",
      "landscape_venue",
      "architecture",
      "aesthetic",
      "dress_style",
      "season",
    ]);
    expect(body.tags.map((tag) => tag.id)).toContain("michigan");
  });
});
