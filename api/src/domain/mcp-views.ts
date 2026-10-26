/**
 * What the Claude connector's read tools say -- spec docs/specs/claude-native.md
 * sections 4 and 5: summaries and short ids, about 500 tokens by default, in
 * the same plain words the wizard uses. Pure: the tools load the studio
 * through the web app's own loaders and shape it here.
 *
 * Nothing here can carry a gallery link (the loaders never read one out) or
 * anyone's contact details: vendor credits are business names only.
 */

import type { ConsentStatus, RightsStatus } from "./rights-gate.js";
import type { SubmissionStatus } from "./submission-status.js";
import { gateWords } from "./wizard.js";
import type { ChipKind } from "./wizard.js";

export interface WeddingRecord {
  id: string;
  slug: string;
  coupleNames: string;
  eventDate: string;
  venueName: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  chip: { kind: ChipKind; label: string };
}

export interface QueueRecord {
  eventId: string;
  publicationName: string;
  status: SubmissionStatus;
  responseDueAt: string | null;
  daysRemaining: number | null;
}

export interface CardWedding extends WeddingRecord {
  hasGalleryUrl: boolean;
  rightsStatus: RightsStatus;
  consentStatus: ConsentStatus;
  coupleStory: string | null;
  uniqueAngle: string | null;
  contentType: string;
  isDestination: boolean;
}

/** In the order a wedding moves through them. */
export const STAGE_WORDS: Readonly<Record<ChipKind, string>> = {
  blocked: "on hold",
  needs_details: "needs details",
  ready: "ready for an outlet",
  queued: "waiting to be sent",
  live: "with an outlet",
  accepted: "accepted",
  published: "published",
};

export const STATUS_WORDS: Readonly<Record<SubmissionStatus, string>> = {
  draft: "being drafted",
  ready: "ready to send",
  queued: "waiting to be sent",
  sent: "sent, waiting for a reply",
  accepted: "accepted",
  published: "published",
  declined: "declined",
  expired: "reply overdue",
  withdraw_pending: "being withdrawn",
  withdrawn: "withdrawn",
  cancelled: "cancelled",
};

/** What she can act on, most pressing first; the rest wait on someone else. */
const NEXT_STEP_ORDER: readonly ChipKind[] = ["queued", "needs_details", "ready", "blocked"];
const NEXT_STEP_LIMIT = 5;
const DEADLINE_DAYS = 14;
const DEADLINE_LIMIT = 5;
const PAGE_DEFAULT = 10;
const PAGE_MAX = 25;

const WAITING_TO_SEND: ReadonlySet<SubmissionStatus> = new Set(["ready", "queued"]);
const WITH_OUTLETS: ReadonlySet<SubmissionStatus> = new Set(["sent", "expired", "withdraw_pending"]);
const AWAITING_REPLY: ReadonlySet<SubmissionStatus> = new Set(["sent", "expired"]);

export function placeOf(wedding: Pick<WeddingRecord, "city" | "state" | "country">): string | null {
  const parts = [wedding.city, wedding.state ?? wedding.country].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

export function weddingLine(wedding: WeddingRecord) {
  return {
    wedding: wedding.slug,
    couple: wedding.coupleNames,
    date: wedding.eventDate,
    place: placeOf(wedding),
    step: wedding.chip.label,
  };
}

export function studioOverview(weddings: readonly WeddingRecord[], queue: readonly QueueRecord[]) {
  const byStage: Record<string, number> = {};
  for (const kind of Object.keys(STAGE_WORDS) as ChipKind[]) {
    const count = weddings.filter((wedding) => wedding.chip.kind === kind).length;
    if (count > 0) byStage[STAGE_WORDS[kind]] = count;
  }

  const actionable = NEXT_STEP_ORDER.flatMap((kind) => weddings.filter((wedding) => wedding.chip.kind === kind));
  const slugOf = new Map(weddings.map((wedding) => [wedding.id, wedding.slug]));

  const deadlines = queue
    .filter(
      (entry): entry is QueueRecord & { daysRemaining: number; responseDueAt: string } =>
        AWAITING_REPLY.has(entry.status) &&
        entry.daysRemaining !== null &&
        entry.responseDueAt !== null &&
        entry.daysRemaining <= DEADLINE_DAYS,
    )
    .sort((a, b) => a.daysRemaining - b.daysRemaining)
    .slice(0, DEADLINE_LIMIT)
    .map((entry) => ({
      wedding: slugOf.get(entry.eventId) ?? null,
      outlet: entry.publicationName,
      due: entry.responseDueAt.slice(0, 10),
      daysLeft: entry.daysRemaining,
    }));

  return {
    weddings: { total: weddings.length, byStage },
    nextSteps: actionable.slice(0, NEXT_STEP_LIMIT).map((wedding) => ({
      wedding: wedding.slug,
      couple: wedding.coupleNames,
      step: wedding.chip.label,
    })),
    moreSteps: Math.max(0, actionable.length - NEXT_STEP_LIMIT),
    queue: {
      waitingToSend: queue.filter((entry) => WAITING_TO_SEND.has(entry.status)).length,
      withOutlets: queue.filter((entry) => WITH_OUTLETS.has(entry.status)).length,
      accepted: queue.filter((entry) => entry.status === "accepted").length,
    },
    deadlines,
  };
}

/** One page of weddings. The cursor is the offset of the next page, as a string. */
export function weddingPage(weddings: readonly WeddingRecord[], options: { limit?: number; cursor?: string }) {
  const start = options.cursor === undefined ? 0 : /^\d+$/.test(options.cursor) ? Number(options.cursor) : -1;
  if (start < 0 || start > weddings.length) return { error: "That cursor is not valid. Ask again without one." };

  const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(options.limit ?? PAGE_DEFAULT)));
  const end = start + limit;
  return {
    weddings: weddings.slice(start, end).map(weddingLine),
    total: weddings.length,
    ...(end < weddings.length ? { next: String(end) } : {}),
  };
}

/**
 * One wedding. Credits are null for the default summary; passing them, even
 * an empty list, is the detail view.
 */
export function weddingCard(
  wedding: CardWedding,
  outlets: readonly QueueRecord[],
  credits: ReadonlyArray<{ role: string; businessName: string }> | null,
) {
  const holds = gateWords(wedding);
  const summary = {
    wedding: wedding.slug,
    couple: wedding.coupleNames,
    date: wedding.eventDate,
    venue: wedding.venueName,
    place: placeOf(wedding),
    step: wedding.chip.label,
    ...(holds.length > 0 ? { onHold: holds } : {}),
    gallery: wedding.hasGalleryUrl,
    outlets: outlets.map((entry) => ({
      outlet: entry.publicationName,
      status: STATUS_WORDS[entry.status],
      ...(AWAITING_REPLY.has(entry.status) && entry.daysRemaining !== null ? { daysLeft: entry.daysRemaining } : {}),
    })),
  };
  if (credits === null) return summary;
  return {
    ...summary,
    story: wedding.coupleStory,
    angle: wedding.uniqueAngle,
    contentType: wedding.contentType,
    destination: wedding.isDestination,
    credits: credits.map((credit) => ({ role: credit.role, business: credit.businessName })),
  };
}

const ID_LIKE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A tool call's arguments as the audit log keeps them: ids, flags and numbers
 * as given, any other text replaced, so the log never holds what she typed.
 */
export function auditArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null) return {};
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value === "boolean" || typeof value === "number") return [key, value];
      if (typeof value === "string") return [key, ID_LIKE.test(value) ? value : "[text]"];
      return [key, `[${typeof value}]`];
    }),
  );
}
