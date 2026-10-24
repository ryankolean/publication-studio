import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../errors.js";
import { parsePublicationSpec } from "../domain/publication-spec.js";
import type { PublicationSpec } from "../domain/publication-spec.js";
import { TAG_CATEGORY_ORDER } from "../domain/tags.js";
import type { MatchProfile } from "../domain/match.js";
import type { D1Database } from "../env.js";
import { applyEdits } from "../domain/research/edits.js";
import type { Correction } from "../domain/research/edits.js";
import { projectPublication } from "../domain/research/project.js";
import { validateFactEdit } from "../domain/research/schema.js";
import type { PublicationFile } from "../domain/research/schema.js";
import type { Contacts } from "../domain/research/contacts.js";
import { loadCorrections, updateColumns } from "./research-projection.js";
import { loadVocab, nowIso, today } from "./research-vocab.js";
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
  match_json: string | null;
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
  /** The photographer's corrections to the research, already applied to the fields above. */
  corrections: Array<{ field: string; value: unknown; note: string | null }>;
  /** The matcher's facts (SUMMIT-336); null until research is approved. */
  matchProfile: MatchProfile | null;
}

type CorrectionView = PublicationView["corrections"][number];
interface EditRow {
  publication_id: string;
  field: string;
  value_json: string;
  note: string | null;
}
const toCorrection = (row: EditRow): CorrectionView => ({
  field: row.field,
  value: JSON.parse(row.value_json) as unknown,
  note: row.note,
});

function toView(row: PublicationRow, tags: string[], corrections: CorrectionView[]): PublicationView {
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
    corrections,
    matchProfile: row.match_json === null ? null : (JSON.parse(row.match_json) as MatchProfile),
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
       WHERE publication_tags.origin != 'removed'
       ORDER BY ${TAG_CATEGORY_ORDER}, tags.sort_order`,
    )
    .all<{ publication_id: string; tag_id: string }>();
  const tagsByPublication = new Map<string, string[]>();
  for (const row of tagRows.results) {
    const list = tagsByPublication.get(row.publication_id) ?? [];
    list.push(row.tag_id);
    tagsByPublication.set(row.publication_id, list);
  }

  const edits = await db
    .prepare("SELECT publication_id, field, value_json, note FROM publication_edits ORDER BY field")
    .all<EditRow>();
  return results.map((row) =>
    toView(
      row,
      tagsByPublication.get(row.id) ?? [],
      edits.results.filter((edit) => edit.publication_id === row.id).map(toCorrection),
    ),
  );
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
  const edits = await db
    .prepare("SELECT publication_id, field, value_json, note FROM publication_edits WHERE publication_id = ? ORDER BY field")
    .bind(row.id)
    .all<EditRow>();
  return toView(row, await effectiveTags(db, row.id), edits.results.map(toCorrection));
}

/** An outlet's tags as the photographer sees them: research and her own, less what she removed. */
async function effectiveTags(db: D1Database, publicationId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT tag_id FROM publication_tags
       JOIN tags ON tags.id = publication_tags.tag_id
       WHERE publication_id = ? AND publication_tags.origin != 'removed'
       ORDER BY ${TAG_CATEGORY_ORDER}, tags.sort_order`,
    )
    .bind(publicationId)
    .all<{ tag_id: string }>();
  return results.map((tag) => tag.tag_id);
}

/**
 * The column update that puts an outlet's corrections in force, or nothing
 * for an outlet whose research is not approved yet: its corrections wait and
 * apply when its research is.
 */
async function reprojection(db: D1Database, id: string, corrections: Correction[], at: string) {
  const row = await db
    .prepare("SELECT research_json FROM publications WHERE id = ?")
    .bind(id)
    .first<{ research_json: string | null }>();
  if (row?.research_json == null) return [];
  const payload = JSON.parse(row.research_json) as { file: PublicationFile; contacts: Contacts | null };
  return [updateColumns(db, projectPublication(applyEdits(payload.file, corrections), payload.contacts).columns, at)];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const publicationExists = async (db: D1Database, id: string) =>
  (await db.prepare("SELECT id FROM publications WHERE id = ?").bind(id).first()) !== null;

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

/**
 * The approved research behind an outlet (SUMMIT-335), with its private
 * contacts and the photographer's corrections. research is null for an outlet
 * whose research has not been approved yet.
 */
publicationRoutes.get("/:id/research", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const row = await db
    .prepare("SELECT research_json, research_revision_id FROM publications WHERE id = ?")
    .bind(id)
    .first<{ research_json: string | null; research_revision_id: string | null }>();
  if (row === null) return fail(c, 404, "NOT_FOUND", "No such publication.");

  const payload = row.research_json === null ? null : (JSON.parse(row.research_json) as { file: unknown; contacts: unknown });
  const edits = await db
    .prepare("SELECT field, value_json, note, updated_at FROM publication_edits WHERE publication_id = ? ORDER BY field")
    .bind(id)
    .all<{ field: string; value_json: string; note: string | null; updated_at: string }>();

  return c.json({
    research: payload?.file ?? null,
    contacts: payload?.contacts ?? null,
    edits: edits.results.map((edit) => ({
      field: edit.field,
      value: JSON.parse(edit.value_json) as unknown,
      note: edit.note,
      updatedAt: edit.updated_at,
    })),
    revisionId: row.research_revision_id,
  });
});

