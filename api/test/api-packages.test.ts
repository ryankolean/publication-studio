import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { hashPassword } from "../src/domain/password.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2 } from "./helpers/r2.js";

const JWT_SECRET = "test-signing-secret";
const PUB = "pub-loverly";

let db: TestD1;
let env: Env;
let auth: Record<string, string>;
const app = createApp();

async function seedEvent(
  id = "w1",
  overrides: {
    rights?: string;
    consent?: string;
    nameDisplay?: string | null;
    consentNotes?: string | null;
    story?: string | null;
  } = {},
) {
  await db
    .prepare(
      `INSERT INTO events (id, slug, couple_names, event_date, venue_name, city, state,
         rights_status, consent_status, name_display, consent_notes, couple_story)
       VALUES (?, ?, 'Sarah and James', '2026-06-14', 'The Barn', 'Detroit', 'MI', ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      id,
      overrides.rights ?? "own_contract",
      overrides.consent ?? "granted",
      overrides.nameDisplay ?? null,
      overrides.consentNotes ?? null,
      overrides.story ?? null,
    )
    .run();
}

const addVendor = (eventId: string, role: string, name: string, order = 0) =>
  db
    .prepare(
      "INSERT INTO vendor_credits (id, event_id, role, business_name, sort_order) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), eventId, role, name, order)
    .run();

beforeEach(async () => {
  db = createTestD1();
  env = { DB: db, IMAGES: createTestR2(), JWT_SECRET, ALLOWED_ORIGIN: "https://studio.example.com" };
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

const createPackage = (eventId = "w1", publicationId = PUB, headers = auth) =>
  app.request(
    "/packages",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ eventId, publicationId }),
    },
    env,
  );

const patchPackage = (id: string, body: unknown, headers = auth) =>
  app.request(
    `/packages/${id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );

/** Response bodies are unknown to TypeScript; these assertions index freely. */
const bodyOf = async (res: Response): Promise<Record<string, any>> =>
  (await res.json()) as Record<string, any>;

const created = async (eventId = "w1", publicationId = PUB) => {
  const res = await createPackage(eventId, publicationId);
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, any>;
};

describe("creating a package", () => {
  it("requires authentication", async () => {
    await seedEvent();
    expect((await createPackage("w1", PUB, {})).status).toBe(401);
  });

  it("404s an unknown event or publication", async () => {
    await seedEvent();
    expect((await createPackage("ghost", PUB)).status).toBe(404);
    expect((await createPackage("w1", "pub-ghost")).status).toBe(404);
  });

  it("rejects a missing field", async () => {
    await seedEvent();
    const res = await app.request(
      "/packages",
      { method: "POST", headers: { "content-type": "application/json", ...auth }, body: "{}" },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("refuses a deactivated publication", async () => {
    await seedEvent();
    await db.prepare("UPDATE publications SET active = 0 WHERE id = ?").bind(PUB).run();
    expect((await createPackage()).status).toBe(400);
  });

  it("carries the publication spec so the client need not fetch it separately", async () => {
    await seedEvent();
    const pkg = await created();
    expect(pkg["publication"]).toMatchObject({ id: PUB, name: "Loverly" });
    expect(pkg["publication"].spec).toMatchObject({ imgMin: 30, imgMax: 40 });
  });

  it("audit-logs the creation", async () => {
    await seedEvent();
    const pkg = await created();
    const row = await db
      .prepare("SELECT user_id, action FROM audit_log WHERE entity = 'package' AND entity_id = ?")
      .bind(pkg["id"])
      .first<{ user_id: string; action: string }>();
    expect(row).toMatchObject({ user_id: "user-1", action: "create" });
  });
});

describe("the rights gate governs packaging", () => {
  it("refuses an event with unverified rights", async () => {
    await seedEvent("w1", { rights: "unverified" });
    const res = await createPackage();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: "RIGHTS_BLOCKED" });
  });

  it("refuses a second-shooter event", async () => {
    await seedEvent("w1", { rights: "second_shooter" });
    expect((await createPackage()).status).toBe(403);
  });

  it("refuses declined consent", async () => {
    await seedEvent("w1", { consent: "declined" });
    expect((await createPackage()).status).toBe(403);
  });

  it("writes no package when the gate refuses", async () => {
    await seedEvent("w1", { rights: "unverified" });
    await createPackage();
    const row = await db.prepare("SELECT COUNT(*) AS n FROM packages").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe("the generator drafts content", () => {
  it("drafts a description from the intake", async () => {
    await seedEvent("w1", { story: "They met at a bus stop." });
    const pkg = await created();
    expect(pkg["descriptionMd"]).toContain("Sarah and James were married on 2026-06-14");
    expect(pkg["descriptionMd"]).toContain("They met at a bus stop.");
  });

  it("drafts a credits block from the vendor list, in order", async () => {
    await seedEvent();
    await addVendor("w1", "Venue", "The Barn", 0);
    await addVendor("w1", "Florist", "Stems", 1);
    const pkg = await created();
    expect(pkg["creditsBlockMd"]).toBe("- Venue: The Barn\n- Florist: Stems");
  });

  it("starts with no images selected", async () => {
    await seedEvent();
    expect((await created())["imageKeys"]).toEqual([]);
  });
});

describe("one package per pairing", () => {
  it("returns the existing package rather than creating a second", async () => {
    await seedEvent();
    const first = await created();

    const again = await createPackage();
    expect(again.status).toBe(200);
    expect((await bodyOf(again))["id"]).toBe(first["id"]);

    const row = await db.prepare("SELECT COUNT(*) AS n FROM packages").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("does not overwrite edits when asked again", async () => {
    await seedEvent();
    const pkg = await created();
    await patchPackage(pkg["id"], { descriptionMd: "My own words." });

    const again = await createPackage();
    expect((await bodyOf(again))["descriptionMd"]).toBe("My own words.");
  });

  it("allows a separate package for a different publication", async () => {
    await seedEvent();
    await created("w1", PUB);
    const other = await created("w1", "pub-carats-and-cake");
    expect(other["publicationId"]).toBe("pub-carats-and-cake");
  });
});

describe("the checklist travels with the package", () => {
  it("is incomplete for a fresh package", async () => {
    await seedEvent();
    const pkg = await created();
    expect(pkg["complete"]).toBe(false);
    expect(pkg["missing"]).toContain("images_present");
  });

  it("reflects the outlet's published image range", async () => {
    await seedEvent();
    const pkg = await created();
    const item = pkg["checklist"].find((i: any) => i.id === "image_count");
    expect(item.label).toContain("30 to 40");
  });

  it("adds the couple's limits when they set any", async () => {
    await seedEvent("w1", { nameDisplay: "first names only" });
    const pkg = await created();
    const item = pkg["checklist"].find((i: any) => i.id === "consent_limits");
    expect(item.detail).toContain("first names only");
    expect(pkg["missing"]).toContain("consent_limits");
  });

  it("surfaces the couple's limits alongside the copy", async () => {
    await seedEvent("w1", { consentNotes: "no family photos" });
    const pkg = await created();
    expect(pkg["consent"]).toEqual({ nameDisplay: null, consentNotes: "no family photos" });
  });
});

describe("editing a package", () => {
  it("requires authentication", async () => {
    await seedEvent();
    const pkg = await created();
    expect((await patchPackage(pkg["id"], { descriptionMd: "x" }, {})).status).toBe(401);
  });

  it("404s an unknown package", async () => {
    expect((await patchPackage("nope", { descriptionMd: "x" })).status).toBe(404);
  });

  it("saves the description and credits block", async () => {
    await seedEvent();
    const pkg = await created();
    const res = await patchPackage(pkg["id"], {
      descriptionMd: "Their story, rewritten.",
      creditsBlockMd: "- Florist: Stems",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body["descriptionMd"]).toBe("Their story, rewritten.");
    expect(body["creditsBlockMd"]).toBe("- Florist: Stems");
  });

  it("leaves a field alone when it is not supplied", async () => {
    await seedEvent("w1", { story: "Original story." });
    const pkg = await created();
    const res = await patchPackage(pkg["id"], { creditsBlockMd: "- Venue: The Barn" });
    expect((await bodyOf(res))["descriptionMd"]).toBe(pkg["descriptionMd"]);
  });

  it("clears a field when explicitly sent null", async () => {
    await seedEvent("w1", { story: "Original story." });
    const pkg = await created();
    const res = await patchPackage(pkg["id"], { descriptionMd: null });
    expect((await bodyOf(res))["descriptionMd"]).toBeNull();
  });

  it("stores selected images in the order given", async () => {
    await seedEvent();
    const pkg = await created();
    const keys = ["events/w1/b.jpg", "events/w1/a.jpg"];
    const res = await patchPackage(pkg["id"], { imageKeys: keys });
    expect((await bodyOf(res))["imageKeys"]).toEqual(keys);
  });

  it("refuses images belonging to another event", async () => {
    await seedEvent();
    await seedEvent("w2");
    const pkg = await created();
    const res = await patchPackage(pkg["id"], { imageKeys: ["events/w2/a.jpg"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details: Array<{ field: string }> };
    expect(body.details[0]?.field).toBe("imageKeys");
  });

  it("refuses the same image twice", async () => {
    await seedEvent();
    const pkg = await created();
    const res = await patchPackage(pkg["id"], {
      imageKeys: ["events/w1/a.jpg", "events/w1/a.jpg"],
    });
    expect(res.status).toBe(400);
  });

  it("refuses a non-list of images", async () => {
    await seedEvent();
    const pkg = await created();
    expect((await patchPackage(pkg["id"], { imageKeys: "a.jpg" })).status).toBe(400);
  });

  it("records an attestation and re-evaluates the checklist", async () => {
    await seedEvent("w1", { nameDisplay: "first names only" });
    const pkg = await created();
    const res = await patchPackage(pkg["id"], { attestations: { consent_limits: true } });
    const body = (await res.json()) as Record<string, any>;
    expect(body["missing"]).not.toContain("consent_limits");
  });

  it("refuses a non-boolean attestation", async () => {
    await seedEvent();
    const pkg = await created();
    expect((await patchPackage(pkg["id"], { attestations: { consent_limits: "yes" } })).status).toBe(
      400,
    );
  });

  it("cannot tick off something the data must answer", async () => {
    await seedEvent();
    const pkg = await created();
    const res = await patchPackage(pkg["id"], {
      attestations: { "req:event_description": true },
      descriptionMd: null,
    });
    expect((await bodyOf(res))["missing"]).toContain("req:event_description");
  });

  it("audit-logs the edit", async () => {
    await seedEvent();
    const pkg = await created();
    await patchPackage(pkg["id"], { descriptionMd: "Edited." });
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'package' AND action = 'update'",
      )
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe("a package becomes complete", () => {
  it("reports complete once every item is satisfied", async () => {
    await seedEvent();
    const pkg = await created();

    const images = Array.from({ length: 30 }, (_, i) => `events/w1/${i}.jpg`);
    const first = await patchPackage(pkg["id"], {
      imageKeys: images,
      descriptionMd: "The story.",
      creditsBlockMd: "- Florist: Stems",
    });

    const attested: Record<string, boolean> = {};
    for (const item of (await bodyOf(first))["checklist"] as Array<{ id: string; kind: string }>) {
      if (item.kind === "attested") attested[item.id] = true;
    }

    const res = await patchPackage(pkg["id"], { attestations: attested });
    const body = (await res.json()) as Record<string, any>;
    expect(body["missing"]).toEqual([]);
    expect(body["complete"]).toBe(true);
  });
});

describe("GET /packages/:id", () => {
  it("returns the package with its evaluated checklist", async () => {
    await seedEvent();
    const pkg = await created();
    const res = await app.request(`/packages/${pkg["id"]}`, { headers: auth }, env);
    expect(res.status).toBe(200);
    expect((await bodyOf(res))["checklist"].length).toBeGreaterThan(0);
  });

  it("requires authentication", async () => {
    await seedEvent();
    const pkg = await created();
    expect((await app.request(`/packages/${pkg["id"]}`, {}, env)).status).toBe(401);
  });
});

describe("GET /events/:id/packages", () => {
  const listFor = (eventId: string, headers = auth) =>
    app.request(`/events/${eventId}/packages`, { headers }, env);

  const listed = async (eventId = "w1") => {
    const res = await listFor(eventId);
    expect(res.status).toBe(200);
    return ((await res.json()) as { packages: Array<Record<string, any>> }).packages;
  };

  it("requires authentication", async () => {
    await seedEvent();
    expect((await listFor("w1", {})).status).toBe(401);
  });

  it("404s an unknown event", async () => {
    expect((await listFor("ghost")).status).toBe(404);
  });

  it("is empty for an event with no packages", async () => {
    await seedEvent();
    expect(await listed()).toEqual([]);
  });

  it("summarises each package with its publication name and image count", async () => {
    await seedEvent();
    const pkg = await created();
    await patchPackage(pkg["id"], { imageKeys: ["events/w1/a.jpg", "events/w1/b.jpg"] });

    expect(await listed()).toEqual([
      {
        id: pkg["id"],
        publicationId: PUB,
        publicationName: "Loverly",
        version: 1,
        complete: false,
        imageCount: 2,
        createdAt: pkg["createdAt"],
      },
    ]);
  });

  it("lists only this event's packages", async () => {
    await seedEvent("w1");
    await seedEvent("w2");
    await created("w1");
    await created("w2");
    await created("w2", "pub-the-lane");

    expect((await listed("w1")).map((row) => row["publicationId"])).toEqual([PUB]);
    expect(await listed("w2")).toHaveLength(2);
  });

  it("reports the same completeness the package view does, couple limits included", async () => {
    // A limit adds an attested item; a list that skipped the consent
    // constraints would call this package complete while the editor would not.
    await seedEvent("w1", { nameDisplay: "First names only" });
    await db
      .prepare(
        "INSERT INTO publications (id, name, tier, method, exclusivity_policy, earned_or_paid, last_verified, spec_json) VALUES ('pub-open', 'Open Outlet', 'secondary', 'email', 'unknown', 'earned', '2026-08-21', '{}')",
      )
      .run();
    const pkg = await created("w1", "pub-open");

    const partial = await bodyOf(await patchPackage(pkg["id"], { imageKeys: ["events/w1/a.jpg"] }));
    expect(partial["complete"]).toBe(false);
    expect((await listed())[0]?.["complete"]).toBe(false);

    const done = await bodyOf(
      await patchPackage(pkg["id"], { attestations: { consent_limits: true } }),
    );
    expect(done["complete"]).toBe(true);
    expect((await listed())[0]?.["complete"]).toBe(true);
  });
});
