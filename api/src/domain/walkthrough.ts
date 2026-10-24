/**
 * Submission walkthrough -- the in-app guide from intake to a recorded outcome.
 *
 * The photographer picks one outlet for an event and the walkthrough lists
 * what is left, step by step, each step pointing at the page where it is done.
 * Nothing here decides anything new: every step reads a verdict that already
 * exists (the rights gate, the package checklist, the submission lifecycle)
 * from data the API has loaded, so the guide cannot disagree with the gates
 * that actually enforce those rules.
 *
 * Pure: no database, no clock. Days remaining arrive precomputed.
 */

import { evaluateRightsGate } from "./rights-gate.js";
import type { ConsentStatus, RightsStatus } from "./rights-gate.js";
import type {
  EarnedOrPaid,
  ExclusivityPolicy,
  PublicationTier,
  SubmissionMethod,
} from "./publication.js";
import type { SubmissionStatus } from "./submission-status.js";

export interface WalkthroughEvent {
  id: string;
  coupleNames: string;
  eventDate: string;
  venueName: string | null;
  city: string | null;
  hasGalleryUrl: boolean;
  coupleStory: string | null;
  uniqueAngle: string | null;
  nameDisplay: string | null;
  consentNotes: string | null;
  rightsStatus: RightsStatus;
  consentStatus: ConsentStatus;
  priorExposure: { ownBlog: boolean; igPosted: boolean; priorPubs: string[] };
}

export interface WalkthroughOutlet {
  id: string;
  name: string;
  tier: PublicationTier;
  method: SubmissionMethod | null;
  submissionUrl: string | null;
  exclusivityPolicy: ExclusivityPolicy;
  countsOwnBlogAsPublished: boolean | null;
  typicalResponseDays: number | null;
  responseWindowNote: string | null;
  earnedOrPaid: EarnedOrPaid;
  spec: { imgMin: number | null; imgMax: number | null; requirements: string[] };
}

export interface IntakeItem {
  id: string;
  label: string;
  done: boolean;
}

export interface OutletWarning {
  code: string;
  text: string;
}

const hasText = (value: string | null): boolean => value !== null && value.trim().length > 0;

/**
 * What outlets ask of an event record before anything else (design doc
 * section 7.1, items 1, 4, 5 and 6). Every item comes back with its state, so
 * the walkthrough can say both what is open and how much is left.
 */
export function evaluateIntake(
  event: Pick<
    WalkthroughEvent,
    "coupleNames" | "eventDate" | "venueName" | "city" | "hasGalleryUrl" | "coupleStory" | "uniqueAngle"
  >,
  vendorCreditCount: number,
): IntakeItem[] {
  return [
    { id: "couple_names", label: "Couple names", done: hasText(event.coupleNames) },
    { id: "event_date", label: "Event date", done: hasText(event.eventDate) },
    {
      id: "venue_or_city",
      label: "Venue or city",
      done: hasText(event.venueName) || hasText(event.city),
    },
    { id: "gallery_link", label: "Gallery link on file", done: event.hasGalleryUrl },
    { id: "vendor_credit", label: "At least one vendor credit", done: vendorCreditCount > 0 },
    {
      id: "story",
      label: "A story or unique angle",
      done: hasText(event.coupleStory) || hasText(event.uniqueAngle),
    },
  ];
}

/**
 * The wedding's exposures (SUMMIT-336) in the shape the outlet warnings read:
 * her own blog, her own social media, and earlier outlets by name.
 */
export function exposureSummary(
  exposures: ReadonlyArray<{ channel: string; detail: string | null }>,
): WalkthroughEvent["priorExposure"] {
  return {
    ownBlog: exposures.some((exposure) => exposure.channel === "own_blog"),
    igPosted: exposures.some((exposure) => exposure.channel === "own_social"),
    priorPubs: exposures
      .filter((exposure) => exposure.channel === "publication" && exposure.detail !== null)
      .map((exposure) => exposure.detail as string),
  };
}

/** "posted on your blog and to Instagram", or null when nothing was posted. */
function postedWhere(exposure: WalkthroughEvent["priorExposure"]): string | null {
  if (exposure.ownBlog && exposure.igPosted) return "posted on your blog and to Instagram";
  if (exposure.ownBlog) return "posted on your blog";
  if (exposure.igPosted) return "posted to Instagram";
  return null;
}

/**
 * What choosing this outlet commits the event to, read only from the outlet's
 * stored policy and spec. No scoring and no tag matching: this answers "what
 * happens if I send it here", not "is it a good fit" (that is SUMMIT-303).
 */
