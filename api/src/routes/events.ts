import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../errors.js";
import { evaluateRightsGate } from "../domain/rights-gate.js";
import type { ConsentStatus, RightsGateResult, RightsStatus } from "../domain/rights-gate.js";
import { validateEventIntake } from "../domain/event-intake.js";
import type { VendorCreditInput, EventIntake } from "../domain/event-intake.js";
import { isLocationCode } from "../domain/geo.js";
import type { Geo } from "../domain/geo.js";
import { rankOutlets, validateExposures } from "../domain/match.js";
import { eventSlug } from "../domain/slug.js";
import { buildWalkthrough, exposureSummary, outletFit } from "../domain/walkthrough.js";
import type { WalkthroughPackage } from "../domain/walkthrough.js";
import { buildWizard, followedPackageId, weddingChip } from "../domain/wizard.js";
import type { WizardPackage } from "../domain/wizard.js";
import type { SubmissionStatus } from "../domain/submission-status.js";
import type { D1Database, D1PreparedStatement } from "../env.js";
import { listEventPackages, loadPackageView } from "./packages.js";
import { listPublications, loadPublication } from "./publications.js";
import { loadView as loadSubmissionView } from "./submissions.js";
import { geoFrom, geoStatement, loadExposures, loadGeo, loadMatchInputs } from "./match-context.js";

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
  location_code: string | null;
  content_type: EventIntake["contentType"];
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
  locationCode: string | null;
  contentType: EventIntake["contentType"];
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
    locationCode: row.location_code,
    contentType: row.content_type,
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
         gallery_url, unique_angle, rights_status, consent_status,
         consent_notes, name_display, couple_story, is_destination, hero_picks,
         video_url, target_outlet_notes, location_code, content_type
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
      intake.locationCode,
      intake.contentType,
    );
}

/** Why a wedding's place code cannot be stored, or null when it can. */
function locationProblem(code: string | null, geo: Geo | null): string | null {
  if (code === null) return null;
  if (geo === null) return "The list of places is not loaded yet.";
  return isLocationCode(code, geo) ? null : "Choose a place from the list.";
}

const today = () => new Date().toISOString().slice(0, 10);

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
  const placeProblem = locationProblem(intake.locationCode, await loadGeo(c.env.DB));
  if (placeProblem !== null) {
    return fail(c, 400, "VALIDATION", "Some fields need attention.", [{ field: "locationCode", message: placeProblem }]);
  }
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

  if (row === null) return fail(c, 500, "INTERNAL", "That was saved, but it could not be loaded again. Refresh the page.");

  return c.json(toView(row), 201);
});

/**
 * The inventory, each event with the wizard's chip, whether the wizard has
 * a package to follow for it (the dashboard's "in progress"), and whether it
 * has ever had a package (the home page's welcome collapses once any has). Three queries in
 * all, not three per event: the vendor counts and package states are read for
 * every event at once and matched up here.
 *
 * DECISION: the chip and the progress flag ride on the existing list rather
 * than a new endpoint or a walkthrough call per card. The start screen and
 * the dashboard both already read this list, and the client must not derive
 * either verdict itself.
 */
/** The reads behind listEvents, for a caller that batches them with its own. */
export function listEventsStatements(db: D1Database): D1PreparedStatement[] {
  return [
    db.prepare("SELECT * FROM events ORDER BY event_date DESC, created_at DESC"),
    db.prepare("SELECT event_id, COUNT(*) AS n FROM vendor_credits GROUP BY event_id"),
    db.prepare(
      `SELECT packages.id AS id, packages.event_id AS event_id, submissions.status AS status,
              publications.name AS publication_name
       FROM packages
       LEFT JOIN submissions ON submissions.event_id = packages.event_id
         AND submissions.publication_id = packages.publication_id
       LEFT JOIN publications ON publications.id = packages.publication_id
       ORDER BY packages.created_at DESC, packages.rowid DESC`,
    ),
  ];
}

/** listEvents' view from the results of listEventsStatements, in their order. */
export function listEventsFrom(results: ReadonlyArray<{ results: unknown[] }>) {
  const events = (results[0]?.results ?? []) as EventRow[];
  const credits = (results[1]?.results ?? []) as Array<{ event_id: string; n: number }>;
  const packages = (results[2]?.results ?? []) as Array<{
    id: string;
    event_id: string;
    status: SubmissionStatus | null;
    publication_name: string | null;
  }>;

  const creditCount = new Map(credits.map((row) => [row.event_id, row.n]));
  const packagesOf = new Map<
    string,
    Array<{ id: string; publicationName: string | null; submission: { status: SubmissionStatus } | null }>
  >();
  for (const row of packages) {
    const list = packagesOf.get(row.event_id) ?? [];
    list.push({
      id: row.id,
      publicationName: row.publication_name,
      submission: row.status === null ? null : { status: row.status },
    });
    packagesOf.set(row.event_id, list);
  }

  return events.map((row) => {
    const view = toView(row);
    return {
      ...view,
      chip: weddingChip(view, creditCount.get(row.id) ?? 0, packagesOf.get(row.id) ?? []),
      inProgress: followedPackageId(packagesOf.get(row.id) ?? []) !== null,
      hasPackage: (packagesOf.get(row.id) ?? []).length > 0,
    };
  });
}

