import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { hashPassword } from "../src/domain/password.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2 } from "./helpers/r2.js";

const JWT_SECRET = "test-signing-secret";
const GALLERY = "https://gallery.example.com/event?it=SECRET-INVITE-TOKEN";

let db: TestD1;
let env: Env;
let auth: Record<string, string>;
const app = createApp();

const minimal = { coupleNames: "Sarah and James", eventDate: "2026-06-14" };

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
    "/events",
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
    expect((await get("/events", {})).status).toBe(401);
  });
});

describe("POST /events", () => {
  it("creates an event and returns it", async () => {
    const body = await create();
    expect(body).toMatchObject({
      coupleNames: "Sarah and James",
      eventDate: "2026-06-14",
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
      expect.arrayContaining(["coupleNames", "eventDate", "rightsStatus"]),
    );
  });

  it("rejects a body that is not json", async () => {
    const res = await app.request(
      "/events",
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
    const detail = (await (await get(`/events/${body["id"]}`)).json()) as Record<string, any>;
    expect(detail["vendorCredits"].map((v: any) => v.businessName)).toEqual([
      "Stems",
      "The Barn",
    ]);
  });

  it("writes the event and its vendors together", async () => {
    const res = await post({
      ...minimal,
      vendorCredits: [{ role: "Florist", businessName: "Stems" }],
    });
    expect(res.status).toBe(201);

    const counts = await db
      .prepare("SELECT (SELECT COUNT(*) FROM events) AS w, (SELECT COUNT(*) FROM vendor_credits) AS v")
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
      "/events",
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
    // event + two vendors + audit entry
    expect(batchedStatements).toBe(4);
    expect(executedDirectly.filter((q) => /INSERT/i.test(q))).toEqual([]);
  });

  it("audit-logs the creation", async () => {
    const body = await create();
    const row = await db
      .prepare("SELECT user_id, entity, entity_id, action FROM audit_log WHERE entity = 'event'")
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      user_id: "user-1",
      entity: "event",
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
      .prepare("SELECT gallery_url FROM events WHERE id = ?")
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
    const text = await (await get("/events")).text();
    expect(text).not.toContain("SECRET-INVITE-TOKEN");
  });

  it("never returns it from the detail view", async () => {
    const body = await create({ ...minimal, galleryUrl: GALLERY });
    const text = await (await get(`/events/${body["id"]}`)).text();
    expect(text).not.toContain("SECRET-INVITE-TOKEN");
  });

  it("reports only whether one is on file", async () => {
    const withGallery = await create({ ...minimal, galleryUrl: GALLERY });
    const without = await create({ coupleNames: "Ada and Bo", eventDate: "2026-07-01" });
    expect(withGallery["hasGalleryUrl"]).toBe(true);
    expect(without["hasGalleryUrl"]).toBe(false);
  });
});

describe("GET /events", () => {
  it("returns an empty inventory before anything is entered", async () => {
    const body = (await (await get("/events")).json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });

  it("lists most recent event first", async () => {
    await create({ coupleNames: "Older", eventDate: "2025-05-01" });
    await create({ coupleNames: "Newer", eventDate: "2026-09-01" });
    const body = (await (await get("/events")).json()) as {
      events: Array<{ coupleNames: string }>;
    };
    expect(body.events.map((w) => w.coupleNames)).toEqual(["Newer", "Older"]);
  });

  it("carries the rights gate verdict for the badge", async () => {
    await create({
      ...minimal,
      rightsStatus: "own_contract",
      consentStatus: "granted",
    });
    const body = (await (await get("/events")).json()) as {
      events: Array<{ gate: { allowed: boolean } }>;
    };
    expect(body.events[0]?.gate).toEqual({ allowed: true });
  });

  it("explains exactly what is missing on a blocked event", async () => {
    await create({ ...minimal, rightsStatus: "unverified", consentStatus: "declined" });
    const body = (await (await get("/events")).json()) as {
      events: Array<{ gate: any }>;
    };
    const gate = body.events[0]?.gate;
    expect(gate.allowed).toBe(false);
    expect(gate.route).toBe("submission");
    expect(gate.reasons.map((r: any) => r.code)).toEqual([
      "RIGHTS_UNVERIFIED",
      "CONSENT_DECLINED",
    ]);
    expect(gate.reasons[0].remedy).toMatch(/\S/);
  });

  it("routes a second-shooter event to credit recovery", async () => {
    await create({ ...minimal, rightsStatus: "second_shooter", consentStatus: "granted" });
    const body = (await (await get("/events")).json()) as { events: Array<{ gate: any }> };
    expect(body.events[0]?.gate.route).toBe("credit_recovery");
  });
});

describe("GET /events: the wizard's chip and progress", () => {
  const complete = {
    ...minimal,
    venueName: "The Barn",
    galleryUrl: GALLERY,
    uniqueAngle: "A ceremony on a frozen lake.",
    rightsStatus: "own_contract",
    consentStatus: "granted",
    vendorCredits: [{ role: "Florist", businessName: "Stems" }],
  };

  const list = async () =>
    ((await (await get("/events")).json()) as { events: Array<Record<string, any>> }).events;

  const packageFor = (eventId: string, id: string, publicationId: string) =>
    db
      .prepare("INSERT INTO packages (id, event_id, publication_id, image_keys) VALUES (?, ?, ?, '[]')")
      .bind(id, eventId, publicationId)
      .run();

  const submissionFor = (eventId: string, publicationId: string, status: string) =>
    db
      .prepare(
        "INSERT INTO submissions (id, event_id, publication_id, status) VALUES (?, ?, ?, ?)",
      )
      .bind(crypto.randomUUID(), eventId, publicationId, status)
      .run();

  it("says ready for a complete record with the gate open", async () => {
    await create(complete);
    expect((await list())[0]).toMatchObject({ chip: { kind: "ready", label: "Ready to send" }, inProgress: false });
  });

  it("says details are needed, counting vendors per event", async () => {
    await create({ ...complete, vendorCredits: [] });
    expect((await list())[0]?.["chip"]).toEqual({ kind: "needs_details", label: "Needs details" });
  });

  it("says blocked, and why, in plain words", async () => {
    await create({ ...complete, consentStatus: "declined" });
    expect((await list())[0]?.["chip"]).toEqual({ kind: "blocked", label: "Blocked: the couple said no" });
  });

  it("is in progress while a package is unqueued or its submission is open, and not after", async () => {
    const id = (await create(complete))["id"] as string;
    await packageFor(id, "pk1", "pub-loverly");
    expect((await list())[0]?.["inProgress"]).toBe(true);

    await submissionFor(id, "pub-loverly", "sent");
    expect((await list())[0]?.["inProgress"]).toBe(true);

    await db.prepare("UPDATE submissions SET status = 'declined'").run();
    expect((await list())[0]?.["inProgress"]).toBe(false);
  });

  it("reads each event's progress from its own packages", async () => {
    const busy = (await create({ ...complete, coupleNames: "Busy" }))["id"] as string;
    await create({ ...complete, coupleNames: "Idle", eventDate: "2026-06-13" });
    await packageFor(busy, "pk1", "pub-loverly");

    const events = await list();
    expect(events.map((event) => [event["coupleNames"], event["inProgress"]])).toEqual([
      ["Busy", true],
      ["Idle", false],
    ]);
  });
});

describe("GET /events/:id", () => {
  it("returns the event with its vendor credits and gate", async () => {
    const created = await create({
      ...minimal,
      vendorCredits: [{ role: "Florist", businessName: "Stems", instagram: "@stems" }],
    });
    const res = await get(`/events/${created["id"]}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body["vendorCredits"]).toEqual([
      { role: "Florist", businessName: "Stems", website: null, instagram: "stems" },
    ]);
    expect(body["gate"]).toBeDefined();
  });

  it("returns a typed 404 for an unknown id", async () => {
    const res = await get("/events/nope");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("PATCH /events/:id", () => {
  const patch = (id: string, body: unknown, headers: Record<string, string> = auth) =>
    app.request(
      `/events/${id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
      env,
    );

  const galleryOf = async (id: string) =>
    (
      await db
        .prepare("SELECT gallery_url FROM events WHERE id = ?")
        .bind(id)
        .first<{ gallery_url: string | null }>()
    )?.gallery_url;

  /** Every intake field set to something other than its default. */
  const full = {
    coupleNames: "Ada and Bo",
    eventDate: "2026-09-20",
    venueName: "The Mill",
    city: "Ann Arbor",
    state: "MI",
    country: "USA",
    styleTags: ["editorial", "garden"],
    uniqueAngle: "A ferry ceremony.",
    rightsStatus: "own_contract",
    consentStatus: "granted_limited",
    consentNotes: "No family photos",
    nameDisplay: "First names only",
    coupleStory: "They met sailing.",
    isDestination: true,
    heroPicks: "12, 40, 88",
    videoUrl: "https://video.example.com/v/1",
    targetOutletNotes: "Dream outlet first.",
    priorExposure: { ownBlog: true, igPosted: true, priorPubs: ["Somewhere"] },
    vendorCredits: [
      { role: "Florist", businessName: "Stems", website: "https://stems.example.com", instagram: "@stems" },
      { role: "Venue", businessName: "The Mill", website: null, instagram: null },
    ],
  };

  it("rejects an unauthenticated edit", async () => {
    const created = await create();
    expect((await patch(created["id"], full, {})).status).toBe(401);
  });

  it("round-trips every intake field and answers with the detail view", async () => {
    const created = await create();
    const res = await patch(created["id"], full);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    const detail = (await (await get(`/events/${created["id"]}`)).json()) as Record<string, any>;
    expect(body).toEqual(detail);

    const { vendorCredits: _credits, ...fields } = full;
    expect(detail).toMatchObject(fields);
    expect(detail["vendorCredits"]).toEqual([
      { role: "Florist", businessName: "Stems", website: "https://stems.example.com", instagram: "stems" },
      { role: "Venue", businessName: "The Mill", website: null, instagram: null },
    ]);
    expect(detail["gate"]).toEqual({ allowed: true });
  });

  it("replaces the vendor credits rather than adding to them", async () => {
    const created = await create({
      ...minimal,
      vendorCredits: [
        { role: "Florist", businessName: "Stems" },
        { role: "Venue", businessName: "The Barn" },
      ],
    });
    await patch(created["id"], { ...minimal, vendorCredits: [{ role: "Planner", businessName: "Plans" }] });

    const detail = (await (await get(`/events/${created["id"]}`)).json()) as Record<string, any>;
    expect(detail["vendorCredits"].map((v: any) => v.businessName)).toEqual(["Plans"]);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM vendor_credits").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("clears an optional field the body leaves out, as the intake form does", async () => {
    const created = await create({ ...minimal, venueName: "The Barn" });
    const body = (await (await patch(created["id"], minimal)).json()) as Record<string, any>;
    expect(body["venueName"]).toBeNull();
  });

  it("keeps the stored gallery link when the body sends null", async () => {
    const created = await create({ ...minimal, galleryUrl: GALLERY });
    const body = (await (await patch(created["id"], { ...minimal, galleryUrl: null })).json()) as Record<
      string,
      any
    >;
    expect(await galleryOf(created["id"])).toBe(GALLERY);
    expect(body["hasGalleryUrl"]).toBe(true);
  });

  it("keeps the stored gallery link when the body leaves it out or sends it blank", async () => {
    const created = await create({ ...minimal, galleryUrl: GALLERY });
    expect((await patch(created["id"], minimal)).status).toBe(200);
    expect(await galleryOf(created["id"])).toBe(GALLERY);
    expect((await patch(created["id"], { ...minimal, galleryUrl: "  " })).status).toBe(200);
    expect(await galleryOf(created["id"])).toBe(GALLERY);
  });

  it("replaces the gallery link when the body sends a new one", async () => {
    const created = await create({ ...minimal, galleryUrl: GALLERY });
    const next = "https://gallery.example.com/event?it=REPLACEMENT-TOKEN";
    await patch(created["id"], { ...minimal, galleryUrl: next });
    expect(await galleryOf(created["id"])).toBe(next);
  });

  it("adds a gallery link to an event that had none", async () => {
    const created = await create();
    const body = (await (await patch(created["id"], { ...minimal, galleryUrl: GALLERY })).json()) as Record<
      string,
      any
    >;
    expect(await galleryOf(created["id"])).toBe(GALLERY);
    expect(body["hasGalleryUrl"]).toBe(true);
  });

  it("never returns the gallery link from the edit response", async () => {
    const created = await create();
    const res = await patch(created["id"], { ...minimal, galleryUrl: GALLERY });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("SECRET-INVITE-TOKEN");
  });

  it("keeps the slug when the couple's names change", async () => {
    const created = await create();
    const body = (await (await patch(created["id"], full)).json()) as Record<string, any>;
    expect(body["slug"]).toBe(created["slug"]);
  });

  it("stamps the update time", async () => {
    const created = await create();
    // Two minutes on: far enough to differ from creation, inside the token's life.
    const later = new Date(Math.floor(Date.now() / 1000) * 1000 + 120_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(later);
    try {
      const res = await patch(created["id"], minimal);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body["updatedAt"]).toBe(later.toISOString().replace(".000Z", "Z"));
      expect(body["createdAt"]).toBe(created["createdAt"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("audit-logs the edit", async () => {
    const created = await create();
    await patch(created["id"], full);
    const row = await db
      .prepare("SELECT user_id, entity_id FROM audit_log WHERE entity = 'event' AND action = 'update'")
      .first<Record<string, unknown>>();
    expect(row).toEqual({ user_id: "user-1", entity_id: created["id"] });
  });

  it("issues the event, credit and audit writes as one batch", async () => {
    const created = await create();
    const executedDirectly: string[] = [];
    let batches = 0;
    let batched = 0;

    const spied: Env["DB"] = {
      prepare: (query: string) => {
        const statement = db.prepare(query);
        const wrap = (bound: ReturnType<typeof statement.bind>) => ({
          first: bound.first.bind(bound),
          all: bound.all.bind(bound),
          bind: (...values: unknown[]) => wrap(bound.bind(...values)),
          run: async () => {
            executedDirectly.push(query);
            return bound.run();
          },
        });
        return wrap(statement);
      },
      batch: async (statements) => {
        batches++;
        batched += statements.length;
        return db.batch(statements);
      },
    };

    const res = await app.request(
      `/events/${created["id"]}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify(full),
      },
      { ...env, DB: spied },
    );

    expect(res.status).toBe(200);
    expect(batches).toBe(1);
    // update + delete credits + two credits + audit entry
    expect(batched).toBe(5);
    expect(executedDirectly.filter((q) => /INSERT|UPDATE|DELETE/i.test(q))).toEqual([]);
  });

  it("returns a typed 404 for an unknown id", async () => {
    const res = await patch("nope", minimal);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: "NOT_FOUND", message: "No such event." });
  });

  it("returns typed validation errors and changes nothing", async () => {
    const created = await create();
    const res = await patch(created["id"], { rightsStatus: "bogus" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details: Array<{ field: string }> };
    expect(body.code).toBe("VALIDATION");
    expect(body.details.map((d) => d.field)).toEqual(
      expect.arrayContaining(["coupleNames", "eventDate", "rightsStatus"]),
    );
    const detail = (await (await get(`/events/${created["id"]}`)).json()) as Record<string, any>;
    expect(detail["coupleNames"]).toBe("Sarah and James");
  });

  it("rejects a body that is not json", async () => {
    const created = await create();
    const res = await app.request(
      `/events/${created["id"]}`,
      { method: "PATCH", headers: { "content-type": "application/json", ...auth }, body: "{" },
      env,
    );
    expect(res.status).toBe(400);
  });
});
