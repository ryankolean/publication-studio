import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../errors.js";
import { evaluateRightsGate } from "../domain/rights-gate.js";
import type { ConsentStatus, RightsGateResult, RightsStatus } from "../domain/rights-gate.js";
import { validateEventIntake } from "../domain/event-intake.js";
import type { PriorExposure, VendorCreditInput, EventIntake } from "../domain/event-intake.js";
import { eventSlug } from "../domain/slug.js";
import { buildWalkthrough, outletFit } from "../domain/walkthrough.js";
import type { WalkthroughPackage } from "../domain/walkthrough.js";
import type { D1Database } from "../env.js";
import { listEventPackages, loadPackageView } from "./packages.js";
import { listPublications, loadPublication } from "./publications.js";
import { loadView as loadSubmissionView } from "./submissions.js";

interface EventRow {
  id: string;
  slug: string;
  couple_names: string;
  event_date: string;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  gallery_url: string | null;
  style_tags: string;
  unique_angle: string | null;
  rights_status: RightsStatus;
  consent_status: ConsentStatus;
  consent_notes: string | null;
  name_display: string | null;
  couple_story: string | null;
  is_destination: number;
  hero_picks: string | null;
  video_url: string | null;
  target_outlet_notes: string | null;
  prior_exposure: string;
  created_at: string;
  updated_at: string;
}

