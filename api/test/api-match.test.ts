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
const loadYaml = (path: string): unknown => parse(readFileSync(join(here, path), "utf8"));
const vocabBody = () => ({ tags: loadYaml("../../research/vocab/tags.yaml"), geo: loadYaml("../../research/vocab/geo.yaml") });

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
    ('user-1', 'partner@example.com', 'Partner', 'photographer', 'x')`);
  admin = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-admin", role: "admin" })}` };
  partner = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" })}` };
  expect((await send("PUT", "/research/vocab", admin, vocabBody())).status).toBe(200);
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

/** Approves the example outlet: covers Michigan and the Midwest by wedding location. */
async function approveExample() {
  const proposed = await send("POST", "/research/revisions", admin, {
    file: loadYaml("fixtures/research/pub-example-weddings.yaml"),
    contacts: null,
    git_sha: "abc1234",
  });
  const { revisionId } = await json(proposed);
  expect((await send("POST", `/research/revisions/${revisionId}/approve`, partner, {})).status).toBe(200);
}

async function createWedding(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await send("POST", "/events", partner, { coupleNames: "Ada and Bo", eventDate: "2026-07-31", ...extra });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await json(res))["id"] as string;
}

const outletsFor = async (id: string) => (await json(await send("GET", `/events/${id}/walkthrough`)))["outlets"] as Array<Record<string, any>>;

describe("GET /events/:id/walkthrough ranks the outlets", () => {
  it("puts an outlet covering the wedding's place first, and says why", async () => {
    await approveExample();
    const id = await createWedding({ locationCode: "US-MI:detroit" });
    const outlets = await outletsFor(id);
    expect(outlets[0]).toMatchObject({ id: "pub-example-weddings", match: { group: "fits" } });
    expect(outlets[0]?.["match"]["parts"].find((part: any) => part.part === "local")).toMatchObject({
      points: 10,
      note: "Covers Michigan specifically.",
    });
    // The seeded outlets have no approved research yet: check first, never excluded.
    expect(outlets.slice(1).every((outlet) => outlet["match"]["group"] === "check")).toBe(true);
  });

  it("excludes it for a wedding elsewhere, last in the list, with the reason", async () => {
    await approveExample();
    const id = await createWedding({ locationCode: "US-FL:florida-keys" });
    const outlets = await outletsFor(id);
    expect(outlets.at(-1)).toMatchObject({
      id: "pub-example-weddings",
      match: { group: "excluded", excluded: ["Covers only Michigan and Midwest; this wedding was in Florida Keys, Florida."] },
    });
  });

  it("turns couple posts into a question where only sneak peeks are allowed", async () => {
    await approveExample();
    const id = await createWedding({ locationCode: "US-MI" });
    const put = await send("PUT", `/events/${id}/exposures`, partner, { exposures: [{ channel: "couple_social" }] });
    expect(put.status).toBe(200);
    const example = (await outletsFor(id)).find((outlet) => outlet["id"] === "pub-example-weddings");
    expect(example?.["match"]).toMatchObject({
      group: "check",
      checks: ["Allows only a few sneak peeks before it publishes. This wedding was shared by the couple on social media. Check it was only a few photos."],
    });
  });

  it("uses her declines as history", async () => {
    await approveExample();
    const id = await createWedding({ locationCode: "US-MI" });
    db.exec(`INSERT INTO submissions (id, event_id, publication_id, status, outcome_at)
      VALUES ('s1', '${id}', 'pub-example-weddings', 'declined', '2026-09-01T00:00:00Z')`);
    const example = (await outletsFor(id)).find((outlet) => outlet["id"] === "pub-example-weddings");
    expect(example?.["match"]["excluded"]).toEqual(["Declined this wedding."]);
  });
});

describe("exposures", () => {
  it("replaces the list and reads it back", async () => {
    const id = await createWedding();
    await send("PUT", `/events/${id}/exposures`, partner, { exposures: [{ channel: "own_blog" }, { channel: "vendor_social", detail: "the florist" }] });
    const res = await send("PUT", `/events/${id}/exposures`, partner, { exposures: [{ channel: "couple_social" }] });
    expect((await json(res))["exposures"]).toEqual([{ id: expect.any(String), channel: "couple_social", detail: null, publicationId: null }]);
    expect((await json(await send("GET", `/events/${id}/exposures`)))["exposures"]).toHaveLength(1);
    expect(await (await send("GET", "/events/nope/exposures")).status).toBe(404);
  });

  it("refuses an outlet that does not exist, and a bad channel", async () => {
    const id = await createWedding();
    const unknown = await send("PUT", `/events/${id}/exposures`, partner, { exposures: [{ channel: "publication", publicationId: "pub-nope" }] });
    expect((await json(unknown))["details"]).toEqual([{ field: "exposures.0.publicationId", message: "That outlet could not be found." }]);
    expect((await send("PUT", `/events/${id}/exposures`, partner, { exposures: [{ channel: "tv" }] })).status).toBe(400);
  });
});

describe("GET /locations", () => {
  it("lists every place a wedding can be", async () => {
    const { locations } = await json(await send("GET", "/locations"));
    expect(locations).toContainEqual({ code: "US-FL:florida-keys", label: "Florida Keys, Florida", group: "us" });
    expect(locations).toContainEqual({ code: "MX", label: "Mexico", group: "intl" });
    expect((await send("GET", "/locations", {})).status).toBe(401);
  });
});

describe("POST /research/reproject", () => {
  it("fills in the match facts of outlets approved before they existed, for the operator only", async () => {
    await approveExample();
    db.exec("UPDATE publications SET match_json = NULL WHERE id = 'pub-example-weddings'");
    expect((await send("POST", "/research/reproject", partner, {})).status).toBe(403);
    expect(await json(await send("POST", "/research/reproject", admin, {}))).toEqual({ reprojected: 1, remaining: 0 });
    const { results } = await db.prepare("SELECT match_json FROM publications WHERE id = 'pub-example-weddings'").all<{ match_json: string }>();
    expect(JSON.parse(results[0]?.match_json ?? "null")).toMatchObject({ coverage: { regions: ["US-MI", "US:midwest"] } });
  });
});

describe("the Look step suggests the region from the place", () => {
  it("reads the location code", async () => {
    const id = await createWedding({ locationCode: "US-FL:florida-keys" });
    const tags = (await json(await send("GET", `/style/events/${id}`)))["tags"] as Array<Record<string, any>>;
    expect(tags.filter((tag) => tag["source"] === "derived").map((tag) => tag["id"])).toEqual(["florida", "southeast_us", "high_summer"]);
  });
});
