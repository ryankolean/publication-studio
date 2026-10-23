/**
 * Event intake validation -- design doc section 7.1, the ten-section form.
 *
 * The SPA is untrusted, so this is where an intake payload becomes an event.
 * Two rules shape the whole module:
 *
 *  1. Every problem is reported at once. Intake is a long form; returning one
 *     error at a time turns it into a guessing game.
 *  2. Nothing is coerced into a permission. An unrecognised rights or consent
 *     value is an error, never a silent fallback, and both default to
 *     unverified -- the state that blocks packaging.
 */

import { CONSENT_STATUSES, RIGHTS_STATUSES } from "./rights-gate.js";
import type { ConsentStatus, RightsStatus } from "./rights-gate.js";

export interface VendorCreditInput {
  role: string;
  businessName: string;
  website: string | null;
  instagram: string | null;
}

export interface PriorExposure {
  ownBlog: boolean;
  igPosted: boolean;
  priorPubs: string[];
}

export interface EventIntake {
  coupleNames: string;
  eventDate: string;
  venueName: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  galleryUrl: string | null;
  styleTags: string[];
  uniqueAngle: string | null;
  rightsStatus: RightsStatus;
  consentStatus: ConsentStatus;
  consentNotes: string | null;
  nameDisplay: string | null;
  coupleStory: string | null;
  isDestination: boolean;
  heroPicks: string | null;
  videoUrl: string | null;
  targetOutletNotes: string | null;
  priorExposure: PriorExposure;
  vendorCredits: VendorCreditInput[];
}

export interface FieldError {
  field: string;
  message: string;
}

export type IntakeResult =
  | { ok: true; value: EventIntake }
  | { ok: false; errors: FieldError[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A real calendar date, not merely a well-shaped string. 2026-02-30 is not one. */
export function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Only http and https. A gallery URL is rendered as a link and carries an
 * invite token; javascript: and data: URLs must never reach that surface.
 */
export function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

class Collector {
  readonly errors: FieldError[] = [];

  add(field: string, message: string): void {
    this.errors.push({ field, message });
  }

  requiredText(source: Record<string, unknown>, field: string): string {
    const value = source[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      this.add(field, "This field is required.");
      return "";
    }
    return value.trim();
  }

  optionalText(source: Record<string, unknown>, field: string): string | null {
    const value = source[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      this.add(field, "Expected text.");
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  optionalUrl(source: Record<string, unknown>, field: string): string | null {
    const value = this.optionalText(source, field);
    if (value === null) return null;
    if (!isSafeUrl(value)) {
      this.add(field, "Enter a full http or https address.");
      return null;
    }
    return value;
  }

  optionalBool(source: Record<string, unknown>, field: string, fallback: boolean): boolean {
    const value = source[field];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "boolean") {
      this.add(field, "Expected true or false.");
      return fallback;
    }
    return value;
  }

  enumValue<T extends string>(
    source: Record<string, unknown>,
    field: string,
    allowed: readonly T[],
    fallback: T,
  ): T {
    const value = source[field];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.add(field, `Expected one of: ${allowed.join(", ")}.`);
      return fallback;
    }
    return value as T;
  }
}

function readStyleTags(source: Record<string, unknown>, errors: Collector): string[] {
  const value = source["styleTags"];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.add("styleTags", "Expected a list of tags.");
    return [];
  }
  if (value.some((entry) => typeof entry !== "string")) {
    errors.add("styleTags", "Every tag must be text.");
    return [];
  }
  const trimmed = (value as string[]).map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  return [...new Set(trimmed)];
}

function readPriorExposure(source: Record<string, unknown>, errors: Collector): PriorExposure {
  const fallback: PriorExposure = { ownBlog: false, igPosted: false, priorPubs: [] };
  const value = source["priorExposure"];
  if (value === undefined || value === null) return fallback;
  if (!isObject(value)) {
    errors.add("priorExposure", "Expected an object.");
    return fallback;
  }

  const readFlag = (field: "ownBlog" | "igPosted"): boolean => {
    const flag = value[field];
    if (flag === undefined || flag === null) return false;
    if (typeof flag !== "boolean") {
      errors.add(`priorExposure.${field}`, "Expected true or false.");
      return false;
    }
    return flag;
  };

  let priorPubs: string[] = [];
  const rawPubs = value["priorPubs"];
  if (rawPubs !== undefined && rawPubs !== null) {
    if (!Array.isArray(rawPubs) || rawPubs.some((entry) => typeof entry !== "string")) {
      errors.add("priorExposure.priorPubs", "Expected a list of publication names.");
    } else {
      priorPubs = (rawPubs as string[]).map((p) => p.trim()).filter((p) => p.length > 0);
    }
  }

  return { ownBlog: readFlag("ownBlog"), igPosted: readFlag("igPosted"), priorPubs };
}

function readVendorCredits(
  source: Record<string, unknown>,
  errors: Collector,
): VendorCreditInput[] {
  const value = source["vendorCredits"];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.add("vendorCredits", "Expected a list of vendor rows.");
    return [];
  }

  const credits: VendorCreditInput[] = [];

  value.forEach((entry, index) => {
    const prefix = `vendorCredits.${index}`;
    if (!isObject(entry)) {
      errors.add(prefix, "Expected a vendor row.");
      return;
    }

    const row = new Collector();
    const role = row.requiredText(entry, "role");
    const businessName = row.requiredText(entry, "businessName");
    const website = row.optionalUrl(entry, "website");
    const rawInstagram = row.optionalText(entry, "instagram");

    for (const error of row.errors) errors.add(`${prefix}.${error.field}`, error.message);
    if (row.errors.length > 0) return;

    credits.push({
      role,
      businessName,
      website,
      // Publications want a handle, and photographers paste all three forms.
      instagram:
        rawInstagram === null
          ? null
          : rawInstagram
              .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
              .replace(/^@/, "")
              .replace(/\/+$/, ""),
    });
  });

  return credits;
}

