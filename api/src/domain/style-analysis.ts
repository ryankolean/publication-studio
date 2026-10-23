/**
 * The Claude request behind "Suggest tags" (SUMMIT-337), and the reading of
 * its answer. Building and parsing are pure so they are tested without a
 * network; the call itself is one line in routes/style.ts.
 *
 * DECISION: photos go by URL, as the Worker's own short-lived read links, so
 * the Worker never reads or encodes the bytes (its CPU budget is 10 ms).
 * The answer is constrained by a JSON schema whose tag field only accepts
 * vocabulary ids, so Claude cannot invent a tag; the parser checks again.
 */

import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";

import { PHOTO_CATEGORIES, TAG_CONFIDENCES } from "./style.js";
import type { Suggestion, TagConfidence } from "./style.js";
import type { TagCategory } from "./tags.js";

export const STYLE_MODEL = "claude-opus-5-5";

/** Server-side fallback: a declined request is retried on another model inside the same call. */
export const STYLE_BETAS = ["server-side-fallback-2026-07-01"] as const;

const MAX_SUGGESTIONS = 16;
const MAX_REASON = 200;

const SYSTEM = `You tag wedding photography by its look, so a photographer's weddings can be matched with the editorial outlets that publish that look.

You are shown photos from one wedding, numbered in the order given. Choose tags from the vocabulary only, in these categories:
- landscape_venue: the setting and kind of venue.
- architecture: the buildings, where they are visible.
- aesthetic: the overall style of the wedding and its styling.
- dress_style: what the couple wore.

Rules:
- Tag only what the photos clearly show. Fewer accurate tags beat many guesses; leave a category empty when the photos do not settle it.
- Typically one or two venue tags, up to two architecture tags, two to four aesthetic tags and one or two dress tags.
- Describe settings, styling and clothing only. Never identify anyone, and never describe people's bodies, ages or ethnicity.
- For each tag give a confidence (high, medium or low) and a reason under 20 words that names the photos it rests on, for example "Photos 3 and 7: stone chapel with vaulted ceiling."`;

/** The vocabulary a run may answer from: the photo categories, in display order. */
export function photoVocabulary(
  tags: ReadonlyArray<{ id: string; category: TagCategory }>,
): Array<{ id: string; category: TagCategory }> {
  return tags.filter((tag) => PHOTO_CATEGORIES.includes(tag.category));
}

/** The Messages request for one wedding: numbered photos, the vocabulary, and the answer schema. */
export function buildSuggestRequest(input: {
  vocabulary: ReadonlyArray<{ id: string; category: TagCategory }>;
  photoUrls: readonly string[];
}): MessageCreateParamsNonStreaming {
  const listing = PHOTO_CATEGORIES.map(
    (category) =>
      `${category}: ${input.vocabulary
        .filter((tag) => tag.category === category)
        .map((tag) => tag.id)
        .join(", ")}`,
  ).join("\n");

  return {
    model: STYLE_MODEL,
    max_tokens: 16000,
    betas: [...STYLE_BETAS],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["tags"],
          properties: {
            tags: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["tag", "confidence", "reason"],
                properties: {
                  tag: { type: "string", enum: input.vocabulary.map((tag) => tag.id) },
                  confidence: { type: "string", enum: [...TAG_CONFIDENCES] },
                  reason: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...input.photoUrls.flatMap((url, index) => [
            { type: "text" as const, text: `Photo ${index + 1}:` },
            { type: "image" as const, source: { type: "url" as const, url } },
          ]),
          { type: "text", text: `Vocabulary:\n${listing}\n\nTag this wedding.` },
        ],
      },
    ],
  };
}

export type SuggestOutcome =
  | { ok: true; suggestions: Suggestion[] }
  | { ok: false; status: "failed" | "refused"; error: string };

/**
 * Claude's answer as suggestions: only vocabulary tags, each once, with a
 * trimmed reason. A refusal, a cut-off answer or JSON that does not parse is
 * reported, never guessed at.
 */
export function parseSuggestions(
  message: Pick<BetaMessage, "content" | "stop_reason">,
  allowed: ReadonlySet<string>,
): SuggestOutcome {
  if (message.stop_reason === "refusal") return { ok: false, status: "refused", error: "refusal" };
  if (message.stop_reason !== "end_turn") {
    return { ok: false, status: "failed", error: `stop_reason ${message.stop_reason ?? "none"}` };
  }
  const text = message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: "failed", error: "answer was not JSON" };
  }
  const list = (parsed as { tags?: unknown } | null)?.tags;
  if (!Array.isArray(list)) return { ok: false, status: "failed", error: "answer had no tags list" };

  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  for (const entry of list as Array<Record<string, unknown>>) {
    const tag = entry?.["tag"];
    const confidence = entry?.["confidence"];
    const reason = entry?.["reason"];
    if (typeof tag !== "string" || !allowed.has(tag) || seen.has(tag)) continue;
    if (!(TAG_CONFIDENCES as readonly unknown[]).includes(confidence)) continue;
    seen.add(tag);
    suggestions.push({
      tag,
      confidence: confidence as TagConfidence,
      reason: typeof reason === "string" ? reason.trim().slice(0, MAX_REASON) : "",
    });
    if (suggestions.length === MAX_SUGGESTIONS) break;
  }
  return { ok: true, suggestions };
}
