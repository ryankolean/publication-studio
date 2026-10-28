/**
 * The matching engine (SUMMIT-336): which outlets suit a wedding, best first.
 *
 * Hard filters exclude an outlet only on a known fact that rules it out:
 * coverage, content type, earlier sharing, an earlier answer, freshness and
 * frequency. A fact the research does not have never excludes; it becomes a
 * question for her ("check first"). Outlets that pass are scored out of 100
 * from six parts, each with the line that explains it; a part whose fact is
 * unknown gets half its points and says so. Her history with an outlet, kept
 * by the tool, is the feedback loop: features and acceptances raise it,
 * declines and silence lower it.
 *
 * Pure: no database, no clock. Today, the geo vocabulary and the history
 * arrive as input.
 */

import { locationAncestors, locationLabel, regionTagsForLocation } from "./geo.js";
import type { Geo } from "./geo.js";
import type { PublicationTier } from "./publication.js";
import { CONTENT_TYPES } from "./research/schema.js";
import { seasonTags } from "./style.js";
import type { TagCategory } from "./tags.js";

export type ContentType = (typeof CONTENT_TYPES)[number];

export const EXPOSURE_CHANNELS = ["own_blog", "own_social", "couple_social", "vendor_social", "publication"] as const;
export type ExposureChannel = (typeof EXPOSURE_CHANNELS)[number];

export type ExposureRule = "allowed" | "sneak_peeks_only" | "disqualifies";

export interface ExposureInput {
  channel: ExposureChannel;
  detail: string | null;
  publicationId: string | null;
}

const MAX_EXPOSURES = 20;
const MAX_DETAIL = 120;

