/**
 * What changed between two versions of an outlet's research, field by field,
 * for the approval screen (SUMMIT-335).
 *
 * Only values count. Re-reading a page moves its read date and may touch a
 * quote or a note without changing a single fact; that import still needs an
 * approval (it re-verifies the outlet), but it shows as "nothing changed".
 */

import { canonicalJson } from "./canonical.js";
import type { PublicationFile } from "./schema.js";

export interface FieldChange {
  /** The fact's path in the research file, the same key a correction uses. */
  field: string;
  /** null when the outlet is new. "unknown" for a fact the research could not find. */
  before: unknown;
  after: unknown;
}

const JUDGMENTS = ["name", "url", "kind", "tier", "recheck_every_days", "taste_summary", "notes"] as const;
const SECTIONS = ["identity", "coverage", "content", "routes", "package", "rules", "rights", "economics", "timing", "people"] as const;

function isFact(node: unknown): node is { known: boolean; value?: unknown } {
  return typeof node === "object" && node !== null && typeof (node as { known?: unknown }).known === "boolean";
}

function walk(node: unknown, path: string, out: Map<string, unknown>): void {
  if (isFact(node)) {
    out.set(path, node.known ? node.value : "unknown");
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) walk(value, `${path}.${key}`, out);
}

/** Every judgment, fact and insight list, by path, in file order. */
export function flattenResearch(file: PublicationFile): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const key of JUDGMENTS) out.set(key, file[key]);
  for (const section of SECTIONS) walk(file[section], section, out);
  out.set("insight.secret_sauce", file.insight.secret_sauce.map((tip) => tip.tip));
  out.set(
    "insight.recent_features",
    file.insight.recent_features.map(({ source, published, location, content_type, tags }) => ({
      source,
      published,
      location,
      content_type,
      tags,
    })),
  );
  return out;
}

export function diffResearch(before: PublicationFile | null, after: PublicationFile): FieldChange[] {
  const previous = before === null ? new Map<string, unknown>() : flattenResearch(before);
  const changes: FieldChange[] = [];
  for (const [field, value] of flattenResearch(after)) {
    const old = previous.get(field) ?? null;
    if (canonicalJson(old) !== canonicalJson(value)) changes.push({ field, before: old, after: value });
  }
  return changes;
}

/** The changes that touch a field the photographer has corrected. */
export function conflictsWith(changes: FieldChange[], editedFields: readonly string[]): FieldChange[] {
  return changes.filter((change) => editedFields.includes(change.field));
}
