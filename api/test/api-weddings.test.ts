import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { hashPassword } from "../src/domain/password.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2 } from "./helpers/r2.js";

const JWT_SECRET = "test-signing-secret";
const GALLERY = "https://gallery.example.com/wedding?it=SECRET-INVITE-TOKEN";

let db: TestD1;
let env: Env;
let auth: Record<string, string>;
const app = createApp();

const minimal = { coupleNames: "Sarah and James", weddingDate: "2026-06-14" };

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
    .bind("user-1", "p@example.com", "Partner", "photographer", await hashPassword("pw", { iterations: 1000 }))
    .run();
  const token = await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" });
  auth = { authorization: `Bearer ${token}` };
});

afterEach(() => {
  db.close();
});

const post = (body: unknown, headers: Record<string, string> = auth) =>
  app.request(
    "/weddings",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );

const get = (path: string, headers: Record<string, string> = auth) =>
  app.request(path, { headers }, env);

const create = async (body: unknown = minimal) => {
  const res = await post(body);
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, any>;
};

describe("authentication", () => {
  it("rejects an unauthenticated create", async () => {
    expect((await post(minimal, {})).status).toBe(401);
  });

  it("rejects an unauthenticated list", async () => {
    expect((await get("/weddings", {})).status).toBe(401);
  });
});

describe("POST /weddings", () => {
  it("creates a wedding and returns it", async () => {
    const body = await create();
    expect(body).toMatchObject({
      coupleNames: "Sarah and James",
      weddingDate: "2026-06-14",
      rightsStatus: "unverified",
      consentStatus: "unverified",
    });
    expect(typeof body["id"]).toBe("string");
  });

  it("derives a readable slug", async () => {
    expect((await create())["slug"]).toBe("sarah-and-james-2026");
  });

  it("disambiguates a colliding slug rather than failing", async () => {
    const first = await create();
    const second = await create();
    expect(second["slug"]).not.toBe(first["slug"]);
    expect(second["slug"]).toMatch(/^sarah-and-james-2026-\d+$/);
  });

  it("returns typed validation errors listing every bad field", async () => {
    const res = await post({ rightsStatus: "bogus" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details: Array<{ field: string }> };
    expect(body.code).toBe("VALIDATION");
    expect(body.details.map((d) => d.field)).toEqual(
      expect.arrayContaining(["coupleNames", "weddingDate", "rightsStatus"]),
    );
  });

  it("rejects a body that is not json", async () => {
    const res = await app.request(
      "/weddings",
      { method: "POST", headers: { "content-type": "application/json", ...auth }, body: "{" },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("stores vendor credits in the order given", async () => {
    const body = await create({
      ...minimal,
      vendorCredits: [
        { role: "Florist", businessName: "Stems" },
        { role: "Venue", businessName: "The Barn" },
      ],
    });
    const detail = (await (await get(`/weddings/${body["id"]}`)).json()) as Record<string, any>;
    expect(detail["vendorCredits"].map((v: any) => v.businessName)).toEqual([
      "Stems",
      "The Barn",
    ]);
  });

  it("writes the wedding and its vendors together", async () => {
    const res = await post({
      ...minimal,
      vendorCredits: [{ role: "Florist", businessName: "Stems" }],
    });
    expect(res.status).toBe(201);

    const counts = await db
      .prepare("SELECT (SELECT COUNT(*) FROM weddings) AS w, (SELECT COUNT(*) FROM vendor_credits) AS v")
      .first<{ w: number; v: number }>();
    expect(counts).toEqual({ w: 1, v: 1 });
  });

  it("issues those writes as one transaction, not a sequence", async () => {
    // Atomicity cannot be observed from a successful request, so this asserts
    // the mechanism: every insert goes through a single batch, and none is
    // executed on its own where a later failure could strand it.
    const executedDirectly: string[] = [];
    let batchCalls = 0;
    let batchedStatements = 0;

    const spied: Env["DB"] = {
      prepare: (query: string) => {
        const statement = db.prepare(query);
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              first: bound.first.bind(bound),
              all: bound.all.bind(bound),
              bind: bound.bind.bind(bound),
              run: async () => {
                executedDirectly.push(query);
                return bound.run();
              },
            };
          },
          first: statement.first.bind(statement),
          all: statement.all.bind(statement),
          run: async () => {
            executedDirectly.push(query);
            return statement.run();
          },
        };
      },
      batch: async (statements) => {
        batchCalls++;
        batchedStatements += statements.length;
        return db.batch(statements);
      },
    };

    const res = await app.request(
      "/weddings",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          ...minimal,
          vendorCredits: [
            { role: "Florist", businessName: "Stems" },
            { role: "Venue", businessName: "The Barn" },
          ],
        }),
      },
      { ...env, DB: spied },
    );

    expect(res.status).toBe(201);
    expect(batchCalls).toBe(1);
    // wedding + two vendors + audit entry
    expect(batchedStatements).toBe(4);
    expect(executedDirectly.filter((q) => /INSERT/i.test(q))).toEqual([]);
  });

  it("audit-logs the creation", async () => {
    const body = await create();
    const row = await db
      .prepare("SELECT user_id, entity, entity_id, action FROM audit_log WHERE entity = 'wedding'")
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      user_id: "user-1",
      entity: "wedding",
      entity_id: body["id"],
      action: "create",
    });
  });

  it("round-trips prior exposure and style tags", async () => {
    const body = await create({
      ...minimal,
      styleTags: ["editorial", "destination"],
      priorExposure: { ownBlog: true, igPosted: false, priorPubs: ["Somewhere"] },
    });
    expect(body["styleTags"]).toEqual(["editorial", "destination"]);
    expect(body["priorExposure"]).toEqual({
      ownBlog: true,
      igPosted: false,
      priorPubs: ["Somewhere"],
    });
  });
});