/** The "shared yet?" answers as the form sends them; the route checks that a named outlet exists. */
export function validateExposures(raw: unknown): { ok: true; value: ExposureInput[] } | { ok: false; errors: Array<{ field: string; message: string }> } {
  const list = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["exposures"] : undefined;
  if (!Array.isArray(list)) return { ok: false, errors: [{ field: "exposures", message: "Expected a list." }] };
  if (list.length > MAX_EXPOSURES) return { ok: false, errors: [{ field: "exposures", message: `Keep it to ${MAX_EXPOSURES} places.` }] };
  const errors: Array<{ field: string; message: string }> = [];
  const value = list.map((entry: unknown, index): ExposureInput => {
    const item = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const channel = item["channel"];
    if (!(EXPOSURE_CHANNELS as readonly unknown[]).includes(channel)) {
      errors.push({ field: `exposures.${index}.channel`, message: `Expected one of: ${EXPOSURE_CHANNELS.join(", ")}.` });
    }
    const text = (field: "detail" | "publicationId"): string | null => {
      const raw = item[field];
      if (raw === undefined || raw === null) return null;
      if (typeof raw !== "string") {
        errors.push({ field: `exposures.${index}.${field}`, message: "Expected text." });
        return null;
      }
      return raw.trim() === "" ? null : raw.trim();
    };
    const detail = text("detail");
    if (detail !== null && detail.length > MAX_DETAIL) {
      errors.push({ field: `exposures.${index}.detail`, message: `Keep it under ${MAX_DETAIL} characters.` });
    }
    const publicationId = text("publicationId");
    if (publicationId !== null && channel !== "publication") {
      errors.push({ field: `exposures.${index}.publicationId`, message: "Only an earlier publication names an outlet." });
    }
    return { channel: channel as ExposureChannel, detail, publicationId };
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** An outlet's matching facts, projected from its approved research. null is unknown throughout. */
export interface MatchProfile {
  coverage: {
    regions: string[] | null;
    basis: "wedding_location" | "couple_home" | "either" | null;
    destinationAccepted: boolean | null;
  };
  content: Record<ContentType, boolean | null>;
  /** The seasons it asks for, "none" when it takes any. */
  seasons: string[] | "none" | null;
  exclusivity: { policy: "exclusive_required" | "exclusive_preferred" | "non_exclusive"; afterPublicationDays: number | null } | null;
  exposure: { publications: ExposureRule | null; blogs: ExposureRule | null; social: ExposureRule | null };
  freshnessMonths: number | "none" | null;
  frequency: { max: number; perMonths: number } | "none" | null;
  fees: { submission: "none" | "some" | null; publication: "none" | "some" | null };
  /** Its largest stated audience figure. */
  reach: { metric: string; value: number } | null;
}

export interface MatchWedding {
  id: string;
  eventDate: string;
  locationCode: string | null;
  contentType: ContentType;
  isDestination: boolean;
  /** Tags she has confirmed on this wedding. */
  tags: string[];
  exposures: Array<{ channel: ExposureChannel; publicationId: string | null; detail: string | null }>;
}

export interface MatchOutlet {
  id: string;
  name: string;
  tier: PublicationTier;
  /** Its tags as the tool shows them, research and hers. */
  tags: string[];
  /** null until its research is approved. */
  profile: MatchProfile | null;
}

/** One thing that happened between her and an outlet, on any wedding. */
export interface HistoryEntry {
  publicationId: string;
  eventId: string | null;
  kind: "feature" | "accepted" | "declined" | "no_reply";
  /** YYYY-MM-DD or YYYY-MM, when known. */
  at: string | null;
}

export interface MatchContext {
  /** YYYY-MM-DD. */
  today: string;
  geo: Geo | null;
  tagCategories: ReadonlyMap<string, TagCategory>;
  /** Her confirmed tags across her own weddings, most used first. */
  profileTags: string[];
  history: HistoryEntry[];
}

export type MatchGroup = "fits" | "check" | "excluded";

export type MatchPartName = "style" | "relationship" | "reach" | "fees" | "local" | "season";

export interface MatchPart {
  part: MatchPartName;
  points: number;
  max: number;
  note: string;
  unknown: boolean;
}

export interface MatchResult {
  outletId: string;
  group: MatchGroup;
  score: number;
  label: "Strong match" | "Good match" | "Worth a look";
  /** The strongest parts, in her words. */
  reasons: string[];
  /** Questions an unknown fact leaves open. */
  checks: string[];
  /** Why it is not for this wedding. */
  excluded: string[];
  /** A deadline coming up, such as the end of its freshness window. */
  deadline: string | null;
  parts: MatchPart[];
}

export const PART_MAX: Record<MatchPartName, number> = { style: 35, relationship: 20, reach: 15, fees: 15, local: 10, season: 5 };

const STYLE_CATEGORIES: ReadonlySet<TagCategory> = new Set(["landscape_venue", "architecture", "aesthetic", "dress_style"]);
const BROAD = new Set(["WORLD", "US", "INTL"]);
const TIER_ORDER: Record<PublicationTier, number> = { primary: 0, secondary: 1, dream: 2 };
const GROUP_ORDER: Record<MatchGroup, number> = { fits: 0, check: 1, excluded: 2 };
const DAY_MS = 86_400_000;

export const CONTENT_WORDS: Record<ContentType, string> = {
  real_wedding: "real weddings",
  elopement: "elopements",
  styled_shoot: "styled shoots",
};

const CHANNEL_WORDS: Record<ExposureChannel, string> = {
  own_blog: "on your blog",
  own_social: "on your social media",
  couple_social: "by the couple on social media",
  vendor_social: "by a vendor on social media",
  publication: "in another publication",
};

const RULE_FOR: Record<ExposureChannel, keyof MatchProfile["exposure"]> = {
  own_blog: "blogs",
  own_social: "social",
  couple_social: "social",
  vendor_social: "social",
  publication: "publications",
};

const RULE_WORDS: Record<keyof MatchProfile["exposure"], string> = {
  publications: "published elsewhere",
  blogs: "shared on a blog",
  social: "shared on social media",
};

const tagWords = (id: string): string => {
  const words = id.replace(/_/g, " ").replace(/\bus\b/g, "US");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const list = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) as string}`;

const days = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;

/** "2025-06" counts as the first of the month. */
const asDate = (value: string): string => (/^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value);

const addDays = (date: string, count: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);

const friendly = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "about 1.2 million Instagram followers" */
export function reachWords(reach: { metric: string; value: number }): string {
  const value =
    reach.value >= 1_000_000
      ? `${(reach.value / 1_000_000).toFixed(1).replace(/\.0$/, "")} million`
      : reach.value >= 1_000
        ? `${Math.round(reach.value / 1_000)} thousand`
        : String(reach.value);
  const metric = reach.metric
    .replace("instagram_followers", "Instagram followers")
    .replace("facebook_followers", "Facebook followers")
    .replace("tiktok_followers", "TikTok followers")
    .replace("pinterest_monthly_views", "Pinterest views a month")
    .replace("monthly_visitors", "visitors a month")
    .replace("monthly_pageviews", "page views a month")
    .replace("newsletter_subscribers", "newsletter readers")
    .replace("print_circulation", "print readers");
  return `About ${value} ${metric}`;
}

interface Verdicts {
  excluded: string[];
  checks: string[];
  deadline: string | null;
}

function coverageVerdicts(wedding: MatchWedding, profile: MatchProfile, geo: Geo | null, out: Verdicts): void {
  const { regions, basis, destinationAccepted } = profile.coverage;
  if (wedding.isDestination && destinationAccepted === false) out.excluded.push("Does not take destination weddings.");
  if (wedding.isDestination && destinationAccepted === null) out.checks.push("Does not say whether it takes destination weddings.");

  if (regions === null) {
    out.checks.push("Does not say which places it covers.");
    return;
  }
  if (regions.includes("WORLD")) return;
  const places = list(regions.map((code) => (geo === null ? code : locationLabel(code, geo))));
  if (basis === "couple_home") {
    out.checks.push(`Goes by where the couple lives: ${places}. Check that they live there.`);
    return;
  }
  if (wedding.locationCode === null || geo === null) {
    out.checks.push(`Covers only ${places}. Add where the wedding was to check.`);
    return;
  }
  const ancestors = locationAncestors(wedding.locationCode, geo);
  if (regions.some((region) => ancestors.includes(region))) return;
  if (regions.some((region) => region.startsWith(`${wedding.locationCode}:`))) {
    out.checks.push(`Covers only ${places}. Pick the wedding's metro to check.`);
    return;
  }
  const here = locationLabel(wedding.locationCode, geo);
  if (basis === "wedding_location") out.excluded.push(`Covers only ${places}; this wedding was in ${here}.`);
  else if (basis === "either") out.checks.push(`Covers ${places}, where the wedding or the couple is from. Check where the couple lives.`);
  else out.checks.push(`Covers only ${places}, and does not say whether that means the wedding or the couple's home.`);
}

