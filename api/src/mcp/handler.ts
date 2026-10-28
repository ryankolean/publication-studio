import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";

import { studioOverview, weddingCard, weddingPage } from "../domain/mcp-views.js";
import { tagChoices, tagStanding } from "../domain/tag-tools.js";
import type { OAuthEnv } from "../env.js";
import { listEvents, loadEvent } from "../routes/events.js";
import { geoFrom, geoStatement } from "../routes/match-context.js";
import { weddingTags } from "../routes/style.js";
import { listSubmissions } from "../routes/submissions.js";
import { READ_ONLY, audited } from "./audit.js";
import type { McpContext } from "./audit.js";
import { registerPackageTools } from "./package-tools.js";
import { registerPhotoTools } from "./photo-tools.js";
import { registerPublicationTools } from "./publication-tools.js";
import { registerTagTools } from "./tag-tools.js";
import { registerWeddingTools } from "./wedding-tools.js";

/**
 * The MCP endpoint, /mcp -- spec section 3. The OAuth provider has already
 * checked the bearer token by the time a request gets here.
 *
 * DECISION: stateless Streamable HTTP. Every request builds its own server
 * and answers with plain JSON: no session, no server-sent events, so no
 * Durable Object. Long work returns a job id to poll (spec section 4), which
 * needs nothing more.
 *
 * Every tool reads through the web app's own loaders (spec section 3) and
 * shapes the result in domain/mcp-views.ts.
 */

// Built once per isolate, not per request: zod schemas are costly to build,
// and every /mcp request builds its own server (buildServer below).
const LIST_WEDDINGS_ARGS = z.object({
  limit: z.number().int().min(1).max(25).optional().describe("How many to return, 1 to 25. Default 10."),
  cursor: z.string().max(12).optional().describe("The `next` value from the previous page."),
});

const GET_WEDDING_ARGS = z.object({
  wedding: z.string().min(1).max(100).describe("The wedding's short id, such as blake-and-anne-2026."),
  detail: z.boolean().optional().describe("Also return the story, angle and vendor credits."),
  tag_choices: z.boolean().optional().describe("Also return the tags she can choose from."),
});

export function buildServer(env: OAuthEnv, ctx: McpContext): McpServer {
  // The default validator compiles schemas at runtime, which Workers forbid.
  const server = new McpServer(
    { name: "publication-studio", title: "Publication Studio", version: "1.0.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );

  server.registerTool(
    "studio_overview",
    {
      title: "Studio overview",
      description:
        "Start here. A short summary of the studio: how many weddings are at each stage, the next few things to do, what is waiting to be sent or with an outlet, and replies due in the next two weeks.",
      annotations: READ_ONLY,
    },
    audited(env, ctx, "studio_overview", async () => {
      const [weddings, queue] = await Promise.all([listEvents(env.DB), listSubmissions(env.DB, Date.now())]);
      return { ok: true, data: studioOverview(weddings, queue) };
    }),
  );

  server.registerTool(
    "list_weddings",
    {
      title: "List weddings",
      description:
        "List the weddings, newest first: each one's short id, couple, date, place and next step. Pass the id to get_wedding. Ten at a time; pass the returned `next` as `cursor` for more.",
      inputSchema: LIST_WEDDINGS_ARGS,
      annotations: READ_ONLY,
    },
    audited(env, ctx, "list_weddings", async (args: { limit?: number | undefined; cursor?: string | undefined }) => {
      const [weddings, geoRows] = await Promise.all([listEvents(env.DB), geoStatement(env.DB).all()]);
      const page = weddingPage(
        weddings,
        {
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        },
        geoFrom(geoRows.results),
      );
      return "error" in page ? { ok: false, result: "invalid_cursor", message: page.error } : { ok: true, data: page };
    }),
  );

  server.registerTool(
    "get_wedding",
    {
      title: "Get a wedding",
      description:
        "One wedding by its short id (from list_weddings or studio_overview): date, venue, place, its next step, anything holding it back, the outlets it has gone to, and its tags (kept, not kept, and waiting for her answer). Set detail to true to add the couple's story, the angle and the vendor credits. Set tag_choices to true to add the tags open to her, by group, before suggesting tags for set_tags.",
      inputSchema: GET_WEDDING_ARGS,
      annotations: READ_ONLY,
    },
    audited(env, ctx, "get_wedding", async (args: { wedding: string; detail?: boolean | undefined; tag_choices?: boolean | undefined }) => {
      const wedding = (await listEvents(env.DB)).find((entry) => entry.slug === args.wedding);
      if (wedding === undefined) {
        return {
          ok: false,
          result: "not_found",
          message: "There is no wedding with that id. Use list_weddings to find the right one.",
        };
      }
      const [outlets, look, geoRows] = await Promise.all([
        listSubmissions(env.DB, Date.now(), wedding.id),
        weddingTags(env.DB, wedding.id),
        geoStatement(env.DB).all(),
      ]);
      if (look === null) throw new Error("a listed wedding has no tags view");
      const credits = args.detail === true ? ((await loadEvent(env.DB, wedding.id))?.vendorCredits ?? []) : null;
      return {
        ok: true,
        data: {
          ...weddingCard(wedding, outlets, credits, geoFrom(geoRows.results)),
          tags: tagStanding(look.tags),
          ...(args.tag_choices === true ? { tagChoices: tagChoices(look.vocabulary, look.tags) } : {}),
        },
      };
    }),
  );

  registerWeddingTools(server, env, ctx);
  registerPhotoTools(server, env, ctx);
  registerTagTools(server, env, ctx);
  registerPublicationTools(server, env, ctx);
  registerPackageTools(server, env, ctx);

  return server;
}

export const mcpHandler = {
  async fetch(request: Request, env: OAuthEnv, ctx: McpContext): Promise<Response> {
    const server = buildServer(env, ctx);
    // No sessionIdGenerator means stateless. Passing it as `undefined`, as
    // the SDK's own example does, fails under exactOptionalPropertyTypes.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
