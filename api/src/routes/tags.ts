import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../errors.js";
import { TAG_CATEGORIES, TAG_CATEGORY_ORDER } from "../domain/tags.js";
import type { TagCategory } from "../domain/tags.js";

interface TagRow {
  id: string;
  category: TagCategory;
}

export const tagRoutes = new Hono<AppContext>();

tagRoutes.use("*", requireAuth);

/** The whole vocabulary, grouped by category in priority order. */
tagRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, category FROM tags ORDER BY ${TAG_CATEGORY_ORDER}, sort_order`,
  ).all<TagRow>();

  return c.json({ tags: results });
});

/** The photographer adds her own tag to the vocabulary, to use on outlets and weddings. */
tagRoutes.post("/", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const category = record["category"];
  if (typeof category !== "string" || !(TAG_CATEGORIES as readonly string[]).includes(category)) {
    return fail(c, 422, "VALIDATION", `Pick one of: ${TAG_CATEGORIES.join(", ")}.`);
  }
  const label = typeof record["label"] === "string" ? record["label"] : "";
  const id = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (id.length < 2) return fail(c, 422, "VALIDATION", "A tag needs at least two letters or numbers.");

  const db = c.env.DB;
  if ((await db.prepare("SELECT id FROM tags WHERE id = ?").bind(id).first()) !== null) {
    return fail(c, 409, "TAG_EXISTS", "That tag already exists.");
  }
  const next = await db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tags WHERE category = ?")
    .bind(category)
    .first<{ n: number }>();
  await db
    .prepare("INSERT INTO tags (id, category, sort_order, origin) VALUES (?, ?, ?, 'custom')")
    .bind(id, category, next?.n ?? 0)
    .run();
  return c.json({ id, category, origin: "custom" }, 201);
});