function exposureVerdicts(wedding: MatchWedding, outlet: MatchOutlet, profile: MatchProfile, out: Verdicts): void {
  if (wedding.exposures.some((exposure) => exposure.channel === "publication" && exposure.publicationId === outlet.id)) {
    out.excluded.push("Has already run this wedding.");
    return;
  }
  const byRule = new Map<keyof MatchProfile["exposure"], string[]>();
  for (const exposure of wedding.exposures) {
    const rule = RULE_FOR[exposure.channel];
    const where = CHANNEL_WORDS[exposure.channel] + (exposure.detail === null ? "" : ` (${exposure.detail})`);
    byRule.set(rule, [...(byRule.get(rule) ?? []), where]);
  }
  for (const [rule, wheres] of byRule) {
    const verdict = profile.exposure[rule];
    const where = `This wedding was shared ${list(wheres)}.`;
    if (verdict === "disqualifies") out.excluded.push(`Takes only weddings not already ${RULE_WORDS[rule]}. ${where}`);
    else if (verdict === "sneak_peeks_only") out.checks.push(`Allows only a few sneak peeks before it publishes. ${where} Check it was only a few photos.`);
    else if (verdict === null) out.checks.push(`Does not say whether a wedding ${RULE_WORDS[rule]} counts. ${where}`);
  }
}

function historyVerdicts(wedding: MatchWedding, outlet: MatchOutlet, profile: MatchProfile | null, context: MatchContext, out: Verdicts): void {
  const here = context.history.filter((entry) => entry.publicationId === outlet.id);
  if (here.some((entry) => entry.eventId === wedding.id && entry.kind === "declined")) out.excluded.push("Declined this wedding.");
  if (here.some((entry) => entry.eventId === wedding.id && (entry.kind === "feature" || entry.kind === "accepted"))) {
    out.excluded.push("Is already featuring this wedding.");
  }

  const frequency = profile?.frequency ?? null;
  const features = here.filter((entry) => entry.kind === "feature" && entry.at !== null);
  if (frequency !== null && frequency !== "none") {
    const recent = features.filter((entry) => days(asDate(entry.at as string), context.today) <= frequency.perMonths * 30.44);
    if (recent.length >= frequency.max) {
      out.excluded.push(`Features the same photographer at most ${frequency.max} times in ${frequency.perMonths} months; you have ${recent.length}.`);
    }
  } else if (frequency === null && features.some((entry) => days(asDate(entry.at as string), context.today) <= 365)) {
    out.checks.push("Featured you in the last year, and does not say how often it features the same photographer.");
  }
}

function freshnessVerdicts(wedding: MatchWedding, profile: MatchProfile, today: string, out: Verdicts): void {
  const age = days(wedding.eventDate, today) / 30.44;
  const window = profile.freshnessMonths;
  if (typeof window === "number") {
    const closes = addDays(wedding.eventDate, Math.round(window * 30.44));
    if (age > window) out.excluded.push(`Takes weddings up to ${window} months old; this one is ${Math.floor(age)} months old.`);
    else if (days(today, closes) <= 31) out.deadline = `Its ${window}-month window for this wedding closes around ${friendly(closes)}.`;
  } else if (window === null && age > 12) {
    out.checks.push(`Does not say how recent a wedding must be; this one is ${Math.floor(age)} months old.`);
  }
}