describe("the gallery url is a credential", () => {
  it("accepts one on intake", async () => {
    const res = await post({ ...minimal, galleryUrl: GALLERY });
    expect(res.status).toBe(201);
  });

  it("stores it", async () => {
    const body = await create({ ...minimal, galleryUrl: GALLERY });
    const row = await db
      .prepare("SELECT gallery_url FROM weddings WHERE id = ?")
      .bind(body["id"])
      .first<{ gallery_url: string }>();
    expect(row?.gallery_url).toBe(GALLERY);
  });

  it("never returns it from the create response", async () => {
    const body = await create({ ...minimal, galleryUrl: GALLERY });
    expect(JSON.stringify(body)).not.toContain("SECRET-INVITE-TOKEN");
  });

  it("never returns it from the list", async () => {
    await create({ ...minimal, galleryUrl: GALLERY });
    const text = await (await get("/weddings")).text();
    expect(text).not.toContain("SECRET-INVITE-TOKEN");
  });

  it("never returns it from the detail view", async () => {
    const body = await create({ ...minimal, galleryUrl: GALLERY });
    const text = await (await get(`/weddings/${body["id"]}`)).text();
    expect(text).not.toContain("SECRET-INVITE-TOKEN");
  });

  it("reports only whether one is on file", async () => {
    const withGallery = await create({ ...minimal, galleryUrl: GALLERY });
    const without = await create({ coupleNames: "Ada and Bo", weddingDate: "2026-07-01" });
    expect(withGallery["hasGalleryUrl"]).toBe(true);
    expect(without["hasGalleryUrl"]).toBe(false);
  });
});

describe("GET /weddings", () => {
  it("returns an empty inventory before anything is entered", async () => {
    const body = (await (await get("/weddings")).json()) as { weddings: unknown[] };
    expect(body.weddings).toEqual([]);
  });

  it("lists most recent wedding first", async () => {
    await create({ coupleNames: "Older", weddingDate: "2025-05-01" });
    await create({ coupleNames: "Newer", weddingDate: "2026-09-01" });
    const body = (await (await get("/weddings")).json()) as {
      weddings: Array<{ coupleNames: string }>;
    };
    expect(body.weddings.map((w) => w.coupleNames)).toEqual(["Newer", "Older"]);
  });

  it("carries the rights gate verdict for the badge", async () => {
    await create({
      ...minimal,
      rightsStatus: "own_contract",
      consentStatus: "granted",
    });
    const body = (await (await get("/weddings")).json()) as {
      weddings: Array<{ gate: { allowed: boolean } }>;
    };
    expect(body.weddings[0]?.gate).toEqual({ allowed: true });
  });

  it("explains exactly what is missing on a blocked wedding", async () => {
    await create({ ...minimal, rightsStatus: "unverified", consentStatus: "declined" });
    const body = (await (await get("/weddings")).json()) as {
      weddings: Array<{ gate: any }>;
    };
    const gate = body.weddings[0]?.gate;
    expect(gate.allowed).toBe(false);
    expect(gate.route).toBe("submission");
    expect(gate.reasons.map((r: any) => r.code)).toEqual([
      "RIGHTS_UNVERIFIED",
      "CONSENT_DECLINED",
    ]);
    expect(gate.reasons[0].remedy).toMatch(/\S/);
  });

  it("routes a second-shooter wedding to credit recovery", async () => {
    await create({ ...minimal, rightsStatus: "second_shooter", consentStatus: "granted" });
    const body = (await (await get("/weddings")).json()) as { weddings: Array<{ gate: any }> };
    expect(body.weddings[0]?.gate.route).toBe("credit_recovery");
  });
});

describe("GET /weddings/:id", () => {
  it("returns the wedding with its vendor credits and gate", async () => {
    const created = await create({
      ...minimal,
      vendorCredits: [{ role: "Florist", businessName: "Stems", instagram: "@stems" }],
    });
    const res = await get(`/weddings/${created["id"]}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body["vendorCredits"]).toEqual([
      { role: "Florist", businessName: "Stems", website: null, instagram: "stems" },
    ]);
    expect(body["gate"]).toBeDefined();
  });

  it("returns a typed 404 for an unknown id", async () => {
    const res = await get("/weddings/nope");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
  });
});