/** The photographer corrects one research fact; newer research never overwrites it. */
publicationRoutes.put("/:id/edits/:field", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const field = c.req.param("field");
  if (!(await publicationExists(db, id))) return fail(c, 404, "NOT_FOUND", "No such publication.");
  const vocab = await loadVocab(db);
  if (vocab === null) return fail(c, 409, "RESEARCH_VOCAB_MISSING", "Load the research vocabulary first.");

  const body: unknown = await c.req.json().catch(() => null);
  if (!isObject(body) || !("value" in body)) return fail(c, 422, "VALIDATION", "Expected a JSON object with a value.");
  if (field === "content.style_tags") {
    return fail(c, 422, "VALIDATION", "Change an outlet's tags with the tag buttons.");
  }
  const checked = validateFactEdit(field, body["value"], vocab, today());
  if (!checked.ok) return fail(c, 422, "VALIDATION", "That correction does not fit this field.", checked.errors);

  const note = typeof body["note"] === "string" && body["note"].trim() !== "" ? body["note"].trim() : null;
  const user = c.get("user").id;
  const at = nowIso();
  const corrections = (await loadCorrections(db, id)).filter((correction) => correction.field !== field);
  corrections.push({ field, value: checked.value });
  await db.batch([
    ...(await reprojection(db, id, corrections, at)),
    db
      .prepare(
        `INSERT INTO publication_edits (publication_id, field, value_json, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (publication_id, field) DO UPDATE SET
           value_json = excluded.value_json, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(id, field, JSON.stringify(checked.value), note, user, at),
    db
      .prepare("INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json) VALUES (?, ?, 'publication', ?, 'research_corrected', ?)")
      .bind(crypto.randomUUID(), user, id, JSON.stringify({ field })),
  ]);
  return c.json({ field, value: checked.value, note });
});

publicationRoutes.delete("/:id/edits/:field", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const field = c.req.param("field");
  const edit = await db
    .prepare("SELECT field FROM publication_edits WHERE publication_id = ? AND field = ?")
    .bind(id, field)
    .first();
  if (edit === null) return fail(c, 404, "NOT_FOUND", "There is no correction to remove.");
  const corrections = (await loadCorrections(db, id)).filter((correction) => correction.field !== field);
  await db.batch([
    ...(await reprojection(db, id, corrections, nowIso())),
    db.prepare("DELETE FROM publication_edits WHERE publication_id = ? AND field = ?").bind(id, field),
    db
      .prepare("INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json) VALUES (?, ?, 'publication', ?, 'research_correction_removed', ?)")
      .bind(crypto.randomUUID(), c.get("user").id, id, JSON.stringify({ field })),
  ]);
  return c.body(null, 204);
});

const tagRow = (db: D1Database, publicationId: string, tagId: string) =>
  db
    .prepare("SELECT origin FROM publication_tags WHERE publication_id = ? AND tag_id = ?")
    .bind(publicationId, tagId)
    .first<{ origin: string }>();

/** Adds a tag the research did not give the outlet, or brings back one she removed. */
publicationRoutes.post("/:id/tags/:tag", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const tagId = c.req.param("tag");
  if (!(await publicationExists(db, id))) return fail(c, 404, "NOT_FOUND", "No such publication.");
  if ((await db.prepare("SELECT id FROM tags WHERE id = ?").bind(tagId).first()) === null) {
    return fail(c, 404, "NOT_FOUND", "No such tag.");
  }
  const row = await tagRow(db, id, tagId);
  if (row === null) {
    await db.prepare("INSERT INTO publication_tags (publication_id, tag_id, origin) VALUES (?, ?, 'added')").bind(id, tagId).run();
  } else if (row.origin === "removed") {
    await db.prepare("UPDATE publication_tags SET origin = 'added' WHERE publication_id = ? AND tag_id = ?").bind(id, tagId).run();
  }
  return c.json({ tags: await effectiveTags(db, id) });
});

/** Removes a tag; a research tag is remembered as removed so newer research does not bring it back. */
publicationRoutes.delete("/:id/tags/:tag", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const tagId = c.req.param("tag");
  const row = await tagRow(db, id, tagId);
  if (row === null || row.origin === "removed") return fail(c, 404, "NOT_FOUND", "That tag is not on this outlet.");
  if (row.origin === "research") {
    await db.prepare("UPDATE publication_tags SET origin = 'removed' WHERE publication_id = ? AND tag_id = ?").bind(id, tagId).run();
  } else {
    await db.prepare("DELETE FROM publication_tags WHERE publication_id = ? AND tag_id = ?").bind(id, tagId).run();
  }
  return c.json({ tags: await effectiveTags(db, id) });
});
