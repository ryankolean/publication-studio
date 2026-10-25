/**
 * The photographer's style profile (SUMMIT-337).
 *
 * Each wedding carries tags from the shared vocabulary. A tag arrives as a
 * suggestion (loaded by the operator, or from the wedding's date and place)
 * and counts only once she confirms it. Her profile is the confirmed tags
 * across her own weddings, plus where she has been published.
 *
 * The tool calls no AI service: suggestions worked out from the photos are
 * prepared outside it and loaded through the operator's route.
 *
 * Pure: no database, no clock, no network.
 */

import { isRealDate, isSafeUrl } from "./event-intake.js";
import type { FieldError } from "./event-intake.js";
import type { TagCategory } from "./tags.js";

export const EVENT_TAG_STATES = ["suggested", "confirmed", "rejected"] as const;
export type EventTagState = (typeof EVENT_TAG_STATES)[number];

/** operator: loaded by the operator. derived: the date or the state. photographer: added by her. */
export const EVENT_TAG_SOURCES = ["operator", "derived", "photographer"] as const;
export type EventTagSource = (typeof EVENT_TAG_SOURCES)[number];

export const TAG_CONFIDENCES = ["high", "medium", "low"] as const;
export type TagConfidence = (typeof TAG_CONFIDENCES)[number];

export const FEATURE_ROLES = ["lead", "second_shooter"] as const;
export type FeatureRole = (typeof FEATURE_ROLES)[number];

const SEASON_BY_MONTH: Record<number, string[]> = {
  1: ["winter"],
  2: ["winter"],
  3: ["spring"],
  4: ["spring"],
  5: ["spring"],
  6: ["early_summer"],
  7: ["high_summer"],
  8: ["late_summer"],
  9: ["early_fall"],
  10: ["late_fall"],
  11: ["late_fall"],
  12: ["winter", "holiday_season"],
};

