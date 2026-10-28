import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { confirmItems, packageReport, pickPhotos } from "../domain/package-tools.js";
import type { PackageViewLike } from "../domain/package-tools.js";
import type { QueueEntry } from "../domain/queue.js";
import type { ErrorBody } from "../errors.js";
import type { OAuthEnv } from "../env.js";
import { callApp } from "./app-call.js";
import { WRITES, audited } from "./audit.js";
import type { McpContext, Outcome } from "./audit.js";
import { NOT_FOUND } from "./wedding-tools.js";

/**
 * build_package_draft and set_queue (SUMMIT-344 slice 5). Prep and queue
 * only (CLAUDE.md constraint 2): nothing here sends anything to an outlet.
 * Both write through the web app's own package, queue and submission routes,
 * so the checklist, the rights gate and the audit rows are the routes'.
 */

// Built once per isolate, not per request: zod schemas are costly to build,
// and every /mcp request builds its own server (handler.ts).
const PACKAGE_ARGS = z.object({
  wedding: z.string().min(1).max(100).describe("The wedding's short id."),
  publication: z.string().min(1).max(100).describe("The outlet's id, such as pub-the-knot."),
  photos: z
    .array(z.string().max(20))
    .max(200)
    .optional()
    .describe("The photos to send, in order, by the numbers or refs review_photos shows. Replaces the selection."),
  write_up: z.string().max(20000).optional().describe("The write-up for this outlet, drafted with her. Replaces the current one."),
  credits: z.string().max(5000).optional().describe("The vendor credits block, if she wants it worded differently from the one built from her vendors."),
  confirm: z.array(z.string().max(100)).max(40).optional().describe("Checklist items she has confirmed herself, by id from toDo. Only what she said yes to."),
  show_text: z.boolean().optional().describe("Also return the write-up and credits in full."),
});

const QUEUE_ARGS = z.object({
  wedding: z.string().min(1).max(100).describe("The wedding's short id."),
  outlets: z.array(z.string().min(1).max(100)).min(1).max(10).describe("Outlet ids in the order she wants to try them."),
});

type PackageArgs = z.infer<typeof PACKAGE_ARGS>;

/** A refusal from a route, with its field messages, in a sentence or two. */
function refusal(error: ErrorBody): Outcome {
  const details = error.details;
  const reasons = Array.isArray(details)
    ? details.map((detail) => (typeof detail === "string" ? detail : String((detail as { message?: unknown }).message ?? ""))).filter(Boolean)
    : [];
  return { ok: false, result: error.code.toLowerCase(), message: [error.message, ...reasons].join(" ") };
}

async function findWedding(env: OAuthEnv, slug: string) {
  return env.DB.prepare("SELECT id FROM events WHERE slug = ?").bind(slug).first<{ id: string }>();
}

function queueLines(entries: readonly QueueEntry[]) {
  return entries.map((entry) => ({ position: entry.position, outlet: entry.publicationId, name: entry.name, state: entry.words }));
}