interface EventView {
  id: string;
  slug: string;
  coupleNames: string;
  eventDate: string;
  venueName: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  styleTags: string[];
  uniqueAngle: string | null;
  rightsStatus: RightsStatus;
  consentStatus: ConsentStatus;
  consentNotes: string | null;
  nameDisplay: string | null;
  coupleStory: string | null;
  isDestination: boolean;
  heroPicks: string | null;
  videoUrl: string | null;
  targetOutletNotes: string | null;
  priorExposure: PriorExposure;
  /**
   * The gallery URL itself is never serialised. It carries a Pic-Time invite
   * token, which the design doc treats as a credential: server-side only,
   * never in a client bundle, a log, or an error message. The dashboard only
   * needs to know whether one is on file.
   */
  hasGalleryUrl: boolean;
  gate: RightsGateResult;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_EXPOSURE: PriorExposure = { ownBlog: false, igPosted: false, priorPubs: [] };

function readJson<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function toView(row: EventRow): EventView {
  return {
    id: row.id,
    slug: row.slug,
    coupleNames: row.couple_names,
    eventDate: row.event_date,
    venueName: row.venue_name,
    city: row.city,
    state: row.state,
    country: row.country,
    styleTags: readJson<string[]>(row.style_tags, []),
    uniqueAngle: row.unique_angle,
    rightsStatus: row.rights_status,
    consentStatus: row.consent_status,
    consentNotes: row.consent_notes,
    nameDisplay: row.name_display,
    coupleStory: row.couple_story,
    isDestination: row.is_destination === 1,
    heroPicks: row.hero_picks,
    videoUrl: row.video_url,
    targetOutletNotes: row.target_outlet_notes,
    priorExposure: readJson<PriorExposure>(row.prior_exposure, EMPTY_EXPOSURE),
    hasGalleryUrl: row.gallery_url !== null && row.gallery_url.length > 0,
    gate: evaluateRightsGate({
      rightsStatus: row.rights_status,
      consentStatus: row.consent_status,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** slug is UNIQUE, so a second event for the same couple and year gets a suffix. */
async function uniqueSlug(db: D1Database, base: string): Promise<string> {
  const { results } = await db
    .prepare("SELECT slug FROM events WHERE slug = ? OR slug LIKE ?")
    .bind(base, `${base}-%`)
    .all<{ slug: string }>();

  const taken = new Set(results.map((row) => row.slug));
  if (!taken.has(base)) return base;

  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function vendorStatements(db: D1Database, eventId: string, credits: VendorCreditInput[]) {
  return credits.map((credit, index) =>
    db
      .prepare(
        `INSERT INTO vendor_credits (id, event_id, role, business_name, website, instagram, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        eventId,
        credit.role,
        credit.businessName,
        credit.website,
        credit.instagram,
        index,
      ),
  );
}

function eventStatement(db: D1Database, id: string, slug: string, intake: EventIntake) {
  return db
    .prepare(
      `INSERT INTO events (
         id, slug, couple_names, event_date, venue_name, city, state, country,
         gallery_url, style_tags, unique_angle, rights_status, consent_status,
         consent_notes, name_display, couple_story, is_destination, hero_picks,
         video_url, target_outlet_notes, prior_exposure
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      slug,
      intake.coupleNames,
      intake.eventDate,
      intake.venueName,
      intake.city,
      intake.state,
      intake.country,
      intake.galleryUrl,
      JSON.stringify(intake.styleTags),
      intake.uniqueAngle,
      intake.rightsStatus,
      intake.consentStatus,
      intake.consentNotes,
      intake.nameDisplay,
      intake.coupleStory,
      intake.isDestination ? 1 : 0,
      intake.heroPicks,
      intake.videoUrl,
      intake.targetOutletNotes,
      JSON.stringify(intake.priorExposure),
    );
}

export const eventRoutes = new Hono<AppContext>();

eventRoutes.use("*", requireAuth);

eventRoutes.post("/", async (c) => {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return fail(c, 400, "VALIDATION", "Expected a JSON body.");
  }

  const parsed = validateEventIntake(payload);
  if (!parsed.ok) {
    return fail(c, 400, "VALIDATION", "Some fields need attention.", parsed.errors);
  }

  const intake = parsed.value;
  const id = crypto.randomUUID();
  const slug = await uniqueSlug(c.env.DB, eventSlug(intake.coupleNames, intake.eventDate));

  // One transaction: an event without its vendor credits is a half-entered
  // form, and the design doc requires no partial writes.
  await c.env.DB.batch([
    eventStatement(c.env.DB, id, slug, intake),
    ...vendorStatements(c.env.DB, id, intake.vendorCredits),
    c.env.DB
      .prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action) VALUES (?, ?, 'event', ?, 'create')",
      )
      .bind(crypto.randomUUID(), c.get("user").id, id),
  ]);

  const row = await c.env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(id)
    .first<EventRow>();

  if (row === null) return fail(c, 500, "INTERNAL", "The event could not be read back.");

  return c.json(toView(row), 201);
});

eventRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM events ORDER BY event_date DESC, created_at DESC",
  ).all<EventRow>();

  return c.json({ events: results.map(toView) });
});

/** The single-event view: the event plus its vendor credits, in their order. */
async function detailView(db: D1Database, row: EventRow) {
  const { results } = await db
    .prepare(
      "SELECT role, business_name, website, instagram FROM vendor_credits WHERE event_id = ? ORDER BY sort_order",
    )
    .bind(row.id)
    .all<{
      role: string;
      business_name: string;
      website: string | null;
      instagram: string | null;
    }>();

  return {
    ...toView(row),
    vendorCredits: results.map((credit) => ({
      role: credit.role,
      businessName: credit.business_name,
      website: credit.website,
      instagram: credit.instagram,
    })),
  };
}

eventRoutes.get("/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(c.req.param("id"))
    .first<EventRow>();

  if (row === null) return fail(c, 404, "NOT_FOUND", "No such event.");

  return c.json(await detailView(c.env.DB, row));
});

/** ISO-8601 UTC to the second: the same shape the schema's defaults write. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The edit is the intake form again, so it is validated by the same rules and
 * replaces every field. Two things it does not touch:
 *
 * DECISION: the gallery link is replaced only by a new one. The SPA is never
 * given the stored link, so it cannot send it back; a null or absent link
 * therefore means "unchanged", never "remove". COALESCE keeps the decision in
 * SQL, so the stored credential is never read into the Worker for an edit.
 *
 * DECISION: the slug stays as minted. It is an identifier, and renaming the
 * couple should not move one.
 */
function updateStatement(db: D1Database, id: string, intake: EventIntake, now: string) {
  return db
    .prepare(
      `UPDATE events SET
         couple_names = ?, event_date = ?, venue_name = ?, city = ?, state = ?, country = ?,
         gallery_url = COALESCE(?, gallery_url), style_tags = ?, unique_angle = ?,
         rights_status = ?, consent_status = ?, consent_notes = ?, name_display = ?,
         couple_story = ?, is_destination = ?, hero_picks = ?, video_url = ?,
         target_outlet_notes = ?, prior_exposure = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      intake.coupleNames,
      intake.eventDate,
      intake.venueName,
      intake.city,
      intake.state,
      intake.country,
      intake.galleryUrl,
      JSON.stringify(intake.styleTags),
      intake.uniqueAngle,
      intake.rightsStatus,
      intake.consentStatus,
      intake.consentNotes,
      intake.nameDisplay,
      intake.coupleStory,
      intake.isDestination ? 1 : 0,
      intake.heroPicks,
      intake.videoUrl,
      intake.targetOutletNotes,
      JSON.stringify(intake.priorExposure),
      now,
      id,
    );
}

eventRoutes.patch("/:id", async (c) => {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return fail(c, 400, "VALIDATION", "Expected a JSON body.");
  }

  const existing = await c.env.DB.prepare("SELECT id FROM events WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string }>();
  if (existing === null) return fail(c, 404, "NOT_FOUND", "No such event.");

  const parsed = validateEventIntake(payload);
  if (!parsed.ok) {
    return fail(c, 400, "VALIDATION", "Some fields need attention.", parsed.errors);
  }

  const intake = parsed.value;
  const db = c.env.DB;

  // One transaction, as on create: the vendor list is replaced whole, and an
  // event left with half its old credits is a partial write.
  await db.batch([
    updateStatement(db, existing.id, intake, isoSeconds(Date.now())),
    db.prepare("DELETE FROM vendor_credits WHERE event_id = ?").bind(existing.id),
    ...vendorStatements(db, existing.id, intake.vendorCredits),
    db
      .prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action) VALUES (?, ?, 'event', ?, 'update')",
      )
      .bind(crypto.randomUUID(), c.get("user").id, existing.id),
  ]);

  const row = await db.prepare("SELECT * FROM events WHERE id = ?")
    .bind(existing.id)
    .first<EventRow>();
  if (row === null) return fail(c, 500, "INTERNAL", "The event could not be read back.");

  return c.json(await detailView(db, row));
});

/**
 * The submission walkthrough for one event, optionally for one of its
 * packages. Everything it reports is loaded through the same loaders the
 * event, package and queue pages use, then handed to the pure walkthrough
 * module, so a step can never call done what the page behind it would not.
 */
eventRoutes.get("/:id/walkthrough", async (c) => {
  const db = c.env.DB;
  const row = await db.prepare("SELECT * FROM events WHERE id = ?")
    .bind(c.req.param("id"))
    .first<EventRow>();
  if (row === null) return fail(c, 404, "NOT_FOUND", "No such event.");
  const event = toView(row);

  const [credits, pool, outlets, packages] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM vendor_credits WHERE event_id = ?")
      .bind(event.id)
      .first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM event_images WHERE event_id = ?")
      .bind(event.id)
      .first<{ n: number }>(),
    listPublications(db, false),
    listEventPackages(db, event.id),
  ]);

  let selected: WalkthroughPackage | null = null;
  let packageBody: Record<string, unknown> | null = null;

  const packageId = c.req.query("package");
  if (packageId !== undefined) {
    // A package from another event is reported exactly like a missing one.
    const view = await loadPackageView(c, packageId);
    const outlet = view === null ? null : await loadPublication(db, view.publicationId);
    if (view === null || view.eventId !== event.id || outlet === null) {
      return fail(c, 404, "NOT_FOUND", "No such package.");
    }

    const submission =
      view.submission === null ? null : await loadSubmissionView(db, view.submission.id, Date.now());

    selected = {
      id: view.id,
      outlet,
      imageCount: view.imageKeys.length,
      complete: view.complete,
      missingLabels: view.missing.map(
        (missing) => view.checklist.find((item) => item.id === missing)?.label ?? missing,
      ),
      submission:
        submission === null
          ? null
          : {
              id: submission.id,
              status: submission.status,
              due:
                submission.responseDueAt === null || submission.daysRemaining === null
                  ? null
                  : { at: submission.responseDueAt, daysRemaining: submission.daysRemaining },
              publishedUrl: submission.publishedUrl,
            },
    };

    packageBody = {
      id: view.id,
      publicationId: view.publicationId,
      publicationName: outlet.name,
      submissionUrl: outlet.submissionUrl,
      descriptionMd: view.descriptionMd,
      creditsBlockMd: view.creditsBlockMd,
      imageCount: view.imageKeys.length,
      complete: view.complete,
      submission:
        submission === null
          ? null
          : {
              id: submission.id,
              status: submission.status,
              responseDueAt: submission.responseDueAt,
              daysRemaining: submission.daysRemaining,
              publishedUrl: submission.publishedUrl,
            },
    };
  }

  const eventPackages = packages ?? [];
  // Mirrors the send route's rule: one live submission per event at a time.
  const liveElsewhere = eventPackages
    .filter((pkg) => pkg.id !== selected?.id && pkg.submission?.status === "sent")
    .map((pkg) => pkg.publicationName ?? pkg.publicationId);

  const steps = buildWalkthrough({
    event,
    vendorCreditCount: credits?.n ?? 0,
    poolCount: pool?.n ?? 0,
    outlets,
    selected,
    liveElsewhere,
  });

  return c.json({
    event: { id: event.id, coupleNames: event.coupleNames },
    packages: eventPackages,
    package: packageBody,
    // DECISION: the outlet chooser needs each outlet's warnings as data, not
    // only as the outlet step's prose, so they travel alongside the steps.
    outlets: outlets.map((outlet) => ({
      id: outlet.id,
      name: outlet.name,
      tier: outlet.tier,
      method: outlet.method,
      imgMin: outlet.spec.imgMin,
      imgMax: outlet.spec.imgMax,
      typicalResponseDays: outlet.typicalResponseDays,
      warnings: outletFit(outlet, event).warnings,
    })),
    steps,
  });
});

eventRoutes.get("/:id/packages", async (c) => {
  const packages = await listEventPackages(c.env.DB, c.req.param("id"));
  if (packages === null) return fail(c, 404, "NOT_FOUND", "No such event.");
  return c.json({ packages });
});
