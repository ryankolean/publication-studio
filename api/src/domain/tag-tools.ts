/**
 * set_tags and the tags get_wedding shows (SUMMIT-344 slice 3). Her own
 * Claude suggests tags in the chat from what review_photos shows it; the
 * studio only checks them against the vocabulary and stores her answers.
 *
 * DECISION: Claude's suggestions are not stored. She answers them in the same
 * chat, and only her answers count, so a stored suggestion would add nothing
 * the web app's Look screen needs.
 *
 * Pure: no database, no clock, no network.
 */

import type { LookTag } from "./style.js";
import type { TagCategory } from "./tags.js";

/** "Late fall" or "late-fall" -> "late_fall", the way vocabulary ids are spelled. */
export function tagId(text: string): string {
  return text.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

// Words that say nothing about which tag was meant.
const FILLER = new Set(["and", "the", "with", "style", "wedding", "weddings"]);

const sameWord = (a: string, b: string) =>
  a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Up to four vocabulary tags sharing a word with one that is not in it: "mountains" -> mountain_alpine. */
export function closeTags(asked: string, vocabulary: readonly string[]): string[] {
  const words = asked.split("_").filter((word) => word.length >= 3 && !FILLER.has(word));
  return vocabulary.filter((id) => id.split("_").some((part) => words.some((word) => sameWord(part, word)))).slice(0, 4);
}

export type TagAnswerCheck =
  | { ok: true; confirmed: string[]; rejected: string[] }
  | { ok: false; result: string; message: string };

/**
 * Her answers as Claude sends them, spelled the vocabulary's way and each
 * listed once. Any tag not in the vocabulary, or one both kept and dropped,
 * refuses the whole set, so nothing is half saved.
 */
export function checkTagAnswers(keep: readonly string[], drop: readonly string[], vocabulary: readonly string[]): TagAnswerCheck {
  const confirmed = [...new Set(keep.map(tagId))];
  const rejected = [...new Set(drop.map(tagId))];
  if (confirmed.length + rejected.length === 0) {
    return {
      ok: false,
      result: "needs_tags",
      message: "Give keep, drop or both: the tags she chose and the ones she said do not fit. Nothing was saved.",
    };
  }

  const known = new Set(vocabulary);
  const unknown = [...new Set([...confirmed, ...rejected])].filter((tag) => !known.has(tag));
  if (unknown.length > 0) {
    const lines = unknown.map((tag) => {
      const close = closeTags(tag, vocabulary);
      return close.length === 0 ? tag : `${tag} (closest: ${close.join(", ")})`;
    });
    return {
      ok: false,
      result: "unknown_tag",
      message: `Not in the tag list: ${lines.join("; ")}. Call get_wedding with tag_choices set to true for the list. Nothing was saved.`,
    };
  }

  const both = confirmed.filter((tag) => rejected.includes(tag));
  if (both.length > 0) {
    return {
      ok: false,
      result: "kept_and_dropped",
      message: `In both keep and drop: ${both.join(", ")}. Ask her which she meant. Nothing was saved.`,
    };
  }
  return { ok: true, confirmed, rejected };
}

export interface TagStanding {
  kept: string[];
  notKept?: string[];
  toAnswer?: Array<{ tag: string; why: string }>;
}

/**
 * Where a wedding's tags stand, in the order of the vocabulary: what she
 * kept, what she said does not fit, and what is waiting for her answer (from
 * the date, the place or the operator), each with why it was suggested.
 */
export function tagStanding(tags: readonly LookTag[]): TagStanding {
  const notKept = tags.filter((tag) => tag.state === "rejected").map((tag) => tag.id);
  const toAnswer = tags
    .filter((tag) => tag.state === "suggested")
    .map((tag) => ({ tag: tag.id, why: tag.reason ?? "Suggested earlier." }));
  return {
    kept: tags.filter((tag) => tag.state === "confirmed").map((tag) => tag.id),
    ...(notKept.length > 0 ? { notKept } : {}),
    ...(toAnswer.length > 0 ? { toAnswer } : {}),
  };
}

/**
 * The tags still open to her, by group, as one line of ids each so the list
 * stays small: everything she has not already kept or said no to.
 */
export function tagChoices(
  vocabulary: ReadonlyArray<{ id: string; category: TagCategory }>,
  tags: readonly LookTag[],
): Partial<Record<TagCategory, string>> {
  const decided = new Set(tags.filter((tag) => tag.state !== "suggested").map((tag) => tag.id));
  const groups = new Map<TagCategory, string[]>();
  for (const tag of vocabulary) {
    if (decided.has(tag.id)) continue;
    const group = groups.get(tag.category);
    if (group === undefined) groups.set(tag.category, [tag.id]);
    else group.push(tag.id);
  }
  return Object.fromEntries([...groups].map(([category, ids]) => [category, ids.join(", ")]));
}
