/**
 * Submission lifecycle - design doc section 6.2.
 *
 *   draft -> ready -> queued -> sent -> accepted -> published
 *                                |       -> declined  (wedding released)
 *                                |       -> expired
 *                                |            -> withdraw_pending -> withdrawn
 *                                -> cancelled (pre-send only)
 *
 * Pure transition rules. The API layer is the enforcement point; the SPA is
 * untrusted and may not skip a step.
 */

export const SUBMISSION_STATUSES = [
  "draft",
  "ready",
  "queued",
  "sent",
  "accepted",
  "published",
  "declined",
  "expired",
  "withdraw_pending",
  "withdrawn",
  "cancelled",
] as const;

export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/**
 * DECISION: the design doc's ASCII diagram leaves three things ambiguous.
 * Resolved deliberately restrictive here - an absent transition surfaces as a
 * caught error, whereas an invented one is an unenforced rule.
 *
 * 1. `cancelled` is reachable only pre-send (draft, ready, queued). After a
 *    send the outlet is holding the submission, so the exit is the withdrawal
 *    path (section 6.2's expiry workflow), never a silent cancel.
 * 2. No backwards edges. In particular `ready -> draft` (de-ready a package
 *    after a curation edit) is deliberately excluded until Phase 1 defines
 *    package editing; add it there with its own tests.
 * 3. `expired -> declined` is excluded. An outlet that never answered has not
 *    declined; the record stays honest and routes through withdrawal.
 */
const TRANSITIONS: Readonly<Record<SubmissionStatus, readonly SubmissionStatus[]>> = {
  draft: ["ready", "cancelled"],
  ready: ["queued", "cancelled"],
  queued: ["sent", "cancelled"],
  sent: ["accepted", "declined", "expired"],
  accepted: ["published"],
  published: [],
  declined: [],
  expired: ["withdraw_pending"],
  withdraw_pending: ["withdrawn"],
  withdrawn: [],
  cancelled: [],
};

/** Statuses with no outbound transitions. */
export const TERMINAL_STATUSES = SUBMISSION_STATUSES.filter(
  (status) => TRANSITIONS[status].length === 0,
);

/**
 * Statuses that free the wedding for a different publication. `expired` and
 * `withdraw_pending` are excluded on purpose: the outlet still holds the
 * submission until the withdrawal note actually goes out (section 6.3).
 */
const RELEASING_STATUSES: ReadonlySet<SubmissionStatus> = new Set([
  "declined",
  "withdrawn",
  "cancelled",
]);

export function allowedTransitions(from: SubmissionStatus): readonly SubmissionStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: SubmissionStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function releasesEvent(status: SubmissionStatus): boolean {
  return RELEASING_STATUSES.has(status);
}

export type TransitionResult =
  | { ok: true }
  | {
      ok: false;
      code: "INVALID_TRANSITION";
      from: SubmissionStatus;
      to: SubmissionStatus;
      allowed: readonly SubmissionStatus[];
    };

export function evaluateTransition(
  from: SubmissionStatus,
  to: SubmissionStatus,
): TransitionResult {
  if (canTransition(from, to)) return { ok: true };
  return { ok: false, code: "INVALID_TRANSITION", from, to, allowed: TRANSITIONS[from] };
}
