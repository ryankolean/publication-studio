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
const GALLERY = "https://gallery.example.com/event?it=SECRET-INVITE-TOKEN";

let db: TestD1;
let env: Env;
let auth: Record<string, string>;
const app = createApp();

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

/** An event whose record is complete and whose rights gate is open. */
const COMPLETE = {
  coupleNames: "Sarah and James",
  eventDate: "2026-06-14",
  venueName: "The Barn",
  city: "Detroit",
  galleryUrl: GALLERY,
  coupleStory: "They met at a bookshop.",
  rightsStatus: "own_contract",
  consentStatus: "granted",
  vendorCredits: [{ role: "Florist", businessName: "Stems" }],
};

async function createEvent(body: Record<string, unknown> = COMPLETE): Promise<string> {
  const res = await send("POST", "/events", body);
  expect(res.status).toBe(201);
  return (await bodyOf(res))["id"] as string;
}

async function seedPublication(id: string, name: string, responseDays: number | null) {
  await db
    .prepare(
      `INSERT INTO publications (id, name, tier, method, submission_url, exclusivity_policy, earned_or_paid,
         last_verified, spec_json, typical_response_days)
       VALUES (?, ?, 'primary', 'web_form', 'https://outlet.example.com/submit', 'unknown', 'earned',
         '2026-08-21', '{}', ?)`,
    )
    .bind(id, name, responseDays)
    .run();
}

const addPoolImages = async (eventId: string, count: number) => {
  for (let n = 0; n < count; n++) {
    await db
      .prepare("INSERT INTO event_images (key, event_id, content_type, bytes) VALUES (?, ?, 'image/jpeg', 10)")
      .bind(`events/${eventId}/img-${n}.jpg`, eventId)
      .run();
  }
};

async function startPackage(eventId: string, publicationId: string): Promise<string> {
  const res = await send("POST", "/packages", { eventId, publicationId });
  expect(res.status).toBe(201);
  return (await bodyOf(res))["id"] as string;
}

/** A package with one image, which completes it at an outlet with an empty spec. */
async function completePackage(eventId: string, publicationId: string): Promise<string> {
  const id = await startPackage(eventId, publicationId);
  const res = await send("PATCH", `/packages/${id}`, { imageKeys: [`events/${eventId}/img-0.jpg`] });
  expect((await bodyOf(res))["complete"]).toBe(true);
  return id;
}

async function submissionAt(packageId: string, ...statuses: string[]): Promise<string> {
  const created = await send("POST", "/submissions", { packageId });
  expect(created.status).toBe(201);
  const id = (await bodyOf(created))["id"] as string;
  for (const status of statuses) {
    const body = status === "published" ? { status, publishedUrl: "https://outlet.example.com/feature" } : { status };
    expect((await send("PATCH", `/submissions/${id}`, body)).status).toBe(200);
  }
  return id;
}

const walkthrough = (eventId: string, packageId?: string, headers = auth) =>
  send(
    "GET",
    `/events/${eventId}/walkthrough${packageId === undefined ? "" : `?package=${packageId}`}`,
    undefined,
    headers,
  );

async function walk(eventId: string, packageId?: string) {
  const res = await walkthrough(eventId, packageId);
  expect(res.status).toBe(200);
  return bodyOf(res);
}

const step = (body: Record<string, any>, id: string) =>
  (body["steps"] as Array<Record<string, any>>).find((entry) => entry["id"] === id) as Record<string, any>;