/**
 * Every event as the home screen shows it, newest first, each with its chip.
 * Shared with the Claude connector, so both read the studio the same way.
 *
 * DECISION: reads that do not depend on each other go to D1 in one batch. On
 * Workers every D1 call costs about half a millisecond of CPU of its own, and
 * the free plan allows 10 ms a request (SUMMIT-344).
 */
export async function listEvents(db: D1Database) {
  return listEventsFrom(await db.batch(listEventsStatements(db)));
}

eventRoutes.get("/", async (c) => c.json({ events: await listEvents(c.env.DB) }));

interface CreditRow {
  role: string;
  business_name: string;
  website: string | null;
  instagram: string | null;
}

/** The reads behind loadEvent: the event, then its vendor credits in their order, by id or by slug. */
export function eventStatements(db: D1Database, key: string, by: "id" | "slug" = "id"): D1PreparedStatement[] {
  return by === "id"
    ? [
        db.prepare("SELECT * FROM events WHERE id = ?").bind(key),
        db.prepare("SELECT role, business_name, website, instagram FROM vendor_credits WHERE event_id = ? ORDER BY sort_order").bind(key),
      ]
    : [
        db.prepare("SELECT * FROM events WHERE slug = ?").bind(key),
        db
          .prepare(
            `SELECT role, business_name, website, instagram FROM vendor_credits
             WHERE event_id = (SELECT id FROM events WHERE slug = ?) ORDER BY sort_order`,
          )
          .bind(key),
      ];
}

/** The single-event view from eventStatements' results; null when there is no such event. */
export function eventFrom(results: ReadonlyArray<{ results: unknown[] }>) {
  const row = results[0]?.results[0] as EventRow | undefined;
  if (row === undefined) return null;
  const credits = (results[1]?.results ?? []) as CreditRow[];
  return {
    ...toView(row),
    vendorCredits: credits.map((credit) => ({
      role: credit.role,
      businessName: credit.business_name,
      website: credit.website,
      instagram: credit.instagram,
    })),
  };
}

/** One event with its vendor credits; null when there is no such id. */
export async function loadEvent(db: D1Database, id: string) {
  return eventFrom(await db.batch(eventStatements(db, id)));
}

