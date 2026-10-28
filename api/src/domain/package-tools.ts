/**
 * What build_package_draft does with Claude's arguments and says back
 * (SUMMIT-344 slice 5). The package itself is the web app's: the tool writes
 * through the package routes, and the checklist verdict is theirs. This
 * module turns photo picks into the pool's keys, adds her confirmations to
 * the ones already ticked, and words the package in a few fields.
 *
 * Pure: no database, no clock, no network.
 */

import type { ChecklistItem } from "./package-checklist.js";
import { photoRef } from "./upload-link.js";

const REF = /^[0-9a-f]{8}$/i;
const NUMBER = /^\d{1,4}$/;

/**
 * Photo picks as review_photos names them, a number ("Photo 12") or a ref
 * ("3f9a1c2e"), turned into pool keys in the order given. Any pick that names
 * no photo refuses the whole set. Repeats are kept once.
 */
export function pickPhotos(
  pool: ReadonlyArray<{ key: string }>,
  picks: readonly string[],
): { ok: true; keys: string[] } | { ok: false; unknown: string[] } {
  const keys: string[] = [];
  const unknown: string[] = [];
  for (const raw of picks) {
    const pick = raw.trim().replace(/^photo\s*/i, "");
    const found = NUMBER.test(pick)
      ? pool[Number(pick) - 1]
      : REF.test(pick)
        ? pool.find((photo) => photoRef(photo.key).toLowerCase() === pick.toLowerCase())
        : undefined;
    if (found === undefined) unknown.push(raw);
    else if (!keys.includes(found.key)) keys.push(found.key);
  }
  return unknown.length > 0 ? { ok: false, unknown } : { ok: true, keys };
}

/**
 * The checklist ticks to store: the ones already ticked plus the ones she
 * just confirmed. Only items she has to confirm can be confirmed; anything
 * else refuses the set.
 */
export function confirmItems(
  checklist: readonly ChecklistItem[],
  confirm: readonly string[],
): { ok: true; attestations: Record<string, true> } | { ok: false; unknown: string[] } {
  const attested = new Set(checklist.filter((item) => item.kind === "attested").map((item) => item.id));
  const unknown = confirm.filter((id) => !attested.has(id));
  if (unknown.length > 0) return { ok: false, unknown };
  const ticked = checklist.filter((item) => item.kind === "attested" && item.satisfied).map((item) => item.id);
  return { ok: true, attestations: Object.fromEntries([...ticked, ...confirm].map((id) => [id, true as const])) };
}

export interface PackageViewLike {
  id: string;
  publication: { name: string; spec: { imgMin: number | null; imgMax: number | null } } | null;
  imageKeys: string[];
  descriptionMd: string | null;
  creditsBlockMd: string | null;
  consent: { nameDisplay: string | null; consentNotes: string | null };
  checklist: ChecklistItem[];
  complete: boolean;
}

function wanted(spec: { imgMin: number | null; imgMax: number | null }): string | null {
  if (spec.imgMin !== null && spec.imgMax !== null) return `${spec.imgMin} to ${spec.imgMax}`;
  if (spec.imgMin !== null) return `at least ${spec.imgMin}`;
  if (spec.imgMax !== null) return `at most ${spec.imgMax}`;
  return null;
}

/**
 * The package in a few fields: photos against the outlet's range, whether
 * the write-up and credits exist, the couple's limits, and the checklist as
 * done and to do. Items she has to confirm are marked so Claude asks her.
 * With text, the write-up and credits come back in full for editing.
 */
export function packageReport(view: PackageViewLike, text: boolean) {
  const range = view.publication === null ? null : wanted(view.publication.spec);
  const limits = [view.consent.nameDisplay, view.consent.consentNotes].filter((part): part is string => part !== null && part.trim() !== "");
  return {
    package: view.id,
    outlet: view.publication?.name ?? null,
    photos: { chosen: view.imageKeys.length, ...(range === null ? {} : { wanted: range }) },
    writeUp: view.descriptionMd === null ? "none yet" : `${view.descriptionMd.length} characters`,
    credits: view.creditsBlockMd === null ? "none yet" : "set",
    ...(limits.length > 0 ? { coupleLimits: limits } : {}),
    done: view.checklist.filter((item) => item.satisfied).map((item) => item.label),
    toDo: view.checklist
      .filter((item) => !item.satisfied)
      .map((item) => ({
        id: item.id,
        item: item.label,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(item.kind === "attested" ? { sheConfirms: true as const } : {}),
      })),
    complete: view.complete,
    ...(text ? { writeUpText: view.descriptionMd, creditsText: view.creditsBlockMd } : {}),
  };
}
