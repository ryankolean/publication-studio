import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { isRealDate } from "../domain/event-intake.js";
import { locationOptions } from "../domain/geo.js";
import type { ConsentStatus, RightsStatus } from "../domain/rights-gate.js";
import { factCard, outletDetail, publicationPage, rankPage, sharpenHints } from "../domain/publication-tools.js";
import type { PublicationFilters } from "../domain/publication-tools.js";
import { CONTENT_TYPES } from "../domain/research/schema.js";
import { closeTags, tagId } from "../domain/tag-tools.js";
import { matchPlace } from "../domain/wedding-tools.js";
import { gateWords } from "../domain/wizard.js";
import type { OAuthEnv } from "../env.js";
import { geoFrom, geoStatement, rankForEvent } from "../routes/match-context.js";
import type { MatchEventRow } from "../routes/match-context.js";
import { listPublications, loadPublication } from "../routes/publications.js";
import { vocabularyStatement } from "../routes/style.js";
import { READ_ONLY, audited } from "./audit.js";
import type { McpContext, Outcome } from "./audit.js";
import { NOT_FOUND } from "./wedding-tools.js";

/**
 * publications and rank_publications_for_wedding (SUMMIT-344 slice 4).
 * publications takes the place of the spec's find_publications and
 * get_publication. Both only read: the cards and the ranking are the
 * studio's own, worked out by the same loaders and matcher as the web app's
 * outlet chooser.
 */

// Built once per isolate, not per request: zod schemas are costly to build,
// and every /mcp request builds its own server (handler.ts).
const PUBLICATIONS_ARGS = z.object({
  publication: z.string().min(1).max(100).optional().describe("An outlet's id, such as pub-junebug-weddings, for its fact card."),
  detail: z.boolean().optional().describe("With publication: also return where and how to submit, and its package requirements."),
  place: z.string().max(100).optional().describe("List only outlets that cover this place, as a name or a code, such as 'Florida Keys'."),
  styles: z.array(z.string().max(60)).max(10).optional().describe("List only outlets tagged with any of these style tags, such as romantic."),
  kind: z.enum(CONTENT_TYPES).optional().describe("List only outlets that take real_wedding, elopement or styled_shoot."),
  married_on: z.string().max(10).optional().describe("YYYY-MM-DD: list only outlets that still take a wedding from that date."),
  cursor: z.string().max(6).optional().describe("The next value from the previous page."),
});

const RANK_ARGS = z.object({
  wedding: z.string().min(1).max(100).describe("The wedding's short id."),
  show: z.enum(["open", "excluded"]).optional().describe("open (default): the outlets she can send to. excluded: the ones ruled out, with why."),
  cursor: z.string().max(6).optional().describe("The next value from the previous page."),
});

const today = () => new Date().toISOString().slice(0, 10);

const UNKNOWN_OUTLET: Outcome = {
  ok: false,
  result: "not_found",
  message: "There is no outlet with that id. Call publications without one to list them.",
};

interface RankEventRow extends MatchEventRow {
  slug: string;
  rights_status: RightsStatus;
  consent_status: ConsentStatus;
}

type ListArgs = z.infer<typeof PUBLICATIONS_ARGS>;

/** The list filters in the matcher's terms, or why one cannot be read. Nothing is listed on a refusal. */
async function readFilters(env: OAuthEnv, args: ListArgs): Promise<{ filters: PublicationFilters } | Outcome> {
  const filters: PublicationFilters = {};
  if (args.kind !== undefined) filters.kind = args.kind;
  if (args.married_on !== undefined) {
    if (!isRealDate(args.married_on)) {
      return { ok: false, result: "bad_date", message: "Give married_on as a date, YYYY-MM-DD." };
    }
    filters.marriedOn = args.married_on;
  }
  if (args.place === undefined && (args.styles ?? []).length === 0) return { filters };

  const [geoRows, vocabularyRows] = await env.DB.batch([geoStatement(env.DB), vocabularyStatement(env.DB)]);
  if (args.place !== undefined) {
    const geo = geoFrom(geoRows?.results ?? []);
    if (geo === null) return { ok: false, result: "places_missing", message: "The list of places is not loaded yet. Ask without place for now." };
    const match = matchPlace(args.place, locationOptions(geo));
    if ("candidates" in match) {
      const options = match.candidates.map((option) => `${option.code} (${option.label})`).join(", ");
      return {
        ok: false,
        result: "unclear_place",
        message:
          options === ""
            ? `No place in the list matches "${args.place}". Try a city, area or state name.`
            : `"${args.place}" is not clear enough. Closest places: ${options}. Ask again with place set to one of these codes.`,
      };
    }
    filters.place = match.code;
  }
  const styles = [...new Set((args.styles ?? []).map(tagId))];
  if (styles.length > 0) {
    const vocabulary = ((vocabularyRows?.results ?? []) as Array<{ id: string }>).map((tag) => tag.id);
    const unknown = styles.filter((tag) => !vocabulary.includes(tag));
    if (unknown.length > 0) {
      const lines = unknown.map((tag) => {
        const close = closeTags(tag, vocabulary);
        return close.length === 0 ? tag : `${tag} (closest: ${close.join(", ")})`;
      });
      return {
        ok: false,
        result: "unknown_tag",
        message: `Not in the tag list: ${lines.join("; ")}. Call get_wedding with tag_choices set to true for the list.`,
      };
    }
    filters.styles = styles;
  }
  return { filters };
}

