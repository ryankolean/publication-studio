/**
 * The guided submission wizard: one screen per task, in a fixed order, from
 * the wedding's details to the outlet's reply.
 *
 * The server decides which screens are finished and where the photographer
 * picks up again; the SPA only renders that. Every verdict here is read from
 * the same sources the walkthrough uses (evaluateIntake, the rights gate,
 * outletFit, the package checklist, the submission lifecycle), so the wizard
 * can never call a step done that the gates behind it would refuse.
 *
 * Pure: no database, no clock. Days remaining arrive precomputed.
 */

import { evaluateRightsGate } from "./rights-gate.js";
import type { RightsGateInput, RightsGateReasonCode } from "./rights-gate.js";
import type { SubmissionStatus } from "./submission-status.js";
import {
  evaluateIntake,
  isAnswered,
  isSentOrLater,
  outletFit,
  silenceMeansPass,
} from "./walkthrough.js";
import type {
  OutletWarning,
  WalkthroughEvent,
  WalkthroughOutlet,
  WalkthroughSubmission,
} from "./walkthrough.js";

/** The screens after a wedding is chosen. "start" (choosing it) is not one. */
export const WIZARD_STEPS = [
  "wedding",
  "permissions",
  "story",
  "outlet",
  "photos",
  "writeup",
  "confirm",
  "review",
  "send",
  "track",
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

/** The package the wizard is following, reduced to the verdicts it reads. */
export interface WizardPackage {
  id: string;
  outlet: WalkthroughOutlet;
  /** The checklist's image items (at least one, and within the outlet's count). */
  imagesReady: boolean;
  /** The write-up and the credits both have text. */
  writeupReady: boolean;
  /** The whole checklist, as the package editor computes it. */
  complete: boolean;
  submission: WalkthroughSubmission | null;
}

export interface WizardInput {
  event: WalkthroughEvent;
  vendorCreditCount: number;
  /** Null until an outlet is chosen. */
  followed: WizardPackage | null;
  /** Outlets where another of this event's packages is sent and unanswered. */
  liveElsewhere: string[];
}

export interface Wizard {
  /** Where to pick up: the first step not done, or track once all are. */
  step: WizardStep;
  /** The outlet has answered (or the window closed): nothing is left to do. */
  finished: boolean;
  packageId: string | null;
  steps: Array<{ id: WizardStep; done: boolean }>;
  /** A screen that cannot be passed, and why, in plain words. */
  blocked: { step: "outlet" | "send"; reasons: string[] } | null;
  outlet: {
    id: string;
    name: string;
    method: WalkthroughOutlet["method"];
    submissionUrl: string | null;
    typicalResponseDays: number | null;
    warnings: OutletWarning[];
  } | null;
  submission: WalkthroughSubmission | null;
  /** Null until sent. */
  reply: {
    dueAt: string | null;
    daysRemaining: number | null;
    /** The outlet's own words about its replies, quoted as stored. */
    outletWords: string | null;
    /** Null when the outlet says nothing; otherwise whether silence is a pass. */
    silenceMeansPass: boolean | null;
  } | null;
}

/**
 * The rights gate's reasons, said to the photographer rather than about her.
 * `short` fits a chip on the wedding card; `long` is what the outlet screen
 * says when it stops.
 */
const GATE_WORDS: Record<RightsGateReasonCode, { short: string; long: string }> = {
  RIGHTS_UNVERIFIED: {
    short: "your contract is not confirmed",
    long: "Confirm you were the lead photographer, under your own contract.",
  },
  RIGHTS_SECOND_SHOOTER: {
    short: "second-shooter wedding",
    long: "Second-shooter weddings cannot be submitted under your name.",
  },
  RIGHTS_BLOCKED_FLAG: {
    short: "marked blocked",
    long: "This wedding is marked blocked. Sort out who holds the rights before changing that.",
  },
  CONSENT_UNVERIFIED: {
    short: "the couple has not agreed yet",
    long: "The couple has not agreed to a submission yet. Ask them, then record their answer.",
  },
  CONSENT_DECLINED: {
    short: "the couple said no",
    long: "The couple said no. It cannot be submitted unless they change their answer in writing.",
  },
};

function gateCodes(input: RightsGateInput): RightsGateReasonCode[] {
  const gate = evaluateRightsGate(input);
  return gate.allowed ? [] : gate.reasons.map((reason) => reason.code);
}

/** Why the gate is closed, in plain words; empty when it is open. */
export function gateWords(input: RightsGateInput): string[] {
  return gateCodes(input).map((code) => GATE_WORDS[code].long);
}

export type ChipKind = "ready" | "needs_details" | "blocked";

/**
 * The chip on a wedding card: blocked first (nothing else matters until the
 * gate opens), then any detail an outlet asks for, else ready.
 */
export function weddingChip(
  event: Pick<
    WalkthroughEvent,
    | "coupleNames"
    | "eventDate"
    | "venueName"
    | "city"
    | "hasGalleryUrl"
    | "coupleStory"
    | "uniqueAngle"
    | "rightsStatus"
    | "consentStatus"
  >,
  vendorCreditCount: number,
): { kind: ChipKind; label: string } {
  const codes = gateCodes(event);
  if (codes.length > 0) {
    return { kind: "blocked", label: `Blocked: ${codes.map((code) => GATE_WORDS[code].short).join(" and ")}` };
  }
  if (evaluateIntake(event, vendorCreditCount).some((item) => !item.done)) {
    return { kind: "needs_details", label: "Needs details" };
  }
  return { kind: "ready", label: "Ready to send" };
}

/**
 * Submissions the outlet still holds, or that are still on their way to it.
 * Declined, withdrawn and cancelled release the wedding; published is done.
 */
const OPEN: ReadonlySet<SubmissionStatus> = new Set([
  "ready",
  "queued",
  "sent",
  "accepted",
  "expired",
  "withdraw_pending",
]);

/**
 * DECISION: with no package named, the wizard follows the newest package
 * whose submission is still open, else the newest one not yet queued, else
 * none (the photographer is choosing an outlet). Packages arrive newest
 * first, as listEventPackages returns them. An event the wizard would follow
 * a package for is the dashboard's "in progress".
 */
export function followedPackageId(
  packages: Array<{ id: string; submission: { status: SubmissionStatus } | null }>,
): string | null {
  const open = packages.find((entry) => entry.submission !== null && OPEN.has(entry.submission.status));
  if (open !== undefined) return open.id;
  return packages.find((entry) => entry.submission === null)?.id ?? null;
}

/**
 * DECISION: the write-up step is done as soon as the write-up and credits
 * have text, which they do the moment a package is drafted. The server has no
 * record of whether she read the draft, and inventing one would be a second
 * source of truth; the linear path still shows her the screen, and resuming
 * skips it only because it is not missing anything.
 */
export function buildWizard(input: WizardInput): Wizard {
  const { event, followed } = input;
  const intake = new Map(
    evaluateIntake(event, input.vendorCreditCount).map((item) => [item.id, item.done]),
  );
  const has = (id: string) => intake.get(id) === true;

  const blockedBy = gateWords(event);
  const status = followed?.submission?.status ?? null;
  const cancelled = status === "cancelled";
  const sent = status !== null && isSentOrLater(status);
  const answered = status !== null && isAnswered(status);
  const queued = followed?.submission != null;

  const done: Record<WizardStep, boolean> = {
    wedding: has("couple_names") && has("event_date") && has("venue_or_city"),
    permissions:
      has("gallery_link") && event.rightsStatus !== "unverified" && event.consentStatus !== "unverified",
    story: has("story") && has("vendor_credit"),
    outlet: blockedBy.length === 0 && followed !== null,
    photos: followed?.imagesReady === true,
    writeup: followed?.writeupReady === true,
    confirm: followed?.complete === true,
    review: queued,
    send: sent,
    track: answered,
  };

  const steps = WIZARD_STEPS.map((id) => ({ id, done: done[id] }));
  const step = steps.find((entry) => !entry.done)?.id ?? "track";

  const holdSend = queued && !sent;
  const blocked: Wizard["blocked"] =
    blockedBy.length > 0
      ? { step: "outlet", reasons: blockedBy }
      : holdSend && cancelled
        ? {
            step: "send",
            reasons: ["This submission was cancelled before it was sent. Choose another outlet to go on."],
          }
        : holdSend && input.liveElsewhere.length > 0
          ? {
              step: "send",
              reasons: input.liveElsewhere.map(
                (name) => `This wedding is waiting on ${name}. Record ${name}'s answer before sending it here.`,
              ),
            }
          : null;

  const outlet = followed?.outlet ?? null;
  const submission = followed?.submission ?? null;
  const note = outlet?.responseWindowNote ?? null;

  return {
    step,
    finished: answered,
    packageId: followed?.id ?? null,
    steps,
    blocked,
    outlet:
      outlet === null
        ? null
        : {
            id: outlet.id,
            name: outlet.name,
            method: outlet.method,
            submissionUrl: outlet.submissionUrl,
            typicalResponseDays: outlet.typicalResponseDays,
            warnings: outletFit(outlet, event).warnings,
          },
    submission,
    reply:
      submission === null || !sent
        ? null
        : {
            dueAt: submission.due?.at ?? null,
            daysRemaining: submission.due?.daysRemaining ?? null,
            outletWords: note,
            silenceMeansPass: note === null ? null : silenceMeansPass(note),
          },
  };
}
