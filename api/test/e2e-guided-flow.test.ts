import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { signAccessToken } from "../src/domain/tokens.js";
import { createTestD1 } from "./helpers/d1.js";
import type { TestD1 } from "./helpers/d1.js";
import { JWT_SECRET, connect, connectorEnv, mcp, seedUser, send } from "./helpers/connector.js";
import type { ConnectorEnv } from "./helpers/connector.js";

/**
 * SUMMIT-344 slice 7: the Phase 2 done-when, end to end. A wedding goes from
 * nothing to a validated, ready-to-submit package entirely through the
 * connector's tools and guided plans, the way her Claude would drive them,
 * with photos coming in through the upload page's own routes. Nothing is
 * sent: the last step is hers.
 *
 * It is also the token budget test (spec section 6a: responses under about
 * 500 tokens, the whole flow inside one Free plan session). Every reply is
 * measured. Tokens are estimated at 3.5 characters each, which overstates
 * JSON a little, and each preview image is counted at 55 tokens, as the
 * slice 0 spike measured in claude.ai. The wedding is made up: the repo is
 * public.
 */

const here = dirname(fileURLToPath(import.meta.url));
const loadYaml = (path: string): unknown => parse(readFileSync(join(here, path), "utf8"));
const tokens = (chars: number) => Math.ceil(chars / 3.5);
const IMAGE_TOKENS = 55;

let db: TestD1;
let env: ConnectorEnv;
let accessToken: string;
const calls: Array<{ tool: string; tokens: number }> = [];

interface Reply {
  isError: boolean;
  text: string;
  data: Record<string, any>;
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const response = await mcp(env, accessToken, "tools/call", { name, arguments: args });
  const body = (await response.json()) as {
    result?: { isError?: boolean; content: Array<{ type: string; text?: string }> };
    error?: { message: string };
  };
  const content = body.result?.content ?? [];
  const chars = content.reduce((sum, block) => sum + (block.type === "text" ? (block.text ?? "").length : 0), 0);
  const images = content.filter((block) => block.type === "image").length;
  calls.push({ tool: name, tokens: tokens(chars) + images * IMAGE_TOKENS });
  const text = content[0]?.type === "text" ? (content[0].text ?? "") : (body.error?.message ?? "");
  const isError = body.result?.isError === true || body.error !== undefined;
  return { isError, text, data: isError ? {} : (JSON.parse(text) as Record<string, any>) };
}

/** A step that must not fail: the flow stops at the first refusal, with its words. */
async function ok(name: string, args: Record<string, unknown> = {}) {
  const reply = await tool(name, args);
  expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
  return reply.data;
}

beforeAll(async () => {
  db = createTestD1();
  env = connectorEnv(db);
  await seedUser(db, "user-1", "partner@example.com", "a-long-studio-password");
  await seedUser(db, "user-admin", "admin@example.com", "a-long-admin-password", "admin");
  ({ accessToken } = await connect(env, "partner@example.com", "a-long-studio-password"));

  // The operator's side: the vocabulary and one researched outlet, approved.
  const admin = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-admin", role: "admin" })}`, "content-type": "application/json" };
  const vocab = { tags: loadYaml("../../research/vocab/tags.yaml"), geo: loadYaml("../../research/vocab/geo.yaml") };
  expect((await send(env, "/research/vocab", { method: "PUT", headers: admin, body: JSON.stringify(vocab) })).status).toBe(200);
  const proposed = await send(env, "/research/revisions", {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ file: loadYaml("../../research/publications/pub-junebug-weddings.yaml"), contacts: null, git_sha: "e2e0001" }),
  });
  expect(proposed.status, await proposed.clone().text()).toBe(201);
  const { revisionId } = (await proposed.json()) as { revisionId: string };
  expect((await send(env, `/research/revisions/${revisionId}/approve`, { method: "POST", headers: admin, body: "{}" })).status).toBe(200);
});

afterAll(() => db.close());

