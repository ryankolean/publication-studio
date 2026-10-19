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
import { buildWizard, followedPackageId, weddingChip } from "../domain/wizard.js";
import type { WizardPackage } from "../domain/wizard.js";
import type { SubmissionStatus } from "../domain/submission-status.js";
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

/**
 * The inventory, each event with the wizard's chip and whether the wizard has
 * a package to follow for it (the dashboard's "in progress"). Three queries in
 * all, not three per event: the vendor counts and package states are read for
 * every event at once and matched up here.
 *
 * DECISION: the chip and the progress flag ride on the existing list rather
 * than a new endpoint or a walkthrough call per card. The start screen and
 * the dashboard both already read this list, and the client must not derive
 * either verdict itself.
 */
eventRoutes.get("/", async (c) => {
  const db = c.env.DB;
  const [events, credits, packages] = await Promise.all([
    db.prepare("SELECT * FROM events ORDER BY event_date DESC, created_at DESC").all<EventRow>(),
    db.prepare("SELECT event_id, COUNT(*) AS n FROM vendor_credits GROUP BY event_id").all<{
      event_id: string;
      n: number;
    }>(),
    db
      .prepare(
        `SELECT packages.id AS id, packages.event_id AS event_id, submissions.status AS status
         FROM packages
         LEFT JOIN submissions ON submissions.event_id = packages.event_id
           AND submissions.publication_id = packages.publication_id
         ORDER BY packages.created_at DESC, packages.rowid DESC`,
      )
      .all<{ id: string; event_id: string; status: SubmissionStatus | null }>(),
  ]);

  const creditCount = new Map(credits.results.map((row) => [row.event_id, row.n]));
  const packagesOf = new Map<string, Array<{ id: string; submission: { status: SubmissionStatus } | null }>>();
  for (const row of packages.results) {
    const list = packagesOf.get(row.event_id) ?? [];
    list.push({ id: row.id, submission: row.status === null ? null : { status: row.status } });
    packagesOf.set(row.event_id, list);
  }

  return c.json({
    events: events.results.map((row) => {
      const view = toView(row);
      return {
        ...view,
        chip: weddingChip(view, creditCount.get(row.id) ?? 0),
        inProgress: followedPackageId(packagesOf.get(row.id) ?? []) !== null,
      };
    }),
  });
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
 * The `wizard` field is the guided wizard's resume position and verdicts,
 * built by domain/wizard.ts from the same loads.
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

  const eventPackages = packages ?? [];

  // The step list follows only a package named in the address, as before.
  // The wizard follows that one too, or, with none named, the one
  // followedPackageId picks, so /wizard/:eventId can resume without an id.
  const named = c.req.query("package");
  const followedId = named ?? followedPackageId(eventPackages);
  const loaded = followedId === null ? null : await loadFollowed(c, followedId, event.id);
  if (named !== undefined && loaded === null) {
    // A package from another event is reported exactly like a missing one.
    return fail(c, 404, "NOT_FOUND", "No such package.");
  }
  const selected = named === undefined ? null : (loaded?.walkthrough ?? null);
  const vendorCreditCount = credits?.n ?? 0;

  // Mirrors the send route's rule: one live submission per event at a time.
  const liveAt = (except: string | null) =>
    eventPackages
      .filter((pkg) => pkg.id !== except && pkg.submission?.status === "sent")
      .map((pkg) => pkg.publicationName ?? pkg.publicationId);

  const steps = buildWalkthrough({
    event,
    vendorCreditCount,
    poolCount: pool?.n ?? 0,
    outlets,
    selected,
    liveElsewhere: liveAt(selected?.id ?? null),
  });

  const wizard = buildWizard({
    event,
    vendorCreditCount,
    followed: loaded?.wizard ?? null,
    liveElsewhere: liveAt(loaded?.wizard.id ?? null),
  });

  return c.json({
    event: { id: event.id, coupleNames: event.coupleNames },
    packages: eventPackages,
    package: named === undefined ? null : (loaded?.body ?? null),
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
      tasteNotes: outlet.tasteNotes,
      warnings: outletFit(outlet, event).warnings,
    })),
    steps,
    wizard,
  });
});

const hasText = (value: string | null): boolean => value !== null && value.trim().length > 0;

/**
 * One package as the walkthrough and the wizard read it, through the package
 * editor's and the queue's own loaders. Null when it is gone, belongs to
 * another event, or its outlet record is missing.
 */
async function loadFollowed(
  c: { env: AppContext["Bindings"] },
  packageId: string,
  eventId: string,
): Promise<{ walkthrough: WalkthroughPackage; wizard: WizardPackage; body: Record<string, unknown> } | null> {
  const db = c.env.DB;
  const view = await loadPackageView(c, packageId);
  const outlet = view === null ? null : await loadPublication(db, view.publicationId);
  if (view === null || view.eventId !== eventId || outlet === null) return null;

  const submission =
    view.submission === null ? null : await loadSubmissionView(db, view.submission.id, Date.now());
  const followedSubmission =
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
        };
  const satisfied = (id: string) => view.checklist.find((item) => item.id === id)?.satisfied !== false;

  return {
    walkthrough: {
      id: view.id,
      outlet,
      imageCount: view.imageKeys.length,
      complete: view.complete,
      missingLabels: view.missing.map(
        (missing) => view.checklist.find((item) => item.id === missing)?.label ?? missing,
      ),
      submission: followedSubmission,
    },
    wizard: {
      id: view.id,
      outlet,
      // The checklist's own image items: at least one, and the outlet's count
      // when it states one (an item that is absent has nothing to object to).
      imagesReady: satisfied("images_present") && satisfied("image_count"),
      writeupReady: hasText(view.descriptionMd) && hasText(view.creditsBlockMd),
      complete: view.complete,
      submission: followedSubmission,
    },
    body: {
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
    },
  };
}

eventRoutes.get("/:id/packages", async (c) => {
  const packages = await listEventPackages(c.env.DB, c.req.param("id"));
  if (packages === null) return fail(c, 404, "NOT_FOUND", "No such event.");
  return c.json({ packages });
});