export function registerPublicationTools(server: McpServer, env: OAuthEnv, ctx: McpContext): void {
  server.registerTool(
    "publications",
    {
      title: "Publications",
      description:
        "The publications (outlets) she can submit to. With publication set to an id: that outlet's fact card, covering what it takes, where, how to send, fees, exclusivity, how recent a wedding must be, reply time, audience and style; facts it does not state are listed under unknown. Set detail to true to add the submission address and the package requirements. Without an id: the outlets ten at a time, primary first, filtered by place, styles, kind and married_on if given. An outlet that does not say enough to answer a filter is kept and marked unsure. To see which outlets suit a particular wedding, use rank_publications_for_wedding instead.",
      inputSchema: PUBLICATIONS_ARGS,
      annotations: READ_ONLY,
    },
    audited(env, ctx, "publications", async (args: ListArgs): Promise<Outcome> => {
      if (args.publication !== undefined) {
        const [outlet, geoRows] = await Promise.all([loadPublication(env.DB, args.publication), geoStatement(env.DB).all()]);
        if (outlet === null) return UNKNOWN_OUTLET;
        const geo = geoFrom(geoRows.results);
        const card = args.detail === true ? outletDetail(outlet, geo) : factCard(outlet, geo);
        return { ok: true, data: outlet.active ? card : { ...card, inactive: true } };
      }

      const read = await readFilters(env, args);
      if (!("filters" in read)) return read;
      const [outlets, geoRows] = await Promise.all([listPublications(env.DB, false), geoStatement(env.DB).all()]);
      const page = publicationPage(outlets, read.filters, geoFrom(geoRows.results), today(), args.cursor);
      return "error" in page ? { ok: false, result: "invalid_cursor", message: page.error } : { ok: true, data: page };
    }),
  );

  server.registerTool(
    "rank_publications_for_wedding",
    {
      title: "Rank publications for a wedding",
      description:
        "Every outlet ranked for one wedding, best first, with the reasons and anything to check. The studio's matcher weighs the wedding's place, kind, kept tags, where it has been shared and her history with each outlet. Shows the outlets she can send to, those that fit first and then those with something to check, eight at a time; set show to excluded for the ones ruled out, with why. Report the ranking as it is, and use publications with an outlet's id for its fact card. sharpen lists what would let the ranking say more.",
      inputSchema: RANK_ARGS,
      annotations: READ_ONLY,
    },
    audited(
      env,
      ctx,
      "rank_publications_for_wedding",
      async (args: { wedding: string; show?: "open" | "excluded" | undefined; cursor?: string | undefined }): Promise<Outcome> => {
        const event = await env.DB.prepare(
          `SELECT id, slug, event_date, location_code, content_type, is_destination, rights_status, consent_status
           FROM events WHERE slug = ?`,
        )
          .bind(args.wedding)
          .first<RankEventRow>();
        if (event === null) return NOT_FOUND;

        const { outlets, match, ranked } = await rankForEvent(env.DB, event, today());
        const page = rankPage(ranked, new Map(outlets.map((outlet) => [outlet.id, outlet])), args.show ?? "open", args.cursor);
        if ("error" in page) return { ok: false, result: "invalid_cursor", message: page.error };

        const holds = gateWords({ rightsStatus: event.rights_status, consentStatus: event.consent_status });
        const sharpen = sharpenHints({ locationCode: event.location_code, keptTags: match.wedding.tags.length });
        return {
          ok: true,
          data: {
            wedding: event.slug,
            ...page,
            ...(holds.length > 0 ? { onHold: holds } : {}),
            ...(sharpen.length > 0 ? { sharpen } : {}),
          },
        };
      },
    ),
  );
}
