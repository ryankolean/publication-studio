import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { verifyImageToken } from "../src/domain/image-token.js";
import { MAX_RUNS_PER_DAY } from "../src/domain/style.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2 } from "./helpers/r2.js";

const here = dirname(fileURLToPath(import.meta.url));
const loadYaml = (path: string): unknown => parse(readFileSync(join(here, "../../research", path), "utf8"));

const JWT_SECRET = "test-signing-secret";
let db: TestD1;
let env: Env;
let partner: Record<string, string>;
let admin: Record<string, string>;
let calls: MessageCreateParamsNonStreaming[];
let reply: () => Promise<BetaMessage>;

const answer = (tags: Array<{ tag: string; confidence: string; reason: string }>, stop_reason = "end_turn"): BetaMessage =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason,
    content: [{ type: "text", text: JSON.stringify({ tags }), citations: null }],
    usage: { input_tokens: 41000, output_tokens: 900 },
  }) as unknown as BetaMessage;

const app = createApp({
  analyze: async (_env, request) => {
    calls.push(request);
    return reply();
  },
});

beforeEach(async () => {
  db = createTestD1();
  env = {
    DB: db,
    IMAGES: createTestR2(),
    JWT_SECRET,
    ALLOWED_ORIGIN: "https://studio.example.com",
    ANTHROPIC_API_KEY: "test-key",
  };
  calls = [];
  added = 0;
  reply = async () =>
    answer([
      { tag: "lakefront", confidence: "high", reason: "Photos 1 and 3: dock on a lake." },
      { tag: "romantic", confidence: "medium", reason: "Photo 2: candles." },
    ]);
  db.exec(`INSERT INTO users (id, email, name, role, pw_hash) VALUES
    ('user-admin', 'admin@example.com', 'Admin', 'admin', 'x'),
    ('user-1', 'partner@example.com', 'Partner', 'photographer', 'x');
    INSERT INTO events (id, slug, couple_names, event_date, state, country, rights_status)
      VALUES ('e1', 'e1', 'Ada and Bo', '2026-01-31', 'MI', 'USA', 'own_contract'),
             ('e2', 'e2', 'Cy and Di', '2025-07-04', 'TX', NULL, 'second_shooter');`);
  admin = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-admin", role: "admin" })}` };
  partner = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" })}` };
});

afterEach(() => db.close());

