/**
 * Publication research files (SUMMIT-333).
 *
 * One YAML file per outlet under research/publications/ is the source of truth
 * for what the app knows about it; research/README.md is the field reference.
 * Whoever reads the YAML (the import, the CI test) hands the parsed data here,
 * so this module only ever sees plain values.
 *
 * Two rules carry the weight:
 *
 *   - Every fact names the pages it came from. A known fact quotes the page;
 *     a fact the research could not find is `value: unknown` and lists the
 *     pages that were read. Nothing may be left blank or left out, because
 *     "nobody looked" would otherwise pass for "the outlet has no rule".
 *   - Unknown is not no. The parsed form keeps them apart (`known: false`
 *     versus a known `false` or `"none"`), so matching cannot confuse them.
 *
 * Like the intake validator, this is total: any input yields a value or a list
 * of field errors, never a throw.
 */

import { isRealDate, isSafeUrl } from "../event-intake.js";
import type { FieldError } from "../event-intake.js";
import { PUBLICATION_TIERS } from "../publication.js";
import type { ExclusivityPolicy } from "../publication.js";
import { TAG_CATEGORIES } from "../tags.js";
import type { TagCategory } from "../tags.js";

export const PUBLICATION_KINDS = [
  "national_magazine",
  "regional_magazine",
  "blog",
  "destination_international",
] as const;

export const SOURCE_KINDS = [
  "guidelines",
  "form",
  "about",
  "media_kit",
  "interview",
  "podcast",
  "feature",
  "other",
] as const;

export const ROUTE_PLATFORMS = [
  "two_bright_lights",
  "matchology",
  "email",
  "web_form",
  "portal",
  "pitch_only",
] as const;

export const CONTENT_TYPES = ["real_wedding", "elopement", "styled_shoot"] as const;

export const COVERAGE_BASES = ["wedding_location", "couple_home", "either"] as const;

export const IMAGE_SIZES = ["web", "print", "both"] as const;

export const GALLERY_HOSTS = [
  "dropbox",
  "google_drive",
  "wetransfer",
  "pic_time",
  "pixieset",
  "smugmug",
  "shootproof",
  "direct_upload",
] as const;

export const VENDOR_CREDIT_FIELDS = ["role", "business_name", "website", "instagram", "email"] as const;

/** A known exclusivity rule; "unknown" is the fact-level `value: unknown`. */
export const EXCLUSIVITY_RULES = [
  "exclusive_required",
  "exclusive_preferred",
  "non_exclusive",
] as const satisfies readonly ExclusivityPolicy[];

/** How an outlet treats a wedding already shown in one channel. */
export const EXPOSURE_RULES = ["allowed", "sneak_peeks_only", "disqualifies"] as const;

export const SUBMITTER_ROLES = ["photographer", "planner", "couple", "vendor", "publicist"] as const;

export const REPLY_POLICIES = ["all", "success_only"] as const;

