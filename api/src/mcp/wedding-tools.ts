import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { locationLabel, locationOptions } from "../domain/geo.js";
import { CONTENT_TYPES } from "../domain/research/schema.js";
import { evaluateIntake } from "../domain/walkthrough.js";
import { gateWords } from "../domain/wizard.js";
import {
  matchPlace,
  mergeWedding,
  permissionsPreview,
  permissionsRecord,
  stillNeeded,
  toolField,
  weddingChanges,
} from "../domain/wedding-tools.js";
import type { CurrentWedding, PermissionsRecord, SaveWeddingArgs } from "../domain/wedding-tools.js";
import type { ErrorBody } from "../errors.js";
import type { OAuthEnv } from "../env.js";
import { eventFrom, eventStatements, listEventsFrom, listEventsStatements, loadEvent } from "../routes/events.js";
import { geoFrom, geoStatement, loadGeo } from "../routes/match-context.js";
import { callApp } from "./app-call.js";
import { WRITES, audited } from "./audit.js";
import type { McpContext, Outcome } from "./audit.js";
import { issueConfirmation, redeemConfirmation } from "./confirmations.js";

/**
 * save_wedding and confirm_permissions (SUMMIT-344 slice 1). Both write
 * through the web app's own event routes (app-call.ts), so the intake rules,
 * the location check and the audit rows are the web app's.
 */

export const NOT_FOUND: Outcome = {
  ok: false,
  result: "not_found",
  message: "There is no wedding with that id. Use list_weddings to find the right one.",
};

type Detail = NonNullable<Awaited<ReturnType<typeof loadEvent>>>;

function asCurrent(detail: Detail): CurrentWedding {
  return {
    coupleNames: detail.coupleNames,
    eventDate: detail.eventDate,
    venueName: detail.venueName,
    city: detail.city,
    state: detail.state,
    country: detail.country,
    uniqueAngle: detail.uniqueAngle,
    rightsStatus: detail.rightsStatus,
    consentStatus: detail.consentStatus,
    consentNotes: detail.consentNotes,
    nameDisplay: detail.nameDisplay,
    coupleStory: detail.coupleStory,
    isDestination: detail.isDestination,
    heroPicks: detail.heroPicks,
    videoUrl: detail.videoUrl,
    targetOutletNotes: detail.targetOutletNotes,
    locationCode: detail.locationCode,
    contentType: detail.contentType,
    vendorCredits: detail.vendorCredits.map((credit) => ({ ...credit })),
  };
}

/** A wedding with its vendor credits, by its short id, in one D1 call. */
async function findWedding(env: OAuthEnv, slug: string) {
  return eventFrom(await env.DB.batch(eventStatements(env.DB, slug, "slug")));
}

/** A refusal from the event routes, in the tool's own argument names. */
function refusal(error: ErrorBody): Outcome {
  const details = Array.isArray(error.details) ? (error.details as Array<{ field: string; message: string }>) : [];
  const fields = details.map((detail) => `${toolField(detail.field)}: ${detail.message}`).join("; ");
  return { ok: false, result: error.code.toLowerCase(), message: fields === "" ? error.message : `${error.message} ${fields}` };
}

/** The wedding as it stands after a write, in the few words the chat needs. */
async function standing(env: OAuthEnv, id: string) {
  // One batch, not three loaders: on Workers each D1 call costs CPU of its own.
  const lists = listEventsStatements(env.DB);
  const results = await env.DB.batch([...lists, geoStatement(env.DB), ...eventStatements(env.DB, id)]);
  const summary = listEventsFrom(results.slice(0, lists.length)).find((event) => event.id === id);
  const geo = geoFrom(results[lists.length]?.results ?? []);
  const detail = eventFrom(results.slice(lists.length + 1));
  if (detail === null || summary === undefined) throw new Error("a wedding just saved could not be read back");
  return {
    wedding: detail.slug,
    couple: detail.coupleNames,
    date: detail.eventDate,
    place: detail.locationCode !== null && geo !== null ? locationLabel(detail.locationCode, geo) : null,
    step: summary.chip.label,
    stillNeeded: stillNeeded(evaluateIntake(detail, detail.vendorCredits.length)),
    holds: gateWords(detail),
  };
}