/** Another outlet that published this wedding may hold it exclusively for a while. */
function embargoVerdicts(wedding: MatchWedding, outlet: MatchOutlet, others: ReadonlyMap<string, MatchOutlet>, context: MatchContext, out: Verdicts): void {
  for (const entry of context.history) {
    if (entry.eventId !== wedding.id || entry.kind !== "feature" || entry.publicationId === outlet.id || entry.at === null) continue;
    const other = others.get(entry.publicationId);
    const hold = other?.profile?.exclusivity?.afterPublicationDays ?? null;
    if (other === undefined || hold === null) continue;
    const until = addDays(asDate(entry.at), hold);
    if (until > context.today) out.excluded.push(`${other.name} published this wedding and holds it exclusively until ${friendly(until)}.`);
  }
}

function styleSource(wedding: MatchWedding, context: MatchContext): { tags: string[]; fromProfile: boolean } {
  const styled = (tags: string[]) => tags.filter((tag) => STYLE_CATEGORIES.has(context.tagCategories.get(tag) as TagCategory));
  const own = styled(wedding.tags);
  if (own.length > 0) return { tags: own, fromProfile: false };
  return { tags: styled(context.profileTags).slice(0, 8), fromProfile: true };
}

function scoreParts(wedding: MatchWedding, outlet: MatchOutlet, context: MatchContext): MatchPart[] {
  const profile = outlet.profile;
  const parts: MatchPart[] = [];
  const part = (name: MatchPartName, fraction: number | null, note: string) =>
    parts.push({
      part: name,
      points: Math.round(PART_MAX[name] * (fraction ?? 0.5) * 10) / 10,
      max: PART_MAX[name],
      note,
      unknown: fraction === null,
    });

  // Style: her tags for this wedding, else her profile, against the outlet's.
  const source = styleSource(wedding, context);
  const outletStyle = outlet.tags.filter((tag) => STYLE_CATEGORIES.has(context.tagCategories.get(tag) as TagCategory));
  if (source.tags.length === 0) part("style", null, "No style tags kept yet, for this wedding or your profile.");
  else if (outletStyle.length === 0) part("style", null, "Its style is not tagged yet.");
  else {
    const shared = source.tags.filter((tag) => outletStyle.includes(tag));
    const fraction = Math.min(1, shared.length / Math.min(source.tags.length, 4));
    const lead = source.fromProfile ? "From your style profile: " : "";
    part("style", fraction, shared.length === 0 ? `${lead}No style tags in common.` : `${lead}Shares ${list(shared.map(tagWords))}.`);
  }

  // Relationship: her history with the outlet on any wedding.
  const here = context.history.filter((entry) => entry.publicationId === outlet.id);
  const positive = here.filter((entry) => entry.kind === "feature" || entry.kind === "accepted").length;
  const declines = here.filter((entry) => entry.kind === "declined" && (entry.at === null || days(asDate(entry.at), context.today) <= 730)).length;
  const silent = here.filter((entry) => entry.kind === "no_reply").length;
  const relationship = Math.max(0, Math.min(1, 0.5 + 0.25 * positive - 0.15 * declines - 0.05 * silent));
  const history = [
    ...(positive > 0 ? [`Featured or accepted your work ${positive === 1 ? "once" : `${positive} times`}`] : []),
    ...(declines > 0 ? [`declined ${declines === 1 ? "once" : `${declines} times`} in the last two years`] : []),
    ...(silent > 0 ? [`did not reply ${silent === 1 ? "once" : `${silent} times`}`] : []),
  ];
  part("relationship", relationship, history.length === 0 ? "No history with you yet." : `${list(history)}.`.replace(/^./, (c) => c.toUpperCase()));

  // Reach: its largest stated audience, on a log scale from ten thousand to about three million.
  const reach = profile?.reach ?? null;
  if (reach === null) part("reach", null, "Audience size unknown.");
  else part("reach", Math.max(0, Math.min(1, (Math.log10(reach.value) - 4) / 2.5)), `${reachWords(reach)}.`);

  // Fees: free scores best; a submission fee less; paying to publish least.
  const fees = profile?.fees ?? { submission: null, publication: null };
  const feeScore = (value: "none" | "some" | null, some: number) => (value === null ? 0.5 : value === "none" ? 1 : some);
  const feeUnknown = fees.submission === null || fees.publication === null;
  const feeFraction = (feeScore(fees.submission, 0.4) + feeScore(fees.publication, 0)) / 2;
  const feeNote =
    fees.publication === "some"
      ? "Charges to publish."
      : fees.submission === "some"
        ? "Charges to submit."
        : fees.submission === "none" && fees.publication === "none"
          ? "Free to submit and publish."
          : "Fees not stated.";
  parts.push({ part: "fees", points: Math.round(PART_MAX.fees * feeFraction * 10) / 10, max: PART_MAX.fees, note: feeNote, unknown: feeUnknown });

  // Local focus: an outlet that covers this place specifically, or tags weddings from it.
  const geo = context.geo;
  if (wedding.locationCode === null || geo === null) part("local", null, "Add where the wedding was to check for local outlets.");
  else {
    const ancestors = locationAncestors(wedding.locationCode, geo);
    const regions = profile?.coverage.regions ?? [];
    const specific = regions.find((region) => !BROAD.has(region) && ancestors.includes(region));
    const regionTag = regionTagsForLocation(wedding.locationCode, geo).find((tag) => outlet.tags.includes(tag));
    if (specific !== undefined) part("local", 1, `Covers ${locationLabel(specific, geo)} specifically.`);
    else if (regionTag !== undefined) part("local", 1, `Features ${tagWords(regionTag)} weddings.`);
    else part("local", 0, "A national or international outlet.");
  }

  // Season: what it asks for against the wedding's season.
  const seasons = profile?.seasons ?? null;
  const weddingSeasons = seasonTags(wedding.eventDate);
  if (seasons === null) part("season", null, "Does not say which seasons it wants.");
  else if (seasons === "none") part("season", 1, "Takes any season.");
  else if (seasons.some((season) => weddingSeasons.includes(season))) part("season", 1, `Asks for ${list(seasons.map(tagWords))} weddings.`);
  else part("season", 0.2, `Asks for ${list(seasons.map(tagWords))} weddings.`);

  return parts;
}

