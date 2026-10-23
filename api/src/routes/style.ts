import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { Hono } from "hono";
import type { Context } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../errors.js";
import type { D1Database, Env } from "../env.js";
import { sha256Hex } from "../domain/research/canonical.js";
import {
  MAX_RUNS_PER_DAY,
  lookTags,
  photoSetText,
  pickPhotos,
  planAnalysis,
  regionTags,
  seasonTags,
  validatePastFeature,
} from "../domain/style.js";
import type { EventTagRow, EventTagSource, PastFeatureInput } from "../domain/style.js";
import { STYLE_MODEL, buildSuggestRequest, parseSuggestions, photoVocabulary } from "../domain/style-analysis.js";
import { TAG_CATEGORY_ORDER } from "../domain/tags.js";
import type { TagCategory } from "../domain/tags.js";
import { readUrlFor } from "./images.js";

/** Sends one suggestion request to Claude. Tests hand createApp their own. */
export type Analyze = (env: Env, request: MessageCreateParamsNonStreaming) => Promise<BetaMessage>;

export const callClaude: Analyze = (env, request) =>
  new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).beta.messages.create(request);

interface EventRow {
  id: string;
  event_date: string;
  state: string | null;
  country: string | null;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

async function loadVocabulary(db: D1Database): Promise<Array<{ id: string; category: TagCategory }>> {
  const { results } = await db
    .prepare(`SELECT id, category FROM tags ORDER BY ${TAG_CATEGORY_ORDER}, tags.sort_order, tags.id`)
    .all<{ id: string; category: TagCategory }>();
  return results;
}

async function analysisEnabled(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT value FROM app_settings WHERE key = 'photo_analysis'")
    .first<{ value: string }>();
  return row?.value === "on";
}

const analysisAvailable = (env: Env): boolean => (env.ANTHROPIC_API_KEY ?? "") !== "";

/** What the wedding's date and state suggest, each with the line the screen shows. */
async function derivedFor(db: D1Database, event: EventRow): Promise<Array<{ tag: string; reason: string }>> {
  const geo = await db.prepare("SELECT json FROM research_vocab WHERE kind = 'geo'").first<{ json: string }>();
  return [
    ...seasonTags(event.event_date).map((tag) => ({ tag, reason: "From the wedding date." })),
    ...regionTags(event.state, event.country, geo === null ? null : JSON.parse(geo.json)).map((tag) => ({
      tag,
      reason: "From where the wedding was.",
    })),
  ];
}

async function tagRows(db: D1Database, eventId: string): Promise<EventTagRow[]> {
  const { results } = await db
    .prepare("SELECT tag_id, state, source, confidence, reason FROM event_tags WHERE event_id = ?")
    .bind(eventId)
    .all<EventTagRow>();
  return results;
}

/** The wedding's photos, oldest first: the order pickPhotos spreads across. */
async function poolOf(db: D1Database, eventId: string): Promise<Array<{ key: string; bytes: number }>> {
  const { results } = await db
    .prepare("SELECT key, bytes FROM event_images WHERE event_id = ? ORDER BY created_at, key")
    .bind(eventId)
    .all<{ key: string; bytes: number }>();
  return results;
}

/** Everything the Look screen shows for one wedding. */
async function lookView(c: Context<AppContext>, event: EventRow) {
  const db = c.env.DB;
  const [rows, derived, vocabulary, pool, enabled, lastRun] = await Promise.all([
    tagRows(db, event.id),
    derivedFor(db, event),
    loadVocabulary(db),
    poolOf(db, event.id),
    analysisEnabled(db),
    db
      .prepare(
        `SELECT status, image_keys_json, photo_set_hash, created_at FROM style_runs
         WHERE event_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .bind(event.id)
      .first<{ status: string; image_keys_json: string; photo_set_hash: string; created_at: string }>(),
  ]);
  const picked = pickPhotos(pool);
  const hash = await sha256Hex(photoSetText(picked));
  return {
    tags: lookTags(rows, derived, vocabulary),
    vocabulary,
    photos: { count: pool.length, usable: picked.length },
    analysis: {
      enabled,
      available: analysisAvailable(c.env),
      lastRun:
        lastRun === null
          ? null
          : {
              at: lastRun.created_at,
              status: lastRun.status,
              photoCount: (JSON.parse(lastRun.image_keys_json) as unknown[]).length,
            },
      current: lastRun !== null && lastRun.status === "ok" && lastRun.photo_set_hash === hash,
    },
  };
}

async function loadEvent(db: D1Database, id: string): Promise<EventRow | null> {
  return db.prepare("SELECT id, event_date, state, country FROM events WHERE id = ?").bind(id).first<EventRow>();
}

interface FeatureRow {
  id: string;
  publication_id: string | null;
  outlet_name: string;
  event_id: string | null;
  couple_names: string | null;
  feature_url: string | null;
  published_on: string | null;
  role: string;
  notes: string | null;
}

async function listFeatures(db: D1Database, id: string | null = null) {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.publication_id, f.outlet_name, f.event_id, e.couple_names, f.feature_url,
              f.published_on, f.role, f.notes
       FROM past_features f LEFT JOIN events e ON e.id = f.event_id
       WHERE ? IS NULL OR f.id = ?
       ORDER BY f.published_on IS NULL, f.published_on DESC, f.created_at DESC`,
    )
    .bind(id, id)
    .all<FeatureRow>();
  return results.map((row) => ({
    id: row.id,
    publicationId: row.publication_id,
    outletName: row.outlet_name,
    eventId: row.event_id,
    coupleNames: row.couple_names,
    featureUrl: row.feature_url,
    publishedOn: row.published_on,
    role: row.role,
    notes: row.notes,
  }));
}

/**
 * Checks a past feature's links, and names the outlet from its publication
 * when it is one of the researched ones and no name was typed.
 */
async function resolveFeature(
  db: D1Database,
  input: PastFeatureInput,
): Promise<{ ok: true; outletName: string } | { ok: false; field: string; message: string }> {
  let outletName = input.outletName;
  if (input.publicationId !== null) {
    const outlet = await db
      .prepare("SELECT name FROM publications WHERE id = ?")
      .bind(input.publicationId)
      .first<{ name: string }>();
    if (outlet === null) return { ok: false, field: "publicationId", message: "That outlet could not be found." };
    outletName ??= outlet.name;
  }
  if (input.eventId !== null && (await loadEvent(db, input.eventId)) === null) {
    return { ok: false, field: "eventId", message: "That wedding could not be found." };
  }
  return { ok: true, outletName: outletName as string };
}

async function readBody(c: Context<AppContext>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createStyleRoutes(analyze: Analyze = callClaude) {
  const routes = new Hono<AppContext>();
  routes.use("*", requireAuth);

  routes.get("/events/:id", async (c) => {
    const event = await loadEvent(c.env.DB, c.req.param("id"));
    if (event === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");
    return c.json(await lookView(c, event));
  });

  /**
   * Sends up to 20 of the wedding's photos to Claude and stores what it
   * suggests. Nothing is sent unless the photographer has switched photo
   * suggestions on, and the same photos are never sent twice.
   */
  routes.post("/events/:id/suggest", async (c) => {
    const db = c.env.DB;
    const event = await loadEvent(db, c.req.param("id"));
    if (event === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");
    if (!(await analysisEnabled(db))) {
      return fail(c, 409, "PHOTO_ANALYSIS_OFF", "Photo suggestions are switched off. Turn them on under Your work first.");
    }
    if (!analysisAvailable(c.env)) {
      return fail(c, 503, "ANALYSIS_UNAVAILABLE", "Suggestions are not set up yet. Choose the tags yourself for now.");
    }

    const pool = await poolOf(db, event.id);
    const keys = pickPhotos(pool);
    if (keys.length === 0) {
      return pool.length === 0
        ? fail(c, 409, "NO_PHOTOS", "Add a few photos first.")
        : fail(c, 409, "NO_PHOTOS", "Every photo here is over 7.5 MB. Add web-size copies first.");
    }

    const hash = await sha256Hex(photoSetText(keys));
    const done = await db
      .prepare("SELECT id FROM style_runs WHERE event_id = ? AND status = 'ok' AND photo_set_hash = ? LIMIT 1")
      .bind(event.id, hash)
      .first<{ id: string }>();
    if (done !== null) return c.json({ ...(await lookView(c, event)), fresh: false });

    const today = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const runs = await db
      .prepare("SELECT COUNT(*) AS n FROM style_runs WHERE event_id = ? AND created_at >= ?")
      .bind(event.id, today)
      .first<{ n: number }>();
    if ((runs?.n ?? 0) >= MAX_RUNS_PER_DAY) {
      return fail(c, 429, "ANALYSIS_LIMIT", "That is enough suggestions for this wedding today. Try again tomorrow.");
    }

    const vocabulary = photoVocabulary(await loadVocabulary(db));
    const origin = new URL(c.req.url).origin;
    const photoUrls = await Promise.all(keys.map(async (key) => `${origin}${await readUrlFor(c.env.JWT_SECRET, key)}`));
    const request = buildSuggestRequest({ vocabulary, photoUrls });

    // DECISION: a failure is stored as a short code, never the SDK's message,
    // which can quote the request and with it the photo links.
    let outcome: ReturnType<typeof parseSuggestions>;
    let usage: { input_tokens: number; output_tokens: number } | null = null;
    try {
      const message = await analyze(c.env, request);
      usage = message.usage;
      outcome = parseSuggestions(message, new Set(vocabulary.map((tag) => tag.id)));
    } catch (error) {
      outcome = {
        ok: false,
        status: "failed",
        error: error instanceof Anthropic.APIError ? `api ${error.status ?? "error"}` : "network",
      };
    }

    const runId = crypto.randomUUID();
    const user = c.get("user").id;
    const at = nowIso();
    const statements = [
      db
        .prepare(
          `INSERT INTO style_runs (id, event_id, model, image_keys_json, photo_set_hash, status, input_tokens, output_tokens, error, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          runId,
          event.id,
          STYLE_MODEL,
          JSON.stringify(keys),
          hash,
          outcome.ok ? "ok" : outcome.status,
          usage?.input_tokens ?? null,
          usage?.output_tokens ?? null,
          outcome.ok ? null : outcome.error,
          user,
          at,
        ),
      db
        .prepare(
          "INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json) VALUES (?, ?, 'event', ?, 'photos_analyzed', ?)",
        )
        .bind(crypto.randomUUID(), user, event.id, JSON.stringify({ runId, photos: keys.length, ok: outcome.ok })),
    ];

    if (outcome.ok) {
      const plan = planAnalysis(await tagRows(db, event.id), outcome.suggestions);
      for (const tag of plan.drop) {
        statements.push(
          db
            .prepare("DELETE FROM event_tags WHERE event_id = ? AND tag_id = ? AND state = 'suggested' AND source = 'analysis'")
            .bind(event.id, tag),
        );
      }
      for (const suggestion of plan.write) {
        // The WHERE keeps a decision safe even if she answered while this ran.
        statements.push(
          db
            .prepare(
              `INSERT INTO event_tags (event_id, tag_id, state, source, confidence, reason, run_id, updated_by, updated_at)
               VALUES (?, ?, 'suggested', 'analysis', ?, ?, ?, ?, ?)
               ON CONFLICT (event_id, tag_id) DO UPDATE SET
                 source = 'analysis', confidence = excluded.confidence, reason = excluded.reason,
                 run_id = excluded.run_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at
               WHERE event_tags.state = 'suggested'`,
            )
            .bind(event.id, suggestion.tag, suggestion.confidence, suggestion.reason, runId, user, at),
        );
      }
    }
    await db.batch(statements);

    if (!outcome.ok) {
      return fail(
        c,
        502,
        "ANALYSIS_FAILED",
        outcome.status === "refused"
          ? "Claude would not suggest tags for these photos. Choose the tags yourself."
          : "Claude could not suggest tags just now. Try again later, or choose the tags yourself.",
      );
    }
    return c.json({ ...(await lookView(c, event)), fresh: true });
  });

  /** Her answer to one tag: keep it or not. A tag with no row yet is added as hers. */
  routes.put("/events/:id/tags/:tag", async (c) => {
    const db = c.env.DB;
    const event = await loadEvent(db, c.req.param("id"));
    if (event === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");
    const tagId = c.req.param("tag");
    const tag = await db.prepare("SELECT id FROM tags WHERE id = ?").bind(tagId).first<{ id: string }>();
    if (tag === null) return fail(c, 404, "NOT_FOUND", "That tag could not be found.");

    const body = (await readBody(c)) as { state?: unknown } | undefined;
    const state = body?.state;
    if (state !== "confirmed" && state !== "rejected") {
      return fail(c, 400, "VALIDATION", "Expected the state confirmed or rejected.");
    }

    const derived = (await derivedFor(db, event)).find((entry) => entry.tag === tagId);
    const source: EventTagSource = derived === undefined ? "photographer" : "derived";
    await db
      .prepare(
        `INSERT INTO event_tags (event_id, tag_id, state, source, reason, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id, tag_id) DO UPDATE SET
           state = excluded.state, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(event.id, tagId, state, source, derived?.reason ?? null, c.get("user").id, nowIso())
      .run();
    return c.json(await lookView(c, event));
  });

  routes.get("/profile", async (c) => {
    const db = c.env.DB;
    const [enabled, counts, weddings, features] = await Promise.all([
      analysisEnabled(db),
      db
        .prepare(
          `SELECT tags.category, tags.id, COUNT(*) AS weddings
           FROM event_tags
           JOIN tags ON tags.id = event_tags.tag_id
           JOIN events ON events.id = event_tags.event_id
           WHERE event_tags.state = 'confirmed' AND events.rights_status != 'second_shooter'
           GROUP BY tags.id
           ORDER BY ${TAG_CATEGORY_ORDER}, weddings DESC, tags.sort_order`,
        )
        .all<{ category: TagCategory; id: string; weddings: number }>(),
      db
        .prepare(
          `SELECT events.id, events.couple_names, events.event_date, events.rights_status,
                  SUM(event_tags.state = 'confirmed') AS confirmed,
                  SUM(event_tags.state = 'suggested') AS suggested
           FROM events LEFT JOIN event_tags ON event_tags.event_id = events.id
           GROUP BY events.id
           ORDER BY events.event_date DESC`,
        )
        .all<{
          id: string;
          couple_names: string;
          event_date: string;
          rights_status: string;
          confirmed: number | null;
          suggested: number | null;
        }>(),
      listFeatures(db),
    ]);

    const categories: Array<{ category: TagCategory; tags: Array<{ id: string; weddings: number }> }> = [];
    for (const row of counts.results) {
      const last = categories[categories.length - 1];
      const entry = { id: row.id, weddings: row.weddings };
      if (last?.category === row.category) last.tags.push(entry);
      else categories.push({ category: row.category, tags: [entry] });
    }

    return c.json({
      analysis: { enabled, available: analysisAvailable(c.env) },
      tagged: weddings.results.filter((row) => (row.confirmed ?? 0) > 0 && row.rights_status !== "second_shooter").length,
      categories,
      weddings: weddings.results.map((row) => ({
        id: row.id,
        coupleNames: row.couple_names,
        eventDate: row.event_date,
        secondShooter: row.rights_status === "second_shooter",
        confirmed: row.confirmed ?? 0,
        suggested: row.suggested ?? 0,
      })),
      features,
    });
  });

  /** Her consent to photos going to Claude. Only she can give or withdraw it. */
  routes.put("/settings/photo-analysis", async (c) => {
    if (c.get("user").role !== "photographer") {
      return fail(c, 403, "FORBIDDEN", "Only the photographer can change this.");
    }
    const body = (await readBody(c)) as { enabled?: unknown } | undefined;
    if (typeof body?.enabled !== "boolean") return fail(c, 400, "VALIDATION", "Expected enabled to be true or false.");
    const user = c.get("user").id;
    const value = body.enabled ? "on" : "off";
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('photo_analysis', ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .bind(value, user, nowIso()),
      c.env.DB
        .prepare(
          "INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json) VALUES (?, ?, 'setting', 'photo_analysis', ?, '{}')",
        )
        .bind(crypto.randomUUID(), user, `photo_analysis_${value}`),
    ]);
    return c.json({ enabled: body.enabled });
  });

  routes.post("/features", async (c) => {
    const parsed = validatePastFeature(await readBody(c));
    if (!parsed.ok) return fail(c, 400, "VALIDATION", "Some fields need attention.", parsed.errors);
    const resolved = await resolveFeature(c.env.DB, parsed.value);
    if (!resolved.ok) {
      return fail(c, 400, "VALIDATION", "Some fields need attention.", [{ field: resolved.field, message: resolved.message }]);
    }
    const id = crypto.randomUUID();
    const input = parsed.value;
    await c.env.DB.prepare(
      `INSERT INTO past_features (id, publication_id, outlet_name, event_id, feature_url, published_on, role, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, input.publicationId, resolved.outletName, input.eventId, input.featureUrl, input.publishedOn, input.role, input.notes, c.get("user").id)
      .run();
    return c.json({ feature: (await listFeatures(c.env.DB, id))[0] }, 201);
  });

  routes.put("/features/:id", async (c) => {
    const id = c.req.param("id");
    if ((await listFeatures(c.env.DB, id)).length === 0) return fail(c, 404, "NOT_FOUND", "That feature could not be found.");
    const parsed = validatePastFeature(await readBody(c));
    if (!parsed.ok) return fail(c, 400, "VALIDATION", "Some fields need attention.", parsed.errors);
    const resolved = await resolveFeature(c.env.DB, parsed.value);
    if (!resolved.ok) {
      return fail(c, 400, "VALIDATION", "Some fields need attention.", [{ field: resolved.field, message: resolved.message }]);
    }
    const input = parsed.value;
    await c.env.DB.prepare(
      `UPDATE past_features SET publication_id = ?, outlet_name = ?, event_id = ?, feature_url = ?, published_on = ?,
         role = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(input.publicationId, resolved.outletName, input.eventId, input.featureUrl, input.publishedOn, input.role, input.notes, nowIso(), id)
      .run();
    return c.json({ feature: (await listFeatures(c.env.DB, id))[0] });
  });

  routes.delete("/features/:id", async (c) => {
    const id = c.req.param("id");
    if ((await listFeatures(c.env.DB, id)).length === 0) return fail(c, 404, "NOT_FOUND", "That feature could not be found.");
    await c.env.DB.prepare("DELETE FROM past_features WHERE id = ?").bind(id).run();
    return c.json({ deleted: id });
  });

  return routes;
}
