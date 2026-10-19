import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../errors.js";
import { evaluateRightsGate } from "../domain/rights-gate.js";
import type { ConsentStatus, RightsGateResult, RightsStatus } from "../domain/rights-gate.js";
import { parsePublicationSpec } from "../domain/publication-spec.js";
import { evaluatePackage } from "../domain/package-checklist.js";
import type { PackageInput } from "../domain/package-checklist.js";
import { buildCreditsBlock, buildDescriptionDraft } from "../domain/package-draft.js";
import type { CreditRow } from "../domain/package-draft.js";
import type { D1Database } from "../env.js";
import type { SubmissionStatus } from "../domain/submission-status.js";

interface EventRow {
  id: string;
  couple_names: string;
  event_date: string;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  couple_story: string | null;
  unique_angle: string | null;
  name_display: string | null;
  consent_notes: string | null;
  rights_status: RightsStatus;
  consent_status: ConsentStatus;
}

interface PackageRow {
  id: string;
  event_id: string;
  publication_id: string;
  image_keys: string;
  description_md: string | null;
  credits_block_md: string | null;
  checklist_json: string;
  version: number;
  created_at: string;
}

function readJson<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** Only booleans survive; a stored checklist is client-influenced data. */
function readAttestations(raw: string): Record<string, boolean> {
  const parsed = readJson<Record<string, unknown>>(raw, {});
  const result: Record<string, boolean> = {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return result;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

/**
 * The one place a stored package becomes a checklist verdict. The single view
 * and the event's package list both go through here, so the list can never
 * call a package complete that the editor would not.
 */
function evaluationFor(
  pkg: PackageRow,
  event: Pick<EventRow, "name_display" | "consent_notes">,
  specJson: string,
) {
  const spec = parsePublicationSpec(specJson);

  const input: PackageInput = {
    imageKeys: readJson<string[]>(pkg.image_keys, []),
    descriptionMd: pkg.description_md,
    creditsBlockMd: pkg.credits_block_md,
    attestations: readAttestations(pkg.checklist_json),
  };

  const evaluation = evaluatePackage(spec, input, {
    nameDisplay: event.name_display,
    consentNotes: event.consent_notes,
  });

  return { spec, input, evaluation };
}

/**
 * Where the pairing stands in the submission lifecycle, so the editor and the
 * event page can show it without a second call. Looked up by the event and
 * publication pair, which is the submissions table's UNIQUE key, rather than
 * by package_id, which goes null if a package is ever removed.
 */
export interface PackageSubmission {
  id: string;
  status: SubmissionStatus;
  sentAt: string | null;
  responseDueAt: string | null;
}

export interface PackageSummary {
  id: string;
  publicationId: string;
  publicationName: string | null;
  version: number;
  complete: boolean;
  imageCount: number;
  createdAt: string;
  submission: PackageSubmission | null;
}

interface SubmissionColumns {
  submission_id: string | null;
  submission_status: SubmissionStatus | null;
  submission_sent_at: string | null;
  submission_response_due_at: string | null;
}

const SUBMISSION_COLUMNS = `submissions.id AS submission_id, submissions.status AS submission_status,
  submissions.sent_at AS submission_sent_at, submissions.response_due_at AS submission_response_due_at`;

function submissionOf(row: SubmissionColumns): PackageSubmission | null {
  if (row.submission_id === null || row.submission_status === null) return null;
  return {
    id: row.submission_id,
    status: row.submission_status,
    sentAt: row.submission_sent_at,
    responseDueAt: row.submission_response_due_at,
  };
}

/** Every package for an event, newest first; null when the event does not exist. */
export async function listEventPackages(
  db: D1Database,
  eventId: string,
): Promise<PackageSummary[] | null> {
  const event = await db
    .prepare("SELECT name_display, consent_notes FROM events WHERE id = ?")
    .bind(eventId)
    .first<Pick<EventRow, "name_display" | "consent_notes">>();
  if (event === null) return null;

  const { results } = await db
    .prepare(
      `SELECT packages.*, publications.name AS publication_name, publications.spec_json AS spec_json,
         ${SUBMISSION_COLUMNS}
       FROM packages
       LEFT JOIN publications ON publications.id = packages.publication_id
       LEFT JOIN submissions ON submissions.event_id = packages.event_id
         AND submissions.publication_id = packages.publication_id
       WHERE packages.event_id = ?
       ORDER BY packages.created_at DESC, packages.rowid DESC`,
    )
    .bind(eventId)
    .all<
      PackageRow & SubmissionColumns & { publication_name: string | null; spec_json: string | null }
    >();

  return results.map((row) => {
    const { input, evaluation } = evaluationFor(row, event, row.spec_json ?? "{}");
    return {
      id: row.id,
      publicationId: row.publication_id,
      publicationName: row.publication_name,
      version: row.version,
      complete: evaluation.complete,
      imageCount: input.imageKeys.length,
      // packages has no updated_at column; creation time is what exists.
      createdAt: row.created_at,
      submission: submissionOf(row),
    };
  });
}

async function viewFor(
  c: { env: AppContext["Bindings"] },
  pkg: PackageRow,
  event: EventRow,
) {
  const publication = await c.env.DB.prepare(
    "SELECT id, name, tier, method, submission_url, spec_json FROM publications WHERE id = ?",
  )
    .bind(pkg.publication_id)
    .first<{
      id: string;
      name: string;
      tier: string;
      method: string | null;
      submission_url: string | null;
      spec_json: string;
    }>();

  const { spec, input, evaluation } = evaluationFor(pkg, event, publication?.spec_json ?? "{}");

  const submission = await c.env.DB.prepare(
    `SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE event_id = ? AND publication_id = ?`,
  )
    .bind(pkg.event_id, pkg.publication_id)
    .first<SubmissionColumns>();

  return {
    id: pkg.id,
    eventId: pkg.event_id,
    publicationId: pkg.publication_id,
    publication:
      publication === null
        ? null
        : {
            id: publication.id,
            name: publication.name,
            tier: publication.tier,
            method: publication.method,
            submissionUrl: publication.submission_url,
            spec,
          },
    imageKeys: input.imageKeys,
    descriptionMd: input.descriptionMd,
    creditsBlockMd: input.creditsBlockMd,
    version: pkg.version,
    createdAt: pkg.created_at,
    // The couple's limits travel with the package so the editor can show them
    // beside the copy being written, not buried on the event record.
    consent: {
      nameDisplay: event.name_display,
      consentNotes: event.consent_notes,
    },
    checklist: evaluation.items,
    complete: evaluation.complete,
    missing: evaluation.missing,
    submission: submission === null ? null : submissionOf(submission),
  };
}

const EVENT_COLUMNS = `id, couple_names, event_date, venue_name, city, state, country,
  couple_story, unique_angle, name_display, consent_notes, rights_status, consent_status`;

export const packageRoutes = new Hono<AppContext>();

packageRoutes.use("*", requireAuth);

packageRoutes.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "VALIDATION", "Expected a JSON body.");
  }

  const source = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const eventId = source["eventId"];
  const publicationId = source["publicationId"];

  if (typeof eventId !== "string" || typeof publicationId !== "string") {
    return fail(c, 400, "VALIDATION", "Both eventId and publicationId are required.");
  }

  const event = await c.env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`)
    .bind(eventId)
    .first<EventRow>();
  if (event === null) return fail(c, 404, "NOT_FOUND", "No such event.");

  const publication = await c.env.DB.prepare(
    "SELECT id, active FROM publications WHERE id = ?",
  )
    .bind(publicationId)
    .first<{ id: string; active: number }>();
  if (publication === null) return fail(c, 404, "NOT_FOUND", "No such publication.");
  if (publication.active !== 1) {
    return fail(c, 400, "VALIDATION", "That publication is no longer active.");
  }

  const gate = evaluateRightsGate({
    rightsStatus: event.rights_status,
    consentStatus: event.consent_status,
  });
  if (!gate.allowed) {
    return fail(c, 403, "RIGHTS_BLOCKED", "This event cannot be packaged yet.", gate.reasons);
  }

  // DECISION: one package per pairing in Phase 1. Asking again returns what
  // exists rather than creating a second, because two packages for the same
  // pairing is a bug the UI would have to resolve, and the version column is
  // there for deliberate regeneration once Phase 1 has a reason to bump it.
  const existing = await c.env.DB.prepare(
    "SELECT * FROM packages WHERE event_id = ? AND publication_id = ? ORDER BY version DESC",
  )
    .bind(eventId, publicationId)
    .first<PackageRow>();

  if (existing !== null) return c.json(await viewFor(c, existing, event), 200);

  const { results: credits } = await c.env.DB.prepare(
    "SELECT role, business_name, website, instagram FROM vendor_credits WHERE event_id = ? ORDER BY sort_order",
  )
    .bind(eventId)
    .all<{ role: string; business_name: string; website: string | null; instagram: string | null }>();

  const creditRows: CreditRow[] = credits.map((row) => ({
    role: row.role,
    businessName: row.business_name,
    website: row.website,
    instagram: row.instagram,
  }));

  const id = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO packages (id, event_id, publication_id, image_keys, description_md, credits_block_md, checklist_json, version)
         VALUES (?, ?, ?, '[]', ?, ?, '{}', 1)`,
      )
      .bind(
        id,
        eventId,
        publicationId,
        buildDescriptionDraft({
          coupleNames: event.couple_names,
          eventDate: event.event_date,
          venueName: event.venue_name,
          city: event.city,
          state: event.state,
          country: event.country,
          coupleStory: event.couple_story,
          uniqueAngle: event.unique_angle,
        }),
        buildCreditsBlock(creditRows),
      ),
    c.env.DB
      .prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action) VALUES (?, ?, 'package', ?, 'create')",
      )
      .bind(crypto.randomUUID(), c.get("user").id, id),
  ]);

  const created = await c.env.DB.prepare("SELECT * FROM packages WHERE id = ?")
    .bind(id)
    .first<PackageRow>();
  if (created === null) return fail(c, 500, "INTERNAL", "The package could not be read back.");

  return c.json(await viewFor(c, created, event), 201);
});