export function outletFit(
  publication: WalkthroughOutlet,
  event: Pick<WalkthroughEvent, "priorExposure">,
): { warnings: OutletWarning[] } {
  const requires = new Set(publication.spec.requirements);
  const warnings: OutletWarning[] = [];

  const thirtyDays = requires.has("exclusive_30_days_after_publication");
  if (publication.exclusivityPolicy === "exclusive_required" || thirtyDays) {
    warnings.push({
      code: "exclusive",
      text:
        "Exclusive: sending here blocks every other outlet for this wedding until it answers." +
        (thirtyDays ? " Once it publishes, the feature stays exclusive to it for 30 days." : ""),
    });
  }

  if (requires.has("unpublished_only")) {
    const where = postedWhere(event.priorExposure);
    if (publication.countsOwnBlogAsPublished === true && where !== null) {
      warnings.push({
        code: "prior_exposure_conflict",
        text: `Takes only unpublished weddings and counts your own blog and Instagram as published. This wedding was already ${where}.`,
      });
    } else {
      const unknown =
        publication.countsOwnBlogAsPublished === null && where !== null
          ? ` This wedding was ${where}; the outlet does not say whether that counts.`
          : "";
      const earlier =
        event.priorExposure.priorPubs.length > 0
          ? ` Earlier outlets on record: ${event.priorExposure.priorPubs.join(", ")}; confirm none of them ran it.`
          : "";
      warnings.push({
        code: "unpublished_only",
        text: `Takes only weddings that have not been published anywhere.${unknown}${earlier}`,
      });
    }
  }

  if (publication.earnedOrPaid === "paid" || requires.has("processing_fee_if_selected")) {
    warnings.push({
      code: "fee_on_selection",
      text: "Pay to publish: the outlet charges a fee if it selects this wedding.",
    });
  } else if (publication.earnedOrPaid === "mixed") {
    warnings.push({
      code: "may_be_paid",
      text: "Placements here may be paid. Confirm the terms before sending.",
    });
  }

  if (requires.has("anti_bride_partner_required_if_accepted")) {
    warnings.push({
      code: "partnership_required",
      text: "If accepted, the photographer or planner must become one of the outlet's brand partners.",
    });
  }

  if (requires.has("embargo_other_features_2_months_after_publication")) {
    warnings.push({
      code: "embargo",
      text: "After it publishes, no other outlet can run this wedding for 2 months.",
    });
  }

  if (publication.method === null) {
    warnings.push({
      code: "no_public_route",
      text: "No public submission route: reaching this outlet is a pitch to an editor, not a form.",
    });
  }

  if (publication.typicalResponseDays === null) {
    warnings.push({
      code: "window_unknown",
      text: "No published response window, so there is no due date to track.",
    });
  }

  return { warnings };
}

export type StepStatus = "done" | "current" | "todo" | "blocked";

export interface WalkthroughSubmission {
  id: string;
  status: SubmissionStatus;
  /** Null until sent, and for an outlet that publishes no response window. */
  due: { at: string; daysRemaining: number } | null;
  publishedUrl: string | null;
}

export interface WalkthroughPackage {
  id: string;
  /** The package's own outlet, which may since have been deactivated. */
  outlet: WalkthroughOutlet;
  imageCount: number;
  /** The checklist verdict, as the package editor computes it. */
  complete: boolean;
  missingLabels: string[];
  submission: WalkthroughSubmission | null;
}

export interface WalkthroughInput {
  event: WalkthroughEvent;
  vendorCreditCount: number;
  /** Images uploaded to the event's pool. */
  poolCount: number;
  /** Active outlets, in the order the chooser lists them. */
  outlets: WalkthroughOutlet[];
  /** The package the walkthrough is following; null before an outlet is chosen. */
  selected: WalkthroughPackage | null;
  /** Outlets where another of this event's packages is sent and unanswered. */
  liveElsewhere: string[];
}

export interface WalkthroughStep {
  id: string;
  title: string;
  status: StepStatus;
  summary: string;
  detail: string[];
  /** An in-app path, without the hash; null when the page renders the step itself. */
  action: { label: string; href: string } | null;
}

/** A step before the current marker is placed. */
interface Draft extends Omit<WalkthroughStep, "status"> {
  done: boolean;
  blocked: boolean;
}

/** Statuses at which the photographer has sent the package herself. */
const SENT_OR_LATER: ReadonlySet<SubmissionStatus> = new Set([
  "sent",
  "accepted",
  "published",
  "declined",
  "expired",
  "withdraw_pending",
  "withdrawn",
]);