const statuses = (body: Record<string, any>) =>
  Object.fromEntries((body["steps"] as Array<Record<string, any>>).map((s) => [s["id"], s["status"]]));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));

  db = createTestD1();
  env = { DB: db, IMAGES: createTestR2(), JWT_SECRET, ALLOWED_ORIGIN: "https://studio.example.com" };
  await db
    .prepare("INSERT INTO users (id, email, name, role, pw_hash) VALUES (?, ?, ?, ?, ?)")
    .bind("user-1", "user-1-login", "P", "photographer", await hashPassword("pw", { iterations: 1000 }))
    .run();
  auth = {
    authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" })}`,
  };

  await seedPublication("pub-open", "Open Outlet", 28);
  await seedPublication("pub-third", "Third Outlet", 14);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe("GET /events/:id/walkthrough", () => {
  it("rejects an anonymous request", async () => {
    const id = await createEvent();
    expect((await walkthrough(id, undefined, {})).status).toBe(401);
  });

  it("returns a typed 404 for an unknown event", async () => {
    const res = await walkthrough("nope");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
  });

  it("walks an event with no outlet chosen up to the outlet step", async () => {
    const id = await createEvent();
    await addPoolImages(id, 3);
    const body = await walk(id);

    expect(body["event"]).toEqual({ id, coupleNames: "Sarah and James", locationCode: null });
    expect(body["packages"]).toEqual([]);
    expect(body["package"]).toBeNull();
    expect(statuses(body)).toEqual({
      intake: "done",
      rights: "done",
      outlet: "current",
      images: "done",
      package: "todo",
      submission: "todo",
      send: "todo",
      response: "todo",
    });
  });

  it("reads intake, rights and the pool from the stored event", async () => {
    const id = await createEvent({ coupleNames: "Ada and Bo", eventDate: "2026-07-01" });
    const body = await walk(id);
    expect(statuses(body)).toMatchObject({ intake: "current", rights: "blocked", images: "todo" });
    expect(step(body, "intake")["detail"]).toEqual([
      "Venue or city",
      "Gallery link on file",
      "At least one vendor credit",
      "A story or unique angle",
    ]);
    expect(step(body, "rights")["detail"].join(" ")).toMatch(/contracted lead/);
  });

  it("lists every active outlet with its warnings, and leaves inactive ones out", async () => {
    await db.prepare("UPDATE publications SET active = 0 WHERE id = 'pub-vogue-weddings'").run();
    const id = await createEvent();
    const body = await walk(id);
    const outlets = body["outlets"] as Array<Record<string, any>>;
    const ids = outlets.map((outlet) => outlet["id"]);

    expect(ids).toContain("pub-open");
    expect(ids).toContain("pub-brides");
    expect(ids).not.toContain("pub-vogue-weddings");

    const brides = outlets.find((outlet) => outlet["id"] === "pub-brides");
    expect(brides?.["warnings"].map((w: any) => w.code)).toEqual(["exclusive", "unpublished_only", "may_be_paid"]);
    expect(brides).toMatchObject({ name: "Brides", tier: expect.any(String), imgMin: 100, imgMax: 200 });

    expect(step(body, "outlet")["detail"]).toHaveLength(outlets.length);
  });

  it("flags the prior-exposure conflict for an outlet that counts the blog", async () => {
    const id = await createEvent(COMPLETE);
    expect((await send("PUT", `/events/${id}/exposures`, { exposures: [{ channel: "own_blog" }] })).status).toBe(200);
    const body = await walk(id);
    const brides = (body["outlets"] as Array<Record<string, any>>).find((o) => o["id"] === "pub-brides");
    expect(brides?.["warnings"].map((w: any) => w.code)).toContain("prior_exposure_conflict");
  });

  it("loads the chosen package with its checklist, copy and outlet", async () => {
    const id = await createEvent();
    await addPoolImages(id, 3);
    const packageId = await startPackage(id, "pub-open");
    const body = await walk(id, packageId);

    expect(body["package"]).toMatchObject({
      id: packageId,
      publicationId: "pub-open",
      publicationName: "Open Outlet",
      submissionUrl: "https://outlet.example.com/submit",
      imageCount: 0,
      complete: false,
      submission: null,
    });
    expect(body["package"]["descriptionMd"]).toMatch(/Sarah and James/);
    expect(body["package"]["creditsBlockMd"]).toMatch(/Stems/);
    expect(statuses(body)).toMatchObject({ outlet: "done", images: "done", package: "current" });
    expect(step(body, "package")["detail"]).toEqual(["At least one image selected"]);
    expect(step(body, "package")["action"]).toEqual({ label: "Open the package", href: `/packages/${packageId}` });
    expect(body["packages"].map((p: any) => p.id)).toEqual([packageId]);
  });

  it("matches the event's own package list", async () => {
    const id = await createEvent();
    await startPackage(id, "pub-open");
    const body = await walk(id);
    const list = await bodyOf(await send("GET", `/events/${id}/packages`));
    expect(body["packages"]).toEqual(list["packages"]);
  });

  it("refuses a package that belongs to another event", async () => {
    const id = await createEvent();
    const other = await createEvent({ ...COMPLETE, coupleNames: "Ada and Bo" });
    const foreign = await startPackage(other, "pub-open");
    const res = await walkthrough(id, foreign);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: "NOT_FOUND", message: "That submission could not be found." });
  });

  it("refuses an unknown package", async () => {
    const id = await createEvent();
    const res = await walkthrough(id, "nope");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: "NOT_FOUND", message: "That submission could not be found." });
  });

  it("follows a sent submission to the reply, with the due date", async () => {
    const id = await createEvent();
    await addPoolImages(id, 1);
    const packageId = await completePackage(id, "pub-open");
    const submissionId = await submissionAt(packageId, "queued", "sent");
    const body = await walk(id, packageId);

    expect(body["package"]["submission"]).toEqual({
      id: submissionId,
      status: "sent",
      responseDueAt: "2026-11-16T12:00:00Z",
      daysRemaining: 28,
      publishedUrl: null,
    });
    expect(statuses(body)).toMatchObject({ submission: "done", send: "done", response: "current" });
    expect(step(body, "response")["detail"][0]).toBe("Due 2026-11-16: 28 days remaining.");
  });

  it("asks for the live link once accepted, and is finished once published", async () => {
    const id = await createEvent();
    await addPoolImages(id, 1);
    const packageId = await completePackage(id, "pub-open");
    const submissionId = await submissionAt(packageId, "queued", "sent", "accepted");

    const accepted = await walk(id, packageId);
    expect(step(accepted, "published")["status"]).toBe("current");

    expect(
      (
        await send("PATCH", `/submissions/${submissionId}`, {
          status: "published",
          publishedUrl: "https://outlet.example.com/feature",
        })
      ).status,
    ).toBe(200);

    const published = await walk(id, packageId);
    expect(published["package"]["submission"]["publishedUrl"]).toBe("https://outlet.example.com/feature");
    expect((published["steps"] as Array<Record<string, any>>).every((s) => s["status"] === "done")).toBe(true);
  });

  it("holds the send while the event is live at another outlet", async () => {
    const id = await createEvent();
    await addPoolImages(id, 1);
    await submissionAt(await completePackage(id, "pub-open"), "queued", "sent");
    const second = await completePackage(id, "pub-third");
    await submissionAt(second);

    const body = await walk(id, second);
    expect(step(body, "send")["status"]).toBe("current");
    expect(step(body, "send")["summary"]).toBe("Waiting on Open Outlet first.");
  });

  it("never returns the gallery link", async () => {
    const id = await createEvent();
    const packageId = await startPackage(id, "pub-open");
    const res = await walkthrough(id, packageId);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("SECRET-INVITE-TOKEN");
  });

  it("carries each outlet's taste notes for the wizard's outlet cards", async () => {
    await db.prepare("UPDATE publications SET taste_notes = 'Loves winter light.' WHERE id = 'pub-open'").run();
    const id = await createEvent();
    const body = await walk(id);
    const open = (body["outlets"] as Array<Record<string, any>>).find((outlet) => outlet["id"] === "pub-open");
    expect(open?.["tasteNotes"]).toBe("Loves winter light.");
  });
});

