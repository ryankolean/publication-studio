/**
 * The photographer's corrections, laid over the approved research (SUMMIT-335)
 * before it is projected onto the publication columns, so a corrected response
 * window or image count is what the wizard and the checklist use.
 *
 * Each correction replaces one fact at its path with a known value. A
 * correction whose path the research no longer has is skipped rather than
 * invented; it stays stored and shows as a conflict when research changes.
 */

import type { PublicationFile } from "./schema.js";

export interface Correction {
  field: string;
  value: unknown;
}

const isFact = (node: unknown): boolean =>
  typeof node === "object" && node !== null && typeof (node as { known?: unknown }).known === "boolean";

export function applyEdits(file: PublicationFile, corrections: readonly Correction[]): PublicationFile {
  const copy = structuredClone(file) as unknown as Record<string, unknown>;
  for (const { field, value } of corrections) {
    const keys = field.split(".");
    const last = keys.pop() as string;
    let parent: unknown = copy;
    for (const key of keys) parent = (parent as Record<string, unknown> | undefined)?.[key];
    if (typeof parent !== "object" || parent === null || !isFact((parent as Record<string, unknown>)[last])) continue;
    (parent as Record<string, unknown>)[last] = { known: true, value, cite: [], note: "Corrected by the photographer." };
  }
  return copy as unknown as PublicationFile;
}