/** Statuses at which the outlet has answered, or the window has closed. */
const ANSWERED: ReadonlySet<SubmissionStatus> = new Set([
  "accepted",
  "published",
  "declined",
  "expired",
  "withdraw_pending",
  "withdrawn",
]);

/** The window passed with no answer; the outlet still holds the submission. */
const WITHDRAWING: ReadonlySet<SubmissionStatus> = new Set(["expired", "withdraw_pending"]);

const RESPONSE_SUMMARY: Partial<Record<SubmissionStatus, string>> = {
  sent: "Waiting for the outlet's answer.",
  accepted: "Accepted.",
  published: "Accepted and published.",
  declined: "Declined. The wedding is free for another outlet.",
  expired: "No answer by the due date.",
  withdraw_pending: "Withdrawal pending.",
  withdrawn: "Withdrawn. The wedding is free for another outlet.",
  cancelled: "Cancelled before it was sent.",
};

const METHOD_LABEL: Record<SubmissionMethod, string> = {
  portal: "portal",
  web_form: "web form",
  email: "email",
  aggregator: "aggregator",
};

const ROUTE: Record<SubmissionMethod, string> = {
  portal: "the outlet's portal",
  web_form: "the outlet's web form",
  email: "email to the outlet's submissions inbox",
  aggregator: "the aggregator's submission form",
};

const NOTHING_SENT =
  "Nothing is sent by this tool. Send it yourself, then mark it sent in the queue.";

/**
 * DECISION: outlets state what silence means only in their own words
 * (publications.response_window_note), never as a field. The walkthrough
 * quotes the words and reads one signal from them: wording that ties a reply
 * to success or selection means no reply is a pass. Anything else is quoted
 * without a guess.
 */
const SILENCE_IS_A_PASS = /success|selected|not heard back/i;

/** True when the outlet's own words make no reply by the due date a pass. */
export function silenceMeansPass(note: string): boolean {
  return SILENCE_IS_A_PASS.test(note);
}

/** The send step's verdict: the photographer has sent it herself. */
export function isSentOrLater(status: SubmissionStatus): boolean {
  return SENT_OR_LATER.has(status);
}

/** The reply step's verdict: the outlet answered, or the window closed. */
export function isAnswered(status: SubmissionStatus): boolean {
  return ANSWERED.has(status);
}

/** "30 to 40 images", or null when the outlet states no count. */
function boundsText(spec: WalkthroughOutlet["spec"]): string | null {
  if (spec.imgMin !== null && spec.imgMax !== null) return `${spec.imgMin} to ${spec.imgMax} images`;
  if (spec.imgMin !== null) return `at least ${spec.imgMin} images`;
  if (spec.imgMax !== null) return `at most ${spec.imgMax} images`;
  return null;
}

function outletLine(outlet: WalkthroughOutlet, event: WalkthroughEvent): string {
  const method = outlet.method === null ? "no public route" : METHOD_LABEL[outlet.method];
  const window =
    outlet.typicalResponseDays === null
      ? "response window unknown"
      : `replies in about ${outlet.typicalResponseDays} days`;
  const head = `${outlet.name} (${outlet.tier}, ${method}): ${boundsText(outlet.spec) ?? "no stated image count"}; ${window}.`;
  return [head, ...outletFit(outlet, event).warnings.map((warning) => warning.text)].join(" ");
}

function daysText(days: number): string {
  if (days < 0) return "the window has passed";
  if (days === 0) return "today is the last day";
  return days === 1 ? "1 day remaining" : `${days} days remaining`;
}

function quoteIfText(label: string, value: string | null): string[] {
  return value !== null && hasText(value) ? [`${label}: "${value.trim()}"`] : [];
}

function intakeStep(input: WalkthroughInput): Draft {
  const items = evaluateIntake(input.event, input.vendorCreditCount);
  const open = items.filter((item) => !item.done);
  return {
    id: "intake",
    title: "Complete the event record",
    done: open.length === 0,
    blocked: false,
    summary:
      open.length === 0
        ? "The event record has what outlets ask for."
        : `${open.length} of ${items.length} items open.`,
    detail: open.map((item) => item.label),
    action: { label: "Edit the event", href: `/events/${input.event.id}/edit` },
  };
}

