import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

import type { OAuthEnv } from "../env.js";

/**
 * The MCP endpoint, /mcp -- spec section 3. The OAuth provider has already
 * checked the bearer token by the time a request gets here.
 *
 * DECISION: stateless Streamable HTTP. Every request builds its own server
 * and answers with plain JSON: no session, no server-sent events, so no
 * Durable Object. Long work returns a job id to poll (spec section 4), which
 * needs nothing more.
 */

/** What the provider passes for a request whose token it accepted. */
export interface McpContext {
  props: { userId: string };
  auth: { clientId?: string };
}

export function buildServer(): McpServer {
  // The default validator compiles schemas with `new Function`, which Workers forbid.
  return new McpServer(
    { name: "publication-studio", title: "Publication Studio", version: "1.0.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
}

export const mcpHandler = {
  async fetch(request: Request, _env: OAuthEnv, _ctx: McpContext): Promise<Response> {
    const server = buildServer();
    // No sessionIdGenerator means stateless. Passing it as `undefined`, as
    // the SDK's own example does, fails under exactOptionalPropertyTypes.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
