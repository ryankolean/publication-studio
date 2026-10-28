import type { D1Database, D1PreparedStatement } from "../env.js";
import { readGeo } from "../domain/geo.js";
import type { Geo } from "../domain/geo.js";
import { rankOutlets } from "../domain/match.js";
import type { ContentType, ExposureChannel, HistoryEntry, MatchContext, MatchOutlet, MatchWedding } from "../domain/match.js";
import { listPublications } from "./publications.js";
import type { PublicationView } from "./publications.js";
import type { TagCategory } from "../domain/tags.js";

/** The read behind loadGeo, for a caller that batches it with its own. */
export function geoStatement(db: D1Database): D1PreparedStatement {
  return db.prepare("SELECT json FROM research_vocab WHERE kind = 'geo'");
}

// The parsed list, kept while the stored JSON is unchanged: parsing it again
// on every request costs Worker CPU (SUMMIT-344). Geo is read-only, so one
// copy can be shared.
let parsedGeo: { json: string; geo: Geo } | null = null;

/** The geo vocabulary from geoStatement's rows, or null when there is none. */
export function geoFrom(rows: readonly unknown[]): Geo | null {
  const row = rows[0] as { json: string } | undefined;
  if (row === undefined) return null;
  if (parsedGeo?.json !== row.json) parsedGeo = { json: row.json, geo: readGeo(JSON.parse(row.json)) };
  return parsedGeo.geo;
}

/** The stored geo vocabulary, or null before the research import has loaded it. */
export async function loadGeo(db: D1Database): Promise<Geo | null> {
  return geoFrom((await geoStatement(db).all()).results);
}

export interface ExposureRow {
  id: string;
  channel: ExposureChannel;
  detail: string | null;
  publication_id: string | null;
}

function exposuresStatement(db: D1Database, eventId: string): D1PreparedStatement {
  return db
    .prepare("SELECT id, channel, detail, publication_id FROM event_exposures WHERE event_id = ? ORDER BY created_at, rowid")
    .bind(eventId);
}

export async function loadExposures(db: D1Database, eventId: string): Promise<ExposureRow[]> {
  const { results } = await exposuresStatement(db, eventId).all<ExposureRow>();
  return results;
}

/** Statuses that are an outlet's answer, as the matcher's history reads them. */
const HISTORY_KIND: Record<string, HistoryEntry["kind"]> = {
  published: "feature",
  accepted: "accepted",
  declined: "declined",
  expired: "no_reply",
};

/**
 * Everything the matcher reads besides the outlets: the wedding, her
 * confirmed tags on it and across her own weddings, her history with every
 * outlet (submissions the tool tracked plus the features she recorded), and
 * the geo vocabulary.
 */
/** The event columns the matcher reads. */
export interface MatchEventRow {
  id: string;
  event_date: string;
  location_code: string | null;
  content_type: ContentType;
  is_destination: number;
}

export async function loadMatchInputs(
  db: D1Database,
  event: MatchEventRow,
  today: string,
): Promise<{ wedding: MatchWedding; context: MatchContext; exposures: ExposureRow[] }> {
  // One batch: on Workers every D1 call costs CPU of its own (SUMMIT-344).
  const results = await db.batch([
    exposuresStatement(db, event.id),
    db.prepare("SELECT tag_id FROM event_tags WHERE event_id = ? AND state = 'confirmed'").bind(event.id),
    db.prepare(
      `SELECT event_tags.tag_id, COUNT(*) AS n FROM event_tags
       JOIN events ON events.id = event_tags.event_id
       WHERE event_tags.state = 'confirmed' AND events.rights_status != 'second_shooter'
       GROUP BY event_tags.tag_id ORDER BY n DESC, event_tags.tag_id`,
    ),
    db.prepare("SELECT id, category FROM tags"),
    db.prepare(
      `SELECT publication_id, event_id, status, outcome_at FROM submissions
       WHERE status IN ('published', 'accepted', 'declined', 'expired')`,
    ),
    db.prepare("SELECT publication_id, event_id, published_on FROM past_features WHERE publication_id IS NOT NULL"),
    geoStatement(db),
  ]);
  const rows = <T>(index: number) => (results[index]?.results ?? []) as unknown as T[];
  const exposures = rows<ExposureRow>(0);
  const own = rows<{ tag_id: string }>(1);
  const profile = rows<{ tag_id: string; n: number }>(2);
  const categories = rows<{ id: string; category: TagCategory }>(3);
  const submissions = rows<{ publication_id: string; event_id: string; status: string; outcome_at: string | null }>(4);
  const features = rows<{ publication_id: string; event_id: string | null; published_on: string | null }>(5);
  const geo = geoFrom(rows(6));

  const history: HistoryEntry[] = [
    ...submissions.map((row) => ({
      publicationId: row.publication_id,
      eventId: row.event_id,
      kind: HISTORY_KIND[row.status] as HistoryEntry["kind"],
      at: row.outcome_at?.slice(0, 10) ?? null,
    })),
    ...features.map((row) => ({
      publicationId: row.publication_id,
      eventId: row.event_id,
      kind: "feature" as const,
      at: row.published_on,
    })),
  ];

  return {
    wedding: {
      id: event.id,
      eventDate: event.event_date,
      locationCode: event.location_code,
      contentType: event.content_type,
      isDestination: event.is_destination === 1,
      tags: own.map((row) => row.tag_id),
      exposures: exposures.map((row) => ({ channel: row.channel, detail: row.detail, publicationId: row.publication_id })),
    },
    context: {
      today,
      geo,
      tagCategories: new Map(categories.map((row) => [row.id, row.category])),
      profileTags: profile.map((row) => row.tag_id),
      history,
    },
    exposures,
  };
}

/** The matcher's view of the outlets the publications loader returns. */
export function matchOutlets(outlets: readonly PublicationView[]): MatchOutlet[] {
  return outlets.map((outlet) => ({ id: outlet.id, name: outlet.name, tier: outlet.tier, tags: outlet.tags, profile: outlet.matchProfile }));
}

/**
 * Every active outlet ranked for one wedding (SUMMIT-336). Shared by the
 * walkthrough and the Claude connector, so both rank exactly the same way.
 */
export async function rankForEvent(db: D1Database, event: MatchEventRow, today: string) {
  const [outlets, match] = await Promise.all([listPublications(db, false), loadMatchInputs(db, event, today)]);
  return { outlets, match, ranked: rankOutlets(match.wedding, matchOutlets(outlets), match.context) };
}
