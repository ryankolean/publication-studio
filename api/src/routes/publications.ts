import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../errors.js";
import { parsePublicationSpec } from "../domain/publication-spec.js";
import type { PublicationSpec } from "../domain/publication-spec.js";
import { TAG_CATEGORY_ORDER } from "../domain/tags.js";
import type { D1Database } from "../env.js";
import type {
  EarnedOrPaid,
  ExclusivityPolicy,
  PublicationTier,
  SubmissionMethod,
} from "../domain/publication.js";

interface PublicationRow {
  id: string;
  name: string;
  tier: PublicationTier;
  method: SubmissionMethod | null;
  submission_url: string | null;
  contact_email: string | null;
  spec_json: string;
  exclusivity_policy: ExclusivityPolicy;
  counts_own_blog_as_published: number | null;
  typical_response_days: number | null;
  response_window_note: string | null;
  earned_or_paid: EarnedOrPaid;
  taste_notes: string | null;
  last_verified: string;
  active: number;
}

export interface PublicationView {
  id: string;
  name: string;
  tier: PublicationTier;
  method: SubmissionMethod | null;
  submissionUrl: string | null;
  contactEmail: string | null;
  spec: PublicationSpec;
  exclusivityPolicy: ExclusivityPolicy;
  /** null means unknown, which is not the same as a known false. */
  countsOwnBlogAsPublished: boolean | null;
  typicalResponseDays: number | null;
  /** The outlet's own wording for its window, e.g. replies only on success. */
  responseWindowNote: string | null;
  earnedOrPaid: EarnedOrPaid;
  tasteNotes: string | null;
  lastVerified: string;
  active: boolean;
  /** Shared vocabulary ids (see the tags table), in category order. */
  tags: string[];
}

function toView(row: PublicationRow, tags: string[]): PublicationView {
  return {
    id: row.id,
    name: row.name,
    tier: row.tier,
    method: row.method,
    submissionUrl: row.submission_url,
    contactEmail: row.contact_email,
    spec: parsePublicationSpec(row.spec_json),
    exclusivityPolicy: row.exclusivity_policy,
    countsOwnBlogAsPublished:
      row.counts_own_blog_as_published === null ? null : row.counts_own_blog_as_published === 1,
    typicalResponseDays: row.typical_response_days,
    responseWindowNote: row.response_window_note,
    earnedOrPaid: row.earned_or_paid,
    tasteNotes: row.taste_notes,
    lastVerified: row.last_verified,
    active: row.active === 1,
    tags,
  };
}

// Tier is a priority, not an alphabet: sequencing guidance says lead with a
// primary outlet (design doc section 7.3), so primary sorts first.
const TIER_ORDER = `CASE tier WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END`;

/** Every publication in priority order, active ones only unless asked. */
export async function listPublications(
  db: D1Database,
  includeInactive: boolean,
): Promise<PublicationView[]> {
  const where = includeInactive ? "" : "WHERE active = 1";

  const { results } = await db
    .prepare(`SELECT * FROM publications ${where} ORDER BY ${TIER_ORDER}, name`)
    .all<PublicationRow>();

  const tagRows = await db
    .prepare(
      `SELECT publication_id, tag_id FROM publication_tags
       JOIN tags ON tags.id = publication_tags.tag_id
       ORDER BY ${TAG_CATEGORY_ORDER}, tags.sort_order`,
    )
    .all<{ publication_id: string; tag_id: string }>();
  const tagsByPublication = new Map<string, string[]>();
  for (const row of tagRows.results) {
    const list = tagsByPublication.get(row.publication_id) ?? [];
    list.push(row.tag_id);
    tagsByPublication.set(row.publication_id, list);
  }

  return results.map((row) => toView(row, tagsByPublication.get(row.id) ?? []));
}

/**
 * One publication, active or not: addressed directly, a deactivated outlet is
 * still readable; deactivation removes it from the list, it does not delete
 * the record.
 */
export async function loadPublication(db: D1Database, id: string): Promise<PublicationView | null> {
  const row = await db
    .prepare("SELECT * FROM publications WHERE id = ?")
    .bind(id)
    .first<PublicationRow>();
  if (row === null) return null;

  const tagRows = await db
    .prepare(
      `SELECT tag_id FROM publication_tags
       JOIN tags ON tags.id = publication_tags.tag_id
       WHERE publication_id = ?
       ORDER BY ${TAG_CATEGORY_ORDER}, tags.sort_order`,
    )
    .bind(row.id)
    .all<{ tag_id: string }>();

  return toView(row, tagRows.results.map((tag) => tag.tag_id));
}

export const publicationRoutes = new Hono<AppContext>();

publicationRoutes.use("*", requireAuth);

publicationRoutes.get("/", async (c) => {
  const includeInactive = c.req.query("include_inactive") !== undefined;
  return c.json({ publications: await listPublications(c.env.DB, includeInactive) });
});

publicationRoutes.get("/:id", async (c) => {
  const publication = await loadPublication(c.env.DB, c.req.param("id"));
  if (publication === null) return fail(c, 404, "NOT_FOUND", "No such publication.");
  return c.json(publication);
});
