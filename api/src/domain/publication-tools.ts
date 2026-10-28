/**
 * What the Claude connector's publications and rank_publications_for_wedding
 * tools say (SUMMIT-344 slice 4). Spec section 6a: the publication research
 * never goes into Claude's context in full. A list gives one line per outlet,
 * one outlet gives a short fact card, and the full record is asked for.
 *
 * DECISION: cards are worked out from the projected research on every call
 * rather than stored. They are a few fields of plain words over columns the
 * tool already keeps, so a stored copy could only fall out of date.
 *
 * Pure: no database, no clock, no network.
 */

import { locationAncestors, locationLabel } from "./geo.js";
import type { Geo } from "./geo.js";
import { CONTENT_WORDS, reachWords } from "./match.js";
import type { ContentType, MatchGroup, MatchProfile, MatchResult } from "./match.js";
import { requirementLabel } from "./package-checklist.js";
import type { PublicationSpec } from "./publication-spec.js";
import type { EarnedOrPaid, ExclusivityPolicy, PublicationTier, SubmissionMethod } from "./publication.js";

/** The fields a card reads; the publications loader's view has them all. */
export interface CardOutlet {
  id: string;
  name: string;
  tier: PublicationTier;
  method: SubmissionMethod | null;
  submissionUrl: string | null;
  contactEmail: string | null;
  spec: PublicationSpec;
  exclusivityPolicy: ExclusivityPolicy;
  typicalResponseDays: number | null;
  responseWindowNote: string | null;
  earnedOrPaid: EarnedOrPaid;
  tasteNotes: string | null;
  lastVerified: string;
  tags: string[];
  matchProfile: MatchProfile | null;
}

const PAGE = 10;
const MAX_ABOUT = 300;
const MAX_STYLES = 8;

