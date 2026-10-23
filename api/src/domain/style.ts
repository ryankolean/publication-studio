/**
 * The photographer's style profile (SUMMIT-337).
 *
 * Each wedding carries tags from the shared vocabulary. A tag arrives as a
 * suggestion (from Claude looking at the photos, or from the wedding's date
 * and state) and counts only once she confirms it. Her profile is the
 * confirmed tags across her own weddings, plus where she has been published.
 *
 * Pure: no database, no clock, no network.
 */

import { isRealDate, isSafeUrl } from "./event-intake.js";
import type { FieldError } from "./event-intake.js";
import type { TagCategory } from "./tags.js";

export const EVENT_TAG_STATES = ["suggested", "confirmed", "rejected"] as const;
export type EventTagState = (typeof EVENT_TAG_STATES)[number];

/** analysis: Claude, from the photos. derived: the date or the state. photographer: added by her. */
export const EVENT_TAG_SOURCES = ["analysis", "derived", "photographer"] as const;
export type EventTagSource = (typeof EVENT_TAG_SOURCES)[number];

export const TAG_CONFIDENCES = ["high", "medium", "low"] as const;
export type TagConfidence = (typeof TAG_CONFIDENCES)[number];

export const STYLE_RUN_STATUSES = ["ok", "failed", "refused"] as const;
export type StyleRunStatus = (typeof STYLE_RUN_STATUSES)[number];

export const FEATURE_ROLES = ["lead", "second_shooter"] as const;
export type FeatureRole = (typeof FEATURE_ROLES)[number];

export const SETTING_KEYS = ["photo_analysis"] as const;

/** The categories a photo can show. Region and season come from the wedding's details. */
export const PHOTO_CATEGORIES: readonly TagCategory[] = ["landscape_venue", "architecture", "aesthetic", "dress_style"];

/**
 * Above 20 photos the API caps every photo at 2000 px a side, and uploads
 * are not resized, so a run sends at most 20.
 */
export const MAX_ANALYSIS_PHOTOS = 20;

/** The API takes up to 10 MB a photo once base64 encoded: 7.5 MB of bytes. */
export const MAX_ANALYSIS_BYTES = 7_864_320;

/** Runs a wedding may start in one UTC day, so a run of photo changes cannot run up a bill. */
export const MAX_RUNS_PER_DAY = 5;

/**
 * Up to MAX_ANALYSIS_PHOTOS keys spread evenly across the wedding's photos,
 * oldest first, so getting ready, the ceremony and the evening are all seen.
 * Photos too large to send are skipped.
 */
export function pickPhotos(pool: ReadonlyArray<{ key: string; bytes: number }>): string[] {
  const eligible = pool.filter((photo) => photo.bytes <= MAX_ANALYSIS_BYTES);
  if (eligible.length <= MAX_ANALYSIS_PHOTOS) return eligible.map((photo) => photo.key);
  return Array.from(
    { length: MAX_ANALYSIS_PHOTOS },
    (_, index) => (eligible[Math.floor((index * eligible.length) / MAX_ANALYSIS_PHOTOS)] as { key: string }).key,
  );
}

/** What a run's photo set is compared by: the keys, order aside. */
export const photoSetText = (keys: readonly string[]): string => [...keys].sort().join("\n");

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

/** The region tag for each US region in research/vocab/geo.yaml. */
const REGION_TAG: Record<string, string> = {
  "US:northeast": "northeast_us",
  "US:mid-atlantic": "mid_atlantic_us",
  "US:southeast": "southeast_us",
  "US:south-central": "south_central_us",
  "US:midwest": "midwest_us",
  "US:southwest": "southwest_us",
  "US:mountain-west": "mountain_west_us",
  "US:pacific-northwest": "pacific_northwest_us",
};

/** States the vocabulary names on their own, ahead of their region. */
const STATE_TAG: Record<string, string> = { "US-MI": "michigan", "US-FL": "florida", "US-CA": "california" };

const UNITED_STATES = /^(us|usa|u\.s\.(a\.)?|united states( of america)?)$/i;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * The region a US wedding's state suggests, read against the geo vocabulary
 * the research import stored. The state is free text on the wedding, so a
 * two-letter code or the full name both count. Weddings outside the US get
 * nothing here; she adds their region herself.
 */
export function regionTags(state: string | null, country: string | null, geo: unknown): string[] {
  const place = (country ?? "").trim();
  if (place !== "" && !UNITED_STATES.test(place)) return [];
  const text = (state ?? "").trim();
  if (text === "") return [];

  const states = asRecord(asRecord(geo)["states"]);
  const code = /^[a-z]{2}$/i.test(text)
    ? `US-${text.toUpperCase()}`
    : Object.keys(states).find((key) => String(states[key]).toLowerCase() === text.toLowerCase());
  if (code === undefined || !(code in states)) return [];

  const tags: string[] = [];
  const own = STATE_TAG[code];
  if (own !== undefined) tags.push(own);
  for (const [region, entry] of Object.entries(asRecord(asRecord(geo)["us_regions"]))) {
    const members = asRecord(entry)["states"];
    const tag = REGION_TAG[region];
    if (tag !== undefined && Array.isArray(members) && members.includes(code)) tags.push(tag);
  }
  return tags;
}

/** One suggestion from an analysis, already checked against the vocabulary. */
export interface Suggestion {
  tag: string;
  confidence: TagConfidence;
  reason: string;
}

export interface EventTagRow {
  tag_id: string;
  state: EventTagState;
  source: EventTagSource;
  confidence: TagConfidence | null;
  reason: string | null;
}

/**
 * What a new analysis changes: its suggestions are written unless she has
 * already decided on that tag, and the last analysis's suggestions it no
 * longer makes are dropped. Her decisions are never touched.
 */
export function planAnalysis(
  existing: readonly EventTagRow[],
  suggestions: readonly Suggestion[],
): { write: Suggestion[]; drop: string[] } {
  const decided = new Set(existing.filter((row) => row.state !== "suggested").map((row) => row.tag_id));
  const write = suggestions.filter((suggestion) => !decided.has(suggestion.tag));
  const kept = new Set(write.map((suggestion) => suggestion.tag));
  const drop = existing
    .filter((row) => row.state === "suggested" && row.source === "analysis" && !kept.has(row.tag_id))
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
