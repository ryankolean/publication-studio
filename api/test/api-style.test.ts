import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2 } from "./helpers/r2.js";

const here = dirname(fileURLToPath(import.meta.url));
const loadYaml = (path: string): unknown => parse(readFileSync(join(here, "../../research", path), "utf8"));

const JWT_SECRET = "test-signing-secret";
let db: TestD1;
let env: Env;
let partner: Record<string, string>;
let admin: Record<string, string>;
const app = createApp();

beforeEach(async () => {
  db = createTestD1();
  env = { DB: db, IMAGES: createTestR2(), JWT_SECRET, ALLOWED_ORIGIN: "https://studio.example.com" };
  db.exec(`INSERT INTO users (id, email, name, role, pw_hash) VALUES
    ('user-admin', 'admin@example.com', 'Admin', 'admin', 'x'),
    ('user-1', 'partner@example.com', 'Partner', 'photographer', 'x');
    INSERT INTO events (id, slug, couple_names, event_date, location_code, rights_status)
      VALUES ('e1', 'e1', 'Ada and Bo', '2026-01-31', 'US-MI', 'own_contract'),
             ('e2', 'e2', 'Cy and Di', '2025-07-04', 'US-TX', 'second_shooter');`);
  admin = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-admin", role: "admin" })}` };
  partner = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" })}` };
});

afterEach(() => db.close());

const send = (method: string, path: string, headers: Record<string, string> = partner, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const rows = async (sql: string) => (await db.prepare(sql).all()).results;
const tagRows = () => rows("SELECT tag_id, state, source, confidence, reason FROM event_tags WHERE event_id = 'e1' ORDER BY tag_id");

const suggest = (tags: unknown, eventId = "e1", headers = admin) =>
  send("PUT", `/style/events/${eventId}/suggestions`, headers, { tags });
const answerTag = (tag: string, state: string, eventId = "e1") =>
  send("PUT", `/style/events/${eventId}/tags/${tag}`, partner, { state });

describe("PUT /style/events/:id/suggestions", () => {
  const two = [
    { tag: "lakefront", confidence: "high", reason: "Photos 1 and 3: dock on a lake." },
    { tag: "romantic", confidence: "medium", reason: " Photo 2: candles. " },
  ];

  it("stores the operator's suggestions for the photographer to answer", async () => {
    const res = await suggest(two);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ written: 2, dropped: 0, alreadyAnswered: 0 });
    expect(await tagRows()).toEqual([
      { tag_id: "lakefront", state: "suggested", source: "operator", confidence: "high", reason: "Photos 1 and 3: dock on a lake." },
      { tag_id: "romantic", state: "suggested", source: "operator", confidence: "medium", reason: "Photo 2: candles." },
    ]);
    expect(await rows("SELECT action FROM audit_log WHERE entity = 'event'")).toEqual([{ action: "tags_suggested" }]);
  });

  it("is for the operator only", async () => {
    expect((await suggest(two, "e1", partner)).status).toBe(403);
    expect((await suggest(two, "e1", {})).status).toBe(401);
    expect(await tagRows()).toEqual([]);
  });

  it("keeps her decisions, and drops earlier suggestions the new set leaves out", async () => {
    await suggest(two);
    expect((await answerTag("lakefront", "rejected")).status).toBe(200);
    const res = await suggest([
      { tag: "lakefront", confidence: "high", reason: "Dock." },
      { tag: "whimsical", confidence: "low", reason: "Balloons." },
    ]);
    expect(await json(res)).toMatchObject({ written: 1, dropped: 1, alreadyAnswered: 1 });
    expect(await tagRows()).toEqual([
      { tag_id: "lakefront", state: "rejected", source: "operator", confidence: "high", reason: "Photos 1 and 3: dock on a lake." },
      { tag_id: "whimsical", state: "suggested", source: "operator", confidence: "low", reason: "Balloons." },
    ]);
  });

  it("refuses the whole set when any tag is wrong, and writes nothing", async () => {
    const res = await suggest([...two, { tag: "lakefrnt", confidence: "high", reason: "Typo." }]);
    expect(res.status).toBe(400);
    expect((await json(res))["details"]).toEqual([{ field: "tags.2.tag", message: "Not a vocabulary tag: lakefrnt." }]);
    expect(await tagRows()).toEqual([]);
  });

  it("is a 404 for a wedding that does not exist", async () => {
    expect((await suggest(two, "nope")).status).toBe(404);
  });
});