export const REACH_METRICS = [
  "instagram_followers",
  "facebook_followers",
  "tiktok_followers",
  "pinterest_monthly_views",
  "monthly_visitors",
  "monthly_pageviews",
  "newsletter_subscribers",
  "print_circulation",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface ResearchVocab {
  /** Tag id to its category, from research/vocab/tags.yaml. */
  tags: ReadonlyMap<string, TagCategory>;
  /** Every location code a file may use, from research/vocab/geo.yaml. */
  geo: ReadonlySet<string>;
}

export type ResearchResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

export interface Cite {
  source: string;
  /** null only when the source is a published feature, where the photos are the evidence. */
  quote: string | null;
}

export type Fact<T> =
  | { known: true; value: T; cite: Cite[]; note: string | null }
  | { known: false; checked: string[]; note: string | null };

const MAX_QUOTE_WORDS = 25;
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/i;
const PUBLICATION_ID = /^pub-[a-z0-9]+(-[a-z0-9]+)*$/;
const SOURCE_ID = /^[a-z][a-z0-9_]*$/;

interface Context {
  errors: FieldError[];
  vocab: ResearchVocab;
  today: string;
  /** Source id to kind, for every source entry that parsed. */
  sources: Map<string, SourceKind>;
  /** Source ids some cite or checked list names. */
  used: Set<string>;
}

interface Reader<T> {
  read(raw: unknown, at: string, ctx: Context): T | undefined;
  /** May be left out of the file; reads as null. */
  optional?: true;
  /** A fact: leaving it out means nobody researched it, which the error says. */
  fact?: true;
}

type Out<R> = R extends Reader<infer T> ? T : never;

/** A rule across a record's fields; returns false after recording an error. */
type Check = (value: Record<string, unknown>, at: string, ctx: Context) => boolean;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(ctx: Context, at: string, message: string): undefined {
  ctx.errors.push({ field: at, message });
  return undefined;
}

const join = (at: string, key: string) => (at === "" ? key : `${at}.${key}`);

// --- values -----------------------------------------------------------------

const text: Reader<string> = {
  read(raw, at, ctx) {
    if (typeof raw !== "string") return fail(ctx, at, "Expected text.");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : fail(ctx, at, "Must not be blank.");
  },
};

const bool: Reader<boolean> = {
  read: (raw, at, ctx) => (typeof raw === "boolean" ? raw : fail(ctx, at, "Expected true or false.")),
};

/** For a detail inside a known fact, where one part may still be unknown. */
const triBool: Reader<boolean | "unknown"> = {
  read: (raw, at, ctx) =>
    typeof raw === "boolean" || raw === "unknown" ? raw : fail(ctx, at, "Expected true, false or unknown."),
};

function int(min: number): Reader<number> {
  return {
    read(raw, at, ctx) {
      if (typeof raw !== "number" || !Number.isInteger(raw)) return fail(ctx, at, "Expected a whole number.");
      return raw >= min ? raw : fail(ctx, at, `Must be at least ${min}.`);
    },
  };
}

const positive: Reader<number> = {
  read: (raw, at, ctx) =>
    typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fail(ctx, at, "Expected a positive number."),
};

function oneOf<T extends string>(allowed: readonly T[]): Reader<T> {
  return {
    read: (raw, at, ctx) =>
      (allowed as readonly unknown[]).includes(raw) ? (raw as T) : fail(ctx, at, `Expected one of: ${allowed.join(", ")}.`),
  };
}

const date: Reader<string> = {
  read: (raw, at, ctx) =>
    typeof raw === "string" && isRealDate(raw) ? raw : fail(ctx, at, "Expected a date written YYYY-MM-DD."),
};

const url: Reader<string> = {
  read: (raw, at, ctx) =>
    typeof raw === "string" && isSafeUrl(raw) ? raw : fail(ctx, at, "Expected a full http or https address."),
};

const publicationId: Reader<string> = {
  read: (raw, at, ctx) =>
    typeof raw === "string" && PUBLICATION_ID.test(raw)
      ? raw
      : fail(ctx, at, "Expected a publication id like pub-brides."),
};

const tagId: Reader<string> = {
  read: (raw, at, ctx) =>
    typeof raw === "string" && ctx.vocab.tags.has(raw) ? raw : fail(ctx, at, "Not a tag in research/vocab/tags.yaml."),
};

const seasonTag: Reader<string> = {
  read: (raw, at, ctx) =>
    typeof raw === "string" && ctx.vocab.tags.get(raw) === "season"
      ? raw
      : fail(ctx, at, "Expected a season tag from research/vocab/tags.yaml."),
};

const geoCode: Reader<string> = {
  read: (raw, at, ctx) =>
    typeof raw === "string" && ctx.vocab.geo.has(raw)
      ? raw
      : fail(ctx, at, "Not a location code in research/vocab/geo.yaml."),
};

const month: Reader<number> = {
  read: (raw, at, ctx) =>
    typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 12
      ? raw
      : fail(ctx, at, "Expected a month, 1 to 12."),
};

const currency: Reader<string> = {
  read: (raw, at, ctx) =>
    typeof raw === "string" && /^[A-Z]{3}$/.test(raw)
      ? raw
      : fail(ctx, at, "Expected a three-letter currency code such as USD."),
};

const quote: Reader<string> = {
  read(raw, at, ctx) {
    const value = text.read(raw, at, ctx);
    if (value === undefined) return undefined;
    return value.split(/\s+/).length <= MAX_QUOTE_WORDS
      ? value
      : fail(ctx, at, `Quote at most ${MAX_QUOTE_WORDS} words; the cited page holds the rest.`);
  },
};

/** A source id from this file's sources. Naming it counts as using it. */
const sourceRef: Reader<string> = {
  read(raw, at, ctx) {
    if (typeof raw !== "string" || !ctx.sources.has(raw)) {
      return fail(ctx, at, `No source named ${String(raw)} under sources.`);
    }
    ctx.used.add(raw);
    return raw;
  },
};

const featureSource: Reader<string> = {
  read(raw, at, ctx) {
    const id = sourceRef.read(raw, at, ctx);
    if (id === undefined) return undefined;
    return ctx.sources.get(id) === "feature"
      ? id
      : fail(ctx, at, "Cite a feature source here: a page showing one of the outlet's published weddings.");
  },
};

// --- combinators ------------------------------------------------------------

function opt<T>(reader: Reader<T>): Reader<T | null> {
  return { read: reader.read, optional: true };
}

/** A reserved word that states a known absence ("none") or no limit ("any"). */
function or<W extends string, T>(word: W, reader: Reader<T>): Reader<W | T> {
  return { read: (raw, at, ctx) => (raw === word ? word : reader.read(raw, at, ctx)) };
}

function listOf<T>(reader: Reader<T>, min = 0): Reader<T[]> {
  return {
    read(raw, at, ctx) {
      if (!Array.isArray(raw)) return fail(ctx, at, "Expected a list.");
      if (raw.length < min) return fail(ctx, at, `List at least ${min}.`);
      const out: T[] = [];
      const seen = new Set<unknown>();
      let ok = true;
      raw.forEach((entry, index) => {
        const value = reader.read(entry, `${at}[${index}]`, ctx);
        if (value === undefined) {
          ok = false;
        } else if (typeof value !== "object" && seen.has(value)) {
          ok = fail(ctx, `${at}[${index}]`, "Listed twice.") ?? false;
        } else {
          seen.add(value);
          out.push(value);
        }
      });
      return ok ? out : undefined;
    },
  };
}

function record<S extends Record<string, Reader<unknown>>>(
  shape: S,
  ...checks: Check[]
): Reader<{ [K in keyof S]: Out<S[K]> }> {
  return {
    read(raw, at, ctx) {
      if (!isObject(raw)) return fail(ctx, at, "Expected a mapping.");
      let ok = true;
      for (const key of Object.keys(raw)) {
        if (!(key in shape)) ok = fail(ctx, join(at, key), "Unknown field.") ?? false;
      }
      const out: Record<string, unknown> = {};
      for (const [key, reader] of Object.entries(shape)) {
        const value = raw[key];
        if (value === undefined && reader.optional) {
          out[key] = null;
        } else if (value === undefined) {
          ok =
            fail(
              ctx,
              join(at, key),
              reader.fact
                ? "Missing. If the research found nothing, write value: unknown and list the pages read under checked."
                : "Missing.",
            ) ?? false;
        } else {
          const read = reader.read(value, join(at, key), ctx);
          if (read === undefined) ok = false;
          else out[key] = read;
        }
      }
      if (ok) ok = checks.every((check) => check(out, at, ctx));
      return ok ? (out as { [K in keyof S]: Out<S[K]> }) : undefined;
    },
  };
}

const atLeastOne =
  (keys: string[]): Check =>
  (value, at, ctx) =>
    keys.some((key) => value[key] !== null) || (fail(ctx, at, `Give at least one of: ${keys.join(", ")}.`) ?? false);

const ordered =
  (low: string, high: string): Check =>
  (value, at, ctx) => {
    const [min, max] = [value[low], value[high]];
    if (typeof min !== "number" || typeof max !== "number" || min <= max) return true;
    return fail(ctx, at, `${low} must not exceed ${high}.`) ?? false;
  };

const CITE = record(
  { source: sourceRef, quote: opt(quote) },
  (value, at, ctx) =>
    value["quote"] !== null ||
    ctx.sources.get(value["source"] as string) === "feature" ||
    (fail(ctx, join(at, "quote"), "A cite of this page needs a quote; only a feature may stand without one.") ?? false),
);

const FACT_KEYS = new Set(["value", "cite", "checked", "note"]);

function fact<T>(reader: Reader<T>): Reader<Fact<T>> {
  return {
    fact: true,
    read(raw, at, ctx) {
      if (!isObject(raw)) {
        return fail(ctx, at, "Expected a mapping with value and cite, or value: unknown and checked.");
      }
      let ok = true;
      for (const key of Object.keys(raw)) {
        if (!FACT_KEYS.has(key)) ok = fail(ctx, join(at, key), "Unknown field.") ?? false;
      }
      const note = raw["note"] === undefined ? null : text.read(raw["note"], join(at, "note"), ctx);
      if (note === undefined) ok = false;

      if (raw["value"] === undefined) {
        return fail(ctx, join(at, "value"), "A fact needs a value; write unknown if the research found nothing.");
      }

      if (raw["value"] === "unknown") {
        if (raw["cite"] !== undefined) {
          ok = fail(ctx, join(at, "cite"), "An unknown fact has no cite; list the pages read under checked.") ?? false;
        }
        const checked =
          raw["checked"] === undefined
            ? fail(ctx, join(at, "checked"), "List the pages that were read under checked.")
            : listOf(sourceRef, 1).read(raw["checked"], join(at, "checked"), ctx);
        return ok && checked !== undefined && note !== undefined ? { known: false, checked, note } : undefined;
      }

      if (raw["checked"] !== undefined) {
        ok = fail(ctx, join(at, "checked"), "checked is only for value: unknown.") ?? false;
      }
      const value = reader.read(raw["value"], join(at, "value"), ctx);
      const cite =
        raw["cite"] === undefined
          ? fail(ctx, join(at, "cite"), "A known fact needs at least one cite.")
          : listOf(CITE, 1).read(raw["cite"], join(at, "cite"), ctx);
      return ok && value !== undefined && cite !== undefined && note !== undefined
        ? { known: true, value, cite, note }
        : undefined;
    },
  };
}

// --- the file -----------------------------------------------------------------

const SOURCE = record({
  url,
  read: {
    read: (raw: unknown, at: string, ctx: Context) => {
      const value = date.read(raw, at, ctx);
      if (value === undefined) return undefined;
      return value <= ctx.today ? value : fail(ctx, at, "Read after today; use the date the page was actually read.");
    },
  },
  kind: oneOf(SOURCE_KINDS),
  title: opt(text),
});

export type Source = Out<typeof SOURCE>;

const SOURCES: Reader<Record<string, Source>> = {
  read(raw, at, ctx) {
    if (!isObject(raw)) return fail(ctx, at, "Expected a mapping of source id to page.");
    const out: Record<string, Source> = {};
    let ok = true;
    for (const [id, entry] of Object.entries(raw)) {
      if (!SOURCE_ID.test(id)) {
        ok = fail(ctx, join(at, id), "Source ids are lowercase snake_case, like guidelines or editor_interview.") ?? false;
        continue;
      }
      const source = SOURCE.read(entry, join(at, id), ctx);
      if (source === undefined) {
        ok = false;
      } else {
        out[id] = source;
        ctx.sources.set(id, source.kind);
      }
    }
    return ok ? out : undefined;
  },
};

const MONEY = record({ amount: or("undisclosed", positive), currency, note: opt(text) });

const FILE = record({
  // First, so every cite below can be checked against it.
  sources: SOURCES,
  id: publicationId,
  name: text,
  url,
  kind: oneOf(PUBLICATION_KINDS),
  // Team judgments, the only fields without a source.
  tier: oneOf(PUBLICATION_TIERS),
  recheck_every_days: int(1),
  taste_summary: opt(text),
  notes: opt(text),

  identity: record({
    parent_company: fact(or("none", text)),
    sister_publications: fact(listOf(text)),
    shared_inbox_with: fact(listOf(publicationId)),
  }),

  coverage: record({
    regions: fact(listOf(geoCode, 1)),
    basis: fact(oneOf(COVERAGE_BASES)),
    destination_accepted: fact(bool),
  }),

  content: record({
    real_wedding: fact(bool),
    elopement: fact(bool),
    styled_shoot: fact(bool),
    style_tags: fact(listOf(tagId, 1)),
    seasonality: fact(
      or(
        "none",
        listOf(record({ wants: listOf(seasonTag, 1), submit_months: opt(listOf(month, 1)), note: opt(text) }), 1),
      ),
    ),
  }),

  routes: fact(
    listOf(
      record({
        platform: oneOf(ROUTE_PLATFORMS),
        url: opt(url),
        account_required: triBool,
        steps: listOf(text, 1),
        preferred: opt(bool),
        note: opt(text),
      }),
      1,
    ),
  ),

  package: record({
    image_min: fact(or("none", int(0))),
    image_max: fact(or("none", int(1))),
    resolution: fact(
      record(
        {
          min_width_px: opt(int(1)),
          max_width_px: opt(int(1)),
          min_long_edge_px: opt(int(1)),
          max_long_edge_px: opt(int(1)),
          min_file_mb: opt(positive),
          max_file_mb: opt(positive),
          note: opt(text),
        },
        atLeastOne(["min_width_px", "max_width_px", "min_long_edge_px", "max_long_edge_px", "min_file_mb", "max_file_mb", "note"]),
      ),
    ),
    size: fact(oneOf(IMAGE_SIZES)),
    orientation_mix: fact(text),
    watermarks_allowed: fact(bool),
    gallery_hosts: fact(or("any", listOf(oneOf(GALLERY_HOSTS), 1))),
    vendor_credits: fact(
      record({ required: bool, fields: opt(listOf(oneOf(VENDOR_CREDIT_FIELDS), 1)), note: opt(text) }),
    ),
    story: fact(
      record(
        {
          required: bool,
          min_words: opt(int(1)),
          max_words: opt(int(1)),
          questionnaire: opt(bool),
          note: opt(text),
        },
        ordered("min_words", "max_words"),
      ),
    ),
    video_accepted: fact(bool),
    other_requirements: fact(listOf(text)),
  }),

  rules: record({
    exclusivity: fact(
      record({
        policy: oneOf(EXCLUSIVITY_RULES),
        during_review: opt(bool),
        after_publication_days: opt(int(1)),
      }),
    ),
    prior_exposure: record({
      publications: fact(oneOf(EXPOSURE_RULES)),
      blogs: fact(oneOf(EXPOSURE_RULES)),
      social: fact(oneOf(EXPOSURE_RULES)),
    }),
    freshness_window_months: fact(or("none", int(1))),
    photographer_frequency: fact(or("none", record({ max: int(1), per_months: int(1) }))),
    submitter_roles: fact(listOf(oneOf(SUBMITTER_ROLES), 1)),
  }),

  rights: record({
    image_usage: fact(text),
    credit_format: fact(text),
    couple_consent_required: fact(bool),
    vendor_consent_required: fact(bool),
  }),

  economics: record({
    submission_fee: fact(or("none", MONEY)),
    publication_fee: fact(or("none", MONEY)),
    priority_paid_tier: fact(or("none", record({ name: text, price: opt(MONEY), note: opt(text) }))),
    reach: fact(
      listOf(record({ metric: oneOf(REACH_METRICS), value: int(1), as_of: date }), 1),
    ),
  }),

  timing: record({
    response_window: fact(record({ days: int(1), replies: oneOf(REPLY_POLICIES) })),
    publish_lead_days: fact(
      record({ min: opt(int(0)), max: opt(int(0)) }, atLeastOne(["min", "max"]), ordered("min", "max")),
    ),
    publishing_cycle: fact(text),
  }),

  people: record({
    editors: fact(listOf(record({ name: text, role: text }), 1)),
  }),

  // Lists of individually cited items rather than facts: an empty list says
  // only that nothing has been gathered yet.
  insight: record({
    secret_sauce: listOf(record({ tip: text, cite: listOf(CITE, 1) })),
    recent_features: listOf(
      record({
        source: featureSource,
        published: date,
        location: opt(geoCode),
        content_type: opt(oneOf(CONTENT_TYPES)),
        tags: opt(listOf(tagId, 1)),
      }),
    ),
  }),
});

export type PublicationFile = Out<typeof FILE>;

/** Every string anywhere in the file that looks like an email address. */
function findEmails(raw: unknown, at: string, errors: FieldError[]): void {
  if (typeof raw === "string") {
    if (EMAIL.test(raw)) {
      errors.push({
        field: at,
        message: "Email addresses stay out of the repo; put them in the private contacts overlay.",
      });
    }
  } else if (Array.isArray(raw)) {
    raw.forEach((entry, index) => findEmails(entry, `${at}[${index}]`, errors));
  } else if (isObject(raw)) {
    for (const [key, value] of Object.entries(raw)) findEmails(value, join(at, key), errors);
  }
}

/**
 * Validates one parsed research file. `today` (YYYY-MM-DD) bounds the dates
 * sources were read, so a typo cannot date research in the future.
 */
export function validatePublicationFile(
  raw: unknown,
  vocab: ResearchVocab,
  today: string,
): ResearchResult<PublicationFile> {
  if (!isObject(raw)) return { ok: false, errors: [{ field: "file", message: "Expected a mapping." }] };

  const ctx: Context = { errors: [], vocab, today, sources: new Map(), used: new Set() };
  findEmails(raw, "", ctx.errors);
  const file = FILE.read(raw, "", ctx);

  if (file === undefined || ctx.errors.length > 0) return { ok: false, errors: ctx.errors };

  // Only once everything else reads cleanly: before that, a fact that failed
  // early may not have reached the cite that names a source.
  for (const id of ctx.sources.keys()) {
    if (!ctx.used.has(id)) fail(ctx, join("sources", id), "This page is never cited or checked; cite it or remove it.");
  }
  return ctx.errors.length > 0 ? { ok: false, errors: ctx.errors } : { ok: true, value: file };
}

/**
 * Rules that span files: each file is named for its id, and every shared
 * inbox points at an outlet that has a file.
 */
export function checkResearchSet(
  files: ReadonlyArray<{ fileName: string; file: PublicationFile }>,
): FieldError[] {
  const errors: FieldError[] = [];
  const ids = new Set(files.map(({ file }) => file.id));
  for (const { fileName, file } of files) {
    if (fileName !== `${file.id}.yaml`) {
      errors.push({ field: `${fileName}: id`, message: `The file must be named ${file.id}.yaml.` });
    }
    const inbox = file.identity.shared_inbox_with;
    if (inbox.known) {
      inbox.value.forEach((id, index) => {
        if (!ids.has(id)) {
          errors.push({
            field: `${fileName}: identity.shared_inbox_with.value[${index}]`,
            message: `No research file for ${id}.`,
          });
        }
      });
    }
  }
  return errors;
}

// --- vocabulary -----------------------------------------------------------------

const TAG_ID = /^[a-z0-9]+(_[a-z0-9]+)*$/;
const GEO_SECTIONS = ["scopes", "us_regions", "states", "metros", "countries"] as const;
const SCOPES = ["INTL", "US", "WORLD"];
const STATE_CODE = /^US-[A-Z]{2}$/;
const REGION_CODE = /^US:[a-z]+(-[a-z]+)*$/;
const METRO_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

function isCountryCode(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code)) return false;
  const name = REGION_NAMES.of(code);
  return name !== code && name !== "Unknown Region";
}