function rightsStep(input: WalkthroughInput): Draft {
  const { event } = input;
  const gate = evaluateRightsGate({
    rightsStatus: event.rightsStatus,
    consentStatus: event.consentStatus,
  });
  const limits = [
    ...quoteIfText("Name display", event.nameDisplay),
    ...quoteIfText("Consent notes", event.consentNotes),
  ];

  if (gate.allowed) {
    return {
      id: "rights",
      title: "Clear rights and consent",
      done: true,
      blocked: false,
      summary: "Rights and consent are clear.",
      detail: limits,
      action: { label: "Edit rights and consent", href: `/events/${event.id}/edit` },
    };
  }

  return {
    id: "rights",
    title: "Clear rights and consent",
    done: false,
    blocked: true,
    summary:
      gate.route === "credit_recovery"
        ? "Blocked: second-shooter work goes to credit recovery, not submission."
        : "Blocked: nothing can be packaged until this clears.",
    detail: [...gate.reasons.map((reason) => reason.remedy), ...limits],
    action: { label: "Edit rights and consent", href: `/events/${event.id}/edit` },
  };
}

function outletStep(input: WalkthroughInput): Draft {
  return {
    id: "outlet",
    title: "Choose an outlet",
    done: input.selected !== null,
    blocked: false,
    summary:
      input.selected === null
        ? "Pick one outlet for this event. It goes to one outlet at a time."
        : `Chosen: ${input.selected.outlet.name}.`,
    detail: input.outlets.map((outlet) => outletLine(outlet, input.event)),
    action: null,
  };
}

function imagesStep(input: WalkthroughInput): Draft {
  const outlet = input.selected?.outlet ?? null;
  // DECISION: only the outlet's minimum gates this step. The pool is what the
  // package selects from, so a pool larger than the outlet's maximum is
  // material to curate, not a mistake; the package checklist enforces the
  // maximum on the selection itself.
  const needed = Math.max(outlet?.spec.imgMin ?? 1, 1);
  const done = input.poolCount >= needed;
  const bounds = outlet === null ? null : boundsText(outlet.spec);

  return {
    id: "images",
    title: "Gather the images",
    done,
    blocked: false,
    summary: done
      ? `${input.poolCount} in the pool.`
      : `${input.poolCount} in the pool; at least ${needed} needed.`,
    detail: [
      input.event.hasGalleryUrl
        ? "Download the web-size files from the gallery and upload them on the event page."
        : "Download the web-size files from the gallery and upload them on the event page. No gallery link is on file yet; add it on the edit page.",
      "Cover the whole day: getting ready, details, ceremony, portraits, reception.",
      outlet === null
        ? "Choose an outlet to see how many it takes."
        : bounds === null
          ? `${outlet.name} states no image count; the pool has ${input.poolCount}.`
          : `${outlet.name} asks for ${bounds}; the pool has ${input.poolCount}.`,
    ],
    action: { label: "Open the event", href: `/events/${input.event.id}` },
  };
}

function packageAction(input: WalkthroughInput): WalkthroughStep["action"] {
  return input.selected === null
    ? null
    : { label: "Open the package", href: `/packages/${input.selected.id}` };
}

function packageStep(input: WalkthroughInput): Draft {
  const { selected } = input;
  return {
    id: "package",
    title: "Build the package",
    done: selected?.complete === true,
    blocked: false,
    summary:
      selected === null
        ? "Starts once an outlet is chosen."
        : selected.complete
          ? "The checklist is complete."
          : `${selected.missingLabels.length} checklist items open.`,
    detail: selected?.missingLabels ?? [],
    action: packageAction(input),
  };
}

function submissionStep(input: WalkthroughInput): Draft {
  const exists = (input.selected?.submission ?? null) !== null;
  return {
    id: "submission",
    title: "Put it in the queue",
    done: exists,
    blocked: false,
    summary: exists
      ? "In the queue."
      : "Create the submission from the package once its checklist is complete.",
    detail: exists
      ? []
      : ["The button is in the package editor. It adds the package to the queue; nothing is sent."],
    action: packageAction(input),
  };
}