describe("GET /events/:id/walkthrough: the wizard", () => {
  /** An outlet that wants two or three images and no watermarks: one attested check. */
  const seedCountedOutlet = () =>
    db
      .prepare(
        `INSERT INTO publications (id, name, tier, method, submission_url, exclusivity_policy, earned_or_paid,
           last_verified, spec_json, typical_response_days, response_window_note)
         VALUES ('pub-count', 'Counted Outlet', 'primary', 'web_form', 'https://counted.example.com/submit',
           'unknown', 'earned', '2026-08-21', '{"img_min":2,"img_max":3,"watermarks_allowed":false}', 14,
           'We reply only to successful submissions.')`,
      )
      .run();

  const wizardOf = async (eventId: string, packageId?: string) =>
    (await walk(eventId, packageId))["wizard"] as Record<string, any>;

  const edit = async (eventId: string, body: Record<string, unknown>) => {
    const res = await send("PATCH", `/events/${eventId}`, body);
    expect(res.status).toBe(200);
  };

  const patchPackage = async (packageId: string, body: Record<string, unknown>) => {
    const res = await send("PATCH", `/packages/${packageId}`, body);
    expect(res.status).toBe(200);
    return bodyOf(res);
  };

  it("resumes one wedding at every screen in turn, from its details to the reply", async () => {
    await seedCountedOutlet();
    const base = { coupleNames: "Ada and Bo", eventDate: "2026-07-01" };

    const id = await createEvent(base);
    expect((await wizardOf(id))["step"]).toBe("wedding");

    await edit(id, { ...base, venueName: "The Barn" });
    expect((await wizardOf(id))["step"]).toBe("permissions");

    const permitted = {
      ...base,
      venueName: "The Barn",
      galleryUrl: GALLERY,
      rightsStatus: "own_contract",
      consentStatus: "granted",
    };
    await edit(id, permitted);
    expect((await wizardOf(id))["step"]).toBe("story");

    await edit(id, {
      ...permitted,
      uniqueAngle: "A ceremony on a frozen lake.",
      vendorCredits: [{ role: "Florist", businessName: "Stems" }],
    });
    expect((await wizardOf(id))["step"]).toBe("look");

    expect((await send("PUT", `/style/events/${id}/tags/romantic`, { state: "confirmed" })).status).toBe(200);
    const choosing = await wizardOf(id);
    expect(choosing).toMatchObject({ step: "outlet", packageId: null, blocked: null, outlet: null, finished: false });

    await addPoolImages(id, 3);
    const packageId = await startPackage(id, "pub-count");
    const photos = await wizardOf(id);
    expect(photos).toMatchObject({ step: "photos", packageId });
    expect(photos["outlet"]).toMatchObject({ id: "pub-count", name: "Counted Outlet", method: "web_form" });

    await patchPackage(packageId, { imageKeys: [`events/${id}/img-0.jpg`] });
    expect((await wizardOf(id))["step"]).toBe("photos");

    await patchPackage(packageId, {
      imageKeys: [`events/${id}/img-0.jpg`, `events/${id}/img-1.jpg`],
      descriptionMd: "",
    });
    expect((await wizardOf(id))["step"]).toBe("writeup");

    await patchPackage(packageId, { descriptionMd: "Ada and Bo married on the ice." });
    expect((await wizardOf(id))["step"]).toBe("confirm");

    await patchPackage(packageId, { attestations: { no_watermarks: true } });
    expect((await wizardOf(id))["step"]).toBe("review");

    const submissionId = await submissionAt(packageId);
    expect((await wizardOf(id))["step"]).toBe("send");

    await send("PATCH", `/submissions/${submissionId}`, { status: "queued" });
    expect((await wizardOf(id))["step"]).toBe("send");

    await send("PATCH", `/submissions/${submissionId}`, { status: "sent" });
    const tracking = await wizardOf(id);
    expect(tracking).toMatchObject({ step: "track", finished: false });
    expect(tracking["reply"]).toEqual({
      dueAt: "2026-11-02T12:00:00Z",
      daysRemaining: 14,
      outletWords: "We reply only to successful submissions.",
      silenceMeansPass: true,
    });

    await send("PATCH", `/submissions/${submissionId}`, { status: "accepted" });
    const finished = await wizardOf(id);
    expect(finished).toMatchObject({ step: "track", finished: true });
    expect((finished["steps"] as Array<Record<string, any>>).every((entry) => entry["done"])).toBe(true);
  });

  it("stops a blocked wedding at the outlet, with the reasons in plain words", async () => {
    const id = await createEvent({ ...COMPLETE, rightsStatus: "second_shooter" });
    const wizard = await wizardOf(id);
    expect(wizard["step"]).toBe("look");
    expect(wizard["blocked"]).toEqual({
      step: "outlet",
      reasons: ["Second-shooter weddings cannot be submitted under your name."],
    });
  });

  it("follows the open package when none is named", async () => {
    const id = await createEvent();
    await addPoolImages(id, 1);
    const sentPackage = await completePackage(id, "pub-open");
    await submissionAt(sentPackage, "queued", "sent");
    await startPackage(id, "pub-third");

    const wizard = await wizardOf(id);
    expect(wizard).toMatchObject({ packageId: sentPackage, step: "track" });
  });

  it("follows the package named in the address over the one it would pick", async () => {
    const id = await createEvent();
    await addPoolImages(id, 1);
    await submissionAt(await completePackage(id, "pub-open"), "queued", "sent");
    const named = await completePackage(id, "pub-third");
    await submissionAt(named);

    const wizard = await wizardOf(id, named);
    expect(wizard["packageId"]).toBe(named);
    expect(wizard["step"]).toBe("send");
    expect(wizard["blocked"]).toEqual({
      step: "send",
      reasons: ["This wedding is waiting on Open Outlet. Record Open Outlet's answer before sending it here."],
    });
  });

  it("leaves the step list's own package alone when none is named", async () => {
    const id = await createEvent();
    await startPackage(id, "pub-open");
    const body = await walk(id);
    expect(body["package"]).toBeNull();
    expect(step(body, "outlet")["status"]).toBe("current");
    expect(body["wizard"]["step"]).toBe("photos");
  });

  it("starts over at the outlet once every package's answer is in", async () => {
    const id = await createEvent();
    await addPoolImages(id, 1);
    await submissionAt(await completePackage(id, "pub-open"), "queued", "sent", "declined");
    expect(await wizardOf(id)).toMatchObject({ step: "outlet", packageId: null });
  });
});