function readTagVocab(raw: unknown, errors: FieldError[]): Map<string, TagCategory> {
  const tags = new Map<string, TagCategory>();
  if (!isObject(raw)) {
    errors.push({ field: "tags.yaml", message: "Expected a mapping of category to tag ids." });
    return tags;
  }
  for (const key of Object.keys(raw)) {
    if (!(TAG_CATEGORIES as readonly string[]).includes(key)) {
      errors.push({ field: `tags.yaml: ${key}`, message: "Unknown category; the categories are fixed in src/domain/tags.ts." });
    }
  }
  for (const category of TAG_CATEGORIES) {
    const at = `tags.yaml: ${category}`;
    const list = raw[category];
    if (list === undefined) {
      errors.push({ field: at, message: "Missing." });
    } else if (!Array.isArray(list)) {
      errors.push({ field: at, message: "Expected a list of tag ids." });
    } else {
      list.forEach((id, index) => {
        if (typeof id !== "string" || !TAG_ID.test(id)) {
          errors.push({ field: `${at}[${index}]`, message: "Tag ids are snake_case." });
        } else if (tags.has(id)) {
          errors.push({ field: `${at}[${index}]`, message: `${id} is already listed under ${tags.get(id)}.` });
        } else {
          tags.set(id, category);
        }
      });
    }
  }
  return tags;
}

