import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../errors.js";
import type { ErrorCode } from "../errors.js";
import { SUBMISSION_STATUSES, evaluateTransition } from "../domain/submission-status.js";
import type { SubmissionStatus } from "../domain/submission-status.js";
import type { D1Database } from "../env.js";
import { packageVerdict } from "./packages.js";
import type { PackageVerdict } from "./packages.js";

/**
 * The send queue -- design doc sections 6.2 and 7.4.
 *
 * Nothing here transmits anything to a publication. "Sent" records that a
 * person sent the package themselves, through the outlet's own form, portal or
 * inbox; this route only writes that fact down, with the time and who.
 */

interface SubmissionRow {
  id: string;
  event_id: string;
  publication_id: string;
  status: SubmissionStatus;
  package_id: string | null;
  queued_at: string | null;
  sent_at: string | null;
  sent_by: string | null;
  response_due_at: string | null;
  outcome_at: string | null;
  outcome_notes: string | null;
  published_url: string | null;
  created_at: string;
  updated_at: string;
}

type ViewRow = SubmissionRow & { couple_names: string; publication_name: string };

const DAY_MS = 86_400_000;

/** ISO-8601 UTC to the second: the same shape the schema's defaults write. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Calendar days (UTC) from today to the due date. A 15-day window reads 15 on
 * the day it was sent and 14 the next day, which is how a person counts it;
 * elapsed hours on the sending day do not shave a day off. It is 0 on the due
 * day and negative once that day has passed.
 */
function daysRemaining(dueAt: string | null, nowMs: number): number | null {
  if (dueAt === null) return null;
  return Math.floor(Date.parse(dueAt) / DAY_MS) - Math.floor(nowMs / DAY_MS);
}

function toView(row: ViewRow, nowMs: number) {
  return {
    id: row.id,
    eventId: row.event_id,
    coupleNames: row.couple_names,
    publicationId: row.publication_id,
    publicationName: row.publication_name,
    status: row.status,
    packageId: row.package_id,
    queuedAt: row.queued_at,
    sentAt: row.sent_at,
    responseDueAt: row.response_due_at,
    outcomeAt: row.outcome_at,
    outcomeNotes: row.outcome_notes,
    publishedUrl: row.published_url,
    // Null with no due date: either not sent yet, or the outlet publishes no
    // typical response time and the window is unknown.
    daysRemaining: daysRemaining(row.response_due_at, nowMs),
  };
}

const SELECT_VIEW = `SELECT submissions.*, events.couple_names AS couple_names,
    publications.name AS publication_name
  FROM submissions
  JOIN events ON events.id = submissions.event_id
  JOIN publications ON publications.id = submissions.publication_id`;

/**
 * Live first, soonest due first with an unknown window last; then the send
 * queue, oldest first; then everything finished, most recently touched first.
 */
const QUEUE_ORDER = `ORDER BY
  CASE submissions.status WHEN 'sent' THEN 0 WHEN 'ready' THEN 1 WHEN 'queued' THEN 1 ELSE 2 END,
  CASE WHEN submissions.status = 'sent' THEN submissions.response_due_at IS NULL END,
  CASE WHEN submissions.status = 'sent' THEN submissions.response_due_at END,
  CASE WHEN submissions.status IN ('ready', 'queued') THEN submissions.created_at END,
  CASE WHEN submissions.status NOT IN ('sent', 'ready', 'queued') THEN submissions.updated_at END DESC,
  submissions.rowid`;

async function loadView(db: D1Database, id: string, nowMs: number) {
  const row = await db
    .prepare(`${SELECT_VIEW} WHERE submissions.id = ?`)
    .bind(id)
    .first<ViewRow>();
  return row === null ? null : toView(row, nowMs);
}

interface Refusal {
  status: 400 | 403 | 422;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * The gates a submission passes when it is created, and again on every move
 * towards the outlet. In the order a person would fix them: rights, then the
 * checklist, then the outlet itself.
 */
function refusalFor(verdict: PackageVerdict): Refusal | null {
  if (!verdict.gate.allowed) {
    return {
      status: 403,
      code: "RIGHTS_BLOCKED",
      message: "This event cannot be submitted.",
      details: verdict.gate.reasons,
    };
  }
  if (!verdict.complete) {
    return {
      status: 422,
      code: "PACKAGE_INCOMPLETE",
      message: "The package is not complete. Finish its checklist first.",
      details: { missing: verdict.missing },
    };
  }
  if (!verdict.publicationActive) {
    return { status: 400, code: "VALIDATION", message: "That publication is no longer active." };
  }
  return null;
}

/** Outcomes the outlet gave, or failed to give. Only these carry notes. */
const OUTCOMES: ReadonlySet<SubmissionStatus> = new Set(["accepted", "declined", "expired"]);

/** Ways out of the lifecycle. Each stamps outcome_at only if nothing has yet. */
const EXITS: ReadonlySet<SubmissionStatus> = new Set(["withdraw_pending", "withdrawn", "cancelled"]);

const isStatus = (value: unknown): value is SubmissionStatus =>
  typeof value === "string" && (SUBMISSION_STATUSES as readonly string[]).includes(value);

/** An http or https address, trimmed; anything else (javascript:, mailto:) is null. */
function webUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? trimmed : null;
  } catch {
    return null;
  }
}

