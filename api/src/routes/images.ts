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

export const imageRoutes = new Hono<AppContext>();

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

  const contentType =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["contentType"]
      : undefined;

  if (typeof contentType !== "string" || ALLOWED_CONTENT_TYPES[contentType] === undefined) {
    return fail(
      c,
      400,
      "VALIDATION",
      `Images must be one of: ${Object.keys(ALLOWED_CONTENT_TYPES).join(", ")}.`,
    );
  }

  const eventId = c.req.param("id");
  const event = await c.env.DB.prepare(
    "SELECT id, rights_status, consent_status FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first<{ id: string; rights_status: RightsStatus; consent_status: ConsentStatus }>();

  if (event === null) return fail(c, 404, "NOT_FOUND", "No such event.");

  // DECISION: the rights gate applies here, not only at packaging. Uploading
  // curated selections is the first step of building a package, and section
  // 6.1 makes the gate server-side law. Blocking at the last moment would mean
  // curating an event that can never be sent.
  const gate = evaluateRightsGate({
    rightsStatus: event.rights_status,
    consentStatus: event.consent_status,
  });
  if (!gate.allowed) {
    return fail(c, 403, "RIGHTS_BLOCKED", "This event cannot be packaged yet.", gate.reasons);
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
    },
    201,
  );
});

/** Mint a read capability for an object that already exists. */
imageRoutes.post("/images/:key{.+}/read-url", requireAuth, async (c) => {
  const key = c.req.param("key");
  if (key === undefined) return fail(c, 404, "NOT_FOUND", "No such image.");
  if ((await c.env.IMAGES.head(key)) === null) {
    return fail(c, 404, "NOT_FOUND", "No such image.");
  }

  const token = await mintImageToken(c.env.JWT_SECRET, { key, purpose: "read" });
  return c.json({
    key,
    url: `/images/${key}?token=${encodeURIComponent(token)}`,
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
  if (key === undefined) return fail(c, 404, "NOT_FOUND", "No such image.");
  const token = c.req.query("token");
  if (token === undefined) return fail(c, 401, "UNAUTHORIZED", "A token is required.");

  const verdict = await verifyImageToken(c.env.JWT_SECRET, token, { key, purpose: "write" });
  if (!verdict.ok) return fail(c, 401, "UNAUTHORIZED", "That upload link is no longer valid.");

  const contentType = c.req.header("content-type") ?? "";
  if (ALLOWED_CONTENT_TYPES[contentType] === undefined) {
    return fail(c, 400, "VALIDATION", "Unsupported image type.");
  }

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return fail(c, 400, "VALIDATION", "The upload was empty.");
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return fail(c, 400, "VALIDATION", "That image is larger than the limit.");
  }

  await c.env.IMAGES.put(key, bytes, { httpMetadata: { contentType } });
  return c.json({ key, bytes: bytes.byteLength }, 201);
});

imageRoutes.get("/images/:key{.+}", async (c) => {
  const key = c.req.param("key");
  if (key === undefined) return fail(c, 404, "NOT_FOUND", "No such image.");
  const token = c.req.query("token");
  if (token === undefined) return fail(c, 401, "UNAUTHORIZED", "A token is required.");

  const verdict = await verifyImageToken(c.env.JWT_SECRET, token, { key, purpose: "read" });
  if (!verdict.ok) return fail(c, 401, "UNAUTHORIZED", "That image link is no longer valid.");

  const object = await c.env.IMAGES.get(key);
  if (object === null || object.body === null) {
    return fail(c, 404, "NOT_FOUND", "No such image.");
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
