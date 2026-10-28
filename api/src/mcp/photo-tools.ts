import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { evaluateRightsGate } from "../domain/rights-gate.js";
import type { ConsentStatus, RightsStatus } from "../domain/rights-gate.js";
import {
  PREVIEW_TYPE,
  UPLOAD_LINK_PHOTO_LIMIT,
  createLinkToken,
  isoSeconds,
  reviewPage,
  uploadLinkExpiry,
} from "../domain/upload-link.js";
import type { ReviewRow } from "../domain/upload-link.js";
import { gateWords } from "../domain/wizard.js";
import type { OAuthEnv } from "../env.js";
import { READ_ONLY, WRITES, audited } from "./audit.js";
import type { McpContext, ToolImage } from "./audit.js";
import { NOT_FOUND } from "./wedding-tools.js";

/**
 * get_upload_link and review_photos (SUMMIT-344 slice 2, decisions A and B).
 * Photos come in through a page on this Worker (routes/upload.ts), never
 * through the chat; Claude looks at them as the small previews her browser
 * made there, and does the judging itself. The server only stores and shows.
 */

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Built once per isolate, not per request: zod schemas are costly to build,
// and every /mcp request builds its own server (handler.ts).
const GET_UPLOAD_LINK_ARGS = z.object({
  wedding: z.string().min(1).max(100).describe("The wedding's short id."),
});

const REVIEW_PHOTOS_ARGS = z.object({
  wedding: z.string().min(1).max(100).describe("The wedding's short id."),
  page: z.number().int().min(1).max(100).optional().describe("Which twelve, counting from 1. Default 1."),
});

export function registerPhotoTools(server: McpServer, env: OAuthEnv, ctx: McpContext): void {
  const userId = ctx.props.userId;

  server.registerTool(
    "get_upload_link",
    {
      title: "Get an upload link",
      description:
        "A link to a page where she adds a wedding's photos: she drags in her web-size exports (JPEG, PNG or WebP, up to 12 MB each), and her browser makes a small preview of each for review_photos. Give her the link exactly as it is. It works for 24 hours or until she presses I'm finished, takes up to 200 photos, and replaces any earlier link for that wedding. Her permission answers must say yes first (confirm_permissions).",
      inputSchema: GET_UPLOAD_LINK_ARGS,
      annotations: WRITES,
    },
    audited(env, ctx, "get_upload_link", async (args: { wedding: string }) => {
      const wedding = await env.DB.prepare("SELECT id, couple_names, rights_status, consent_status FROM events WHERE slug = ?")
        .bind(args.wedding)
        .first<{ id: string; couple_names: string; rights_status: RightsStatus; consent_status: ConsentStatus }>();
      if (wedding === null) return NOT_FOUND;

      const gate = { rightsStatus: wedding.rights_status, consentStatus: wedding.consent_status };
      if (!evaluateRightsGate(gate).allowed) {
        return {
          ok: false,
          result: "permissions_first",
          message: `Photos can be added once her permission answers say yes. ${gateWords(gate).join(" ")} Record them with confirm_permissions first. No link was made.`,
        };
      }

      // One live link per wedding: a new one closes any still open.
      const now = Date.now();
      const { token, id } = await createLinkToken();
      await env.DB.batch([
        env.DB.prepare("UPDATE upload_links SET closed_at = ? WHERE event_id = ? AND closed_at IS NULL").bind(isoSeconds(now), wedding.id),
        env.DB.prepare("INSERT INTO upload_links (id, user_id, event_id, expires_at) VALUES (?, ?, ?, ?)").bind(
          id,
          userId,
          wedding.id,
          uploadLinkExpiry(now),
        ),
      ]);
      const pool = await env.DB.prepare("SELECT COUNT(*) AS n FROM event_images WHERE event_id = ?").bind(wedding.id).first<{ n: number }>();

      return {
        ok: true,
        data: {
          wedding: args.wedding,
          couple: wedding.couple_names,
          link: `${env.PUBLIC_ORIGIN}/upload#${token}`,
          expiresInHours: 24,
          takesUpTo: UPLOAD_LINK_PHOTO_LIMIT,
          photosSoFar: pool?.n ?? 0,
          next: "Give her this link exactly as it is. When she says the photos are in, call review_photos to look through them.",
        },
      };
    }),
  );

  server.registerTool(
    "review_photos",
    {
      title: "Review photos",
      description:
        "Look through a wedding's photos as small previews, twelve at a time, in the order they were added. Each picture follows a caption with its number, file name and short ref; use those when you talk with her about the photos. Pass page for the next twelve. Photos without a preview are listed under withoutPreview.",
      inputSchema: REVIEW_PHOTOS_ARGS,
      annotations: READ_ONLY,
    },
    audited(env, ctx, "review_photos", async (args: { wedding: string; page?: number | undefined }) => {
      const wedding = await env.DB.prepare("SELECT id FROM events WHERE slug = ?").bind(args.wedding).first<{ id: string }>();
      if (wedding === null) return NOT_FOUND;

      // rowid breaks ties inside one second, as the pool listing does.
      const { results } = await env.DB.prepare(
        "SELECT key, original_name, preview_key FROM event_images WHERE event_id = ? ORDER BY created_at ASC, rowid ASC",
      )
        .bind(wedding.id)
        .all<ReviewRow>();
      if (results.length === 0) {
        return {
          ok: true,
          result: "empty",
          data: { wedding: args.wedding, photos: 0, next: "No photos yet. Use get_upload_link to give her a page to add them." },
        };
      }

      const page = reviewPage(results, args.page ?? 1);
      if ("error" in page) return { ok: false, result: "invalid_page", message: page.error };

      const shown = await Promise.all(
        page.shown.map(async (entry) => {
          const object = entry.previewKey === null ? null : await env.IMAGES.get(entry.previewKey);
          if (object === null || object.body === null) return { entry, image: null };
          const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
          const image: ToolImage = {
            caption: `Photo ${entry.n}: ${entry.name}, ref ${entry.ref}`,
            data: toBase64(bytes),
            mimeType: PREVIEW_TYPE,
          };
          return { entry, image };
        }),
      );
      const missing = shown.filter((item) => item.image === null).map(({ entry }) => ({ n: entry.n, name: entry.name, ref: entry.ref }));

      return {
        ok: true,
        images: shown.flatMap((item) => (item.image === null ? [] : [item.image])),
        data: {
          wedding: args.wedding,
          photos: page.photos,
          page: page.page,
          pages: page.pages,
          ...(missing.length > 0 ? { withoutPreview: missing } : {}),
          next: page.next === null ? "That is all of them." : `Call review_photos with page ${page.next} for the next twelve.`,
        },
      };
    }),
  );
}
