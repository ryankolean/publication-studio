import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../errors.js";
import { evaluateRightsGate } from "../domain/rights-gate.js";
import type { ConsentStatus, RightsStatus } from "../domain/rights-gate.js";
import {
  READ_TOKEN_TTL_SECONDS,
  UPLOAD_TOKEN_TTL_SECONDS,
  mintImageToken,
  verifyImageToken,
} from "../domain/image-token.js";
import { fileNameFromHeader, sanitizeFileName } from "../domain/file-name.js";

/**
 * Only curated, web-size derivatives live in R2 (design doc section 4). These
 * are the formats publications accept, and the cap is generous for one.
 */
const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** "events/<id>/<file>" -> "<id>"; null for any key this server did not mint. */
function eventIdOf(key: string): string | null {
  const match = /^events\/([^/]+)\/[^/]+$/.exec(key);
  return match?.[1] ?? null;
}

/** A short-lived read capability for one object, as a path on this API. */
export async function readUrlFor(secret: string, key: string): Promise<string> {
  const token = await mintImageToken(secret, { key, purpose: "read" });
  return `/images/${key}?token=${encodeURIComponent(token)}`;
}

export const imageRoutes = new Hono<AppContext>();

/** The event's whole pool, newest first, each with a short-lived read url. */
imageRoutes.get("/events/:id/images", requireAuth, async (c) => {
  const event = await c.env.DB.prepare("SELECT id FROM events WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string }>();
  if (event === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");

  // rowid breaks ties inside one second, so two uploads in a row still list
  // in the order they landed.
  const { results } = await c.env.DB.prepare(
    `SELECT key, content_type, bytes, created_at, original_name FROM event_images
     WHERE event_id = ? ORDER BY created_at DESC, rowid DESC`,
  )
    .bind(event.id)
    .all<{
      key: string;
      content_type: string;
      bytes: number;
      created_at: string;
      original_name: string | null;
    }>();

  const images = await Promise.all(
    results.map(async (row) => ({
      key: row.key,
      originalName: row.original_name,
      contentType: row.content_type,
      bytes: row.bytes,
      createdAt: row.created_at,
      readUrl: await readUrlFor(c.env.JWT_SECRET, row.key),
      expiresIn: READ_TOKEN_TTL_SECONDS,
    })),
  );

  return c.json({ images });
});

// DECISION: no rights gate on removal. Deleting curated images is never a
// packaging step, and an event whose consent was later withdrawn is exactly
// the one whose images should be removable.
imageRoutes.delete("/events/:id/images/:key{.+}", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const key = c.req.param("key");

  // Scoped to the event in the path: a key from another event is a 404 here,
  // not a delete, whatever the caller knows about it.
  const image = await c.env.DB.prepare(
    "SELECT key FROM event_images WHERE key = ? AND event_id = ?",
  )
    .bind(key, eventId)
    .first<{ key: string }>();
  if (image === null) return fail(c, 404, "NOT_FOUND", "That photo could not be found.");

  // Exact element match across every package, not a substring of the JSON.
  const user = await c.env.DB.prepare(
    "SELECT packages.id AS id FROM packages, json_each(packages.image_keys) WHERE json_each.value = ? LIMIT 1",
  )
    .bind(image.key)
    .first<{ id: string }>();
  if (user !== null) {
    return fail(
      c,
      409,
      "IMAGE_IN_USE",
      "This photo is still part of a submission. Take it out of that submission first.",
    );
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM event_images WHERE key = ?").bind(image.key),
    c.env.DB
      .prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json) VALUES (?, ?, 'image', ?, 'delete', ?)",
      )
      .bind(crypto.randomUUID(), c.get("user").id, image.key, JSON.stringify({ eventId })),
  ]);
  // After the row: a failed object delete leaves an unlisted orphan, which is
  // harmless, rather than a listed image whose bytes are gone.
  await c.env.IMAGES.delete(image.key);

  return c.json({ key: image.key, deleted: true });
});

/**
 * Mint an upload capability. The key is generated here and never taken from
 * the client, which is what makes path traversal and cross-event writes
 * impossible rather than merely filtered.
 */
imageRoutes.post("/events/:id/images", requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "VALIDATION", "Expected a JSON body.");
  }

  const source = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const contentType = source["contentType"];

  if (typeof contentType !== "string" || ALLOWED_CONTENT_TYPES[contentType] === undefined) {
    return fail(
      c,
      400,
      "VALIDATION",
      `Images must be one of: ${Object.keys(ALLOWED_CONTENT_TYPES).join(", ")}.`,
    );
  }

  const rawName = source["fileName"];
  if (rawName !== undefined && rawName !== null && typeof rawName !== "string") {
    return fail(c, 400, "VALIDATION", "Some fields need attention.", [
      { field: "fileName", message: "Expected text." },
    ]);
  }
  // DECISION: the file name is not stored at grant time and is not put in the
  // capability token, whose format must not change. The grant echoes the
  // sanitized name, the client sends it back as the x-file-name header on the
  // PUT, and the PUT sanitizes it again before writing the pool row. The grant
  // stays stateless and the row is still written only once the bytes land.
  const fileName = sanitizeFileName(rawName);

  const eventId = c.req.param("id");
  const event = await c.env.DB.prepare(
    "SELECT id, rights_status, consent_status FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first<{ id: string; rights_status: RightsStatus; consent_status: ConsentStatus }>();

  if (event === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");

  // DECISION: the rights gate applies here, not only at packaging. Uploading
  // curated selections is the first step of building a package, and section
  // 6.1 makes the gate server-side law. Blocking at the last moment would mean
  // curating an event that can never be sent.
  const gate = evaluateRightsGate({
    rightsStatus: event.rights_status,
    consentStatus: event.consent_status,
  });
  if (!gate.allowed) {
    return fail(c, 403, "RIGHTS_BLOCKED", "This wedding cannot go to an outlet yet.", gate.reasons);
  }

  const extension = ALLOWED_CONTENT_TYPES[contentType] ?? "bin";
  const key = `events/${event.id}/${crypto.randomUUID()}.${extension}`;
  const token = await mintImageToken(c.env.JWT_SECRET, { key, purpose: "write" });

  return c.json(
    {
      key,
      uploadUrl: `/images/${key}?token=${encodeURIComponent(token)}`,
      expiresIn: UPLOAD_TOKEN_TTL_SECONDS,
      maxBytes: MAX_IMAGE_BYTES,
      fileName,
    },
    201,
  );
});