describe("the guided flow, from a new wedding to a ready-to-submit package", () => {
  it("runs through every plan with her answers, and leaves the sending to her", async () => {
    // Plan first: a new wedding, before it exists.
    expect((await ok("plan", { template: "new_wedding", goal: "Add the Georgia wedding" })).plan).toBeNull();

    // 1. The wedding, then the plan is kept for it.
    const saved = await ok("save_wedding", { couple_names: "Rowan & Sage", date: "2026-05-16", venue: "Oak Hall", city: "Athens", place: "US-GA" });
    const wedding = saved["wedding"] as string;
    expect(wedding).toBe("rowan-sage-2026");
    await ok("plan", { template: "new_wedding", wedding });
    expect(await ok("run_plan_step", { plan: `${wedding}/new_wedding` })).toMatchObject({ step: { n: 2 }, use: "confirm_permissions" });

    // 2. Her permission answers, in two steps.
    const answers = { wedding, lead_photographer: true, couple_agreed: "yes" };
    const shown = await ok("confirm_permissions", answers);
    await ok("confirm_permissions", { ...answers, confirmation: shown["confirm"] });

    // 3. Photos through the upload link, as the page sends them.
    const link = String((await ok("get_upload_link", { wedding }))["link"]);
    const bearer = { authorization: `Bearer ${link.slice(link.indexOf("#") + 1)}` };
    for (const n of [1, 2, 3]) {
      const added = await send(env, "/upload/photos", {
        method: "POST",
        headers: { ...bearer, "content-type": "image/jpeg", "x-file-name": `Ceremony-0${n}.jpg` },
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n]),
      });
      expect(added.status).toBe(201);
      const { photo } = (await added.json()) as { photo: string };
      const preview = await send(env, `/upload/photos/${photo}/preview`, {
        method: "PUT",
        headers: { ...bearer, "content-type": "image/jpeg" },
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xdb, n]),
      });
      expect(preview.status).toBe(201);
    }
    expect((await send(env, "/upload/done", { method: "POST", headers: bearer })).status).toBe(200);
    expect((await ok("review_photos", { wedding }))["photos"]).toBe(3);

    // 4. Story and vendors; 5. the style tags she keeps.
    await ok("save_wedding", {
      wedding,
      story: "Rowan and Sage met restoring an old sailboat and married under the oaks.",
      vendors: [{ role: "Florist", business: "Petal and Stem" }],
    });
    expect((await ok("get_wedding", { wedding, tag_choices: true }))["tagChoices"]).toHaveProperty("aesthetic");
    await ok("set_tags", { wedding, keep: ["garden_botanical", "romantic"] });
    expect(await ok("run_plan_step", { plan: `${wedding}/new_wedding` })).toMatchObject({ done: true });

    // Pick the outlets: rank, read a card, set her order.
    await ok("plan", { template: "pick_outlets", wedding });
    const ranked = await ok("rank_publications_for_wedding", { wedding });
    expect(ranked["outlets"].map((line: { id: string }) => line.id)).toContain("pub-junebug-weddings");
    expect(await ok("publications", { publication: "pub-junebug-weddings" })).toMatchObject({ where: "Anywhere" });
    expect(await ok("set_queue", { wedding, outlets: ["pub-junebug-weddings"] })).toMatchObject({ upNext: "Junebug Weddings" });
    expect(await ok("run_plan_step", { plan: `${wedding}/pick_outlets` })).toMatchObject({ done: true });

    // Build the package: photos, write-up, then her confirmations in two steps.
    await ok("plan", { template: "build_package", wedding });
    const drafted = await ok("build_package_draft", {
      wedding,
      publication: "pub-junebug-weddings",
      photos: ["1", "2", "3"],
      write_up: "Rowan and Sage married under the oaks at Oak Hall, after years of restoring a sailboat together.",
    });
    const hers = (drafted["toDo"] as Array<{ id: string; sheConfirms?: boolean }>).filter((item) => item.sheConfirms === true).map((item) => item.id);
    expect(hers.length).toBeGreaterThan(0);
    expect((drafted["toDo"] as unknown[]).length).toBe(hers.length);
    const asked = await ok("build_package_draft", { wedding, publication: "pub-junebug-weddings", confirm: hers });
    expect(asked["willRecord"]).toHaveLength(hers.length + 1);
    const confirmed = await ok("build_package_draft", { wedding, publication: "pub-junebug-weddings", confirmation: asked["confirm"] });
    expect(confirmed).toMatchObject({ complete: true, toDo: [] });

    // Ready to submit: the order readies it, and the plans move on to her.
    expect(await ok("set_queue", { wedding, outlets: ["pub-junebug-weddings"] })).toMatchObject({ readied: "Junebug Weddings" });
    expect(await ok("run_plan_step", { plan: `${wedding}/build_package` })).toMatchObject({ done: true });
    await ok("plan", { template: "send_and_follow_up", wedding });
    expect(await ok("run_plan_step", { plan: `${wedding}/send_and_follow_up` })).toMatchObject({ step: { n: 2, who: "you" }, use: null });

    const submission = await db
      .prepare("SELECT status, sent_at FROM submissions WHERE publication_id = 'pub-junebug-weddings'")
      .first<{ status: string; sent_at: string | null }>();
    expect(submission).toEqual({ status: "ready", sent_at: null });
  });

  it("stays inside the token budget: every reply small, the whole flow within one session", async () => {
    const listed = await mcp(env, accessToken, "tools/list");
    const toolList = tokens((await listed.text()).length);
    const largest = calls.reduce((max, call) => (call.tokens > max.tokens ? call : max));
    const total = calls.reduce((sum, call) => sum + call.tokens, 0);
    console.log(
      `token budget: ${calls.length} tool calls, ${total} tokens in replies, largest ${largest.tokens} (${largest.tool}), tool list ${toolList}`,
    );

    // Spec 6a: about 500 tokens per reply by default. review_photos carries
    // its pictures, at 55 tokens each.
    for (const call of calls.filter((entry) => entry.tool !== "review_photos")) {
      expect(call.tokens, call.tool).toBeLessThan(600);
    }
    expect(toolList).toBeLessThan(8000);
    expect(total).toBeLessThan(12000);
  });
});
