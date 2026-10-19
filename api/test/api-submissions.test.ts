import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { hashPassword } from "../src/domain/password.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2 } from "./helpers/r2.js";

const JWT_SECRET = "test-signing-secret";
/** Server time for every test. Only Date is faked; timers stay real. */
const NOW = "2026-10-19T12:00:00Z";

let db: TestD1;
let env: Env;
let auth: Record<string, string>;
const app = createApp();

/** Response bodies are unknown to TypeScript; these assertions index freely. */
const bodyOf = async (res: Response): Promise<Record<string, any>> =>
  (await res.json()) as Record<string, any>;

const send = (method: string, path: string, body?: unknown, headers = auth) =>
  app.request(
    path,
    {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );

async function seedEvent(id = "e1", overrides: { rights?: string; consent?: string } = {}) {
  await db
    .prepare(
      `INSERT INTO events (id, slug, couple_names, event_date, rights_status, consent_status)
       VALUES (?, ?, ?, '2026-06-14', ?, ?)`,
    )
    .bind(
      id,
      id,
      `Couple ${id}`,
      overrides.rights ?? "own_contract",
      overrides.consent ?? "granted",
    )
    .run();
}

/** Outlets with an empty spec: one image makes a package complete. */
async function seedPublication(id: string, name: string, responseDays: number | null) {
  await db
    .prepare(
      `INSERT INTO publications (id, name, tier, method, exclusivity_policy, earned_or_paid,
         last_verified, spec_json, typical_response_days)
       VALUES (?, ?, 'primary', 'email', 'unknown', 'earned', '2026-08-21', '{}', ?)`,
    )
    .bind(id, name, responseDays)
    .run();
}

async function packageFor(eventId = "e1", publicationId = "pub-open", complete = true) {
  const created = await bodyOf(await send("POST", "/packages", { eventId, publicationId }));
  if (!complete) return created["id"] as string;
  const patched = await bodyOf(
    await send("PATCH", `/packages/${created["id"]}`, { imageKeys: [`events/${eventId}/a.jpg`] }),
  );
  expect(patched["complete"]).toBe(true);
  return created["id"] as string;
}

const createSubmission = (packageId: unknown, headers = auth) =>
  send("POST", "/submissions", { packageId }, headers);

const patchSubmission = (id: string, body: unknown, headers = auth) =>
  send("PATCH", `/submissions/${id}`, body, headers);

/** A ready submission for the pairing, built through the routes. */
async function readySubmission(eventId = "e1", publicationId = "pub-open") {
  const res = await createSubmission(await packageFor(eventId, publicationId));
  expect(res.status).toBe(201);
  return bodyOf(res);
}

/** ready -> queued -> sent, each step through the route. */
async function sentSubmission(eventId = "e1", publicationId = "pub-open") {
  const submission = await readySubmission(eventId, publicationId);
  expect((await patchSubmission(submission["id"], { status: "queued" })).status).toBe(200);
  const res = await patchSubmission(submission["id"], { status: "sent" });
  expect(res.status).toBe(200);
  return bodyOf(res);
}

const row = (id: string) =>
  db.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first<Record<string, any>>();

const count = async (table: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));

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

  await seedEvent();
  await seedPublication("pub-open", "Open Outlet", 28);
  await seedPublication("pub-slow", "Slow Outlet", null);
  await seedPublication("pub-third", "Third Outlet", 14);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe("POST /submissions", () => {
  it("requires authentication", async () => {
    const packageId = await packageFor();
    expect((await createSubmission(packageId, {})).status).toBe(401);
  });

  it("requires a package id", async () => {
    const res = await send("POST", "/submissions", {});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "VALIDATION" });
  });

  it("404s an unknown package", async () => {
    const res = await createSubmission("ghost");
    expect(res.status).toBe(404);
  });

  it("refuses an event the rights gate blocks, with the reasons", async () => {
    const packageId = await packageFor();
    // Consent withdrawn after the package was built.
    await db.prepare("UPDATE events SET consent_status = 'declined' WHERE id = 'e1'").run();

    const res = await createSubmission(packageId);
    expect(res.status).toBe(403);
    const body = await bodyOf(res);
    expect(body["code"]).toBe("RIGHTS_BLOCKED");
    expect(body["details"]).toEqual([expect.objectContaining({ code: "CONSENT_DECLINED" })]);
    expect(await count("submissions")).toBe(0);
  });

  it("refuses an incomplete package with what is missing, whatever the client claims", async () => {
    const packageId = await packageFor("e1", "pub-open", false);

    const res = await send("POST", "/submissions", { packageId, complete: true, missing: [] });
    expect(res.status).toBe(422);
    const body = await bodyOf(res);
    expect(body["code"]).toBe("PACKAGE_INCOMPLETE");
    expect(body["details"]).toEqual({ missing: ["images_present"] });
    expect(await count("submissions")).toBe(0);
  });

  it("refuses a publication that is no longer active", async () => {
    const packageId = await packageFor();
    await db.prepare("UPDATE publications SET active = 0 WHERE id = 'pub-open'").run();

    const res = await createSubmission(packageId);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "VALIDATION" });
    expect(await count("submissions")).toBe(0);
  });

  it("creates a ready submission linked to its package, skipping draft", async () => {
    const packageId = await packageFor();

    const res = await createSubmission(packageId);
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    expect(body).toMatchObject({
      eventId: "e1",
      coupleNames: "Couple e1",
      publicationId: "pub-open",
      publicationName: "Open Outlet",
      status: "ready",
      packageId,
      queuedAt: null,
      sentAt: null,
      responseDueAt: null,
      daysRemaining: null,
    });

    expect(await row(body["id"])).toMatchObject({ status: "ready", package_id: packageId });
  });

  it("refuses a second submission for the same pairing and names the existing one", async () => {
    const packageId = await packageFor();
    const first = await bodyOf(await createSubmission(packageId));

    const res = await createSubmission(packageId);
    expect(res.status).toBe(409);
    const body = await bodyOf(res);
    expect(body["code"]).toBe("SUBMISSION_EXISTS");
    expect(body["details"]).toEqual({ submissionId: first["id"] });
    expect(await count("submissions")).toBe(1);
  });

  it("audit-logs the creation", async () => {
    const submission = await readySubmission();
    const audit = await db
      .prepare("SELECT user_id, action FROM audit_log WHERE entity = 'submission' AND entity_id = ?")
      .bind(submission["id"])
      .first<{ user_id: string; action: string }>();
    expect(audit).toEqual({ user_id: "user-1", action: "create" });
  });
});

