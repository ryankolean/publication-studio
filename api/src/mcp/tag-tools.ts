import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LookTag } from "../domain/style.js";
import { checkTagAnswers, tagStanding } from "../domain/tag-tools.js";
import type { OAuthEnv } from "../env.js";
import { loadVocabulary } from "../routes/style.js";
import { callApp } from "./app-call.js";
import { WRITES, audited } from "./audit.js";
import type { McpContext, Outcome } from "./audit.js";
import { NOT_FOUND } from "./wedding-tools.js";

/**
 * set_tags (SUMMIT-344 slice 3, decision A), which takes the place of the
 * spec's suggest_tags and set_tags. Claude suggests tags in the chat from the
 * list get_wedding gives it; this records her answers through the web app's
 * own route, so the Look screen and the matcher see exactly what she chose.
 */

export function registerTagTools(server: McpServer, env: OAuthEnv, ctx: McpContext): void {
  const userId = ctx.props.userId;

  server.registerTool(
    "set_tags",
    {
      title: "Set tags",
      description:
        "Record which tags she keeps for a wedding. Tags come from a fixed list in six groups (region, landscape_venue, architecture, aesthetic, dress_style, season), and outlets are tagged from the same list, so her kept tags decide which outlets fit. To suggest tags: call get_wedding with tag_choices set to true for the list and any tags already waiting for her answer, look at the photos with review_photos, and suggest the few that fit, saying what you saw. Ask her which to keep, then call this with keep and drop as she answered. Record only what she agreed to. Tags left out stay as they are; a dropped tag is not suggested again. Returns where the wedding's tags stand.",
      inputSchema: {
        wedding: z.string().min(1).max(100).describe("The wedding's short id."),
        keep: z.array(z.string().max(60)).max(40).optional().describe("Tags she wants on this wedding, by id, such as lakefront."),
        drop: z.array(z.string().max(60)).max(40).optional().describe("Tags she said do not fit."),
      },
      annotations: { ...WRITES, idempotentHint: true },
    },
    audited(
      env,
      ctx,
      "set_tags",
      async (args: { wedding: string; keep?: string[] | undefined; drop?: string[] | undefined }): Promise<Outcome> => {
        const wedding = await env.DB.prepare("SELECT id FROM events WHERE slug = ?").bind(args.wedding).first<{ id: string }>();
        if (wedding === null) return NOT_FOUND;

        const vocabulary = (await loadVocabulary(env.DB)).map((tag) => tag.id);
        const answers = checkTagAnswers(args.keep ?? [], args.drop ?? [], vocabulary);
        if (!answers.ok) return answers;

        const saved = await callApp(env, userId, "PUT", `/style/events/${wedding.id}/tags`, {
          confirmed: answers.confirmed,
          rejected: answers.rejected,
        });
        if (!saved.ok) return { ok: false, result: saved.error.code.toLowerCase(), message: saved.error.message };

        const { tags } = saved.body as { tags: LookTag[] };
        return {
          ok: true,
          data: {
            wedding: args.wedding,
            saved: { kept: answers.confirmed.length, dropped: answers.rejected.length },
            tags: tagStanding(tags),
          },
        };
      },
    ),
  );
}