const send = (method: string, path: string, headers: Record<string, string> = partner, body?: unknown) =>
  app.request(
    `https://api.example.com${path}`,
    {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
const json = async (res: Response) => (await res.json()) as Record<string, any>;

/** Photos keyed 000, 001, ... in the order they were added; a later call continues the numbering. */
const addPhotos = (eventId: string, count: number, bytes = 1000) => {
  for (let n = 0; n < count; n++) {
    const index = added++;
    const key = `events/${eventId}/${String(index).padStart(3, "0")}.jpg`;
    db.exec(`INSERT INTO event_images (key, event_id, content_type, bytes, created_at)
      VALUES ('${key}', '${eventId}', 'image/jpeg', ${bytes}, '2026-02-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z')`);
  }
};
let added = 0;
const switchOn = () => send("PUT", "/style/settings/photo-analysis", partner, { enabled: true });
const suggest = (eventId = "e1") => send("POST", `/style/events/${eventId}/suggest`);
const answerTag = (tag: string, state: string, eventId = "e1") =>
  send("PUT", `/style/events/${eventId}/tags/${tag}`, partner, { state });
const rows = async (sql: string) => (await db.prepare(sql).all()).results;
const tagRows = () => rows("SELECT tag_id, state, source, confidence FROM event_tags WHERE event_id = 'e1' ORDER BY tag_id");
const runs = () => rows("SELECT status, error, input_tokens, image_keys_json FROM style_runs ORDER BY created_at, rowid");
const codeOf = async (res: Response) => (await json(res))["code"];

describe("photo analysis consent", () => {
  it("is off until the photographer turns it on, and nothing is sent while it is off", async () => {
    addPhotos("e1", 3);
    const res = await suggest();
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("PHOTO_ANALYSIS_OFF");
    expect(calls).toHaveLength(0);
  });

  it("can only be changed by the photographer, and every change is logged", async () => {
    const res = await send("PUT", "/style/settings/photo-analysis", admin, { enabled: true });
    expect(res.status).toBe(403);
    expect((await switchOn()).status).toBe(200);
    expect((await send("PUT", "/style/settings/photo-analysis", partner, { enabled: false })).status).toBe(200);
    expect(await rows("SELECT action FROM audit_log ORDER BY rowid")).toEqual([
      { action: "photo_analysis_on" },
      { action: "photo_analysis_off" },
    ]);
    expect((await json(await send("GET", "/style/profile")))["analysis"]).toEqual({ enabled: false, available: true });
  });

  it("refuses a body that is not true or false", async () => {
    expect((await send("PUT", "/style/settings/photo-analysis", partner, { enabled: "yes" })).status).toBe(400);
  });
});

describe("POST /style/events/:id/suggest", () => {
  beforeEach(async () => {
    expect((await switchOn()).status).toBe(200);
  });

  it("sends up to 20 photos by their read links and stores the suggestions", async () => {
    addPhotos("e1", 39);
    const res = await suggest();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["fresh"]).toBe(true);

    expect(calls).toHaveLength(1);
    const images = (calls[0]?.messages[0]?.content as Array<Record<string, any>>).filter((block) => block["type"] === "image");
    expect(images).toHaveLength(20);
    const url = new URL(images[0]?.["source"]["url"]);
    expect(url.origin).toBe("https://api.example.com");
    expect(url.pathname).toBe("/images/events/e1/000.jpg");
    const verdict = await verifyImageToken(JWT_SECRET, url.searchParams.get("token") ?? "", {
      key: "events/e1/000.jpg",
      purpose: "read",
    });
    expect(verdict.ok).toBe(true);

    expect(await tagRows()).toEqual([
      { tag_id: "lakefront", state: "suggested", source: "analysis", confidence: "high" },
      { tag_id: "romantic", state: "suggested", source: "analysis", confidence: "medium" },
    ]);
    expect(await runs()).toEqual([
      expect.objectContaining({ status: "ok", error: null, input_tokens: 41000 }),
    ]);
    expect(JSON.parse(String(((await runs())[0] as any).image_keys_json))).toHaveLength(20);
    expect(body["analysis"]).toMatchObject({ enabled: true, available: true, current: true, lastRun: { status: "ok", photoCount: 20 } });
    expect(await rows("SELECT action FROM audit_log WHERE entity = 'event'")).toEqual([{ action: "photos_analyzed" }]);
  });

  it("never sends the same photos twice", async () => {
    addPhotos("e1", 3);
    expect((await suggest()).status).toBe(200);
    const again = await suggest();
    expect(again.status).toBe(200);
    expect((await json(again))["fresh"]).toBe(false);
    expect(calls).toHaveLength(1);

    addPhotos("e1", 4);
    expect((await json(await suggest()))["fresh"]).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("keeps her decisions when a new analysis runs, and drops suggestions it no longer makes", async () => {
    addPhotos("e1", 2);
    await suggest();
    expect((await answerTag("lakefront", "rejected")).status).toBe(200);

    reply = async () =>
      answer([
        { tag: "lakefront", confidence: "high", reason: "Dock." },
        { tag: "whimsical", confidence: "low", reason: "Balloons." },
      ]);
    addPhotos("e1", 3);
    await suggest();
    expect(await tagRows()).toEqual([
      { tag_id: "lakefront", state: "rejected", source: "analysis", confidence: "high" },
      { tag_id: "whimsical", state: "suggested", source: "analysis", confidence: "low" },
    ]);
  });

  it("stops at five runs a wedding a day", async () => {
    for (let run = 1; run <= MAX_RUNS_PER_DAY; run++) {
      addPhotos("e1", run);
      expect((await suggest()).status).toBe(200);
      db.exec("DELETE FROM event_images");
    }
    addPhotos("e1", 9);
    const res = await suggest();
    expect(res.status).toBe(429);
    expect(await codeOf(res)).toBe("ANALYSIS_LIMIT");
    expect(calls).toHaveLength(MAX_RUNS_PER_DAY);
  });

  it("asks for photos first, or for web-size copies", async () => {
    expect(await codeOf(await suggest())).toBe("NO_PHOTOS");
    addPhotos("e1", 1, 9_000_000);
    const res = await suggest();
    expect(res.status).toBe(409);
    expect((await json(res))["message"]).toContain("over 7.5 MB");
    expect(calls).toHaveLength(0);
  });

  it("says suggestions are not set up when there is no key", async () => {
    env.ANTHROPIC_API_KEY = undefined;
    addPhotos("e1", 1);
    const res = await suggest();
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe("ANALYSIS_UNAVAILABLE");
  });

  it("records a refusal and leaves the tags alone", async () => {
    reply = async () => answer([], "refusal");
    addPhotos("e1", 1);
    const res = await suggest();
    expect(res.status).toBe(502);
    expect((await json(res))["message"]).toBe("Claude would not suggest tags for these photos. Choose the tags yourself.");
    expect(await tagRows()).toEqual([]);
    expect(await runs()).toEqual([expect.objectContaining({ status: "refused", error: "refusal" })]);
  });

  it("stores a failed call as a short code, never the error's text", async () => {
    reply = async () => {
      throw new Anthropic.APIError(400, undefined, "Could not fetch https://api.example.com/images/x?token=secret", undefined);
    };
    addPhotos("e1", 1);
    const res = await suggest();
    expect(res.status).toBe(502);
    expect(await codeOf(res)).toBe("ANALYSIS_FAILED");
    expect(await runs()).toEqual([expect.objectContaining({ status: "failed", error: "api 400" })]);
    expect(JSON.stringify(await runs())).not.toContain("secret");
  });

  it("can try the same photos again after a failure", async () => {
    reply = async () => answer([], "max_tokens");
    addPhotos("e1", 1);
    expect((await suggest()).status).toBe(502);
    reply = async () => answer([{ tag: "romantic", confidence: "high", reason: "r" }]);
    expect((await suggest()).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("is a 404 for a wedding that does not exist", async () => {
    expect((await suggest("nope")).status).toBe(404);
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
    expect(body["photos"]).toEqual({ count: 0, usable: 0 });
    expect(body["analysis"]).toEqual({ enabled: false, available: true, lastRun: null, current: false });
    expect(body["vocabulary"]).toContainEqual({ id: "romantic", category: "aesthetic" });
    expect(await tagRows()).toEqual([]);
  });

  it("stores her answer to a date or state tag as derived, and any other tag as hers", async () => {
    expect((await answerTag("winter", "rejected")).status).toBe(200);
    expect((await answerTag("ball_gown", "confirmed")).status).toBe(200);
    expect(await tagRows()).toEqual([
      { tag_id: "ball_gown", state: "confirmed", source: "photographer", confidence: null },
      { tag_id: "winter", state: "rejected", source: "derived", confidence: null },
    ]);
    const body = await json(await answerTag("winter", "confirmed"));
    expect(body["tags"]).toContainEqual(expect.objectContaining({ id: "winter", state: "confirmed" }));
  });

  it("refuses an unknown tag, a missing wedding and a bad state", async () => {
    expect((await answerTag("not_a_tag", "confirmed")).status).toBe(404);
    expect((await answerTag("romantic", "confirmed", "nope")).status).toBe(404);
    expect((await answerTag("romantic", "suggested")).status).toBe(400);
  });
});

describe("GET /style/profile", () => {
  it("counts confirmed tags across her own weddings, leaving out second-shooter ones", async () => {
    db.exec(`INSERT INTO events (id, slug, couple_names, event_date, rights_status) VALUES ('e3', 'e3', 'Ed and Flo', '2025-09-01', 'own_contract')`);
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
      { id: "e1", coupleNames: "Ada and Bo", eventDate: "2026-01-31", secondShooter: false, confirmed: 2, suggested: 0 },
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
