import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { createTestD1 } from "./helpers/d1.js";
import type { TestD1 } from "./helpers/d1.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { JWT_SECRET, connect, connectorEnv, mcp, seedUser, send } from "./helpers/connector.js";
import type { ConnectorEnv } from "./helpers/connector.js";

const here = dirname(fileURLToPath(import.meta.url));
const GEO = JSON.stringify(parse(readFileSync(join(here, "../../research/vocab/geo.yaml"), "utf8")));

let db: TestD1;
let env: ConnectorEnv;
let accessToken: string;

interface ToolReply {
  isError: boolean;
  text: string;
  data: Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  const response = await mcp(env, accessToken, "tools/call", { name, arguments: args });
  const body = (await response.json()) as { result?: { isError?: boolean; content: Array<{ type: string; text: string }> }; error?: { message: string } };
  const text = body.result?.content[0]?.text ?? body.error?.message ?? "";
  const isError = body.result?.isError === true || body.error !== undefined;
  return { isError, text, data: isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const tagRows = async () =>
  (await db.prepare("SELECT tag_id, state, source FROM event_tags WHERE event_id = 'w1' ORDER BY tag_id").all()).results;

async function auditRows() {
  const { results } = await db
    .prepare("SELECT entity, entity_id, action, detail_json FROM audit_log WHERE entity IN ('event', 'mcp_tool') ORDER BY rowid")
    .all<{ entity: string; entity_id: string; action: string; detail_json: string }>();
  return results.map((row) => ({ ...row, detail: JSON.parse(row.detail_json) as Record<string, unknown> }));
}

beforeEach(async () => {
  db = createTestD1();
  env = connectorEnv(db);
  await seedUser(db, "user-1", "partner@example.com", "a-long-studio-password");
  ({ accessToken } = await connect(env, "partner@example.com", "a-long-studio-password"));
  await db.prepare("INSERT INTO research_vocab (kind, json, content_hash) VALUES ('geo', ?, 'test')").bind(GEO).run();
  await db
    .prepare(
      `INSERT INTO events (id, slug, couple_names, event_date, location_code, rights_status, consent_status)
       VALUES ('w1', 'w1-2026', 'Casey & Jordan', '2026-01-31', 'US-MI', 'own_contract', 'granted')`,
    )
    .run();
});

afterEach(() => {
  db.close();
});

describe("tools/list", () => {
  it("adds set_tags as a write that is safe to repeat, and tag_choices to get_wedding", async () => {
    const response = await mcp(env, accessToken, "tools/list");
    const { result } = (await response.json()) as {
      result: { tools: Array<{ name: string; annotations: Record<string, unknown>; inputSchema: { properties: Record<string, unknown> } }> };
    };
    const byName = new Map(result.tools.map((tool) => [tool.name, tool]));
    expect(byName.get("set_tags")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(Object.keys(byName.get("set_tags")?.inputSchema.properties ?? {})).toEqual(["wedding", "keep", "drop"]);
    expect(byName.get("get_wedding")?.inputSchema.properties).toHaveProperty("tag_choices");
  });
});

describe("get_wedding tags", () => {
  it("shows what the date and place suggest, waiting for her answer, without storing anything", async () => {
    const reply = await callTool("get_wedding", { wedding: "w1-2026" });
    expect(reply.data["tags"]).toEqual({
      kept: [],
      toAnswer: [
        { tag: "michigan", why: "From where the wedding was." },
        { tag: "midwest_us", why: "From where the wedding was." },
        { tag: "winter", why: "From the wedding date." },
      ],
    });
    expect(reply.data).not.toHaveProperty("tagChoices");
    expect(await tagRows()).toEqual([]);
    // Placed only by the location list, the wedding still has a place.
    expect(reply.data["place"]).toBe("Michigan");
    const listed = await callTool("list_weddings");
    expect((listed.data["weddings"] as Array<{ place: string | null }>)[0]?.place).toBe("Michigan");
  });

  it("adds the tags open to her, by group, on request, leaving out the ones she answered", async () => {
    await callTool("set_tags", { wedding: "w1-2026", keep: ["lakefront"], drop: ["winter"] });
    const reply = await callTool("get_wedding", { wedding: "w1-2026", tag_choices: true });
    const choices = reply.data["tagChoices"] as Record<string, string>;
    expect(Object.keys(choices)).toEqual(["region", "landscape_venue", "architecture", "aesthetic", "dress_style", "season"]);
    expect(choices["landscape_venue"]).toMatch(/^garden_botanical, vineyard_winery, beach_coastal, mountain_alpine/);
    expect(choices["landscape_venue"]?.split(", ")).not.toContain("lakefront");
    expect(choices["season"]?.split(", ")).not.toContain("winter");
    expect(choices["region"]?.split(", ")).toContain("michigan");
    expect(reply.data["tags"]).toEqual({
      kept: ["lakefront"],
      notKept: ["winter"],
      toAnswer: [
        { tag: "michigan", why: "From where the wedding was." },
        { tag: "midwest_us", why: "From where the wedding was." },
      ],
    });
  });

  it("keeps the tag list small", async () => {
    const reply = await callTool("get_wedding", { wedding: "w1-2026", tag_choices: true });
    expect(JSON.stringify(reply.data["tagChoices"]).length).toBeLessThan(1600);
  });
});

describe("set_tags", () => {
  it("records what she keeps and drops through the web app's route, and says where the tags stand", async () => {
    const reply = await callTool("set_tags", { wedding: "w1-2026", keep: ["Lakefront", "michigan", "late fall"], drop: ["winter"] });
    expect(reply.isError).toBe(false);
    expect(reply.data).toEqual({
      wedding: "w1-2026",
      saved: { kept: 3, dropped: 1 },
      tags: {
        kept: ["michigan", "lakefront", "late_fall"],
        notKept: ["winter"],
        toAnswer: [{ tag: "midwest_us", why: "From where the wedding was." }],
      },
    });
    expect(await tagRows()).toEqual([
      { tag_id: "lakefront", state: "confirmed", source: "photographer" },
      { tag_id: "late_fall", state: "confirmed", source: "photographer" },
      { tag_id: "michigan", state: "confirmed", source: "derived" },
      { tag_id: "winter", state: "rejected", source: "derived" },
    ]);

    const audit = await auditRows();
    expect(audit.map((row) => [row.entity, row.entity_id, row.action])).toEqual([
      ["event", "w1", "tags_answered"],
      ["mcp_tool", "set_tags", "call"],
    ]);
    expect(audit[1]?.detail).toMatchObject({ args: { wedding: "w1-2026", keep: "[object]", drop: "[object]" }, result: "ok" });
  });

  it("changes an earlier answer when she changes her mind", async () => {
    await callTool("set_tags", { wedding: "w1-2026", drop: ["romantic"] });
    const reply = await callTool("set_tags", { wedding: "w1-2026", keep: ["romantic"] });
    expect((reply.data["tags"] as { kept: string[] }).kept).toEqual(["romantic"]);
    expect(await tagRows()).toEqual([{ tag_id: "romantic", state: "confirmed", source: "photographer" }]);
  });

  it("refuses a tag not in the list, offering the closest ones, and saves nothing", async () => {
    const reply = await callTool("set_tags", { wedding: "w1-2026", keep: ["lakefront", "mountains"] });
    expect(reply.isError).toBe(true);
    expect(reply.text).toBe(
      "Not in the tag list: mountains (closest: mountain_west_us, mountain_alpine). Call get_wedding with tag_choices set to true for the list. Nothing was saved.",
    );
    expect(await tagRows()).toEqual([]);
    expect((await auditRows()).map((row) => row.detail["result"])).toEqual(["unknown_tag"]);
  });

  it("refuses a tag both kept and dropped, an empty call and an unknown wedding", async () => {
    const both = await callTool("set_tags", { wedding: "w1-2026", keep: ["romantic"], drop: ["Romantic"] });
    expect(both.text).toContain("In both keep and drop: romantic.");
    const empty = await callTool("set_tags", { wedding: "w1-2026", keep: [] });
    expect(empty.text).toContain("Give keep, drop or both");
    const missing = await callTool("set_tags", { wedding: "nobody-2026", keep: ["romantic"] });
    expect(missing.text).toContain("list_weddings");
    expect(await tagRows()).toEqual([]);
    expect((await auditRows()).map((row) => row.detail["result"])).toEqual(["kept_and_dropped", "needs_tags", "not_found"]);
  });

  it("marks the wizard's Look step done once she keeps a tag", async () => {
    const web = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" })}` };
    const lookDone = async () => {
      const body = (await (await send(env, "/events/w1/walkthrough", { headers: web })).json()) as {
        wizard: { steps: Array<{ id: string; done: boolean }> };
      };
      return body.wizard.steps.find((step) => step.id === "look")?.done;
    };
    expect(await lookDone()).toBe(false);
    await callTool("set_tags", { wedding: "w1-2026", drop: ["winter"] });
    expect(await lookDone()).toBe(false);
    await callTool("set_tags", { wedding: "w1-2026", keep: ["romantic"] });
    expect(await lookDone()).toBe(true);
  });
});