export function validateEventIntake(input: unknown): IntakeResult {
  if (!isObject(input)) {
    return { ok: false, errors: [{ field: "", message: "Expected the wedding's details." }] };
  }

  const errors = new Collector();

  const coupleNames = errors.requiredText(input, "coupleNames");

  const eventDate = errors.requiredText(input, "eventDate");
  if (eventDate.length > 0 && !isRealDate(eventDate)) {
    errors.add("eventDate", "Enter a real date as yyyy-mm-dd.");
  }

  const value: EventIntake = {
    coupleNames,
    eventDate,
    venueName: errors.optionalText(input, "venueName"),
    city: errors.optionalText(input, "city"),
    state: errors.optionalText(input, "state"),
    country: errors.optionalText(input, "country"),
    galleryUrl: errors.optionalUrl(input, "galleryUrl"),
    styleTags: readStyleTags(input, errors),
    uniqueAngle: errors.optionalText(input, "uniqueAngle"),
    rightsStatus: errors.enumValue(input, "rightsStatus", RIGHTS_STATUSES, "unverified"),
    consentStatus: errors.enumValue(input, "consentStatus", CONSENT_STATUSES, "unverified"),
    consentNotes: errors.optionalText(input, "consentNotes"),
    nameDisplay: errors.optionalText(input, "nameDisplay"),
    coupleStory: errors.optionalText(input, "coupleStory"),
    isDestination: errors.optionalBool(input, "isDestination", false),
    heroPicks: errors.optionalText(input, "heroPicks"),
    videoUrl: errors.optionalUrl(input, "videoUrl"),
    targetOutletNotes: errors.optionalText(input, "targetOutletNotes"),
    priorExposure: readPriorExposure(input, errors),
    vendorCredits: readVendorCredits(input, errors),
  };

  return errors.errors.length > 0 ? { ok: false, errors: errors.errors } : { ok: true, value };
}
