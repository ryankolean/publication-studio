/**
 * The Claude connector's wedding tools, save_wedding and confirm_permissions
 * (SUMMIT-344): turning the tool's plain arguments into the record the web
 * app's own routes validate and save. Pure.
 *
 * Two things only confirm_permissions may change: the permission answers,
 * which open the rights gate, and nothing here ever sets the gallery link,
 * which is a credential and never passes through a chat.
 */

import type { EventIntake, VendorCreditInput } from "./event-intake.js";
import type { ConsentStatus, RightsStatus } from "./rights-gate.js";

export type CoupleAgreed = "yes" | "yes_with_limits" | "not_yet" | "no";

export interface PermissionsRecord {
  rightsStatus: RightsStatus;
  consentStatus: ConsentStatus;
  consentNotes: string | null;
}

const CONSENT_FOR: Readonly<Record<CoupleAgreed, ConsentStatus>> = {
  yes: "granted",
  yes_with_limits: "granted_limited",
  not_yet: "unverified",
  no: "declined",
};

/**
 * Her answers as the web app's permissions screen records them: "No" to the
 * lead question means second shooter, and limits are kept unless the couple
 * agreed without any.
 */
export function permissionsRecord(input: {
  leadPhotographer: boolean;
  coupleAgreed: CoupleAgreed;
  limits?: string | undefined;
}): { ok: true; record: PermissionsRecord } | { ok: false; message: string } {
  const limits = input.limits?.trim() ? input.limits.trim() : null;
  if (input.coupleAgreed === "yes_with_limits" && limits === null) {
    return { ok: false, message: "Say what the couple's limits are, for example first names only." };
  }
  return {
    ok: true,
    record: {
      rightsStatus: input.leadPhotographer ? "own_contract" : "second_shooter",
      consentStatus: CONSENT_FOR[input.coupleAgreed],
      consentNotes: input.coupleAgreed === "yes" ? null : limits,
    },
  };
}

/** Exactly what will be recorded, in her words, for her to say yes to. */
export function permissionsPreview(coupleNames: string, record: PermissionsRecord): string[] {
  const rights =
    record.rightsStatus === "own_contract"
      ? "You were the lead photographer, under your own contract."
      : "You were not the lead photographer under your own contract.";
  const consent = {
    granted: "The couple agreed to a submission.",
    granted_limited: `The couple agreed to a submission, with these limits: ${record.consentNotes ?? ""}`,
    unverified: "The couple has not answered yet.",
    declined: "The couple said no.",
  }[record.consentStatus];
  return [`For ${coupleNames}:`, rights, consent];
}

export interface SaveWeddingArgs {
  couple_names?: string | undefined;
  date?: string | undefined;
  venue?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  country?: string | undefined;
  story?: string | undefined;
  angle?: string | undefined;
  names_in_print?: string | undefined;
  destination?: boolean | undefined;
  kind?: EventIntake["contentType"] | undefined;
  hero_picks?: string | undefined;
  video_link?: string | undefined;
  outlet_notes?: string | undefined;
  vendors?: Array<{ role: string; business: string; website?: string | undefined; instagram?: string | undefined }> | undefined;
}

/** The fields save_wedding may change; never the permission answers or the gallery link. */
export type WeddingChanges = Partial<
  Pick<
    EventIntake,
    | "coupleNames"
    | "eventDate"
    | "venueName"
    | "city"
    | "state"
    | "country"
    | "locationCode"
    | "coupleStory"
    | "uniqueAngle"
    | "nameDisplay"
    | "isDestination"
    | "contentType"
    | "heroPicks"
    | "videoUrl"
    | "targetOutletNotes"
    | "vendorCredits"
  >
>;

const ARG_FIELDS = [
  ["couple_names", "coupleNames"],
  ["date", "eventDate"],
  ["venue", "venueName"],
  ["city", "city"],
  ["state", "state"],
  ["country", "country"],
  ["story", "coupleStory"],
  ["angle", "uniqueAngle"],
  ["names_in_print", "nameDisplay"],
  ["destination", "isDestination"],
  ["kind", "contentType"],
  ["hero_picks", "heroPicks"],
  ["video_link", "videoUrl"],
  ["outlet_notes", "targetOutletNotes"],
] as const satisfies ReadonlyArray<readonly [keyof SaveWeddingArgs, keyof WeddingChanges]>;

