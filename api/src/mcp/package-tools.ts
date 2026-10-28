import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { confirmItems, confirmPreview, packageReport, pickPhotos, withTicks } from "../domain/package-tools.js";
import type { PackageViewLike } from "../domain/package-tools.js";
import type { QueueEntry } from "../domain/queue.js";
import { evaluateRightsGate } from "../domain/rights-gate.js";
import type { ConsentStatus, RightsStatus } from "../domain/rights-gate.js";
import type { ErrorBody } from "../errors.js";
import type { OAuthEnv } from "../env.js";
import { callApp } from "./app-call.js";
import { WRITES, audited } from "./audit.js";
import type { McpContext, Outcome } from "./audit.js";
import { issueConfirmation, redeemConfirmation } from "./confirmations.js";
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
  confirm: z
    .array(z.string().max(300))
    .max(40)
    .optional()
    .describe("Checklist items marked sheConfirms that she is ready to confirm, by id or wording from toDo. Returns the lines to show her and a code; nothing is recorded yet."),
  confirmation: z.string().max(20).optional().describe("The code from the call with confirm. Only after she has said yes to those lines."),
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
  return env.DB.prepare("SELECT id, couple_names FROM events WHERE slug = ?").bind(slug).first<{ id: string; couple_names: string }>();
}

