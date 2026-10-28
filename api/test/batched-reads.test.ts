import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { callApp } from "../src/mcp/app-call.js";
import type { OAuthEnv } from "../src/env.js";
import { eventFrom, eventStatements, listEvents, loadEvent } from "../src/routes/events.js";
import { geoFrom, loadGeo } from "../src/routes/match-context.js";
import { weddingTags } from "../src/routes/style.js";
import { createTestD1 } from "./helpers/d1.js";
import type { TestD1 } from "./helpers/d1.js";
import { connectorEnv, seedUser } from "./helpers/connector.js";

/**
 * The reads the Claude connector's tools make, cut down for Worker CPU
 * (SUMMIT-344): batched loaders, the parsed geo list kept per isolate, and
 * routes run in process as an already-loaded user.
 */

const here = dirname(fileURLToPath(import.meta.url));
const GEO = JSON.stringify(parse(readFileSync(join(here, "../../research/vocab/geo.yaml"), "utf8")));

let db: TestD1;
let env: OAuthEnv;

beforeEach(async () => {
  db = createTestD1();
  env = connectorEnv(db) as unknown as OAuthEnv;
  await seedUser(db, "user-1", "partner@example.com", "a-long-studio-password");
  db.exec(`INSERT INTO events (id, slug, couple_names, event_date) VALUES ('e1', 'casey-2026', 'Casey & Jordan', '2026-06-14');
    INSERT INTO vendor_credits (event_id, role, business_name, sort_order) VALUES
      ('e1', 'Florist', 'Petal and Stem', 1), ('e1', 'Venue', 'Hawks Cay', 0);`);
});

afterEach(() => db.close());

describe("callApp", () => {
  it("runs a route as the person, with the role the database holds now", async () => {
    const me = await callApp(env, "user-1", "GET", "/auth/me");
    expect(me).toEqual({
      ok: true,
      status: 200,
      body: { id: "user-1", email: "partner@example.com", name: "user-1", role: "photographer" },
    });
    const operatorOnly = await callApp(env, "user-1", "POST", "/research/reproject", {});
    expect(operatorOnly).toMatchObject({ ok: false, status: 403, error: { code: "FORBIDDEN" } });
  });

  it("is refused for a person who no longer exists, before any route runs", async () => {
    expect(await callApp(env, "ghost", "GET", "/auth/me")).toEqual({
      ok: false,
      status: 401,
      error: { code: "UNAUTHORIZED", message: "Authentication required." },
    });
  });
});

describe("eventStatements", () => {
  it("loads the same wedding and credits, in their order, by id or by slug", async () => {
    const byId = await loadEvent(db, "e1");
    expect(byId?.vendorCredits.map((credit) => credit.businessName)).toEqual(["Hawks Cay", "Petal and Stem"]);
    expect(eventFrom(await db.batch(eventStatements(db, "casey-2026", "slug")))).toEqual(byId);
    expect(eventFrom(await db.batch(eventStatements(db, "nobody-2026", "slug")))).toBeNull();
    expect(await loadEvent(db, "nope")).toBeNull();
  });

  it("leaves listEvents as it was, chips and all", async () => {
    const [wedding] = await listEvents(db);
    expect(wedding).toMatchObject({ id: "e1", slug: "casey-2026", inProgress: false, hasPackage: false });
    expect(wedding?.chip.kind).toBe("blocked");
  });
});

describe("weddingTags", () => {
  it("reads one wedding's Look view in one batch, and null for none", async () => {
    const look = await weddingTags(db, "e1");
    expect(look?.tags).toEqual([
      { id: "early_summer", category: "season", state: "suggested", source: "derived", confidence: null, reason: "From the wedding date." },
    ]);
    expect(look?.vocabulary).toContainEqual({ id: "romantic", category: "aesthetic" });
    expect(await weddingTags(db, "nope")).toBeNull();
  });
});

describe("geoFrom", () => {
  it("parses the stored list once, and again only when it changes", async () => {
    expect(geoFrom([])).toBeNull();
    const first = geoFrom([{ json: GEO }]);
    expect(first?.states.get("US-MI")).toBe("Michigan");
    expect(geoFrom([{ json: GEO }])).toBe(first);

    const changed = JSON.parse(GEO) as { states: Record<string, unknown> };
    changed.states = { ...changed.states, "US-MI": "Mitten" };
    expect(geoFrom([{ json: JSON.stringify(changed) }])?.states.get("US-MI")).toBe("Mitten");
  });

  it("is what loadGeo returns, and null before the list is loaded", async () => {
    expect(await loadGeo(db)).toBeNull();
    db.prepare("INSERT INTO research_vocab (kind, json, content_hash) VALUES ('geo', ?, 'x')").bind(GEO).run();
    expect((await loadGeo(db))?.states.get("US-FL")).toBe("Florida");
  });
});