/** Only what was given; `place` is resolved separately (matchPlace) into locationCode. */
export function weddingChanges(args: SaveWeddingArgs): WeddingChanges {
  const changes: Record<string, unknown> = {};
  for (const [arg, field] of ARG_FIELDS) {
    if (args[arg] !== undefined) changes[field] = args[arg];
  }
  if (args.vendors !== undefined) {
    changes["vendorCredits"] = args.vendors.map(
      (vendor): VendorCreditInput => ({
        role: vendor.role,
        businessName: vendor.business,
        website: vendor.website ?? null,
        instagram: vendor.instagram ?? null,
      }),
    );
  }
  return changes as WeddingChanges;
}

/** A saved wedding as the record holds it, without the gallery link. */
export type CurrentWedding = Omit<EventIntake, "galleryUrl">;

const EDITABLE: ReadonlyArray<keyof WeddingChanges> = [...ARG_FIELDS.map(([, field]) => field), "locationCode", "vendorCredits"];

const NEW_WEDDING: Omit<CurrentWedding, "coupleNames" | "eventDate"> = {
  venueName: null,
  city: null,
  state: null,
  country: null,
  uniqueAngle: null,
  rightsStatus: "unverified",
  consentStatus: "unverified",
  consentNotes: null,
  nameDisplay: null,
  coupleStory: null,
  isDestination: false,
  heroPicks: null,
  videoUrl: null,
  targetOutletNotes: null,
  locationCode: null,
  contentType: "real_wedding",
  vendorCredits: [],
};

/**
 * The whole record to validate and save: the current one (or a new one) with
 * the changes laid over it. Only EDITABLE fields are taken from the changes,
 * so the permission answers always stay as they were; the gallery link is
 * sent as null, which the update route reads as "unchanged".
 */
export function mergeWedding(current: CurrentWedding | null, changes: WeddingChanges): Record<string, unknown> {
  const base: Record<string, unknown> = { ...NEW_WEDDING, ...(current ?? {}) };
  for (const field of EDITABLE) {
    if (changes[field] !== undefined) base[field] = changes[field];
  }
  return { ...base, galleryUrl: null };
}

const ARG_NAME: ReadonlyMap<string, string> = new Map<string, string>([
  ...ARG_FIELDS.map(([arg, field]) => [field, arg] as [string, string]),
  ["locationCode", "place"],
  ["vendorCredits", "vendors"],
  ["businessName", "business"],
]);

/** A validation error's field, as the tool's argument is named: "vendorCredits.2.businessName" reads "vendors.2.business". */
export function toolField(field: string): string {
  return field
    .split(".")
    .map((part) => ARG_NAME.get(part) ?? part)
    .join(".");
}

const STOP_WORDS = new Set(["the", "in", "at", "of", "near", "area"]);
const MAX_CANDIDATES = 5;

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));

/**
 * A place given as a code or a name, against the location list. A name
 * resolves when its every word starts a word of exactly one place's name, or
 * matches one place's name outright; otherwise the closest places come back,
 * most words in common first.
 */
export function matchPlace(
  query: string,
  options: ReadonlyArray<{ code: string; label: string }>,
): { code: string } | { candidates: Array<{ code: string; label: string }> } {
  const byCode = options.find((option) => option.code.toLowerCase() === query.trim().toLowerCase());
  if (byCode !== undefined) return { code: byCode.code };

  const asked = words(query);
  const scored = options.map((option) => {
    const label = words(option.label);
    return { option, label, hits: asked.filter((word) => label.some((part) => part.startsWith(word))).length };
  });

  const strong = scored.filter((entry) => asked.length > 0 && entry.hits === asked.length);
  if (strong.length === 1) return { code: strong[0]!.option.code };
  const exact = strong.find((entry) => entry.label.join(" ") === asked.join(" "));
  if (exact !== undefined) return { code: exact.option.code };

  const closest = scored
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.option);
  return { candidates: closest };
}

/** What a wedding still needs, leaving out the gallery link: photos arrive by upload link, not through chat. */
export function stillNeeded(items: ReadonlyArray<{ id: string; label: string; done: boolean }>): string[] {
  return items.filter((item) => !item.done && item.id !== "gallery_link").map((item) => item.label);
}
