import type { D1Database, D1PreparedStatement } from "../env.js";
import type { Correction } from "../domain/research/edits.js";
import type { PublicationColumns } from "../domain/research/project.js";

/** The photographer's corrections to one outlet, values parsed. */
export async function loadCorrections(db: D1Database, publicationId: string): Promise<Correction[]> {
  const { results } = await db
    .prepare("SELECT field, value_json FROM publication_edits WHERE publication_id = ? ORDER BY field")
    .bind(publicationId)
    .all<{ field: string; value_json: string }>();
  return results.map((row) => ({ field: row.field, value: JSON.parse(row.value_json) as unknown }));
}

/** Rewrites an outlet's projected columns; the research and its revision are left as they are. */
export function updateColumns(db: D1Database, columns: PublicationColumns, at: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE publications SET name = ?, tier = ?, kind = ?, method = ?, submission_url = ?, contact_email = ?,
         spec_json = ?, exclusivity_policy = ?, counts_own_blog_as_published = ?, typical_response_days = ?,
         response_window_note = ?, earned_or_paid = ?, taste_notes = ?, last_verified = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      columns.name,
      columns.tier,
      columns.kind,
      columns.method,
      columns.submission_url,
      columns.contact_email,
      columns.spec_json,
      columns.exclusivity_policy,
      columns.counts_own_blog_as_published,
      columns.typical_response_days,
      columns.response_window_note,
      columns.earned_or_paid,
      columns.taste_notes,
      columns.last_verified,
      at,
      columns.id,
    );
}