describe("GET /style/events/:id and answering tags", () => {
  beforeEach(async () => {
    const vocab = { tags: loadYaml("vocab/tags.yaml"), geo: loadYaml("vocab/geo.yaml") };
    expect((await send("PUT", "/research/vocab", admin, vocab)).status).toBe(200);
  });

  it("suggests the season and region from the wedding's details without storing them", async () => {
    const body = await json(await send("GET", "/style/events/e1"));
    expect(body["tags"]).toEqual([
      { id: "michigan", category: "region", state: "suggested", source: "derived", confidence: null, reason: "From where the wedding was." },
      { id: "midwest_us", category: "region", state: "suggested", source: "derived", confidence: null, reason: "From where the wedding was." },
      { id: "winter", category: "season", state: "suggested", source: "derived", confidence: null, reason: "From the wedding date." },
    ]);
    expect(body["vocabulary"]).toContainEqual({ id: "romantic", category: "aesthetic" });
    expect(await tagRows()).toEqual([]);
  });

  it("stores her answer to a date or state tag as derived, and any other tag as hers", async () => {
    expect((await answerTag("winter", "rejected")).status).toBe(200);
    expect((await answerTag("ball_gown", "confirmed")).status).toBe(200);
    expect(await tagRows()).toEqual([
      { tag_id: "ball_gown", state: "confirmed", source: "photographer", confidence: null, reason: null },
      { tag_id: "winter", state: "rejected", source: "derived", confidence: null, reason: "From the wedding date." },
    ]);
    const body = await json(await answerTag("winter", "confirmed"));
    expect(body["tags"]).toContainEqual(expect.objectContaining({ id: "winter", state: "confirmed" }));
  });

  it("refuses an unknown tag, a missing wedding and a bad state", async () => {
    expect((await answerTag("not_a_tag", "confirmed")).status).toBe(404);
    expect((await answerTag("romantic", "confirmed", "nope")).status).toBe(404);
    expect((await answerTag("romantic", "suggested")).status).toBe(400);
  });

  describe("PUT /style/events/:id/tags", () => {
    const answerTags = (body: unknown, eventId = "e1", headers = partner) => send("PUT", `/style/events/${eventId}/tags`, headers, body);

    it("stores several answers at once, with the same sources as one at a time, and one audit row", async () => {
      await suggest([{ tag: "lakefront", confidence: "high", reason: "Photo 1: a dock." }]);
      const res = await answerTags({ confirmed: ["lakefront", "michigan", "romantic"], rejected: ["winter"] });
      expect(res.status).toBe(200);
      expect(await tagRows()).toEqual([
        { tag_id: "lakefront", state: "confirmed", source: "operator", confidence: "high", reason: "Photo 1: a dock." },
        { tag_id: "michigan", state: "confirmed", source: "derived", confidence: null, reason: "From where the wedding was." },
        { tag_id: "romantic", state: "confirmed", source: "photographer", confidence: null, reason: null },
        { tag_id: "winter", state: "rejected", source: "derived", confidence: null, reason: "From the wedding date." },
      ]);
      expect(await rows("SELECT user_id, action, detail_json FROM audit_log WHERE entity = 'event' AND action = 'tags_answered'")).toEqual([
        { user_id: "user-1", action: "tags_answered", detail_json: JSON.stringify({ confirmed: 3, rejected: 1 }) },
      ]);

      const body = await json(res);
      expect(body["tags"]).toEqual([
        { id: "michigan", category: "region", state: "confirmed", source: "derived", confidence: null, reason: "From where the wedding was." },
        { id: "midwest_us", category: "region", state: "suggested", source: "derived", confidence: null, reason: "From where the wedding was." },
        { id: "lakefront", category: "landscape_venue", state: "confirmed", source: "operator", confidence: "high", reason: "Photo 1: a dock." },
        { id: "romantic", category: "aesthetic", state: "confirmed", source: "photographer", confidence: null, reason: null },
        { id: "winter", category: "season", state: "rejected", source: "derived", confidence: null, reason: "From the wedding date." },
      ]);
      expect(body["vocabulary"]).toContainEqual({ id: "romantic", category: "aesthetic" });
    });

    it("changes an earlier answer, and leaves tags it does not name alone", async () => {
      await answerTags({ confirmed: ["romantic", "lakefront"] });
      await answerTags({ rejected: ["romantic"] });
      expect((await tagRows()).map((row) => [row["tag_id"], row["state"]])).toEqual([
        ["lakefront", "confirmed"],
        ["romantic", "rejected"],
      ]);
    });

    it("refuses the whole set when any tag is wrong, and writes nothing", async () => {
      const res = await answerTags({ confirmed: ["romantic", "made_up"], rejected: ["romantic"] });
      expect(res.status).toBe(400);
      expect((await json(res))["details"]).toEqual([
        { field: "confirmed.1", message: "Not a vocabulary tag: made_up." },
        { field: "rejected.0", message: "Listed twice: romantic." },
      ]);
      expect((await answerTags({})).status).toBe(400);
      expect(await tagRows()).toEqual([]);
      expect(await rows("SELECT action FROM audit_log WHERE action = 'tags_answered'")).toEqual([]);
    });

    it("is a 404 for a wedding that does not exist, and needs a signed-in user", async () => {
      expect((await answerTags({ confirmed: ["romantic"] }, "nope")).status).toBe(404);
      expect((await answerTags({ confirmed: ["romantic"] }, "e1", {})).status).toBe(401);
      expect(await tagRows()).toEqual([]);
    });
  });
});