/** The two-step confirmation's action name for her checklist items (mcp/confirmations.ts). */
const CONFIRM_ITEMS = "confirm_package_items";

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
        "Build or update the package for one wedding and one outlet: the photos to send, the write-up and the vendor credits, checked against that outlet's requirements. The first call creates it, with a write-up started from the couple's story and credits from her vendor list. Then pass photos (numbers or refs from review_photos), write_up (drafted with her, within the couple's limits) and credits. Items marked sheConfirms take two steps, like confirm_permissions: call with confirm to get the exact lines and a code, show her the lines, and only after she says yes call again with confirmation set to the code. Never confirm on her behalf. Returns what is done and what is left (toDo). Nothing is sent anywhere. When complete is true, add the outlet to her order with set_queue.",
      inputSchema: PACKAGE_ARGS,
      annotations: WRITES,
    },
    audited(env, ctx, "build_package_draft", async (args: PackageArgs): Promise<Outcome> => {
      if (args.confirm !== undefined && args.confirm.length > 0 && args.confirmation !== undefined) {
        return { ok: false, result: "confirm_and_code", message: "Pass confirm to get the lines and a code, or confirmation with the code after her yes, not both. Nothing was changed." };
      }
      // What the call needs first, in one batch: on Workers every D1 call
      // costs CPU of its own (SUMMIT-344).
      const [weddingRows, packageRows, poolRows] = await env.DB.batch([
        env.DB.prepare("SELECT id, couple_names, rights_status, consent_status FROM events WHERE slug = ?").bind(args.wedding),
        env.DB
          .prepare(
            `SELECT packages.id FROM packages JOIN events ON events.id = packages.event_id
             WHERE events.slug = ? AND packages.publication_id = ? ORDER BY packages.version DESC`,
          )
          .bind(args.wedding, args.publication),
        env.DB
          .prepare(
            `SELECT event_images.key FROM event_images JOIN events ON events.id = event_images.event_id
             WHERE events.slug = ? ORDER BY event_images.created_at ASC, event_images.rowid ASC`,
          )
          .bind(args.wedding),
      ]);
      const wedding = weddingRows?.results[0] as
        | { id: string; couple_names: string; rights_status: RightsStatus; consent_status: ConsentStatus }
        | undefined;
      if (wedding === undefined) return NOT_FOUND;
      const existingId = (packageRows?.results[0] as { id: string } | undefined)?.id;

      // The create route checks the rights gate; an existing package is
      // edited through a route that does not, so the gate is checked here for
      // every call, with the create route's words (CLAUDE.md constraint 3).
      const gate = evaluateRightsGate({ rightsStatus: wedding.rights_status, consentStatus: wedding.consent_status });
      if (existingId !== undefined && !gate.allowed) {
        return { ok: false, result: "rights_blocked", message: ["This wedding cannot go to an outlet yet.", ...gate.reasons].join(" ") };
      }

      let created = false;
      let view: PackageViewLike | null = null;
      if (existingId === undefined) {
        const opened = await callApp(env, userId, "POST", "/packages", { eventId: wedding.id, publicationId: args.publication });
        if (!opened.ok) return refusal(opened.error);
        view = opened.body as PackageViewLike;
        created = opened.status === 201;
      }
      const packageId = view?.id ?? (existingId as string);
      // The checklist is read before an edit only to name her confirmations or keep the ones already ticked.
      if (view === null && ((args.confirm?.length ?? 0) > 0 || args.confirmation !== undefined)) {
        const read = await callApp(env, userId, "GET", `/packages/${packageId}`);
        if (!read.ok) return refusal(read.error);
        view = read.body as PackageViewLike;
      }

      const patch: Record<string, unknown> = {};
      if (args.photos !== undefined) {
        const picked = pickPhotos((poolRows?.results ?? []) as Array<{ key: string }>, args.photos);
        if (!picked.ok) {
          return {
            ok: false,
            result: "unknown_photo",
            message: `No photo matches: ${picked.unknown.join(", ")}. Use the numbers or refs review_photos shows. The package exists, but nothing in it was changed.`,
          };
        }
        patch["imageKeys"] = picked.keys;
      }
      let pending: ReturnType<typeof confirmPreview> | null = null;
      let pendingIds: string[] = [];
      if (args.confirm !== undefined && args.confirm.length > 0) {
        const named = confirmItems((view as PackageViewLike).checklist, args.confirm);
        if (!named.ok) {
          return {
            ok: false,
            result: "unknown_item",
            message: `Not something she confirms on this outlet's checklist: ${named.unknown.join(", ")}. Use the ids or wording under toDo marked sheConfirms. Nothing in the package was changed.`,
          };
        }
        pending = confirmPreview(wedding.couple_names, view?.publication?.name ?? args.publication, named.items);
        pendingIds = named.items.map((item) => item.id);
      }
      if (args.write_up !== undefined) patch["descriptionMd"] = args.write_up;
      if (args.credits !== undefined) patch["creditsBlockMd"] = args.credits;

      let recorded: string[] | null = null;
      if (args.confirmation !== undefined) {
        const redeemed = await redeemConfirmation(env.DB, args.confirmation, { userId, action: CONFIRM_ITEMS, targetId: packageId });
        if (redeemed === null) {
          return {
            ok: false,
            result: "invalid_code",
            message: "That code is not valid: it was used already, it expired, or it was for another package. Call again with confirm to get a fresh one, and show her the lines again.",
          };
        }
        patch["attestations"] = withTicks((view as PackageViewLike).checklist, (redeemed.payload as { ids: string[] }).ids);
        recorded = redeemed.preview.slice(1);
      }

      if (Object.keys(patch).length > 0) {
        const saved = await callApp(env, userId, "PATCH", `/packages/${packageId}`, patch);
        if (!saved.ok) return refusal(saved.error);
        view = saved.body as PackageViewLike;
      } else if (view === null) {
        const read = await callApp(env, userId, "GET", `/packages/${packageId}`);
        if (!read.ok) return refusal(read.error);
        view = read.body as PackageViewLike;
      }

      const report = packageReport(view, args.show_text === true);
      if (pending !== null) {
        const code = await issueConfirmation(env.DB, { userId, action: CONFIRM_ITEMS, targetId: packageId, payload: { ids: pendingIds }, preview: pending });
        return {
          ok: true,
          result: "awaiting_yes",
          data: {
            wedding: args.wedding,
            ...report,
            willRecord: pending,
            confirm: code,
            expiresInMinutes: 15,
            next: "Show her these lines word for word and ask if they are right. Only after she says yes, call build_package_draft again with the same wedding and publication and confirmation set to the code. Never confirm on her behalf.",
          },
        };
      }
      return {
        ok: true,
        data: {
          wedding: args.wedding,
          ...(created ? { created: true } : {}),
          ...report,
          ...(recorded === null ? {} : { recorded }),
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