async function readBody(c: { req: { json(): Promise<unknown> } }) {
  try {
    const body: unknown = await c.req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

export const submissionRoutes = new Hono<AppContext>();

submissionRoutes.use("*", requireAuth);

submissionRoutes.post("/", async (c) => {
  const source = await readBody(c);
  if (source === null) return fail(c, 400, "VALIDATION", "Expected a JSON body.");

  const packageId = source["packageId"];
  if (typeof packageId !== "string" || packageId === "") {
    return fail(c, 400, "VALIDATION", "A packageId is required.");
  }

  const verdict = await packageVerdict(c, packageId);
  if (verdict === null) return fail(c, 404, "NOT_FOUND", "No such package.");

  const refused = refusalFor(verdict);
  if (refused !== null) {
    return fail(c, refused.status, refused.code, refused.message, refused.details);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM submissions WHERE event_id = ? AND publication_id = ?",
  )
    .bind(verdict.eventId, verdict.publicationId)
    .first<{ id: string }>();
  if (existing !== null) {
    return fail(
      c,
      409,
      "SUBMISSION_EXISTS",
      "A submission already exists for this event and publication.",
      { submissionId: existing.id },
    );
  }

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const now = isoSeconds(nowMs);

  // DECISION: a submission is born `ready`, never `draft`. The only thing
  // draft meant was "the package is not complete yet", and the package already
  // carries that verdict; a submission exists only once the gates above pass.
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO submissions (id, event_id, publication_id, status, package_id, created_at, updated_at)
         VALUES (?, ?, ?, 'ready', ?, ?, ?)`,
      )
      .bind(id, verdict.eventId, verdict.publicationId, verdict.packageId, now, now),
    c.env.DB
      .prepare(
        `INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json)
         VALUES (?, ?, 'submission', ?, 'create', ?)`,
      )
      .bind(crypto.randomUUID(), c.get("user").id, id, JSON.stringify({ packageId: verdict.packageId })),
  ]);

  const view = await loadView(c.env.DB, id, nowMs);
  if (view === null) return fail(c, 500, "INTERNAL", "The submission could not be read back.");
  return c.json(view, 201);
});

submissionRoutes.get("/", async (c) => {
  const eventId = c.req.query("eventId");
  const statement =
    eventId === undefined
      ? c.env.DB.prepare(`${SELECT_VIEW} ${QUEUE_ORDER}`)
      : c.env.DB.prepare(`${SELECT_VIEW} WHERE submissions.event_id = ? ${QUEUE_ORDER}`).bind(eventId);

  const { results } = await statement.all<ViewRow>();
  const nowMs = Date.now();
  return c.json({ submissions: results.map((row) => toView(row, nowMs)) });
});

submissionRoutes.get("/:id", async (c) => {
  const view = await loadView(c.env.DB, c.req.param("id"), Date.now());
  if (view === null) return fail(c, 404, "NOT_FOUND", "No such submission.");
  return c.json(view);
});

submissionRoutes.patch("/:id", async (c) => {
  const source = await readBody(c);
  if (source === null) return fail(c, 400, "VALIDATION", "Expected a JSON body.");

  const current = await c.env.DB.prepare("SELECT * FROM submissions WHERE id = ?")
    .bind(c.req.param("id"))
    .first<SubmissionRow>();
  if (current === null) return fail(c, 404, "NOT_FOUND", "No such submission.");

  const to = source["status"];
  if (!isStatus(to)) {
    return fail(c, 400, "VALIDATION", "Some fields need attention.", [
      { field: "status", message: "Expected a submission status." },
    ]);
  }

  const transition = evaluateTransition(current.status, to);
  if (!transition.ok) {
    return fail(
      c,
      409,
      "ILLEGAL_TRANSITION",
      `A ${current.status} submission cannot move to ${to}.`,
      { from: transition.from, to: transition.to, allowed: transition.allowed },
    );
  }

  const errors: Array<{ field: string; message: string }> = [];

  const notes = source["outcomeNotes"];
  if (notes !== undefined && notes !== null) {
    if (typeof notes !== "string") {
      errors.push({ field: "outcomeNotes", message: "Expected text." });
    } else if (!OUTCOMES.has(to)) {
      errors.push({
        field: "outcomeNotes",
        message: "Notes are recorded with an outcome: accepted, declined or expired.",
      });
    }
  }

  const rawUrl = source["publishedUrl"];
  const publishedUrl = webUrl(rawUrl);
  if (to === "published" && publishedUrl === null) {
    errors.push({ field: "publishedUrl", message: "Add the web address where the feature ran." });
  } else if (to !== "published" && rawUrl !== undefined && rawUrl !== null) {
    errors.push({
      field: "publishedUrl",
      message: "A published address is recorded only when marking a feature published.",
    });
  }

  if (errors.length > 0) {
    return fail(c, 400, "VALIDATION", "Some fields need attention.", errors);
  }

  if (to === "queued" || to === "sent") {
    // DECISION: moving towards the outlet re-runs the creation gates. The
    // event record and the package both stay editable after the submission
    // exists, so consent withdrawn or a checklist undone since then has to
    // stop the send here. Outcomes and exits are not gated: what the outlet
    // said, or a cancel, must always be recordable.
    const verdict =
      current.package_id === null ? null : await packageVerdict(c, current.package_id);
    if (verdict === null) {
      return fail(c, 422, "PACKAGE_INCOMPLETE", "This submission has no package to send.", {
        missing: ["package"],
      });
    }
    const refused = refusalFor(verdict);
    if (refused !== null) {
      return fail(c, refused.status, refused.code, refused.message, refused.details);
    }
  }

  if (to === "sent") {
    // DECISION: this is the Phase 1 floor of the exclusivity ledger (design
    // doc section 6.3), not the ledger itself. The policy-aware locks
    // (exclusive_required hard locks, exclusive_preferred overrides with a
    // logged reason) are Phase 2. This one rule exists now because the
    // product rule "one publication at a time per event" predates the ledger:
    // an event already live at one outlet is not recorded as sent to another.
    const live = await c.env.DB.prepare(
      `SELECT submissions.id, publications.name AS publication_name
       FROM submissions JOIN publications ON publications.id = submissions.publication_id
       WHERE submissions.event_id = ? AND submissions.status = 'sent' AND submissions.id != ?`,
    )
      .bind(current.event_id, current.id)
      .first<{ id: string; publication_name: string }>();
    if (live !== null) {
      return fail(
        c,
        409,
        "EVENT_HAS_LIVE_SUBMISSION",
        `This event is already live at ${live.publication_name}. Record that outlet's answer before marking another one sent.`,
        { submissionId: live.id },
      );
    }
  }

  const nowMs = Date.now();
  const now = isoSeconds(nowMs);
  const next = {
    queued_at: current.queued_at,
    sent_at: current.sent_at,
    sent_by: current.sent_by,
    response_due_at: current.response_due_at,
    outcome_at: current.outcome_at,
    outcome_notes: current.outcome_notes,
    published_url: current.published_url,
  };

  if (to === "queued") next.queued_at = now;

  if (to === "sent") {
    // Server time and the authenticated caller, never anything the client sent.
    next.sent_at = now;
    next.sent_by = c.get("user").id;
    const publication = await c.env.DB.prepare(
      "SELECT typical_response_days FROM publications WHERE id = ?",
    )
      .bind(current.publication_id)
      .first<{ typical_response_days: number | null }>();
    const days = publication?.typical_response_days ?? null;
    next.response_due_at = days === null ? null : isoSeconds(nowMs + days * DAY_MS);
  }

  if (OUTCOMES.has(to)) {
    next.outcome_at = now;
    if (typeof notes === "string") {
      const trimmed = notes.trim();
      next.outcome_notes = trimmed === "" ? null : trimmed;
    }
  }

  if (to === "published") next.published_url = publishedUrl;

  if (EXITS.has(to)) next.outcome_at = current.outcome_at ?? now;

  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE submissions SET status = ?, queued_at = ?, sent_at = ?, sent_by = ?,
           response_due_at = ?, outcome_at = ?, outcome_notes = ?, published_url = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        to,
        next.queued_at,
        next.sent_at,
        next.sent_by,
        next.response_due_at,
        next.outcome_at,
        next.outcome_notes,
        next.published_url,
        now,
        current.id,
      ),
    c.env.DB
      .prepare(
        `INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json)
         VALUES (?, ?, 'submission', ?, 'transition', ?)`,
      )
      .bind(
        crypto.randomUUID(),
        c.get("user").id,
        current.id,
        JSON.stringify({ from: current.status, to }),
      ),
  ]);

  const view = await loadView(c.env.DB, current.id, nowMs);
  if (view === null) return fail(c, 500, "INTERNAL", "The submission could not be read back.");
  return c.json(view);
});
