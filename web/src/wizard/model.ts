import { ApiError } from "../api/client.js";
import type { SubmissionStatus, SubmissionSummary } from "../components/SubmissionBadge.js";

/** Mirrors WIZARD_STEPS in the API (api/src/domain/wizard.ts). */
export const STEPS = [
  "wedding",
  "permissions",
  "story",
  "look",
  "outlet",
  "photos",
  "writeup",
  "confirm",
  "review",
  "send",
  "track",
] as const;

export type StepId = (typeof STEPS)[number];

/** The progress rail's short names. */
export const RAIL_LABEL: Record<StepId, string> = {
  wedding: "Wedding",
  permissions: "Permissions",
  story: "Story",
  look: "Look",
  outlet: "Outlet",
  photos: "Photos",
  writeup: "Write-up",
  confirm: "Checks",
  review: "Review",
  send: "Send",
  track: "Reply",
};

export const isStep = (value: string): value is StepId => (STEPS as readonly string[]).includes(value);

export const stepAfter = (step: StepId): StepId | null => STEPS[STEPS.indexOf(step) + 1] ?? null;
export const stepBefore = (step: StepId): StepId | null => STEPS[STEPS.indexOf(step) - 1] ?? null;

export interface Warning {
  code: string;
  text: string;
}

/** The `wizard` field of GET /events/:id/walkthrough. Every verdict in it is the server's. */
export interface WizardState {
  step: StepId;
  finished: boolean;
  packageId: string | null;
  steps: Array<{ id: StepId; done: boolean }>;
  blocked: { step: "outlet" | "send"; reasons: string[] } | null;
  outlet: {
    id: string;
    name: string;
    method: string | null;
    submissionUrl: string | null;
    typicalResponseDays: number | null;
    warnings: Warning[];
  } | null;
  submission: {
    id: string;
    status: SubmissionStatus;
    due: { at: string; daysRemaining: number } | null;
    publishedUrl: string | null;
  } | null;
  reply: {
    dueAt: string | null;
    daysRemaining: number | null;
    outletWords: string | null;
    silenceMeansPass: boolean | null;
  } | null;
}

/** The matcher's verdict on one outlet for this wedding (SUMMIT-336). */
export interface OutletMatch {
  group: "fits" | "check" | "excluded";
  score: number;
  label: string;
  reasons: string[];
  checks: string[];
  excluded: string[];
  deadline: string | null;
}

export interface OutletOption {
  id: string;
  name: string;
  tier: string;
  method: string | null;
  imgMin: number | null;
  imgMax: number | null;
  typicalResponseDays: number | null;
  tasteNotes: string | null;
  warnings: Warning[];
  match: OutletMatch;
}

export interface EventPackage {
  id: string;
  publicationId: string;
  publicationName: string | null;
  complete: boolean;
  imageCount: number;
  submission: SubmissionSummary | null;
}

export interface Walkthrough {
  event: { id: string; coupleNames: string; locationCode: string | null };
  packages: EventPackage[];
  outlets: OutletOption[];
  wizard: WizardState;
}

/** GET /events/:id: the whole record, so a wizard screen can send it all back. */
export interface StoredEvent {
  id: string;
  coupleNames: string;
  eventDate: string;
  venueName: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  uniqueAngle: string | null;
  rightsStatus: string;
  consentStatus: string;
  consentNotes: string | null;
  nameDisplay: string | null;
  coupleStory: string | null;
  isDestination: boolean;
  heroPicks: string | null;
  videoUrl: string | null;
  targetOutletNotes: string | null;
  locationCode: string | null;
  contentType: "real_wedding" | "elopement" | "styled_shoot";
  hasGalleryUrl: boolean;
  vendorCredits: Array<{ role: string; businessName: string; website: string | null; instagram: string | null }>;
}

export type EventChanges = Partial<Omit<StoredEvent, "id" | "hasGalleryUrl">> & { galleryUrl?: string };

/**
 * PATCH /events/:id replaces every field, so a screen that edits a few of
 * them sends the stored record back with its changes on top. The gallery link
 * is sent only when a new one was typed; absent means "keep the stored one".
 */
export function eventPayload(stored: StoredEvent, changes: EventChanges): Record<string, unknown> {
  const merged = { ...stored, ...changes };
  const gallery = changes.galleryUrl?.trim() ?? "";
  return {
    coupleNames: merged.coupleNames,
    eventDate: merged.eventDate,
    venueName: merged.venueName,
    city: merged.city,
    state: merged.state,
    country: merged.country,
    ...(gallery === "" ? {} : { galleryUrl: gallery }),
    uniqueAngle: merged.uniqueAngle,
    rightsStatus: merged.rightsStatus,
    consentStatus: merged.consentStatus,
    consentNotes: merged.consentNotes,
    nameDisplay: merged.nameDisplay,
    coupleStory: merged.coupleStory,
    isDestination: merged.isDestination,
    heroPicks: merged.heroPicks,
    videoUrl: merged.videoUrl,
    targetOutletNotes: merged.targetOutletNotes,
    locationCode: merged.locationCode,
    contentType: merged.contentType,
    vendorCredits: merged.vendorCredits,
  };
}

/** Blank text becomes null, as the server would store it. */
export const textOrNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/** The server's message, with its field messages when it sent any. */
export function errorText(caught: unknown, fallback: string): string {
  if (!(caught instanceof ApiError)) return fallback;
  const details = caught.details.map((detail) => detail.message).filter(Boolean);
  return details.length > 0 ? `${caught.message} ${details.join(" ")}` : caught.message;
}

export function wizardPath(eventId: string, step: StepId, packageId: string | null = null): string {
  return `/wizard/${eventId}/${step}${packageId === null ? "" : `?package=${encodeURIComponent(packageId)}`}`;
}

export const TIER_LABEL: Record<string, string> = {
  primary: "Top tier",
  secondary: "Second tier",
  dream: "Dream",
};

const ROUTE_WORDS: Record<string, string> = {
  web_form: "web form",
  portal: "portal with an account",
  email: "email with a subject line",
  aggregator: "submission service form",
};

export const routeWords = (method: string | null): string =>
  method === null ? "pitch to an editor" : (ROUTE_WORDS[method] ?? method);

/** "30 to 40", "at least 30", "at most 40", or null when the outlet states no count. */
export function countRange(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) return `${min} to ${max}`;
  if (min !== null) return `at least ${min}`;
  if (max !== null) return `at most ${max}`;
  return null;
}

/** The first sentence of the outlet's taste notes: one line on a card. */
export function firstSentence(text: string | null): string | null {
  if (text === null || text.trim() === "") return null;
  const match = /^.*?[.!?](\s|$)/.exec(text.trim());
  return (match?.[0] ?? text).trim();
}

/** "2026-06-14" -> "June 14, 2026"; anything else is shown as stored. */
export function friendlyDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Only a web address becomes a link; anything else stays text. */
export const isWebUrl = (value: string | null): value is string => value !== null && /^https?:\/\//i.test(value);
