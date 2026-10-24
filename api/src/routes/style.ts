import { Hono } from "hono";
import type { Context } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { fail } from "../errors.js";
import type { D1Database } from "../env.js";
import { regionTagsForLocation } from "../domain/geo.js";
import { lookTags, planSuggestions, seasonTags, validatePastFeature, validateSuggestions } from "../domain/style.js";
import type { EventTagRow, EventTagSource, PastFeatureInput } from "../domain/style.js";
import { TAG_CATEGORY_ORDER } from "../domain/tags.js";
import type { TagCategory } from "../domain/tags.js";
import { loadGeo } from "./match-context.js";

interface EventRow {
  id: string;
  event_date: string;
  location_code: string | null;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

async function loadVocabulary(db: D1Database): Promise<Array<{ id: string; category: TagCategory }>> {
  const { results } = await db
    .prepare(`SELECT id, category FROM tags ORDER BY ${TAG_CATEGORY_ORDER}, tags.sort_order, tags.id`)
    .all<{ id: string; category: TagCategory }>();
  return results;
}

/** What the wedding's date and place suggest, each with the line the screen shows. */
async function derivedFor(db: D1Database, event: EventRow): Promise<Array<{ tag: string; reason: string }>> {
  const geo = await loadGeo(db);
  return [
    ...seasonTags(event.event_date).map((tag) => ({ tag, reason: "From the wedding date." })),
    ...(geo === null ? [] : regionTagsForLocation(event.location_code, geo)).map((tag) => ({
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

/** Everything the Look screen shows for one wedding. */
async function lookView(db: D1Database, event: EventRow) {
  const [rows, derived, vocabulary] = await Promise.all([tagRows(db, event.id), derivedFor(db, event), loadVocabulary(db)]);
  return { tags: lookTags(rows, derived, vocabulary), vocabulary };
}

async function loadEvent(db: D1Database, id: string): Promise<EventRow | null> {
  return db.prepare("SELECT id, event_date, location_code FROM events WHERE id = ?").bind(id).first<EventRow>();
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

export const styleRoutes = new Hono<AppContext>();

styleRoutes.use("*", requireAuth);

styleRoutes.get("/events/:id", async (c) => {
  const event = await loadEvent(c.env.DB, c.req.param("id"));
  if (event === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");
  return c.json(await lookView(c.env.DB, event));
});

/**
 * The operator's suggested tags for one wedding, worked out outside the tool
 * (scripts/suggest-tags.ts sends them). The set replaces the operator's
 * earlier suggestions for the wedding; tags the photographer has already
 * confirmed or rejected are left as she answered them.
 */
styleRoutes.put("/events/:id/suggestions", requireRole("admin"), async (c) => {
  const db = c.env.DB;
  const event = await loadEvent(db, c.req.param("id") ?? "");
  if (event === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");
  const vocabulary = new Set((await loadVocabulary(db)).map((tag) => tag.id));
  const parsed = validateSuggestions(await readBody(c), vocabulary);
  if (!parsed.ok) return fail(c, 400, "VALIDATION", "Some fields need attention.", parsed.errors);

  const plan = planSuggestions(await tagRows(db, event.id), parsed.value);
  const user = c.get("user").id;
  const at = nowIso();
  await db.batch([
    ...plan.drop.map((tag) =>
      db
        .prepare("DELETE FROM event_tags WHERE event_id = ? AND tag_id = ? AND state = 'suggested' AND source = 'operator'")
        .bind(event.id, tag),
    ),
    // The WHERE keeps a decision safe even if she answered while this ran.
    ...plan.write.map((suggestion) =>
      db
        .prepare(
          `INSERT INTO event_tags (event_id, tag_id, state, source, confidence, reason, updated_by, updated_at)
           VALUES (?, ?, 'suggested', 'operator', ?, ?, ?, ?)
           ON CONFLICT (event_id, tag_id) DO UPDATE SET
             source = 'operator', confidence = excluded.confidence, reason = excluded.reason,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at
           WHERE event_tags.state = 'suggested'`,
        )
        .bind(event.id, suggestion.tag, suggestion.confidence, suggestion.reason, user, at),
    ),
    db
      .prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json) VALUES (?, ?, 'event', ?, 'tags_suggested', ?)",
      )
      .bind(crypto.randomUUID(), user, event.id, JSON.stringify({ written: plan.write.length, dropped: plan.drop.length })),
  ]);

  return c.json({
    ...(await lookView(db, event)),
    written: plan.write.length,
    dropped: plan.drop.length,
    alreadyAnswered: parsed.value.length - plan.write.length,
  });
});

/** Her answer to one tag: keep it or not. A tag with no row yet is added as hers. */
styleRoutes.put("/events/:id/tags/:tag", async (c) => {
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
  return c.json(await lookView(db, event));
});

styleRoutes.get("/profile", async (c) => {
  const db = c.env.DB;
  const [counts, weddings, features] = await Promise.all([
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

styleRoutes.post("/features", async (c) => {
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

styleRoutes.put("/features/:id", async (c) => {
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

styleRoutes.delete("/features/:id", async (c) => {
  const id = c.req.param("id");
  if ((await listFeatures(c.env.DB, id)).length === 0) return fail(c, 404, "NOT_FOUND", "That feature could not be found.");
  await c.env.DB.prepare("DELETE FROM past_features WHERE id = ?").bind(id).run();
  return c.json({ deleted: id });
});