/** Mint a read capability for an object that already exists. */
imageRoutes.post("/images/:key{.+}/read-url", requireAuth, async (c) => {
  const key = c.req.param("key");
  if (key === undefined) return fail(c, 404, "NOT_FOUND", "That photo could not be found.");
  if ((await c.env.IMAGES.head(key)) === null) {
    return fail(c, 404, "NOT_FOUND", "That photo could not be found.");
  }

  return c.json({
    key,
    url: await readUrlFor(c.env.JWT_SECRET, key),
    expiresIn: READ_TOKEN_TTL_SECONDS,
  });
});

/**
 * Upload and read are authorised by the capability token in the query string,
 * not by the bearer token. An <img> tag cannot send an Authorization header,
 * and an upload streamed straight from the browser is simpler this way. The
 * token is bound to this exact key and purpose and expires in minutes.
 */
imageRoutes.put("/images/:key{.+}", async (c) => {
  const key = c.req.param("key");
  if (key === undefined) return fail(c, 404, "NOT_FOUND", "That photo could not be found.");
  const token = c.req.query("token");
  if (token === undefined) return fail(c, 401, "UNAUTHORIZED", "A token is required.");

  const verdict = await verifyImageToken(c.env.JWT_SECRET, token, { key, purpose: "write" });
  if (!verdict.ok) return fail(c, 401, "UNAUTHORIZED", "That upload link is no longer valid.");

  const contentType = c.req.header("content-type") ?? "";
  if (ALLOWED_CONTENT_TYPES[contentType] === undefined) {
    return fail(c, 400, "VALIDATION", "That file type is not supported. Use JPEG, PNG or WebP.");
  }

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return fail(c, 400, "VALIDATION", "The upload was empty.");
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return fail(c, 400, "VALIDATION", "That photo is larger than 12 MB. Export it at web size and try again.");
  }

  // DECISION: the event check runs before the R2 put, not after it. The
  // prefix was minted by this server and the token is bound to the whole key,
  // so the event id in it is trusted; whether that event still exists is not.
  // Checking first means a deleted event gets a 404 and no orphan object,
  // where checking after would store bytes that nothing lists.
  const eventId = eventIdOf(key);
  const event =
    eventId === null
      ? null
      : await c.env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(eventId).first<{ id: string }>();
  if (event === null) return fail(c, 404, "NOT_FOUND", "That wedding could not be found.");

  await c.env.IMAGES.put(key, bytes, { httpMetadata: { contentType } });

  // The name the grant echoed, percent-encoded by the client because header
  // values must be ISO-8859-1. Sanitized again here: the header is client
  // input whatever the grant said.
  const originalName = fileNameFromHeader(c.req.header("x-file-name"));

  // A grant stays valid for its whole TTL, so a second PUT with it replaces the
  // object; the pool row follows rather than duplicating. A repeat without a
  // name keeps the one already recorded.
  await c.env.DB.prepare(
    `INSERT INTO event_images (key, event_id, content_type, bytes, original_name) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET content_type = excluded.content_type, bytes = excluded.bytes,
       original_name = COALESCE(excluded.original_name, event_images.original_name)`,
  )
    .bind(key, event.id, contentType, bytes.byteLength, originalName)
    .run();

  return c.json({ key, bytes: bytes.byteLength }, 201);
});

imageRoutes.get("/images/:key{.+}", async (c) => {
  const key = c.req.param("key");
  if (key === undefined) return fail(c, 404, "NOT_FOUND", "That photo could not be found.");
  const token = c.req.query("token");
  if (token === undefined) return fail(c, 401, "UNAUTHORIZED", "A token is required.");

  const verdict = await verifyImageToken(c.env.JWT_SECRET, token, { key, purpose: "read" });
  if (!verdict.ok) return fail(c, 401, "UNAUTHORIZED", "That photo link has expired. Refresh the page to get a new one.");

  const object = await c.env.IMAGES.get(key);
  if (object === null || object.body === null) {
    return fail(c, 404, "NOT_FOUND", "That photo could not be found.");
  }

  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "content-length": String(object.size),
      // The token already expires; caching beyond it would outlive the grant.
      "cache-control": `private, max-age=${READ_TOKEN_TTL_SECONDS}`,
    },
  });
});