// Built once per isolate, not per request: zod schemas are costly to build,
// and every /mcp request builds its own server (handler.ts).
const SAVE_WEDDING_ARGS = z.object({
  wedding: z.string().max(100).optional().describe("Short id of the wedding to change. Leave out to create one."),
  couple_names: z.string().max(200).optional().describe("As they should appear, for example 'Blake & Anne'."),
  date: z.string().max(10).optional().describe("Wedding date, YYYY-MM-DD."),
  venue: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  place: z.string().max(100).optional().describe("Where it was, as a name or a code from the location list."),
  story: z.string().max(5000).optional().describe("The couple's story, in her words or drafted with her."),
  angle: z.string().max(1000).optional().describe("What makes this wedding its own."),
  names_in_print: z.string().max(200).optional().describe("How names may appear in print, if the couple set limits."),
  destination: z.boolean().optional(),
  kind: z.enum(CONTENT_TYPES).optional().describe("real_wedding, elopement or styled_shoot."),
  hero_picks: z.string().max(1000).optional(),
  video_link: z.string().max(500).optional(),
  outlet_notes: z.string().max(1000).optional(),
  vendors: z
    .array(
      z.object({
        role: z.string().max(100),
        business: z.string().max(200),
        website: z.string().max(300).optional(),
        instagram: z.string().max(100).optional(),
      }),
    )
    .max(40)
    .optional()
    .describe("Every vendor credit; replaces the list."),
});

const CONFIRM_PERMISSIONS_ARGS = z.object({
  wedding: z.string().min(1).max(100).describe("The wedding's short id."),
  lead_photographer: z.boolean().optional().describe("Was she the lead photographer, under her own contract? Needed for the first call."),
  couple_agreed: z.enum(["yes", "yes_with_limits", "not_yet", "no"]).optional().describe("Has the couple agreed to a submission? Needed for the first call."),
  limits: z.string().max(500).optional().describe("The couple's limits, such as first names only. Needed for yes_with_limits."),
  confirmation: z.string().max(20).optional().describe("The code from the first call. Only once she has said yes."),
});

