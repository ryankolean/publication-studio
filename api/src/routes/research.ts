/**
 * The research approval gate (SUMMIT-335).
 *
 * The operator's import posts the vocabulary and then each outlet's research
 * file. A file that changed becomes a pending revision; nothing reaches the
 * publications table until a person approves it. Approving copies the research
 * onto the publication columns and replaces the outlet's research tags, while
 * the photographer's own tags and corrections, kept apart, survive untouched.
 */

import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { fail } from "../errors.js";
import type { D1Database } from "../env.js";
import { TAG_CATEGORIES } from "../domain/tags.js";
import { canonicalJson, sha256Hex } from "../domain/research/canonical.js";
import { parseContacts } from "../domain/research/contacts.js";
import type { Contacts } from "../domain/research/contacts.js";
import { conflictsWith, diffResearch } from "../domain/research/diff.js";
import type { FieldChange } from "../domain/research/diff.js";
import { projectPublication } from "../domain/research/project.js";
import { parseResearchVocab, validatePublicationFile } from "../domain/research/schema.js";
import type { PublicationFile } from "../domain/research/schema.js";
import { VOCAB_KINDS } from "../domain/research/store.js";
import type { RevisionStatus } from "../domain/research/store.js";
import { loadPublication } from "./publications.js";
import { loadVocab, nowIso, today } from "./research-vocab.js";

export interface ResearchPayload {
  file: PublicationFile;
  contacts: Contacts | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);


export const researchRoutes = new Hono<AppContext>();

researchRoutes.use("*", requireAuth);

researchRoutes.put("/vocab", requireRole("admin"), async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const tags = isObject(body) ? body["tags"] : undefined;
  const geo = isObject(body) ? body["geo"] : undefined;
  const parsed = parseResearchVocab(tags, geo);
  if (!parsed.ok) return fail(c, 422, "VALIDATION", "The vocabulary does not validate.", parsed.errors);

  const db = c.env.DB;
  const updatedAt = nowIso();
  const statements = [];
  for (const kind of VOCAB_KINDS) {
    const json = canonicalJson(kind === "tags" ? tags : geo);
    statements.push(
      db
        .prepare(
          `INSERT INTO research_vocab (kind, json, content_hash, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (kind) DO UPDATE SET json = excluded.json, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
        )
        .bind(kind, json, await sha256Hex(json), updatedAt),
    );
  }
  // Seed tags take the file's category and order; a custom tag of the same id is left alone.
  for (const category of TAG_CATEGORIES) {
    ((tags as Record<string, string[]>)[category] as string[]).forEach((id, index) => {
      statements.push(
        db
          .prepare(
            `INSERT INTO tags (id, category, sort_order, origin) VALUES (?, ?, ?, 'seed')
             ON CONFLICT (id) DO UPDATE SET category = excluded.category, sort_order = excluded.sort_order
             WHERE tags.origin = 'seed'`,
          )
          .bind(id, category, index),
      );
    });
  }
  await db.batch(statements);
  return c.json({ tags: parsed.value.tags.size, geo: parsed.value.geo.size });
});

researchRoutes.post("/revisions", requireRole("admin"), async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!isObject(body)) return fail(c, 422, "VALIDATION", "Expected a JSON object with file and contacts.");

  const db = c.env.DB;
  const vocab = await loadVocab(db);
  if (vocab === null) return fail(c, 409, "RESEARCH_VOCAB_MISSING", "Load the research vocabulary first.");

  const file = validatePublicationFile(body["file"], vocab, today());
  if (!file.ok) return fail(c, 422, "VALIDATION", "The research file does not validate.", file.errors);

  let contacts: Contacts | null = null;
  if (body["contacts"] !== null && body["contacts"] !== undefined) {
    const parsed = parseContacts(body["contacts"], today());
    if (!parsed.ok) return fail(c, 422, "VALIDATION", "The contacts do not validate.", parsed.errors);
    if (parsed.value.id !== file.value.id) {
      return fail(c, 422, "VALIDATION", "The contacts belong to another outlet.", [
        { field: "contacts.id", message: `Expected ${file.value.id}.` },
      ]);
    }
    contacts = parsed.value;
  }

  const publicationId = file.value.id;
  const payloadJson = canonicalJson({ file: file.value, contacts } satisfies ResearchPayload);
  const hash = await sha256Hex(payloadJson);

  // Already waiting, already live, or already turned down: nothing new to ask.
  const same = await db
    .prepare(
      `SELECT id, status FROM research_revisions
       WHERE publication_id = ? AND content_hash = ? AND status IN ('pending', 'approved', 'rejected')
       ORDER BY proposed_at DESC LIMIT 1`,
    )
    .bind(publicationId, hash)
    .first<{ id: string; status: RevisionStatus }>();
  if (same !== null) {
    return c.json({ status: same.status === "rejected" ? "rejected" : "unchanged", revisionId: same.id });
  }

  const current = await db
    .prepare("SELECT research_json FROM publications WHERE id = ?")
    .bind(publicationId)
    .first<{ research_json: string | null }>();
  const before = current?.research_json ? (JSON.parse(current.research_json) as ResearchPayload).file : null;
  const changes = diffResearch(before, file.value);

  const id = crypto.randomUUID();
  const gitSha = typeof body["git_sha"] === "string" ? body["git_sha"].slice(0, 64) : null;
  await db.batch([
    db
      .prepare("UPDATE research_revisions SET status = 'superseded' WHERE publication_id = ? AND status = 'pending'")
      .bind(publicationId),
    db
      .prepare(
        `INSERT INTO research_revisions (id, publication_id, payload_json, content_hash, changes_json, git_sha, proposed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, publicationId, payloadJson, hash, JSON.stringify(changes), gitSha, c.get("user").id),
  ]);
  return c.json({ status: "pending", revisionId: id }, 201);
});

