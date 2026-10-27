import { Hono } from "hono";
import type { Context } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { fail } from "../errors.js";
import { fileNameFromHeader } from "../domain/file-name.js";
import { evaluateRightsGate } from "../domain/rights-gate.js";
import type { ConsentStatus, RightsStatus } from "../domain/rights-gate.js";
import { UPLOAD_LINK_PHOTO_LIMIT, hashLinkToken, isoSeconds, linkToken, photoRef } from "../domain/upload-link.js";
import { ALLOWED_CONTENT_TYPES, MAX_IMAGE_BYTES, storePreview } from "./images.js";
import { uploadPage, uploadPagePolicy } from "./upload-page.js";

/**
 * Photo intake by link (SUMMIT-344 slice 2): the page get_upload_link points
 * to, and the four calls it makes. They are authorised by the link's own
 * token, never by a session, and only while the link is open: not expired,
 * not closed, and not replaced by a newer link for the same wedding.
 *
 * The rules are the pool's own (routes/images.ts): the same formats and size
 * cap, keys minted here and never taken from the page, and the rights gate
 * before any photo is stored.
 */

interface OpenLink {
  id: string;
  event_id: string;
  photos: number;
  couple_names: string;
  event_date: string;
  rights_status: RightsStatus;
  consent_status: ConsentStatus;
}

const CLOSED = "This link has expired or has been closed. Ask Claude for a new one.";
const BLOCKED = "Photos can be added once the permission answers for this wedding say yes. Go back to Claude to record them.";
const FULL = "This link cannot take any more photos. Ask Claude for a new one to add more.";

async function openLink(c: Context<AppContext>): Promise<OpenLink | null> {
  const token = linkToken(c.req.header("authorization"));
  if (token === null) return null;
  return c.env.DB.prepare(
    `SELECT upload_links.id, upload_links.event_id, upload_links.photos, events.couple_names, events.event_date,
            events.rights_status, events.consent_status
     FROM upload_links JOIN events ON events.id = upload_links.event_id
     WHERE upload_links.id = ? AND upload_links.closed_at IS NULL AND upload_links.expires_at > ?`,
  )
    .bind(await hashLinkToken(token), isoSeconds(Date.now()))
    .first<OpenLink>();
}

const gateOpen = (link: OpenLink) =>
  evaluateRightsGate({ rightsStatus: link.rights_status, consentStatus: link.consent_status }).allowed;

async function poolSize(c: Context<AppContext>, eventId: string): Promise<number> {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM event_images WHERE event_id = ?").bind(eventId).first<{ n: number }>();
  return row?.n ?? 0;
}

export const uploadRoutes = new Hono<AppContext>();

uploadRoutes.get("/", (c) => {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return c.body(uploadPage(nonce), 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": uploadPagePolicy(nonce),
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
});

uploadRoutes.get("/link", async (c) => {
  const link = await openLink(c);
  if (link === null) return fail(c, 401, "UNAUTHORIZED", CLOSED);
  if (!gateOpen(link)) return fail(c, 403, "RIGHTS_BLOCKED", BLOCKED);
  return c.json({
    couple: link.couple_names,
    date: link.event_date,
    photos: await poolSize(c, link.event_id),
    room: UPLOAD_LINK_PHOTO_LIMIT - link.photos,
    maxBytes: MAX_IMAGE_BYTES,
    types: Object.keys(ALLOWED_CONTENT_TYPES),
  });
});

uploadRoutes.post("/photos", async (c) => {
  const link = await openLink(c);
  if (link === null) return fail(c, 401, "UNAUTHORIZED", CLOSED);
  // Checked per photo, not once: the answers can change while the page is open.
  if (!gateOpen(link)) return fail(c, 403, "RIGHTS_BLOCKED", BLOCKED);
  if (link.photos >= UPLOAD_LINK_PHOTO_LIMIT) return fail(c, 409, "UPLOAD_LINK_FULL", FULL);

  const contentType = c.req.header("content-type") ?? "";
  const extension = ALLOWED_CONTENT_TYPES[contentType];
  if (extension === undefined) {
    return fail(c, 400, "VALIDATION", "That file type is not supported. Use JPEG, PNG or WebP.");
  }
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return fail(c, 400, "VALIDATION", "The upload was empty.");
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return fail(c, 400, "VALIDATION", "That photo is larger than 12 MB. Export it at web size and try again.");
  }

  // One statement re-checks the link and takes a place under the cap, so two
  // uploads racing for the last place cannot both have it, and a link closed
  // since the check above takes nothing more.
  const claimed = await c.env.DB.prepare(
    `UPDATE upload_links SET photos = photos + 1
     WHERE id = ? AND closed_at IS NULL AND expires_at > ? AND photos < ?
     RETURNING photos`,
  )
    .bind(link.id, isoSeconds(Date.now()), UPLOAD_LINK_PHOTO_LIMIT)
    .first<{ photos: number }>();
  if (claimed === null) return fail(c, 409, "UPLOAD_LINK_FULL", FULL);

  const file = `${crypto.randomUUID()}.${extension}`;
  const key = `events/${link.event_id}/${file}`;
  await c.env.IMAGES.put(key, bytes, { httpMetadata: { contentType } });
  await c.env.DB.prepare(
    "INSERT INTO event_images (key, event_id, content_type, bytes, original_name) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(key, link.event_id, contentType, bytes.byteLength, fileNameFromHeader(c.req.header("x-file-name")))
    .run();

  return c.json({ photo: file, ref: photoRef(key), bytes: bytes.byteLength }, 201);
});

uploadRoutes.put("/photos/:file/preview", async (c) => {
  const link = await openLink(c);
  if (link === null) return fail(c, 401, "UNAUTHORIZED", CLOSED);
  // The wedding comes from the link, so a photo of any other wedding is a 404.
  return storePreview(c, link.event_id, c.req.param("file"));
});

uploadRoutes.post("/done", async (c) => {
  const link = await openLink(c);
  if (link === null) return fail(c, 401, "UNAUTHORIZED", CLOSED);
  await c.env.DB.prepare("UPDATE upload_links SET closed_at = ? WHERE id = ?").bind(isoSeconds(Date.now()), link.id).run();
  return c.json({ closed: true, added: link.photos, photos: await poolSize(c, link.event_id) });
});