/** Visits each entry of a mapping section, or records that it is not one. */
function eachEntry(
  raw: unknown,
  at: string,
  errors: FieldError[],
  visit: (key: string, value: unknown, at: string) => void,
): void {
  if (!isObject(raw)) {
    errors.push({ field: at, message: "Expected a mapping." });
    return;
  }
  for (const [key, value] of Object.entries(raw)) visit(key, value, `${at}.${key}`);
}

function placeName(value: unknown, at: string, errors: FieldError[]): void {
  if (typeof value !== "string" || value.trim().length === 0) errors.push({ field: at, message: "Must not be blank." });
}

function readGeoVocab(raw: unknown, errors: FieldError[]): Set<string> {
  const codes = new Set<string>();
  if (!isObject(raw)) {
    errors.push({ field: "geo.yaml", message: "Expected a mapping of sections." });
    return codes;
  }
  for (const key of Object.keys(raw)) {
    if (!(GEO_SECTIONS as readonly string[]).includes(key)) {
      errors.push({ field: `geo.yaml: ${key}`, message: "Unknown section." });
    }
  }
  const section = (name: (typeof GEO_SECTIONS)[number]) => {
    if (raw[name] === undefined) errors.push({ field: `geo.yaml: ${name}`, message: "Missing." });
    return raw[name];
  };

  // States first: regions and metros are checked against them.
  const states = new Set<string>();
  eachEntry(section("states"), "geo.yaml: states", errors, (code, name, at) => {
    if (!STATE_CODE.test(code)) return void errors.push({ field: at, message: "State codes are US-XX." });
    placeName(name, at, errors);
    states.add(code);
  });

  const scopes = section("scopes");
  eachEntry(scopes, "geo.yaml: scopes", errors, (code, name, at) => {
    placeName(name, at, errors);
    codes.add(code);
  });
  if (isObject(scopes) && Object.keys(scopes).sort().join() !== SCOPES.join()) {
    errors.push({ field: "geo.yaml: scopes", message: "Scopes are exactly WORLD, US, INTL." });
  }

  eachEntry(section("us_regions"), "geo.yaml: us_regions", errors, (code, region, at) => {
    if (!REGION_CODE.test(code)) return void errors.push({ field: at, message: "Region codes are US:<kebab-case>." });
    if (!isObject(region)) return void errors.push({ field: at, message: "Expected a mapping with name and states." });
    placeName(region["name"], `${at}.name`, errors);
    const members = region["states"];
    if (!Array.isArray(members) || members.length === 0) {
      return void errors.push({ field: `${at}.states`, message: "List at least 1 state." });
    }
    members.forEach((state, index) => {
      if (typeof state !== "string" || !states.has(state)) {
        errors.push({ field: `${at}.states[${index}]`, message: `No state ${String(state)} in states.` });
      }
    });
    codes.add(code);
  });

  eachEntry(section("metros"), "geo.yaml: metros", errors, (state, metros, at) => {
    if (!states.has(state)) return void errors.push({ field: at, message: `No state ${state} in states.` });
    eachEntry(metros, at, errors, (slug, name, metroAt) => {
      if (!METRO_SLUG.test(slug)) return void errors.push({ field: metroAt, message: "Metro slugs are kebab-case." });
      placeName(name, metroAt, errors);
      codes.add(`${state}:${slug}`);
    });
  });

  eachEntry(section("countries"), "geo.yaml: countries", errors, (code, name, at) => {
    if (!isCountryCode(code)) return void errors.push({ field: at, message: "Not an ISO 3166 country code." });
    placeName(name, at, errors);
    codes.add(code);
  });

  for (const state of states) codes.add(state);
  return codes;
}

/** Parses research/vocab/tags.yaml and research/vocab/geo.yaml, already read as YAML. */
export function parseResearchVocab(tags: unknown, geo: unknown): ResearchResult<ResearchVocab> {
  const errors: FieldError[] = [];
  const value = { tags: readTagVocab(tags, errors), geo: readGeoVocab(geo, errors) };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
