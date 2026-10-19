import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { TAG_CATEGORY_ORDER } from "../domain/tags.js";
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
