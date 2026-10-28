import type { D1Database, D1PreparedStatement } from "../env.js";
import { readGeo } from "../domain/geo.js";
import type { Geo } from "../domain/geo.js";
import type { ContentType, ExposureChannel, HistoryEntry, MatchContext, MatchWedding } from "../domain/match.js";
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

export async function loadExposures(db: D1Database, eventId: string): Promise<ExposureRow[]> {
  const { results } = await db
    .prepare("SELECT id, channel, detail, publication_id FROM event_exposures WHERE event_id = ? ORDER BY created_at, rowid")
    .bind(eventId)
    .all<ExposureRow>();
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
export async function loadMatchInputs(
  db: D1Database,
  event: { id: string; event_date: string; location_code: string | null; content_type: ContentType; is_destination: number },
  today: string,
): Promise<{ wedding: MatchWedding; context: MatchContext; exposures: ExposureRow[] }> {
  const [exposures, own, profile, categories, submissions, features, geo] = await Promise.all([
    loadExposures(db, event.id),
    db.prepare("SELECT tag_id FROM event_tags WHERE event_id = ? AND state = 'confirmed'").bind(event.id).all<{ tag_id: string }>(),
    db
      .prepare(
        `SELECT event_tags.tag_id, COUNT(*) AS n FROM event_tags
         JOIN events ON events.id = event_tags.event_id
         WHERE event_tags.state = 'confirmed' AND events.rights_status != 'second_shooter'
         GROUP BY event_tags.tag_id ORDER BY n DESC, event_tags.tag_id`,
      )
      .all<{ tag_id: string; n: number }>(),
    db.prepare("SELECT id, category FROM tags").all<{ id: string; category: TagCategory }>(),
    db
      .prepare(
        `SELECT publication_id, event_id, status, outcome_at FROM submissions
         WHERE status IN ('published', 'accepted', 'declined', 'expired')`,
      )
      .all<{ publication_id: string; event_id: string; status: string; outcome_at: string | null }>(),
    db
      .prepare("SELECT publication_id, event_id, published_on FROM past_features WHERE publication_id IS NOT NULL")
      .all<{ publication_id: string; event_id: string | null; published_on: string | null }>(),
    loadGeo(db),
  ]);

  const history: HistoryEntry[] = [
    ...submissions.results.map((row) => ({
      publicationId: row.publication_id,
      eventId: row.event_id,
      kind: HISTORY_KIND[row.status] as HistoryEntry["kind"],
      at: row.outcome_at?.slice(0, 10) ?? null,
    })),
    ...features.results.map((row) => ({
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
      tags: own.results.map((row) => row.tag_id),
      exposures: exposures.map((row) => ({ channel: row.channel, detail: row.detail, publicationId: row.publication_id })),
    },
    context: {
      today,
      geo,
      tagCategories: new Map(categories.results.map((row) => [row.id, row.category])),
      profileTags: profile.results.map((row) => row.tag_id),
      history,
    },
    exposures,
  };
}