function sendStep(input: WalkthroughInput): Draft {
  const { selected } = input;
  const status = selected?.submission?.status ?? null;
  const done = status !== null && SENT_OR_LATER.has(status);
  // DECISION: a cancelled submission is terminal and the pairing is unique,
  // so the send can never happen; the step says so rather than waiting.
  const cancelled = status === "cancelled";
  // The server refuses a second live send for one event; say so up front.
  const waitingOn = done ? [] : input.liveElsewhere;
  const names = waitingOn.join(", ");

  const base: Omit<Draft, "summary" | "detail"> = {
    id: "send",
    title: "Send it yourself",
    done,
    blocked: !done && (cancelled || waitingOn.length > 0),
    action: { label: "Open the queue", href: "/queue" },
  };

  if (selected === null) {
    return {
      ...base,
      summary: "Send the package through the outlet's own route, then mark it sent.",
      detail: [NOTHING_SENT],
    };
  }

  const { outlet } = selected;
  return {
    ...base,
    summary: done
      ? "Marked sent."
      : cancelled
        ? "Cancelled before it was sent."
        : waitingOn.length > 0
          ? `Waiting on ${names} first.`
          : "Send the package through the outlet's own route, then mark it sent.",
    detail: [
      ...(cancelled
        ? ["This submission was cancelled before it was sent. Choose another outlet to continue."]
        : []),
      ...(waitingOn.length > 0
        ? [`This event is live at ${names}. Record that outlet's answer before sending it here.`]
        : []),
      outlet.method === null
        ? "How to send: there is no public route. Reaching this outlet is a pitch to an editor."
        : `How to send: ${ROUTE[outlet.method]}.`,
      ...(outlet.submissionUrl === null ? [] : [`Submission page: ${outlet.submissionUrl}`]),
      "Paste the description from the package.",
      "Paste the credits block from the package.",
      `Upload the selected images (${selected.imageCount}) in the package's order.`,
      ...outletFit(outlet, input.event).warnings.map((warning) => warning.text),
      NOTHING_SENT,
    ],
  };
}

function responseStep(input: WalkthroughInput): Draft {
  const submission = input.selected?.submission ?? null;
  const status = submission?.status ?? null;
  const sent = status !== null && SENT_OR_LATER.has(status);
  const due = submission?.due ?? null;
  const note = input.selected?.outlet.responseWindowNote ?? null;

  const dueLine = !sent
    ? "The due date is set when you mark it sent."
    : due === null
      ? "No due date: the outlet publishes no response window."
      : `Due ${due.at.slice(0, 10)}: ${daysText(due.daysRemaining)}.`;

  const wording =
    input.selected === null
      ? []
      : note === null
        ? ["The outlet publishes no wording about its replies."]
        : [
            `The outlet's own words: "${note}".`,
            silenceMeansPass(note)
              ? "By that wording, no reply by the due date means it passed."
              : "That wording does not say what silence means.",
          ];

  // Design doc section 6.2: an outlet that sat on a submission gets a polite
  // withdrawal note before the event goes anywhere else.
  const waiting = status === null || !(ANSWERED.has(status) || status === "cancelled");
  const advice =
    status !== null && WITHDRAWING.has(status)
      ? [
          "The window passed without an answer. Send the outlet a short withdrawal note before offering the event elsewhere.",
        ]
      : waiting
        ? [
            "If the due date passes with no reply, send the outlet a short withdrawal note before offering the event elsewhere.",
          ]
        : [];

  return {
    id: "response",
    title: "Wait for the reply",
    done: status !== null && ANSWERED.has(status),
    blocked: false,
    summary:
      (status === null ? undefined : RESPONSE_SUMMARY[status]) ??
      "Starts once you mark it sent.",
    detail: [dueLine, ...wording, ...advice],
    action: { label: "Open the queue", href: "/queue" },
  };
}

function publishedStep(submission: WalkthroughSubmission): Draft {
  const done = submission.status === "published";
  return {
    id: "published",
    title: "Record the live link",
    done,
    blocked: false,
    summary: done ? "Published." : "Accepted. Record the live link when the feature runs.",
    detail:
      submission.publishedUrl === null
        ? ["Paste the address of the live feature."]
        : [`Live at ${submission.publishedUrl}`],
    action: null,
  };
}

/**
 * DECISION: the current step is the first step not done. When that step is
 * blocked it is still the current one (its summary says "Blocked"), and every
 * open step after it is todo, because nothing past a closed gate can move.
 * When the current step is not blocked, a blocked step further down keeps its
 * blocked status so the trouble ahead is visible. Once every step is done,
 * no step is current: the walkthrough is finished.
 */
function placeCurrent(drafts: Draft[]): WalkthroughStep[] {
  const current = drafts.findIndex((draft) => !draft.done);
  const currentIsBlocked = drafts[current]?.blocked === true;

  return drafts.map(({ done, blocked, ...step }, index) => ({
    ...step,
    status: done
      ? "done"
      : index === current
        ? "current"
        : blocked && !currentIsBlocked
          ? "blocked"
          : "todo",
  }));
}

export function buildWalkthrough(input: WalkthroughInput): WalkthroughStep[] {
  const drafts: Draft[] = [
    intakeStep(input),
    rightsStep(input),
    outletStep(input),
    imagesStep(input),
    packageStep(input),
    submissionStep(input),
    sendStep(input),
    responseStep(input),
  ];

  const submission = input.selected?.submission ?? null;
  if (submission !== null && (submission.status === "accepted" || submission.status === "published")) {
    drafts.push(publishedStep(submission));
  }

  return placeCurrent(drafts);
}
