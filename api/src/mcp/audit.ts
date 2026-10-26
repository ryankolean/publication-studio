import { auditArgs } from "../domain/mcp-views.js";
import type { OAuthEnv } from "../env.js";

/** What the provider passes for a request whose token it accepted. */
export interface McpContext {
  props: { userId: string };
  auth: { clientId?: string };
}

/** A tool's answer; `result` names it in the audit row, "ok" unless a successful call says otherwise. */
export type Outcome = { ok: true; data: unknown; result?: string } | { ok: false; result: string; message: string };

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/**
 * Runs a tool and writes its audit row (spec section 3: tool, input summary,
 * result, time). The row is written before anything is returned, and if it
 * cannot be written nothing is returned: no read without a record of it.
 *
 * DECISION: a call the SDK rejects for malformed arguments never reaches
 * here, so it has no row. It returned nothing either.
 */
export function audited<Args>(env: OAuthEnv, ctx: McpContext, tool: string, run: (args: Args) => Promise<Outcome>) {
  return async (args: Args) => {
    const started = Date.now();
    let outcome: Outcome;
    try {
      outcome = await run(args);
    } catch (error) {
      console.error("mcp tool failed", tool, error instanceof Error ? error.message : error);
      outcome = { ok: false, result: "internal", message: "Something went wrong in the studio. Try again." };
    }

    try {
      await env.DB.prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json) VALUES (?, ?, 'mcp_tool', ?, 'call', ?)",
      )
        .bind(
          crypto.randomUUID(),
          ctx.props.userId,
          tool,
          JSON.stringify({
            client: ctx.auth.clientId ?? null,
            args: auditArgs(args),
            result: outcome.ok ? (outcome.result ?? "ok") : outcome.result,
            ms: Date.now() - started,
          }),
        )
        .run();
    } catch (error) {
      console.error("mcp audit failed", tool, error instanceof Error ? error.message : error);
      return { content: [{ type: "text" as const, text: "The studio could not record this request, so it returned nothing. Try again." }], isError: true };
    }

    return outcome.ok
      ? { content: [{ type: "text" as const, text: JSON.stringify(outcome.data) }] }
      : { content: [{ type: "text" as const, text: outcome.message }], isError: true };
  };
}

/** For tools that change the studio but never destroy anything. */
export const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
