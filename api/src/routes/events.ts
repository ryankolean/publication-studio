import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../errors.js";
import { evaluateRightsGate } from "../domain/rights-gate.js";
import type { ConsentStatus, RightsGateResult, RightsStatus } from "../domain/rights-gate.js";
import { validateEventIntake } from "../domain/event-intake.js";
import type { PriorExposure, VendorCreditInput, EventIntake } from "../domain/event-intake.js";
import { eventSlug } from "../domain/slug.js";
import type { D1Database } from "../env.js";

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

eventRoutes.get("/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(c.req.param("id"))
    .first<EventRow>();

  if (row === null) return fail(c, 404, "NOT_FOUND", "No such event.");

  const { results } = await c.env.DB.prepare(
    "SELECT role, business_name, website, instagram FROM vendor_credits WHERE event_id = ? ORDER BY sort_order",
  )
    .bind(row.id)
    .all<{
      role: string;
      business_name: string;
      website: string | null;
      instagram: string | null;
    }>();

  return c.json({
    ...toView(row),
    vendorCredits: results.map((credit) => ({
      role: credit.role,
      businessName: credit.business_name,
      website: credit.website,
      instagram: credit.instagram,
    })),
  });
});
