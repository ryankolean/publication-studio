import { describe, expect, it } from "vitest";

import { hashInviteToken } from "../src/domain/invite.js";
import {
  PHOTO_FILE,
  REVIEW_PAGE_SIZE,
  UPLOAD_LINK_TTL_MS,
  createLinkToken,
  hashLinkToken,
  isoSeconds,
  linkToken,
  photoRef,
  previewKeyFor,
  reviewPage,
  uploadLinkExpiry,
} from "../src/domain/upload-link.js";
import type { ReviewRow } from "../src/domain/upload-link.js";

const UUID = "0f8e2b7c-1d2e-4a3b-9c4d-5e6f7a8b9c0d";

describe("link tokens", () => {
  it("are 43 url-safe characters, stored only as their SHA-256", async () => {
    const first = await createLinkToken();
    const second = await createLinkToken();
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.id).toBe(await hashInviteToken(first.token));
    expect(first.id).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashLinkToken(first.token)).toBe(first.id);
  });

  it("come back from the page as a bearer token", async () => {
    const { token } = await createLinkToken();
    expect(linkToken(`Bearer ${token}`)).toBe(token);
  });

  it("are refused in any other shape", () => {
    const token = "a".repeat(43);
    for (const header of [undefined, "", token, `Basic ${token}`, `Bearer  ${token}`, `bearer ${token}`, `Bearer ${token} x`]) {
      expect(linkToken(header), String(header)).toBeNull();
    }
    expect(linkToken(`Bearer ${"a".repeat(31)}`)).toBeNull();
    expect(linkToken(`Bearer ${"a".repeat(65)}`)).toBeNull();
    expect(linkToken(`Bearer ${"a".repeat(42)}=`)).toBeNull();
    expect(linkToken(`Bearer ${"a".repeat(32)}`)).toBe("a".repeat(32));
    expect(linkToken(`Bearer ${"a".repeat(64)}`)).toBe("a".repeat(64));
  });
});

describe("times", () => {
  it("are written to the second, and a link lasts 24 hours", () => {
    const now = Date.UTC(2026, 9, 27, 12, 30, 15, 999);
    expect(isoSeconds(now)).toBe("2026-10-27T12:30:15Z");
    expect(uploadLinkExpiry(now)).toBe("2026-10-28T12:30:15Z");
    expect(UPLOAD_LINK_TTL_MS).toBe(86_400_000);
  });
});

describe("photo keys", () => {
  it("name a preview outside the pool's prefix, always as a JPEG", () => {
    expect(previewKeyFor(`events/w1/${UUID}.png`)).toBe(`previews/w1/${UUID}.jpg`);
    expect(previewKeyFor(`events/w1/${UUID}.jpg`)).toBe(`previews/w1/${UUID}.jpg`);
    expect(previewKeyFor(`events/w1/${UUID}.webp`)).toBe(`previews/w1/${UUID}.jpg`);
  });

  it("give a short ref from the photo's own id", () => {
    expect(photoRef(`events/w1/${UUID}.jpg`)).toBe("0f8e2b7c");
  });

  it("accept only a file part this server minted", () => {
    expect(PHOTO_FILE.test(`${UUID}.jpg`)).toBe(true);
    expect(PHOTO_FILE.test(`${UUID}.webp`)).toBe(true);
    for (const file of [`${UUID}.gif`, `${UUID}.JPG`, `${UUID}`, `../${UUID}.jpg`, `x${UUID}.jpg`, `${UUID}.jpg/x`, "a.jpg"]) {
      expect(PHOTO_FILE.test(file), file).toBe(false);
    }
  });
});

function rows(count: number, withoutPreview: number[] = []): ReviewRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `events/w1/${String(index).padStart(8, "0")}-0000-4000-8000-000000000000.jpg`,
    original_name: index === 2 ? null : `IMG_${index + 1}.jpg`,
    preview_key: withoutPreview.includes(index + 1) ? null : `previews/w1/${index}.jpg`,
  }));
}

describe("reviewPage", () => {
  it("shows twelve at a time, numbered across the whole pool", () => {
    const first = reviewPage(rows(30), 1);
    if ("error" in first) throw new Error(first.error);
    expect(REVIEW_PAGE_SIZE).toBe(12);
    expect(first).toMatchObject({ photos: 30, page: 1, pages: 3, next: 2, withoutPreview: 0 });
    expect(first.shown.map((entry) => entry.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const last = reviewPage(rows(30), 3);
    if ("error" in last) throw new Error(last.error);
    expect(last.shown.map((entry) => entry.n)).toEqual([25, 26, 27, 28, 29, 30]);
    expect(last.next).toBeNull();
  });

  it("names each photo by its file name, or by its number when it has none", () => {
    const page = reviewPage(rows(3), 1);
    if ("error" in page) throw new Error(page.error);
    expect(page.shown).toEqual([
      { n: 1, ref: "00000000", name: "IMG_1.jpg", preview: true, previewKey: "previews/w1/0.jpg" },
      { n: 2, ref: "00000001", name: "IMG_2.jpg", preview: true, previewKey: "previews/w1/1.jpg" },
      { n: 3, ref: "00000002", name: "Photo 3", preview: true, previewKey: "previews/w1/2.jpg" },
    ]);
  });

  it("counts every photo without a preview, on any page", () => {
    const page = reviewPage(rows(14, [2, 13]), 2);
    if ("error" in page) throw new Error(page.error);
    expect(page.withoutPreview).toBe(2);
    expect(page.shown.map((entry) => entry.preview)).toEqual([false, true]);
    expect(page.shown[0]?.previewKey).toBeNull();
  });

  it("has exactly one page at the boundary, and two just past it", () => {
    expect(reviewPage(rows(12), 1)).toMatchObject({ pages: 1, next: null });
    expect(reviewPage(rows(13), 1)).toMatchObject({ pages: 2, next: 2 });
  });

  it("refuses a page outside the pool, saying which pages there are", () => {
    expect(reviewPage(rows(30), 4)).toEqual({ error: "There are 3 pages of photos. Ask for a page from 1 to 3." });
    expect(reviewPage(rows(5), 2)).toEqual({ error: "There is 1 page of photos. Ask for a page from 1 to 1." });
    expect(reviewPage(rows(5), 0)).toHaveProperty("error");
    expect(reviewPage(rows(30), 1.5)).toHaveProperty("error");
  });
});