/** One outlet against one wedding. */
export function matchOutlet(
  wedding: MatchWedding,
  outlet: MatchOutlet,
  context: MatchContext,
  others: ReadonlyMap<string, MatchOutlet> = new Map(),
): MatchResult {
  const out: Verdicts = { excluded: [], checks: [], deadline: null };
  const profile = outlet.profile;
  if (profile === null) {
    out.checks.push("Not researched yet: its coverage, rules and fees are unknown.");
  } else {
    coverageVerdicts(wedding, profile, context.geo, out);
    const offered = profile.content[wedding.contentType];
    if (offered === false) out.excluded.push(`Does not publish ${CONTENT_WORDS[wedding.contentType]}.`);
    if (offered === null) out.checks.push(`Does not say whether it publishes ${CONTENT_WORDS[wedding.contentType]}.`);
    exposureVerdicts(wedding, outlet, profile, out);
    freshnessVerdicts(wedding, profile, context.today, out);
  }
  historyVerdicts(wedding, outlet, profile, context, out);
  embargoVerdicts(wedding, outlet, others, context, out);

  const parts = scoreParts(wedding, outlet, context);
  const score = Math.round(parts.reduce((sum, part) => sum + part.points, 0));
  const reasons = parts
    .filter((part) => !part.unknown && part.points / part.max >= 0.6)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((part) => part.note);

  return {
    outletId: outlet.id,
    group: out.excluded.length > 0 ? "excluded" : out.checks.length > 0 ? "check" : "fits",
    score,
    label: score >= 75 ? "Strong match" : score >= 60 ? "Good match" : "Worth a look",
    reasons,
    checks: out.checks,
    excluded: out.excluded,
    // A deadline is only worth saying for an outlet she can still send to.
    deadline: out.excluded.length > 0 ? null : out.deadline,
    parts,
  };
}

/** Every outlet for one wedding: fits first, then check first, then excluded, each best score first. */
export function rankOutlets(wedding: MatchWedding, outlets: readonly MatchOutlet[], context: MatchContext): MatchResult[] {
  const byId = new Map(outlets.map((outlet) => [outlet.id, outlet]));
  return outlets
    .map((outlet) => ({ outlet, result: matchOutlet(wedding, outlet, context, byId) }))
    .sort(
      (a, b) =>
        GROUP_ORDER[a.result.group] - GROUP_ORDER[b.result.group] ||
        b.result.score - a.result.score ||
        TIER_ORDER[a.outlet.tier] - TIER_ORDER[b.outlet.tier] ||
        a.outlet.name.localeCompare(b.outlet.name),
    )
    .map(({ result }) => result);
}
