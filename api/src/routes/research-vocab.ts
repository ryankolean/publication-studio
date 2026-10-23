import type { D1Database } from "../env.js";
import { parseResearchVocab } from "../domain/research/schema.js";
import type { ResearchVocab } from "../domain/research/schema.js";

/** Now, as the ISO-8601 UTC text every timestamp column holds. */
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Today in UTC, YYYY-MM-DD: research read dates may not be later. */
export const today = () => new Date().toISOString().slice(0, 10);

/** The vocabulary the last import loaded, or null before the first one. */
export async function loadVocab(db: D1Database): Promise<ResearchVocab | null> {
  const { results } = await db.prepare("SELECT kind, json FROM research_vocab").all<{ kind: string; json: string }>();
  const byKind = new Map(results.map((row) => [row.kind, JSON.parse(row.json) as unknown]));
  if (!byKind.has("tags") || !byKind.has("geo")) return null;
  const parsed = parseResearchVocab(byKind.get("tags"), byKind.get("geo"));
  return parsed.ok ? parsed.value : null;
}