eventRoutes.get("/:id", async (c) => {
  const event = await loadEvent(c.env.DB, c.req.param("id"));
  if (event === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");
  return c.json(event);
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
         gallery_url = COALESCE(?, gallery_url), unique_angle = ?,
         rights_status = ?, consent_status = ?, consent_notes = ?, name_display = ?,
         couple_story = ?, is_destination = ?, hero_picks = ?, video_url = ?,
         target_outlet_notes = ?, location_code = ?, content_type = ?, updated_at = ?
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
      intake.locationCode,
      intake.contentType,
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

  const db = c.env.DB;
  const [found, geoRows] = await db.batch([
    db.prepare("SELECT id FROM events WHERE id = ?").bind(c.req.param("id")),
    geoStatement(db),
  ]);
  const existing = found?.results[0] as { id: string } | undefined;
  if (existing === undefined) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");

  const parsed = validateEventIntake(payload);
  if (!parsed.ok) {
    return fail(c, 400, "VALIDATION", "Some fields need attention.", parsed.errors);
  }

  const intake = parsed.value;
  const placeProblem = locationProblem(intake.locationCode, geoFrom(geoRows?.results ?? []));
  if (placeProblem !== null) {
    return fail(c, 400, "VALIDATION", "Some fields need attention.", [{ field: "locationCode", message: placeProblem }]);
  }

  // One transaction, as on create: the vendor list is replaced whole, and an
  // event left with half its old credits is a partial write. The saved event
  // is read back in the same batch, after the writes.
  const written = await db.batch([
    updateStatement(db, existing.id, intake, isoSeconds(Date.now())),
    db.prepare("DELETE FROM vendor_credits WHERE event_id = ?").bind(existing.id),
    ...vendorStatements(db, existing.id, intake.vendorCredits),
    db
      .prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action) VALUES (?, ?, 'event', ?, 'update')",
      )
      .bind(crypto.randomUUID(), c.get("user").id, existing.id),
    ...eventStatements(db, existing.id),
  ]);

  const saved = eventFrom(written.slice(-2));
  if (saved === null) return fail(c, 500, "INTERNAL", "That was saved, but it could not be loaded again. Refresh the page.");

  return c.json(saved);
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
  if (row === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");

  const [credits, pool, outlets, packages, tags, match] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM vendor_credits WHERE event_id = ?")
      .bind(row.id)
      .first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM event_images WHERE event_id = ?")
      .bind(row.id)
      .first<{ n: number }>(),
    listPublications(db, false),
    listEventPackages(db, row.id),
    db.prepare("SELECT COUNT(*) AS n FROM event_tags WHERE event_id = ? AND state = 'confirmed'")
      .bind(row.id)
      .first<{ n: number }>(),
    loadMatchInputs(db, row, today()),
  ]);
  const event = { ...toView(row), priorExposure: exposureSummary(match.exposures) };

  const eventPackages = packages ?? [];

  // The step list follows only a package named in the address, as before.
  // The wizard follows that one too, or, with none named, the one
  // followedPackageId picks, so /wizard/:eventId can resume without an id.
  const named = c.req.query("package");
  const followedId = named ?? followedPackageId(eventPackages);
  const loaded = followedId === null ? null : await loadFollowed(c, followedId, event.id);
  if (named !== undefined && loaded === null) {
    // A package from another event is reported exactly like a missing one.
    return fail(c, 404, "NOT_FOUND", "That submission could not be found.");
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
    confirmedTagCount: tags?.n ?? 0,
    packageCount: eventPackages.length,
    followed: loaded?.wizard ?? null,
    liveElsewhere: liveAt(loaded?.wizard.id ?? null),
  });

  const byId = new Map(outlets.map((outlet) => [outlet.id, outlet]));
  const ranked = rankOutlets(
    match.wedding,
    outlets.map((outlet) => ({ id: outlet.id, name: outlet.name, tier: outlet.tier, tags: outlet.tags, profile: outlet.matchProfile })),
    match.context,
  );

  return c.json({
    event: { id: event.id, coupleNames: event.coupleNames, locationCode: event.locationCode },
    packages: eventPackages,
    package: named === undefined ? null : (loaded?.body ?? null),
    // DECISION: the outlet chooser needs each outlet's warnings as data, not
    // only as the outlet step's prose, so they travel alongside the steps.
    // The matcher's order replaces the tier order (SUMMIT-336).
    outlets: ranked.map((result) => {
      const outlet = byId.get(result.outletId) as (typeof outlets)[number];
      return {
        id: outlet.id,
        name: outlet.name,
        tier: outlet.tier,
        method: outlet.method,
        imgMin: outlet.spec.imgMin,
        imgMax: outlet.spec.imgMax,
        typicalResponseDays: outlet.typicalResponseDays,
        tasteNotes: outlet.tasteNotes,
        warnings: outletFit(outlet, event).warnings,
        match: result,
      };
    }),
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
  if (packages === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");
  return c.json({ packages });
});

const exposureView = (row: { id: string; channel: string; detail: string | null; publication_id: string | null }) => ({
  id: row.id,
  channel: row.channel,
  detail: row.detail,
  publicationId: row.publication_id,
});

/** Where the wedding has already been shared (SUMMIT-336). */
eventRoutes.get("/:id/exposures", async (c) => {
  const event = await c.env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(c.req.param("id")).first<{ id: string }>();
  if (event === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");
  return c.json({ exposures: (await loadExposures(c.env.DB, event.id)).map(exposureView) });
});

/**
 * Replaces the whole list: the form sends every place she ticked. A named
 * earlier outlet must be one of the researched publications; anything else
 * goes in as text.
 */
eventRoutes.put("/:id/exposures", async (c) => {
  const db = c.env.DB;
  const event = await db.prepare("SELECT id FROM events WHERE id = ?").bind(c.req.param("id")).first<{ id: string }>();
  if (event === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");
  const parsed = validateExposures(await c.req.json().catch(() => null));
  if (!parsed.ok) return fail(c, 400, "VALIDATION", "Some fields need attention.", parsed.errors);

  for (const [index, exposure] of parsed.value.entries()) {
    if (exposure.publicationId === null) continue;
    const outlet = await db.prepare("SELECT id FROM publications WHERE id = ?").bind(exposure.publicationId).first();
    if (outlet === null) {
      return fail(c, 400, "VALIDATION", "Some fields need attention.", [
        { field: `exposures.${index}.publicationId`, message: "That outlet could not be found." },
      ]);
    }
  }

  const user = c.get("user").id;
  await db.batch([
    db.prepare("DELETE FROM event_exposures WHERE event_id = ?").bind(event.id),
    ...parsed.value.map((exposure) =>
      db
        .prepare("INSERT INTO event_exposures (id, event_id, channel, detail, publication_id, created_by) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), event.id, exposure.channel, exposure.detail, exposure.publicationId, user),
    ),
    db
      .prepare("INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json) VALUES (?, ?, 'event', ?, 'exposures_updated', ?)")
      .bind(crypto.randomUUID(), user, event.id, JSON.stringify({ count: parsed.value.length })),
  ]);
  return c.json({ exposures: (await loadExposures(db, event.id)).map(exposureView) });
});