describe("GET /style/profile", () => {
  it("counts confirmed tags across her own weddings, leaving out second-shooter ones", async () => {
    db.exec(`INSERT INTO events (id, slug, couple_names, event_date, rights_status) VALUES ('e3', 'e3', 'Ed and Flo', '2025-09-01', 'own_contract')`);
    await suggest([{ tag: "whimsical", confidence: "low", reason: "Balloons." }]);
    await answerTag("romantic", "confirmed", "e1");
    await answerTag("lakefront", "confirmed", "e1");
    await answerTag("romantic", "confirmed", "e3");
    await answerTag("bohemian", "rejected", "e3");
    await answerTag("romantic", "confirmed", "e2");
    await answerTag("ball_gown", "confirmed", "e2");

    const body = await json(await send("GET", "/style/profile"));
    expect(body["tagged"]).toBe(2);
    expect(body["categories"]).toEqual([
      { category: "landscape_venue", tags: [{ id: "lakefront", weddings: 1 }] },
      { category: "aesthetic", tags: [{ id: "romantic", weddings: 2 }] },
    ]);
    expect(body["weddings"]).toEqual([
      { id: "e1", coupleNames: "Ada and Bo", eventDate: "2026-01-31", secondShooter: false, confirmed: 2, suggested: 1 },
      { id: "e3", coupleNames: "Ed and Flo", eventDate: "2025-09-01", secondShooter: false, confirmed: 1, suggested: 0 },
      { id: "e2", coupleNames: "Cy and Di", eventDate: "2025-07-04", secondShooter: true, confirmed: 2, suggested: 0 },
    ]);
  });
});

describe("past features", () => {
  beforeEach(() => {
    db.exec(`INSERT INTO publications (id, name, tier, exclusivity_policy, earned_or_paid, last_verified)
      VALUES ('pub-known', 'Known Weddings', 'primary', 'non_exclusive', 'earned', '2026-10-01')`);
  });

  it("names a linked outlet from its publication, and lists features newest first", async () => {
    const linked = await send("POST", "/style/features", partner, { publicationId: "pub-known", eventId: "e1", publishedOn: "2026-03" });
    expect(linked.status).toBe(201);
    expect((await json(linked))["feature"]).toMatchObject({ outletName: "Known Weddings", coupleNames: "Ada and Bo", role: "lead" });
    await send("POST", "/style/features", admin, { outletName: "Old Blog", publishedOn: "2024-05-02", role: "second_shooter" });
    await send("POST", "/style/features", partner, { outletName: "Undated" });

    const features = (await json(await send("GET", "/style/profile")))["features"] as Array<Record<string, any>>;
    expect(features.map((feature) => feature["outletName"])).toEqual(["Known Weddings", "Old Blog", "Undated"]);
  });

  it("refuses an unknown outlet or wedding and reports the field", async () => {
    const res = await send("POST", "/style/features", partner, { publicationId: "pub-nope" });
    expect(res.status).toBe(400);
    expect((await json(res))["details"]).toEqual([{ field: "publicationId", message: "That outlet could not be found." }]);
    const wedding = await send("POST", "/style/features", partner, { outletName: "X", eventId: "nope" });
    expect((await json(wedding))["details"]).toEqual([{ field: "eventId", message: "That wedding could not be found." }]);
  });

  it("edits and deletes a feature", async () => {
    const id = (await json(await send("POST", "/style/features", partner, { outletName: "X" })))["feature"]["id"];
    const edited = await send("PUT", `/style/features/${id}`, partner, { outletName: "Y", featureUrl: "https://y.example.com/a" });
    expect((await json(edited))["feature"]).toMatchObject({ outletName: "Y", featureUrl: "https://y.example.com/a" });
    expect((await send("DELETE", `/style/features/${id}`)).status).toBe(200);
    expect((await send("DELETE", `/style/features/${id}`)).status).toBe(404);
    expect((await send("PUT", `/style/features/${id}`, partner, { outletName: "Z" })).status).toBe(404);
  });

  it("needs a signed-in user", async () => {
    expect((await send("GET", "/style/profile", {})).status).toBe(401);
  });
});