researchRoutes.get("/revisions", async (c) => {
  const db = c.env.DB;
  const { results } = await db
    .prepare(
      `SELECT r.id, r.publication_id, r.proposed_at, r.git_sha, r.changes_json,
              json_extract(r.payload_json, '$.file.name') AS name,
              p.id AS existing_id, p.research_json IS NULL AS no_research
       FROM research_revisions r LEFT JOIN publications p ON p.id = r.publication_id
       WHERE r.status = 'pending'
       ORDER BY name`,
    )
    .all<{
      id: string;
      publication_id: string;
      proposed_at: string;
      git_sha: string | null;
      changes_json: string;
      name: string;
      existing_id: string | null;
      no_research: number;
    }>();

  const edits = await db.prepare("SELECT publication_id, field FROM publication_edits").all<{ publication_id: string; field: string }>();
  const editedFields = (publicationId: string) =>
    edits.results.filter((edit) => edit.publication_id === publicationId).map((edit) => edit.field);

  return c.json({
    revisions: results.map((row) => {
      const changes = JSON.parse(row.changes_json) as FieldChange[];
      return {
        id: row.id,
        publicationId: row.publication_id,
        name: row.name,
        isNew: row.existing_id === null,
        firstResearch: row.existing_id !== null && row.no_research === 1,
        proposedAt: row.proposed_at,
        gitSha: row.git_sha,
        changes,
        conflicts: conflictsWith(changes, editedFields(row.publication_id)),
      };
    }),
  });
});

interface RevisionRow {
  id: string;
  publication_id: string;
  status: RevisionStatus;
  payload_json: string;
  changes_json: string;
  proposed_at: string;
}

const loadRevision = (db: D1Database, id: string) =>
  db
    .prepare("SELECT id, publication_id, status, payload_json, changes_json, proposed_at FROM research_revisions WHERE id = ?")
    .bind(id)
    .first<RevisionRow>();

researchRoutes.get("/revisions/:id", async (c) => {
  const row = await loadRevision(c.env.DB, c.req.param("id"));
  if (row === null) return fail(c, 404, "NOT_FOUND", "No such research revision.");
  return c.json({
    id: row.id,
    publicationId: row.publication_id,
    status: row.status,
    proposedAt: row.proposed_at,
    payload: JSON.parse(row.payload_json) as ResearchPayload,
    changes: JSON.parse(row.changes_json) as FieldChange[],
  });
});