export function registerPackageTools(server: McpServer, env: OAuthEnv, ctx: McpContext): void {
  const userId = ctx.props.userId;

  server.registerTool(
    "build_package_draft",
    {
      title: "Build a package draft",
      description:
        "Build or update the package for one wedding and one outlet: the photos to send, the write-up and the vendor credits, checked against that outlet's requirements. The first call creates it, with a write-up started from the couple's story and credits from her vendor list. Then pass photos (numbers or refs from review_photos), write_up (drafted with her, within the couple's limits), credits, and confirm for checklist items she has said yes to herself; never confirm on her behalf. Returns what is done and what is left (toDo); items marked sheConfirms need her yes. Nothing is sent anywhere. When complete is true, add the outlet to her order with set_queue.",
      inputSchema: PACKAGE_ARGS,
      annotations: WRITES,
    },
    audited(env, ctx, "build_package_draft", async (args: PackageArgs): Promise<Outcome> => {
      const wedding = await findWedding(env, args.wedding);
      if (wedding === null) return NOT_FOUND;

      const opened = await callApp(env, userId, "POST", "/packages", { eventId: wedding.id, publicationId: args.publication });
      if (!opened.ok) return refusal(opened.error);
      let view = opened.body as PackageViewLike;

      const patch: Record<string, unknown> = {};
      if (args.photos !== undefined) {
        const { results: pool } = await env.DB.prepare("SELECT key FROM event_images WHERE event_id = ? ORDER BY created_at ASC, rowid ASC")
          .bind(wedding.id)
          .all<{ key: string }>();
        const picked = pickPhotos(pool, args.photos);
        if (!picked.ok) {
          return {
            ok: false,
            result: "unknown_photo",
            message: `No photo matches: ${picked.unknown.join(", ")}. Use the numbers or refs review_photos shows. The package exists, but nothing in it was changed.`,
          };
        }
        patch["imageKeys"] = picked.keys;
      }
      if (args.confirm !== undefined && args.confirm.length > 0) {
        const confirmed = confirmItems(view.checklist, args.confirm);
        if (!confirmed.ok) {
          return {
            ok: false,
            result: "unknown_item",
            message: `Not something she confirms on this outlet's checklist: ${confirmed.unknown.join(", ")}. Use the ids under toDo marked sheConfirms. Nothing in the package was changed.`,
          };
        }
        patch["attestations"] = confirmed.attestations;
      }
      if (args.write_up !== undefined) patch["descriptionMd"] = args.write_up;
      if (args.credits !== undefined) patch["creditsBlockMd"] = args.credits;

      if (Object.keys(patch).length > 0) {
        const saved = await callApp(env, userId, "PATCH", `/packages/${view.id}`, patch);
        if (!saved.ok) return refusal(saved.error);
        view = saved.body as PackageViewLike;
      }

      const report = packageReport(view, args.show_text === true);
      return {
        ok: true,
        data: {
          wedding: args.wedding,
          ...(opened.status === 201 ? { created: true } : {}),
          ...report,
          next: report.complete
            ? "The package is complete. Add the outlet to her order with set_queue to ready it."
            : "Work through toDo with her. Ask before confirming anything marked sheConfirms.",
        },
      };
    }),
  );

  server.registerTool(
    "set_queue",
    {
      title: "Set the outlet order",
      description:
        "Set her order of outlets for one wedding, from her ranking: one outlet holds the wedding at a time, so the first that has not released it is up next, and the next one only after an answer. Replaces any earlier order. If the outlet up next has a complete package, this readies it to send. It is never sent from here: she sends it herself through the outlet's own route and marks it sent in the studio. Returns the order with where each outlet stands and what comes next.",
      inputSchema: QUEUE_ARGS,
      annotations: WRITES,
    },
    audited(env, ctx, "set_queue", async (args: { wedding: string; outlets: string[] }): Promise<Outcome> => {
      const wedding = await findWedding(env, args.wedding);
      if (wedding === null) return NOT_FOUND;

      const set = await callApp(env, userId, "PUT", `/events/${wedding.id}/queue`, { publicationIds: args.outlets });
      if (!set.ok) return refusal(set.error);
      let queue = set.body as { entries: QueueEntry[]; upNext: QueueEntry | null; next: string };

      let readied: string | null = null;
      const up = queue.upNext;
      if (up !== null && up.state === "package_complete" && up.packageId !== null) {
        const created = await callApp(env, userId, "POST", "/submissions", { packageId: up.packageId });
        if (!created.ok) return refusal(created.error);
        readied = up.name;
        const reread = await callApp(env, userId, "GET", `/events/${wedding.id}/queue`);
        if (!reread.ok) return refusal(reread.error);
        queue = reread.body as typeof queue;
      }

      return {
        ok: true,
        data: {
          wedding: args.wedding,
          order: queueLines(queue.entries),
          upNext: queue.upNext?.name ?? null,
          ...(readied === null ? {} : { readied }),
          next: queue.next,
        },
      };
    }),
  );
}
