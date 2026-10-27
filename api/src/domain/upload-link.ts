import { hashInviteToken } from "./invite.js";

/**
 * Photo intake by link (SUMMIT-344 slice 2, migration 0012), as pure rules.
 *
 * get_upload_link hands her a link to a page on this Worker for one wedding.
 * The token rides in the URL fragment, so it never reaches a server log; the
 * page sends it back as a bearer token. On that page her browser makes a
 * small JPEG preview of each photo next to the upload, and review_photos
 * shows Claude those previews a page at a time.
 *
 * DECISION: previews are made in her browser, not by the Images binding. The
 * slice 0 spike measured 7 to 20 ms of CPU per transform against the free
 * plan's 10 ms, so the Worker only stores what the browser made.
 */

export const UPLOAD_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** Enough for any one wedding's selection; a ceiling on what a leaked link can add. */
export const UPLOAD_LINK_PHOTO_LIMIT = 200;

/** The long edge of a preview, in pixels: about 60 tokens per picture for Claude. */
export const PREVIEW_EDGE = 256;
export const PREVIEW_TYPE = "image/jpeg";
export const MAX_PREVIEW_BYTES = 256 * 1024;

export const REVIEW_PAGE_SIZE = 12;

const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

/** Only the hash of a link's token is stored. */
export const hashLinkToken = (token: string): Promise<string> => hashInviteToken(token);

/** A new link's token, for the URL, and its hash, the row's id. */
export async function createLinkToken(): Promise<{ token: string; id: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { token, id: await hashLinkToken(token) };
}

/** Seconds precision, the way every timestamp column is written. */
export const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export const uploadLinkExpiry = (nowMs: number): string => isoSeconds(nowMs + UPLOAD_LINK_TTL_MS);

/** "Bearer <token>" from the upload page; null for anything that is not a link token. */
export function linkToken(authorization: string | undefined): string | null {
  const match = /^Bearer (\S+)$/.exec(authorization ?? "");
  const token = match?.[1] ?? "";
  return TOKEN.test(token) ? token : null;
}

/** A stored photo's file part, "<uuid>.<ext>", as the page names it back. */
export const PHOTO_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/** events/<id>/<uuid>.<ext> -> previews/<id>/<uuid>.jpg, outside the pool's prefix. */
export function previewKeyFor(key: string): string {
  return key.replace(/^events\//, "previews/").replace(/\.[a-z]+$/, ".jpg");
}

/** The short reference Claude uses for a photo: the first eight characters of its id. */
export function photoRef(key: string): string {
  return (key.split("/").pop() ?? "").slice(0, 8);
}

export interface ReviewRow {
  key: string;
  original_name: string | null;
  preview_key: string | null;
}

export interface ReviewEntry {
  n: number;
  ref: string;
  name: string;
  preview: boolean;
  previewKey: string | null;
}

export type ReviewPage =
  | { photos: number; page: number; pages: number; shown: ReviewEntry[]; withoutPreview: number; next: number | null }
  | { error: string };

/**
 * One page of the pool, in the order the photos were added. Numbers run
 * across the whole pool, so "photo 14" means the same photo on every page.
 */
export function reviewPage(rows: ReviewRow[], page: number): ReviewPage {
  const pages = Math.max(1, Math.ceil(rows.length / REVIEW_PAGE_SIZE));
  if (!Number.isInteger(page) || page < 1 || page > pages) {
    return { error: `There ${pages === 1 ? "is 1 page" : `are ${pages} pages`} of photos. Ask for a page from 1 to ${pages}.` };
  }
  const start = (page - 1) * REVIEW_PAGE_SIZE;
  const shown = rows.slice(start, start + REVIEW_PAGE_SIZE).map((row, index) => ({
    n: start + index + 1,
    ref: photoRef(row.key),
    name: row.original_name ?? `Photo ${start + index + 1}`,
    preview: row.preview_key !== null,
    previewKey: row.preview_key,
  }));
  return {
    photos: rows.length,
    page,
    pages,
    shown,
    withoutPreview: rows.filter((row) => row.preview_key === null).length,
    next: page < pages ? page + 1 : null,
  };
}