/** The first sentence of a description, for a list line. */
export function firstSentence(text: string | null): string | null {
  if (text === null || text.trim() === "") return null;
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

/** A description cut at a word under the limit, so a long one never fills the chat. */
function clip(text: string | null, max: number): string | null {
  if (text === null || text.trim() === "") return null;
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const space = trimmed.lastIndexOf(" ", max - 3);
  return `${trimmed.slice(0, space > 0 ? space : max - 3)}...`;
}

/** "a, b and c" */
function list(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const METHOD_WORDS: Record<SubmissionMethod, string> = {
  portal: "its own submission portal",
  web_form: "a form on its site",
  email: "email",
  aggregator: "a submission service such as Two Bright Lights",
};

export interface OutletLine {
  id: string;
  name: string;
  tier: PublicationTier;
  about: string | null;
  /** Its research is not approved yet, so most of its facts are unknown. */
  unresearched?: true;
  /** A filter asked about something it does not say. */
  unsure?: string[];
}

/** One outlet in a list. */
export function outletLine(outlet: CardOutlet, unsure: readonly string[] = []): OutletLine {
  return {
    id: outlet.id,
    name: outlet.name,
    tier: outlet.tier,
    about: firstSentence(outlet.tasteNotes),
    ...(outlet.matchProfile === null ? { unresearched: true as const } : {}),
    ...(unsure.length > 0 ? { unsure: [...unsure] } : {}),
  };
}

function takesWords(profile: MatchProfile): { takes: string | null; doesNotTake: string | null } {
  const kinds = Object.entries(profile.content) as Array<[ContentType, boolean | null]>;
  const yes = kinds.filter(([, value]) => value === true).map(([kind]) => CONTENT_WORDS[kind]);
  const no = kinds.filter(([, value]) => value === false).map(([kind]) => CONTENT_WORDS[kind]);
  return { takes: yes.length > 0 ? list(yes) : null, doesNotTake: no.length > 0 ? list(no) : null };
}

const BASIS_WORDS: Record<NonNullable<MatchProfile["coverage"]["basis"]>, string> = {
  wedding_location: "by where the wedding was",
  couple_home: "by where the couple lives",
  either: "by where the wedding was or where the couple lives",
};

function whereWords(profile: MatchProfile, geo: Geo | null): string | null {
  const { regions, basis, destinationAccepted } = profile.coverage;
  if (regions === null) return null;
  const places = regions.includes("WORLD") ? "Anywhere" : list(regions.map((code) => (geo === null ? code : locationLabel(code, geo))));
  const parts = [places];
  if (basis !== null && !regions.includes("WORLD")) parts.push(BASIS_WORDS[basis]);
  if (destinationAccepted === false) parts.push("no destination weddings");
  return parts.join(", ");
}

function feeWords(profile: MatchProfile | null, earnedOrPaid: EarnedOrPaid): string | null {
  const fees = profile?.fees;
  const submit = fees?.submission === "none" ? "free to submit" : fees?.submission === "some" ? "charges to submit" : null;
  const publish =
    fees?.publication === "none"
      ? "no fee to be featured"
      : fees?.publication === "some" || earnedOrPaid === "paid"
        ? "paid placement"
        : earnedOrPaid === "earned"
          ? "no fee to be featured"
          : null;
  const words = [submit, publish].filter((part): part is string => part !== null);
  return words.length > 0 ? words.join(", ") : null;
}

function exclusiveWords(profile: MatchProfile | null, policy: ExclusivityPolicy): string | null {
  const known = profile?.exclusivity ?? (policy === "unknown" ? null : { policy, afterPublicationDays: null });
  if (known === null) return null;
  const base =
    known.policy === "exclusive_required"
      ? "wants it unpublished elsewhere"
      : known.policy === "exclusive_preferred"
        ? "prefers it unpublished elsewhere"
        : "does not need it to be exclusive";
  return known.afterPublicationDays === null ? base : `${base}, and holds it for ${known.afterPublicationDays} days after it runs`;
}

function freshWords(profile: MatchProfile): string | null {
  const window = profile.freshnessMonths;
  if (window === null) return null;
  return window === "none" ? "any age of wedding" : `weddings up to ${window} months old`;
}

function repliesWords(outlet: CardOutlet): string | null {
  if (outlet.typicalResponseDays !== null) return `usually replies within ${outlet.typicalResponseDays} days`;
  return clip(outlet.responseWindowNote, 120);
}

export interface FactCard {
  id: string;
  name: string;
  tier: PublicationTier;
  about: string | null;
  /** Its research is not approved yet, so most of its facts are unknown. */
  unresearched?: true;
  takes?: string;
  doesNotTake?: string;
  where?: string;
  send?: string;
  fees?: string;
  exclusive?: string;
  fresh?: string;
  replies?: string;
  reach?: string;
  styles?: string[];
  /** Facts it does not state, so Claude can say so rather than guess. */
  unknown?: string[];
  checked: string;
}

/**
 * One outlet in a few plain fields. Anything the research does not state is
 * left out and named under unknown.
 */
export function factCard(outlet: CardOutlet, geo: Geo | null): FactCard {
  const profile = outlet.matchProfile;
  const takes = profile === null ? null : takesWords(profile);
  const facts = {
    takes: takes?.takes ?? null,
    where: profile === null ? null : whereWords(profile, geo),
    send: outlet.method === null ? null : METHOD_WORDS[outlet.method],
    fees: feeWords(profile, outlet.earnedOrPaid),
    exclusive: exclusiveWords(profile, outlet.exclusivityPolicy),
    fresh: profile === null ? null : freshWords(profile),
    replies: repliesWords(outlet),
    reach: profile?.reach == null ? null : reachWords(profile.reach),
  };
  const entries = Object.entries(facts) as Array<[keyof typeof facts, string | null]>;
  const unknown = entries.filter(([, value]) => value === null).map(([field]) => field);
  return {
    id: outlet.id,
    name: outlet.name,
    tier: outlet.tier,
    about: clip(outlet.tasteNotes, MAX_ABOUT),
    ...(profile === null ? { unresearched: true as const } : {}),
    ...Object.fromEntries(entries.filter(([, value]) => value !== null)),
    ...(takes?.doesNotTake == null ? {} : { doesNotTake: takes.doesNotTake }),
    ...(outlet.tags.length > 0 ? { styles: outlet.tags.slice(0, MAX_STYLES) } : {}),
    ...(unknown.length > 0 ? { unknown } : {}),
    checked: outlet.lastVerified,
  };
}

/** The card plus what she needs to prepare and send a package. */
export function outletDetail(outlet: CardOutlet, geo: Geo | null) {
  const { spec } = outlet;
  const images =
    spec.imgMin !== null && spec.imgMax !== null
      ? `${spec.imgMin} to ${spec.imgMax}`
      : spec.imgMin !== null
        ? `at least ${spec.imgMin}`
        : spec.imgMax !== null
          ? `at most ${spec.imgMax}`
          : null;
  const pack = {
    ...(images === null ? {} : { images }),
    ...(spec.size === "unknown" ? {} : { size: spec.size === "web" ? "web-size files" : "print-size files" }),
    ...(spec.watermarksAllowed === null ? {} : { watermarks: spec.watermarksAllowed ? "allowed" : "not allowed" }),
    ...(spec.videoAccepted === null ? {} : { video: spec.videoAccepted ? "accepted" : "not accepted" }),
    ...(spec.requirements.length === 0 ? {} : { requirements: spec.requirements.map(requirementLabel) }),
  };
  return {
    ...factCard(outlet, geo),
    styles: outlet.tags,
    ...(outlet.submissionUrl === null ? {} : { submitAt: outlet.submissionUrl }),
    ...(outlet.contactEmail === null ? {} : { email: outlet.contactEmail }),
    ...(outlet.responseWindowNote === null ? {} : { repliesNote: outlet.responseWindowNote }),
    package: pack,
  };
}

export interface PublicationFilters {
  /** A place code: a state, a metro or a country. */
  place?: string;
  /** Vocabulary tags; an outlet with any of them passes. */
  styles?: string[];
  kind?: ContentType;
  /** YYYY-MM-DD: the wedding date, to keep outlets whose freshness window still covers it. */
  marriedOn?: string;
}

const monthsBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (86_400_000 * 30.44);

/**
 * Whether an outlet passes the filters: "no" when a stated fact rules it
 * out, otherwise the filters it does not say enough to answer, so an unknown
 * is never treated as a no.
 */
export function filterOutlet(outlet: CardOutlet, filters: PublicationFilters, geo: Geo | null, today: string): "no" | string[] {
  const profile = outlet.matchProfile;
  const unsure: string[] = [];

  if (filters.styles !== undefined && filters.styles.length > 0 && !filters.styles.some((tag) => outlet.tags.includes(tag))) return "no";

  if (filters.kind !== undefined) {
    const takes = profile?.content[filters.kind] ?? null;
    if (takes === false) return "no";
    if (takes === null) unsure.push("kind");
  }

  if (filters.place !== undefined) {
    const regions = profile?.coverage.regions ?? null;
    if (regions === null || geo === null) unsure.push("place");
    else {
      const ancestors = locationAncestors(filters.place, geo);
      const covers = regions.some((region) => ancestors.includes(region));
      const within = regions.some((region) => locationAncestors(region, geo).includes(filters.place as string));
      if (!covers && !within) return "no";
    }
  }

  if (filters.marriedOn !== undefined) {
    const window = profile?.freshnessMonths ?? null;
    if (window === null) unsure.push("married_on");
    else if (window !== "none" && monthsBetween(filters.marriedOn, today) > window) return "no";
  }

  return unsure;
}

/** A page of the outlets that pass the filters, in the loader's order (tier, then name). */
export function publicationPage(
  outlets: readonly CardOutlet[],
  filters: PublicationFilters,
  geo: Geo | null,
  today: string,
  cursor: string | undefined,
) {
  const passing = outlets.flatMap((outlet) => {
    const verdict = filterOutlet(outlet, filters, geo, today);
    return verdict === "no" ? [] : [outletLine(outlet, verdict)];
  });
  const start = cursor === undefined ? 0 : /^\d+$/.test(cursor) ? Number(cursor) : -1;
  if (start < 0 || start > passing.length) return { error: "That cursor is not valid. Ask again without one." };
  const end = start + PAGE;
  return {
    outlets: passing.slice(start, end),
    total: passing.length,
    ...(end < passing.length ? { next: String(end) } : {}),
  };
}

const RANK_PAGE = 8;

export interface RankLine {
  id: string;
  name: string;
  tier: PublicationTier;
  match?: string;
  why?: string[];
  check?: string[];
  excluded?: string[];
  deadline?: string;
}

function rankLine(result: MatchResult, outlet: { name: string; tier: PublicationTier }): RankLine {
  const line: RankLine = { id: result.outletId, name: outlet.name, tier: outlet.tier };
  if (result.group === "excluded") {
    line.excluded = result.excluded;
    return line;
  }
  line.match = `${result.label} (${result.score} of 100)`;
  if (result.reasons.length > 0) line.why = result.reasons;
  if (result.checks.length > 0) line.check = result.checks;
  if (result.deadline !== null) line.deadline = result.deadline;
  return line;
}

/**
 * A page of the matcher's ranking for one wedding. "open" is the outlets she
 * can send to, those that fit first and then those with something to check;
 * "excluded" is the ones ruled out, with why.
 */
export function rankPage(
  ranked: readonly MatchResult[],
  outlets: ReadonlyMap<string, { name: string; tier: PublicationTier }>,
  show: "open" | "excluded",
  cursor: string | undefined,
) {
  const counts: Record<MatchGroup, number> = { fits: 0, check: 0, excluded: 0 };
  for (const result of ranked) counts[result.group] += 1;
  const shown = ranked.filter((result) => (show === "excluded") === (result.group === "excluded"));
  const start = cursor === undefined ? 0 : /^\d+$/.test(cursor) ? Number(cursor) : -1;
  if (start < 0 || start > shown.length) return { error: "That cursor is not valid. Ask again without one." };
  const end = start + RANK_PAGE;
  const lines = shown.slice(start, end).flatMap((result) => {
    const outlet = outlets.get(result.outletId);
    return outlet === undefined ? [] : [rankLine(result, outlet)];
  });
  return {
    counts,
    outlets: lines,
    ...(end < shown.length ? { next: String(end) } : {}),
  };
}

/** What would let the matcher say more about this wedding, in the order worth doing. */
export function sharpenHints(wedding: { locationCode: string | null; keptTags: number }): string[] {
  const hints: string[] = [];
  if (wedding.locationCode === null) hints.push("Add where the wedding was (save_wedding place) so each outlet's coverage can be checked.");
  if (wedding.keptTags === 0) hints.push("Keep some tags for this wedding (set_tags) so style can count towards the match.");
  return hints;
}