/** The season a wedding date suggests; nothing for a date that is not one. */
export function seasonTags(eventDate: string): string[] {
  if (!isRealDate(eventDate)) return [];
  return SEASON_BY_MONTH[Number(eventDate.slice(5, 7))] ?? [];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** One suggested tag, already checked against the vocabulary. */
export interface Suggestion {
  tag: string;
  confidence: TagConfidence;
  reason: string;
}

const MAX_REASON = 200;

/**
 * The operator's suggestions for one wedding: vocabulary tags, each once,
 * with a confidence and a short reason. Anything else is refused outright,
 * so a typo never turns into a silently missing tag.
 */
export function validateSuggestions(
  raw: unknown,
  vocabulary: ReadonlySet<string>,
): { ok: true; value: Suggestion[] } | { ok: false; errors: FieldError[] } {
  const list = asRecord(raw)["tags"];
  if (!Array.isArray(list)) return { ok: false, errors: [{ field: "tags", message: "Expected a list of tags." }] };
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  const value: Suggestion[] = [];
  list.forEach((entry: unknown, index) => {
    const field = `tags.${index}`;
    const { tag, confidence, reason } = asRecord(entry);
    if (typeof tag !== "string" || !vocabulary.has(tag)) {
      errors.push({ field: `${field}.tag`, message: `Not a vocabulary tag: ${String(tag)}.` });
    } else if (seen.has(tag)) {
      errors.push({ field: `${field}.tag`, message: `Listed twice: ${tag}.` });
    }
    if (!(TAG_CONFIDENCES as readonly unknown[]).includes(confidence)) {
      errors.push({ field: `${field}.confidence`, message: `Expected one of: ${TAG_CONFIDENCES.join(", ")}.` });
    }
    if (typeof reason !== "string" || reason.trim() === "" || reason.trim().length > MAX_REASON) {
      errors.push({ field: `${field}.reason`, message: `Give a reason under ${MAX_REASON} characters.` });
    }
    if (typeof tag === "string") seen.add(tag);
    value.push({ tag: String(tag), confidence: confidence as TagConfidence, reason: String(reason).trim() });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

export interface EventTagRow {
  tag_id: string;
  state: EventTagState;
  source: EventTagSource;
  confidence: TagConfidence | null;
  reason: string | null;
}

/**
 * What a new set of suggestions changes: each is written unless she has
 * already decided on that tag, and earlier suggestions the new set no longer
 * makes are dropped. Her decisions are never touched.
 */
export function planSuggestions(
  existing: readonly EventTagRow[],
  suggestions: readonly Suggestion[],
): { write: Suggestion[]; drop: string[] } {
  const decided = new Set(existing.filter((row) => row.state !== "suggested").map((row) => row.tag_id));
  const write = suggestions.filter((suggestion) => !decided.has(suggestion.tag));
  const kept = new Set(write.map((suggestion) => suggestion.tag));
  const drop = existing
    .filter((row) => row.state === "suggested" && row.source === "operator" && !kept.has(row.tag_id))
    .map((row) => row.tag_id);
  return { write, drop };
}

export interface LookTag {
  id: string;
  category: TagCategory;
  state: EventTagState;
  source: EventTagSource;
  confidence: TagConfidence | null;
  reason: string | null;
}

/**
 * Every tag the wedding screen shows: the stored rows, plus a suggestion for
 * each tag the date or state points to that has no row yet. Those are not
 * stored until she answers them, so a page view never writes.
 */
export function lookTags(
  rows: readonly EventTagRow[],
  derived: ReadonlyArray<{ tag: string; reason: string }>,
  vocabulary: ReadonlyArray<{ id: string; category: TagCategory }>,
): LookTag[] {
  const position = new Map(vocabulary.map((tag, index) => [tag.id, index]));
  const categoryOf = new Map(vocabulary.map((tag) => [tag.id, tag.category]));
  const tags: LookTag[] = [];
  for (const row of rows) {
    const category = categoryOf.get(row.tag_id);
    if (category === undefined) continue;
    tags.push({ id: row.tag_id, category, state: row.state, source: row.source, confidence: row.confidence, reason: row.reason });
  }
  const stored = new Set(rows.map((row) => row.tag_id));
  for (const { tag, reason } of derived) {
    const category = categoryOf.get(tag);
    if (category === undefined || stored.has(tag)) continue;
    stored.add(tag);
    tags.push({ id: tag, category, state: "suggested", source: "derived", confidence: null, reason });
  }
  return tags.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
}

export interface PastFeatureInput {
  publicationId: string | null;
  outletName: string | null;
  eventId: string | null;
  featureUrl: string | null;
  publishedOn: string | null;
  role: FeatureRole;
  notes: string | null;
}

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_NOTES = 1000;
const MAX_OUTLET_NAME = 120;

/**
 * A past feature as the form sends it. The outlet is either one of the
 * researched publications or a name she types; the route fills the name in
 * from the publication when it is linked.
 */
export function validatePastFeature(raw: unknown): { ok: true; value: PastFeatureInput } | { ok: false; errors: FieldError[] } {
  const source = asRecord(raw);
  const errors: FieldError[] = [];
  const text = (field: string): string | null => {
    const value = source[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      errors.push({ field, message: "Expected text." });
      return null;
    }
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  };

  const publicationId = text("publicationId");
  const outletName = text("outletName");
  const eventId = text("eventId");
  const featureUrl = text("featureUrl");
  const publishedOn = text("publishedOn");
  const notes = text("notes");
  const role = source["role"] ?? "lead";

  if (publicationId === null && outletName === null) errors.push({ field: "outletName", message: "Name the outlet." });
  if (outletName !== null && outletName.length > MAX_OUTLET_NAME) {
    errors.push({ field: "outletName", message: `Keep the outlet name under ${MAX_OUTLET_NAME} characters.` });
  }
  if (featureUrl !== null && !isSafeUrl(featureUrl)) {
    errors.push({ field: "featureUrl", message: "Enter a full http or https address." });
  }
  if (publishedOn !== null && !isRealDate(publishedOn) && !YEAR_MONTH.test(publishedOn)) {
    errors.push({ field: "publishedOn", message: "Enter a date, or just the year and month." });
  }
  if (notes !== null && notes.length > MAX_NOTES) {
    errors.push({ field: "notes", message: `Keep notes under ${MAX_NOTES} characters.` });
  }
  if (!(FEATURE_ROLES as readonly unknown[]).includes(role)) {
    errors.push({ field: "role", message: `Expected one of: ${FEATURE_ROLES.join(", ")}.` });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { publicationId, outletName, eventId, featureUrl, publishedOn, role: role as FeatureRole, notes },
  };
}