researchRoutes.post("/revisions/:id/approve", async (c) => {
  const db = c.env.DB;
  const row = await loadRevision(db, c.req.param("id"));
  if (row === null) return fail(c, 404, "NOT_FOUND", "No such research revision.");
  if (row.status !== "pending") {
    return fail(c, 409, "ILLEGAL_TRANSITION", "Only research waiting for approval can be approved.");
  }

  const payload = JSON.parse(row.payload_json) as ResearchPayload;
  const { columns, tags } = projectPublication(payload.file, payload.contacts);
  const user = c.get("user").id;
  const at = nowIso();
  const body: unknown = await c.req.json().catch(() => null);
  const note = isObject(body) && typeof body["note"] === "string" ? body["note"] : null;

  await db.batch([
    db
      .prepare(
        `INSERT INTO publications (id, name, tier, kind, method, submission_url, contact_email, spec_json,
           exclusivity_policy, counts_own_blog_as_published, typical_response_days, response_window_note,
           earned_or_paid, taste_notes, last_verified, active, research_json, research_revision_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, tier = excluded.tier, kind = excluded.kind, method = excluded.method,
           submission_url = excluded.submission_url, contact_email = excluded.contact_email,
           spec_json = excluded.spec_json, exclusivity_policy = excluded.exclusivity_policy,
           counts_own_blog_as_published = excluded.counts_own_blog_as_published,
           typical_response_days = excluded.typical_response_days,
           response_window_note = excluded.response_window_note, earned_or_paid = excluded.earned_or_paid,
           taste_notes = excluded.taste_notes, last_verified = excluded.last_verified, active = 1,
           research_json = excluded.research_json, research_revision_id = excluded.research_revision_id,
           updated_at = excluded.updated_at`,
      )
      .bind(
        columns.id,
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
        row.payload_json,
        row.id,
        at,
      ),
    db.prepare("DELETE FROM publication_tags WHERE publication_id = ? AND origin = 'research'").bind(columns.id),
    // OR IGNORE: a tag she added, or a research tag she removed, keeps its row.
    ...tags.map((tag) =>
      db
        .prepare("INSERT OR IGNORE INTO publication_tags (publication_id, tag_id, origin) VALUES (?, ?, 'research')")
        .bind(columns.id, tag),
    ),
    db
      .prepare("UPDATE research_revisions SET status = 'superseded' WHERE publication_id = ? AND status = 'approved'")
      .bind(columns.id),
    db
      .prepare("UPDATE research_revisions SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?")
      .bind(user, at, note, row.id),
    db
      .prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json) VALUES (?, ?, 'publication', ?, 'research_approved', ?)",
      )
      .bind(crypto.randomUUID(), user, columns.id, JSON.stringify({ revisionId: row.id, changes: (JSON.parse(row.changes_json) as unknown[]).length })),
  ]);

  return c.json({ publication: await loadPublication(db, columns.id) });
});

researchRoutes.post("/revisions/:id/reject", async (c) => {
  const db = c.env.DB;
  const row = await loadRevision(db, c.req.param("id"));
  if (row === null) return fail(c, 404, "NOT_FOUND", "No such research revision.");
  if (row.status !== "pending") {
    return fail(c, 409, "ILLEGAL_TRANSITION", "Only research waiting for approval can be turned down.");
  }
  const body: unknown = await c.req.json().catch(() => null);
  const note = isObject(body) && typeof body["note"] === "string" ? body["note"] : null;
  const user = c.get("user").id;
  await db.batch([
    db
      .prepare("UPDATE research_revisions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?")
      .bind(user, nowIso(), note, row.id),
    db
      .prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json) VALUES (?, ?, 'publication', ?, 'research_rejected', ?)",
      )
      .bind(crypto.randomUUID(), user, row.publication_id, JSON.stringify({ revisionId: row.id, note })),
  ]);
  return c.json({ id: row.id, status: "rejected" });
});