export function registerWeddingTools(server: McpServer, env: OAuthEnv, ctx: McpContext): void {
  const userId = ctx.props.userId;

  server.registerTool(
    "save_wedding",
    {
      title: "Save a wedding",
      description:
        "Create a wedding, or change one. To create, give couple_names and date (YYYY-MM-DD). To change one, give its short id as wedding and only the fields to change; everything else stays as it is, and vendors replaces the whole vendor list. place takes a place name or code, such as 'Florida Keys' or 'US-FL:florida-keys'; if it is unclear, you get the closest places to choose from and nothing is saved. This never changes her permission answers (use confirm_permissions) or a gallery link. Returns where the wedding stands and what it still needs.",
      inputSchema: SAVE_WEDDING_ARGS,
      annotations: WRITES,
    },
    audited(env, ctx, "save_wedding", async (args: SaveWeddingArgs & { wedding?: string | undefined; place?: string | undefined }) => {
      let existing: { id: string } | null = null;
      let current: CurrentWedding | null = null;
      if (args.wedding !== undefined) {
        const detail = await findWedding(env, args.wedding);
        if (detail === null) return NOT_FOUND;
        existing = { id: detail.id };
        current = asCurrent(detail);
      }

      const changes = weddingChanges(args);
      if (args.place !== undefined) {
        const geo = await loadGeo(env.DB);
        if (geo === null) {
          return { ok: false, result: "places_missing", message: "The list of places is not loaded yet. Save without place for now." };
        }
        const match = matchPlace(args.place, locationOptions(geo));
        if ("candidates" in match) {
          const options = match.candidates.map((option) => `${option.code} (${option.label})`).join(", ");
          return {
            ok: false,
            result: "unclear_place",
            message:
              options === ""
                ? `No place in the list matches "${args.place}". Try a city, area or state name. Nothing was saved.`
                : `"${args.place}" is not clear enough. Closest places: ${options}. Call save_wedding again with place set to one of these codes. Nothing was saved.`,
          };
        }
        changes.locationCode = match.code;
      }

      const saved =
        existing === null
          ? await callApp(env, userId, "POST", "/events", mergeWedding(null, changes))
          : await callApp(env, userId, "PATCH", `/events/${existing.id}`, mergeWedding(current, changes));
      if (!saved.ok) return refusal(saved.error);

      const { holds, ...view } = await standing(env, (saved.body as { id: string }).id);
      return { ok: true, data: { ...view, saved: existing === null ? "created" : "updated", ...(holds.length > 0 ? { onHold: holds } : {}) } };
    }),
  );

  server.registerTool(
    "confirm_permissions",
    {
      title: "Confirm permissions",
      description:
        "Record her two permission answers for a wedding: was she the lead photographer under her own contract, and has the couple agreed to a submission (yes, yes_with_limits, not_yet or no). Nothing can be submitted until these say yes. Two steps. First call without confirmation: you get the exact lines that would be recorded and a code. Show her those lines word for word and ask. Only after she clearly says yes, call again with the same wedding and confirmation set to the code; what gets recorded is what she was shown. Never confirm on her behalf. A code works once and expires in 15 minutes.",
      inputSchema: CONFIRM_PERMISSIONS_ARGS,
      annotations: WRITES,
    },
    audited(
      env,
      ctx,
      "confirm_permissions",
      async (args: {
        wedding: string;
        lead_photographer?: boolean | undefined;
        couple_agreed?: "yes" | "yes_with_limits" | "not_yet" | "no" | undefined;
        limits?: string | undefined;
        confirmation?: string | undefined;
      }): Promise<Outcome> => {
        const wedding = await findWedding(env, args.wedding);
        if (wedding === null) return NOT_FOUND;

        if (args.confirmation === undefined) {
          if (args.lead_photographer === undefined || args.couple_agreed === undefined) {
            return { ok: false, result: "needs_answers", message: "Give both answers, lead_photographer and couple_agreed, to see what would be recorded." };
          }
          const answer = permissionsRecord({ leadPhotographer: args.lead_photographer, coupleAgreed: args.couple_agreed, limits: args.limits });
          if (!answer.ok) return { ok: false, result: "needs_limits", message: answer.message };
          const preview = permissionsPreview(wedding.coupleNames, answer.record);
          const code = await issueConfirmation(env.DB, {
            userId,
            action: "confirm_permissions",
            targetId: wedding.id,
            payload: answer.record,
            preview,
          });
          return {
            ok: true,
            result: "awaiting_yes",
            data: {
              wedding: args.wedding,
              willRecord: preview,
              confirm: code,
              expiresInMinutes: 15,
              next: "Show her these lines word for word and ask if they are right. Only after she says yes, call confirm_permissions again with this wedding and confirmation set to the code. If anything is wrong, ask what to change and start again without a code.",
            },
          };
        }

        const redeemed = await redeemConfirmation(env.DB, args.confirmation, { userId, action: "confirm_permissions", targetId: wedding.id });
        if (redeemed === null) {
          return {
            ok: false,
            result: "invalid_code",
            message: "That code is not valid: it was used already, it expired, or it was for another wedding. Call confirm_permissions again without a code to get a fresh one, and show her the lines again.",
          };
        }

        const record = redeemed.payload as PermissionsRecord;
        const saved = await callApp(env, userId, "PATCH", `/events/${wedding.id}`, { ...mergeWedding(asCurrent(wedding), {}), ...record });
        if (!saved.ok) return refusal(saved.error);

        const now = await standing(env, wedding.id);
        return {
          ok: true,
          data: {
            wedding: now.wedding,
            recorded: redeemed.preview.slice(1),
            step: now.step,
            ...(now.holds.length > 0 ? { onHold: now.holds } : {}),
          },
        };
      },
    ),
  );
}