describe("PATCH /submissions/:id", () => {
  it("requires authentication", async () => {
    const submission = await readySubmission();
    expect((await patchSubmission(submission["id"], { status: "queued" }, {})).status).toBe(401);
  });

  it("404s an unknown submission", async () => {
    expect((await patchSubmission("ghost", { status: "queued" })).status).toBe(404);
  });

  it("refuses a status outside the lifecycle", async () => {
    const submission = await readySubmission();
    const res = await patchSubmission(submission["id"], { status: "teleported" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses an illegal transition with the allowed list, and changes nothing", async () => {
    const submission = await readySubmission();

    const res = await patchSubmission(submission["id"], { status: "sent" });
    expect(res.status).toBe(409);
    const body = await bodyOf(res);
    expect(body["code"]).toBe("ILLEGAL_TRANSITION");
    expect(body["details"]).toEqual({ from: "ready", to: "sent", allowed: ["queued", "cancelled"] });
    expect(await row(submission["id"])).toMatchObject({ status: "ready", sent_at: null });
  });

  it("stamps queued_at when queued", async () => {
    const submission = await readySubmission();
    const res = await patchSubmission(submission["id"], { status: "queued" });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({ status: "queued", queuedAt: NOW });
  });

  it("records a send at server time, by the caller, whatever time the client claims", async () => {
    const submission = await readySubmission();
    await patchSubmission(submission["id"], { status: "queued" });

    const res = await patchSubmission(submission["id"], {
      status: "sent",
      sentAt: "2020-01-01T00:00:00Z",
      sentBy: "someone-else",
    });
    expect(res.status).toBe(200);

    expect(await row(submission["id"])).toMatchObject({
      status: "sent",
      sent_at: NOW,
      sent_by: "user-1",
      response_due_at: "2026-11-16T12:00:00Z",
    });
    expect(await bodyOf(res)).toMatchObject({
      sentAt: NOW,
      responseDueAt: "2026-11-16T12:00:00Z",
      daysRemaining: 28,
    });
  });

  it("leaves the due date unknown when the outlet has no typical response time", async () => {
    const sent = await sentSubmission("e1", "pub-slow");
    expect(sent).toMatchObject({ status: "sent", sentAt: NOW, responseDueAt: null, daysRemaining: null });
  });

  for (const outcome of ["accepted", "declined", "expired"] as const) {
    it(`stamps the outcome and keeps the notes when ${outcome}`, async () => {
      const sent = await sentSubmission();
      const res = await patchSubmission(sent["id"], { status: outcome, outcomeNotes: "Editor replied." });
      expect(res.status).toBe(200);
      expect(await row(sent["id"])).toMatchObject({
        status: outcome,
        outcome_at: NOW,
        outcome_notes: "Editor replied.",
      });
    });
  }

  it("records an outcome without notes", async () => {
    const sent = await sentSubmission();
    const res = await patchSubmission(sent["id"], { status: "declined" });
    expect(res.status).toBe(200);
    expect(await row(sent["id"])).toMatchObject({ outcome_at: NOW, outcome_notes: null });
  });

  it("refuses notes on a step that is not an outcome", async () => {
    const submission = await readySubmission();
    const res = await patchSubmission(submission["id"], { status: "queued", outcomeNotes: "Hm." });
    expect(res.status).toBe(400);
    expect(await row(submission["id"])).toMatchObject({ status: "ready" });
  });

  it("refuses notes that are not text", async () => {
    const sent = await sentSubmission();
    expect((await patchSubmission(sent["id"], { status: "declined", outcomeNotes: 7 })).status).toBe(400);
  });

  it("requires the published url to mark a feature published", async () => {
    const sent = await sentSubmission();
    await patchSubmission(sent["id"], { status: "accepted" });

    const res = await patchSubmission(sent["id"], { status: "published" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "VALIDATION" });
    expect(await row(sent["id"])).toMatchObject({ status: "accepted", published_url: null });
  });

  it("refuses a published url that is not a web address", async () => {
    const sent = await sentSubmission();
    await patchSubmission(sent["id"], { status: "accepted" });

    const res = await patchSubmission(sent["id"], {
      status: "published",
      publishedUrl: "javascript:alert(1)",
    });
    expect(res.status).toBe(400);
  });

  it("stores the published url", async () => {
    const sent = await sentSubmission();
    await patchSubmission(sent["id"], { status: "accepted" });

    const res = await patchSubmission(sent["id"], {
      status: "published",
      publishedUrl: "https://outlet.example/features/couple",
    });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({
      status: "published",
      publishedUrl: "https://outlet.example/features/couple",
    });
  });

  it("refuses a published url on any other step", async () => {
    const sent = await sentSubmission();
    const res = await patchSubmission(sent["id"], {
      status: "accepted",
      publishedUrl: "https://outlet.example/features/couple",
    });
    expect(res.status).toBe(400);
  });

  it("keeps the first outcome time through the withdrawal path", async () => {
    const sent = await sentSubmission();
    await db
      .prepare("UPDATE submissions SET status = 'expired', outcome_at = '2026-10-01T00:00:00Z' WHERE id = ?")
      .bind(sent["id"])
      .run();

    await patchSubmission(sent["id"], { status: "withdraw_pending" });
    expect(await row(sent["id"])).toMatchObject({ status: "withdraw_pending", outcome_at: "2026-10-01T00:00:00Z" });

    await patchSubmission(sent["id"], { status: "withdrawn" });
    expect(await row(sent["id"])).toMatchObject({ status: "withdrawn", outcome_at: "2026-10-01T00:00:00Z" });
  });

  it("stamps the outcome time on a cancel", async () => {
    const submission = await readySubmission();
    const res = await patchSubmission(submission["id"], { status: "cancelled" });
    expect(res.status).toBe(200);
    expect(await row(submission["id"])).toMatchObject({ status: "cancelled", outcome_at: NOW });
  });

  it("stamps updated_at on every change", async () => {
    const submission = await readySubmission();
    await db
      .prepare("UPDATE submissions SET updated_at = '2026-01-01T00:00:00Z' WHERE id = ?")
      .bind(submission["id"])
      .run();
    await patchSubmission(submission["id"], { status: "queued" });
    expect(await row(submission["id"])).toMatchObject({ updated_at: NOW });
  });

  it("audit-logs each transition with where it came from", async () => {
    const sent = await sentSubmission();
    const { results } = await db
      .prepare(
        "SELECT user_id, action, detail_json FROM audit_log WHERE entity = 'submission' AND entity_id = ? ORDER BY rowid",
      )
      .bind(sent["id"])
      .all<{ user_id: string; action: string; detail_json: string }>();

    expect(results.map((entry) => entry.action)).toEqual(["create", "transition", "transition"]);
    expect(results.every((entry) => entry.user_id === "user-1")).toBe(true);
    expect(JSON.parse(results[1]?.detail_json ?? "{}")).toEqual({ from: "ready", to: "queued" });
    expect(JSON.parse(results[2]?.detail_json ?? "{}")).toEqual({ from: "queued", to: "sent" });
  });

  it("writes no audit row for a refused transition", async () => {
    const submission = await readySubmission();
    await patchSubmission(submission["id"], { status: "sent" });
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'submission' AND action = 'transition'")
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("one publication at a time per event", () => {
  it("refuses to record a second send while another outlet holds the event", async () => {
    const live = await sentSubmission("e1", "pub-open");
    const other = await readySubmission("e1", "pub-third");
    await patchSubmission(other["id"], { status: "queued" });

    const res = await patchSubmission(other["id"], { status: "sent" });
    expect(res.status).toBe(409);
    const body = await bodyOf(res);
    expect(body["code"]).toBe("EVENT_HAS_LIVE_SUBMISSION");
    expect(body["details"]).toEqual({ submissionId: live["id"] });
    expect(await row(other["id"])).toMatchObject({ status: "queued", sent_at: null });
  });

  it("allows the next send once the live one has an answer", async () => {
    const live = await sentSubmission("e1", "pub-open");
    const other = await readySubmission("e1", "pub-third");
    await patchSubmission(other["id"], { status: "queued" });
    await patchSubmission(live["id"], { status: "declined" });

    expect((await patchSubmission(other["id"], { status: "sent" })).status).toBe(200);
  });

  it("is per event: another event's live submission does not block", async () => {
    await seedEvent("e2");
    await sentSubmission("e2", "pub-open");
    await sentSubmission("e1", "pub-open");
  });
});

describe("forward moves re-run the creation gates", () => {
  it("refuses to queue once the rights gate has closed", async () => {
    const submission = await readySubmission();
    await db.prepare("UPDATE events SET consent_status = 'declined' WHERE id = 'e1'").run();

    const res = await patchSubmission(submission["id"], { status: "queued" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: "RIGHTS_BLOCKED" });
    expect(await row(submission["id"])).toMatchObject({ status: "ready" });
  });

  it("refuses to record a send once the rights gate has closed", async () => {
    const submission = await readySubmission();
    await patchSubmission(submission["id"], { status: "queued" });
    await db.prepare("UPDATE events SET rights_status = 'blocked' WHERE id = 'e1'").run();

    expect((await patchSubmission(submission["id"], { status: "sent" })).status).toBe(403);
  });

  it("refuses to send a package edited back to incomplete", async () => {
    const submission = await readySubmission();
    await patchSubmission(submission["id"], { status: "queued" });
    await send("PATCH", `/packages/${submission["packageId"]}`, { imageKeys: [] });

    const res = await patchSubmission(submission["id"], { status: "sent" });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      code: "PACKAGE_INCOMPLETE",
      details: { missing: ["images_present"] },
    });
  });

  it("refuses to send to an outlet deactivated since", async () => {
    const submission = await readySubmission();
    await patchSubmission(submission["id"], { status: "queued" });
    await db.prepare("UPDATE publications SET active = 0 WHERE id = 'pub-open'").run();

    expect((await patchSubmission(submission["id"], { status: "sent" })).status).toBe(400);
  });

  it("refuses to send a submission whose package is gone", async () => {
    const submission = await readySubmission();
    await patchSubmission(submission["id"], { status: "queued" });
    await db.prepare("UPDATE submissions SET package_id = NULL WHERE id = ?").bind(submission["id"]).run();

    const res = await patchSubmission(submission["id"], { status: "sent" });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ details: { missing: ["package"] } });
  });

  it("still lets a blocked submission be cancelled", async () => {
    const submission = await readySubmission();
    await db.prepare("UPDATE events SET consent_status = 'declined' WHERE id = 'e1'").run();
    expect((await patchSubmission(submission["id"], { status: "cancelled" })).status).toBe(200);
  });

  it("still records an outcome after the gate closes", async () => {
    const sent = await sentSubmission();
    await db.prepare("UPDATE events SET consent_status = 'declined' WHERE id = 'e1'").run();
    expect((await patchSubmission(sent["id"], { status: "declined" })).status).toBe(200);
  });
});

describe("GET /submissions", () => {
  const list = async (query = "") => {
    const res = await send("GET", `/submissions${query}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { submissions: Array<Record<string, any>> }).submissions;
  };

  /** Arranged directly so timestamps and states are exact. */
  async function insert(
    id: string,
    eventId: string,
    publicationId: string,
    fields: {
      status: string;
      createdAt?: string;
      updatedAt?: string;
      responseDueAt?: string | null;
    },
  ) {
    await db
      .prepare(
        `INSERT INTO submissions (id, event_id, publication_id, status, response_due_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        eventId,
        publicationId,
        fields.status,
        fields.responseDueAt ?? null,
        fields.createdAt ?? "2026-10-01T00:00:00Z",
        fields.updatedAt ?? "2026-10-01T00:00:00Z",
      )
      .run();
  }

  it("requires authentication", async () => {
    expect((await send("GET", "/submissions", undefined, {})).status).toBe(401);
  });

  it("is empty when nothing has been submitted", async () => {
    expect(await list()).toEqual([]);
  });

  it("names the couple and the outlet on every row", async () => {
    const submission = await readySubmission();
    expect(await list()).toEqual([
      {
        id: submission["id"],
        eventId: "e1",
        coupleNames: "Couple e1",
        publicationId: "pub-open",
        publicationName: "Open Outlet",
        status: "ready",
        packageId: submission["packageId"],
        queuedAt: null,
        sentAt: null,
        responseDueAt: null,
        outcomeAt: null,
        outcomeNotes: null,
        publishedUrl: null,
        daysRemaining: null,
      },
    ]);
  });

  it("counts whole days to the due date, negative once it has passed", async () => {
    await seedEvent("e2");
    await seedEvent("e3");
    await insert("s-future", "e1", "pub-open", { status: "sent", responseDueAt: "2026-10-29T12:00:00Z" });
    await insert("s-today", "e2", "pub-open", { status: "sent", responseDueAt: "2026-10-19T18:00:00Z" });
    await insert("s-past", "e3", "pub-open", { status: "sent", responseDueAt: "2026-10-16T12:00:00Z" });
    await insert("s-none", "e1", "pub-slow", { status: "accepted" });

    const days = Object.fromEntries((await list()).map((s) => [s["id"], s["daysRemaining"]]));
    expect(days).toEqual({ "s-future": 10, "s-today": 0, "s-past": -3, "s-none": null });
  });

  it("orders live first by due date, then the send queue oldest first, then the rest newest first", async () => {
    for (const id of ["e2", "e3", "e4", "e5"]) await seedEvent(id);

    await insert("finished-old", "e1", "pub-open", { status: "declined", updatedAt: "2026-10-02T00:00:00Z" });
    await insert("queue-new", "e2", "pub-open", { status: "ready", createdAt: "2026-10-10T00:00:00Z" });
    await insert("live-unknown", "e3", "pub-open", { status: "sent", responseDueAt: null });
    await insert("live-late", "e4", "pub-open", { status: "sent", responseDueAt: "2026-11-20T00:00:00Z" });
    await insert("finished-new", "e1", "pub-slow", { status: "published", updatedAt: "2026-10-12T00:00:00Z" });
    await insert("queue-old", "e2", "pub-slow", { status: "queued", createdAt: "2026-10-03T00:00:00Z" });
    await insert("live-soon", "e5", "pub-open", { status: "sent", responseDueAt: "2026-10-25T00:00:00Z" });
    await insert("finished-mid", "e3", "pub-slow", { status: "cancelled", updatedAt: "2026-10-08T00:00:00Z" });

    expect((await list()).map((s) => s["id"])).toEqual([
      "live-soon",
      "live-late",
      "live-unknown",
      "queue-old",
      "queue-new",
      "finished-new",
      "finished-mid",
      "finished-old",
    ]);
  });

  it("filters to one event", async () => {
    await seedEvent("e2");
    await readySubmission("e1", "pub-open");
    await readySubmission("e2", "pub-open");

    const rows = await list("?eventId=e2");
    expect(rows.map((s) => s["eventId"])).toEqual(["e2"]);
  });

  it("returns one submission by id", async () => {
    const submission = await readySubmission();
    const res = await send("GET", `/submissions/${submission["id"]}`);
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual(submission);
  });

  it("404s an unknown submission", async () => {
    expect((await send("GET", "/submissions/ghost")).status).toBe(404);
  });

  it("requires authentication for one submission", async () => {
    const submission = await readySubmission();
    expect((await send("GET", `/submissions/${submission["id"]}`, undefined, {})).status).toBe(401);
  });
});

describe("the package carries its submission", () => {
  it("is null before a submission exists", async () => {
    const packageId = await packageFor();
    const view = await bodyOf(await send("GET", `/packages/${packageId}`));
    expect(view["submission"]).toBeNull();
  });

  it("summarises the submission on the package view and its edit response", async () => {
    const sent = await sentSubmission();
    const summary = {
      id: sent["id"],
      status: "sent",
      sentAt: NOW,
      responseDueAt: "2026-11-16T12:00:00Z",
    };

    const view = await bodyOf(await send("GET", `/packages/${sent["packageId"]}`));
    expect(view["submission"]).toEqual(summary);

    const edited = await bodyOf(
      await send("PATCH", `/packages/${sent["packageId"]}`, { descriptionMd: "Edited." }),
    );
    expect(edited["submission"]).toEqual(summary);
  });

  it("summarises the submission on the event's package list", async () => {
    const submission = await readySubmission();
    await packageFor("e1", "pub-third", false);

    const res = await send("GET", "/events/e1/packages");
    const packages = ((await res.json()) as { packages: Array<Record<string, any>> }).packages;
    const byOutlet = Object.fromEntries(packages.map((p) => [p["publicationId"], p["submission"]]));
    expect(byOutlet).toEqual({
      "pub-open": { id: submission["id"], status: "ready", sentAt: null, responseDueAt: null },
      "pub-third": null,
    });
  });
});
