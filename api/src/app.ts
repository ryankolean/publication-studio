import { Hono } from "hono";
import { cors } from "hono/cors";

import type { AppContext } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { publicationRoutes } from "./routes/publications.js";
import { eventRoutes } from "./routes/events.js";
import { imageRoutes } from "./routes/images.js";
import { packageRoutes } from "./routes/packages.js";
import { tagRoutes } from "./routes/tags.js";
import { researchRoutes } from "./routes/research.js";
import { submissionRoutes } from "./routes/submissions.js";
import { styleRoutes } from "./routes/style.js";
import { locationRoutes } from "./routes/locations.js";
import { fail } from "./errors.js";

/**
 * There is deliberately no signup route and no user-creation route. Users are
 * created by seed migration only (design doc section 4).
 */
export function createApp() {
  const app = new Hono<AppContext>();

  // CORS is pinned to the SPA origin; anything else gets no allow-origin header.
  //
  // The origin is read through the callback rather than by wrapping cors() in
  // another middleware. Wrapping it produced a preflight response with no
  // headers at all on workerd -- fine in Hono's in-process test harness, fatal
  // in the browser, since every authenticated request preflights.
  app.use(
    "*",
    cors({
      origin: (origin, c) => (origin === c.env.ALLOWED_ORIGIN ? origin : null),
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      // x-file-name carries the photographer's file name on an image upload.
      allowHeaders: ["authorization", "content-type", "x-file-name"],
      maxAge: 86400,
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.route("/auth", authRoutes);
  app.route("/publications", publicationRoutes);
  app.route("/events", eventRoutes);
  app.route("/packages", packageRoutes);
  app.route("/tags", tagRoutes);
  app.route("/research", researchRoutes);
  app.route("/submissions", submissionRoutes);
  app.route("/style", styleRoutes);
  app.route("/locations", locationRoutes);
  // Mounted at the root: image routes own both /events/:id/images and /images/*.
  app.route("/", imageRoutes);

  app.notFound((c) => fail(c, 404, "NOT_FOUND", "No such route."));

  app.onError((error, c) => {
    // Errors may carry gallery URLs or hashes; never return one to a client.
    console.error("unhandled error", error instanceof Error ? error.message : error);
    return fail(c, 500, "INTERNAL", "Something went wrong.");
  });

  return app;
}
