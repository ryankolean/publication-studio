import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { locationOptions } from "../domain/geo.js";
import { loadGeo } from "./match-context.js";

/** Every place a wedding can be, for the wedding screen's dropdown (SUMMIT-336). */
export const locationRoutes = new Hono<AppContext>();

locationRoutes.use("*", requireAuth);

locationRoutes.get("/", async (c) => {
  const geo = await loadGeo(c.env.DB);
  return c.json({ locations: geo === null ? [] : locationOptions(geo) });
});
