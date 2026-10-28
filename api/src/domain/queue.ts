/**
 * Her running order of outlets for one wedding (SUMMIT-344 slice 5), and
 * where each stands. Design doc 7.3 and 7.4: one outlet holds a wedding at a
 * time and she picks the order. This module only reads that order against
 * the packages and submissions the tool already keeps; the submissions table
 * stays the record of what was sent.
 *
 * Pure: no database, no clock, no network.
 */

import type { FieldError } from "./event-intake.js";
import type { SubmissionStatus } from "./submission-status.js";

export const QUEUE_MAX = 10;

/** Answers that free the wedding for the next outlet in the order. */
const RELEASED: ReadonlySet<SubmissionStatus> = new Set(["declined", "withdrawn", "cancelled"]);
/** Answers that place the wedding; the order is finished. */
const PLACED: ReadonlySet<SubmissionStatus> = new Set(["accepted", "published"]);

/** Outlet ids, each once, at least one and at most QUEUE_MAX. */
export function validateQueue(raw: unknown): { ok: true; value: string[] } | { ok: false; errors: FieldError[] } {
  const list = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>)["publicationIds"] : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, errors: [{ field: "publicationIds", message: "Give the outlets in the order to try them." }] };
  }
  if (list.length > QUEUE_MAX) {
    return { ok: false, errors: [{ field: "publicationIds", message: `Keep the order to ${QUEUE_MAX} outlets or fewer.` }] };
  }
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  list.forEach((id: unknown, index) => {
    if (typeof id !== "string" || id.trim() === "") errors.push({ field: `publicationIds.${index}`, message: "Expected an outlet id." });
    else if (seen.has(id)) errors.push({ field: `publicationIds.${index}`, message: `Listed twice: ${id}.` });
    else seen.add(id);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: list as string[] };
}

export type QueueState = "no_package" | "package_incomplete" | "package_complete" | SubmissionStatus;

const STATE_WORDS: Record<QueueState, string> = {
  no_package: "no package yet",
  package_incomplete: "package started, not complete",
  package_complete: "package complete",
  draft: "package started, not complete",
  ready: "ready to send",
  queued: "waiting to be sent",
  sent: "with the outlet",
  accepted: "accepted",
  published: "published",
  declined: "declined; the wedding is free again",
  expired: "no reply in time; withdraw it to move on",
  withdraw_pending: "withdrawal asked for",
  withdrawn: "withdrawn; the wedding is free again",
  cancelled: "cancelled before sending",
};

export interface QueueEntry {
  position: number;
  publicationId: string;
  name: string;
  state: QueueState;
  words: string;
  /** The package for this outlet, when there is one. */
  packageId: string | null;
}

export interface QueuedPackage {
  id: string;
  publicationId: string;
  complete: boolean;
  submission: { status: SubmissionStatus } | null;
}

/**
 * The order with each outlet's state, and the outlet up next: the first one
 * that has not released the wedding. When that one accepted or published it,
 * the wedding is placed and nothing is up next.
 */
export function queueView(order: ReadonlyArray<{ publicationId: string; name: string }>, packages: readonly QueuedPackage[]) {
  const byOutlet = new Map(packages.map((pkg) => [pkg.publicationId, pkg]));
  const entries: QueueEntry[] = order.map((outlet, index) => {
    const pkg = byOutlet.get(outlet.publicationId);
    const state: QueueState =
      pkg === undefined ? "no_package" : pkg.submission !== null ? pkg.submission.status : pkg.complete ? "package_complete" : "package_incomplete";
    return { position: index + 1, publicationId: outlet.publicationId, name: outlet.name, state, words: STATE_WORDS[state], packageId: pkg?.id ?? null };
  });
  const open = entries.find((entry) => !RELEASED.has(entry.state as SubmissionStatus)) ?? null;
  const placed = open !== null && PLACED.has(open.state as SubmissionStatus) ? open : null;
  return { entries, upNext: placed === null ? open : null, placed };
}

/** What she or Claude does next for the outlet up next, in one sentence. */
export function queueNext(view: ReturnType<typeof queueView>): string {
  if (view.placed !== null) return `The wedding is placed with ${view.placed.name}; nothing else in the order is needed.`;
  const next = view.upNext;
  if (next === null) {
    return view.entries.length === 0
      ? "There is no order yet. Rank the outlets and set one with set_queue."
      : "Every outlet in the order has released the wedding. Rank again and set a new order.";
  }
  switch (next.state) {
    case "no_package":
      return `Build the package for ${next.name} with build_package_draft.`;
    case "package_incomplete":
    case "draft":
      return `Finish the package for ${next.name} with build_package_draft; it lists what is left.`;
    case "package_complete":
      return `The package for ${next.name} is complete; set_queue readies it.`;
    case "ready":
    case "queued":
      return `Ready to send to ${next.name}. She sends it herself through the outlet's own route, then marks it sent in the studio.`;
    case "sent":
      return `With ${next.name}; wait for its answer before the next outlet.`;
    case "expired":
      return `${next.name} did not answer in time. Withdraw it in the studio to move to the next outlet.`;
    default:
      return `Waiting for ${next.name} to confirm the withdrawal.`;
  }
}