async function loadPair(
  c: { env: AppContext["Bindings"] },
  packageId: string,
): Promise<{ pkg: PackageRow; event: EventRow } | null> {
  const pkg = await c.env.DB.prepare("SELECT * FROM packages WHERE id = ?")
    .bind(packageId)
    .first<PackageRow>();
  if (pkg === null) return null;

  const event = await c.env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`)
    .bind(pkg.event_id)
    .first<EventRow>();
  if (event === null) return null;

  return { pkg, event };
}

/**
 * Everything a submission is gated on, read fresh from the stored package, its
 * event and its publication. The client's opinion of completeness never enters
 * into it. Null when any of the three is gone.
 */
export interface PackageVerdict {
  packageId: string;
  eventId: string;
  publicationId: string;
  gate: RightsGateResult;
  publicationActive: boolean;
  complete: boolean;
  missing: string[];
}

export async function packageVerdict(
  c: { env: AppContext["Bindings"] },
  packageId: string,
): Promise<PackageVerdict | null> {
  const found = await loadPair(c, packageId);
  if (found === null) return null;

  const publication = await c.env.DB.prepare(
    "SELECT active, spec_json FROM publications WHERE id = ?",
  )
    .bind(found.pkg.publication_id)
    .first<{ active: number; spec_json: string }>();
  if (publication === null) return null;

  const { evaluation } = evaluationFor(found.pkg, found.event, publication.spec_json);

  return {
    packageId: found.pkg.id,
    eventId: found.pkg.event_id,
    publicationId: found.pkg.publication_id,
    gate: evaluateRightsGate({
      rightsStatus: found.event.rights_status,
      consentStatus: found.event.consent_status,
    }),
    publicationActive: publication.active === 1,
    complete: evaluation.complete,
    missing: evaluation.missing,
  };
}

packageRoutes.get("/:id", async (c) => {
  const found = await loadPair(c, c.req.param("id"));
  if (found === null) return fail(c, 404, "NOT_FOUND", "No such package.");
  return c.json(await viewFor(c, found.pkg, found.event));
});

packageRoutes.patch("/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "VALIDATION", "Expected a JSON body.");
  }

  const found = await loadPair(c, c.req.param("id"));
  if (found === null) return fail(c, 404, "NOT_FOUND", "No such package.");

  const source = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const errors: Array<{ field: string; message: string }> = [];

  let imageKeys = readJson<string[]>(found.pkg.image_keys, []);
  if (source["imageKeys"] !== undefined) {
    const value = source["imageKeys"];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      errors.push({ field: "imageKeys", message: "Expected a list of image keys." });
    } else {
      const keys = value as string[];
      // Keys are minted by the image route against this event. Accepting a
      // key from anywhere else would let one event's package reference
      // another's images.
      const foreign = keys.filter((key) => !key.startsWith(`events/${found.pkg.event_id}/`));
      if (foreign.length > 0) {
        errors.push({ field: "imageKeys", message: "Those images belong to another event." });
      } else if (new Set(keys).size !== keys.length) {
        errors.push({ field: "imageKeys", message: "The same image is selected twice." });
      } else {
        imageKeys = keys;
      }
    }
  }

  const readText = (field: string, current: string | null): string | null => {
    const value = source[field];
    if (value === undefined) return current;
    if (value === null) return null;
    if (typeof value !== "string") {
      errors.push({ field, message: "Expected text." });
      return current;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const descriptionMd = readText("descriptionMd", found.pkg.description_md);
  const creditsBlockMd = readText("creditsBlockMd", found.pkg.credits_block_md);

  let attestations = readAttestations(found.pkg.checklist_json);
  if (source["attestations"] !== undefined) {
    const value = source["attestations"];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push({ field: "attestations", message: "Expected an object of checklist states." });
    } else {
      const next: Record<string, boolean> = {};
      for (const [key, checked] of Object.entries(value as Record<string, unknown>)) {
        if (typeof checked !== "boolean") {
          errors.push({ field: `attestations.${key}`, message: "Expected true or false." });
        } else if (checked) {
          // Only ticked items are stored; an unticked box is the absence of an
          // attestation, not a recorded denial.
          next[key] = true;
        }
      }
      attestations = next;
    }
  }

  if (errors.length > 0) {
    return fail(c, 400, "VALIDATION", "Some fields need attention.", errors);
  }

  await c.env.DB.batch([
    c.env.DB
      .prepare(
        "UPDATE packages SET image_keys = ?, description_md = ?, credits_block_md = ?, checklist_json = ? WHERE id = ?",
      )
      .bind(
        JSON.stringify(imageKeys),
        descriptionMd,
        creditsBlockMd,
        JSON.stringify(attestations),
        found.pkg.id,
      ),
    c.env.DB
      .prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action) VALUES (?, ?, 'package', ?, 'update')",
      )
      .bind(crypto.randomUUID(), c.get("user").id, found.pkg.id),
  ]);

  const updated = await c.env.DB.prepare("SELECT * FROM packages WHERE id = ?")
    .bind(found.pkg.id)
    .first<PackageRow>();
  if (updated === null) return fail(c, 500, "INTERNAL", "The package could not be read back.");

  return c.json(await viewFor(c, updated, found.event));
});
