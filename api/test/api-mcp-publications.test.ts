import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { signAccessToken } from "../src/domain/tokens.js";
import { createTestD1 } from "./helpers/d1.js";
import type { TestD1 } from "./helpers/d1.js";
import { JWT_SECRET, connect, connectorEnv, mcp, seedUser, send } from "./helpers/connector.js";
import type { ConnectorEnv } from "./helpers/connector.js";

const here = dirname(fileURLToPath(import.meta.url));
const loadYaml = (path: string): unknown => parse(readFileSync(join(here, path), "utf8"));

let db: TestD1;
let env: ConnectorEnv;
let accessToken: string;
let admin: Record<string, string>;
let partner: Record<string, string>;

interface ToolReply {
  isError: boolean;
  text: string;
  data: Record<string, any>;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  const response = await mcp(env, accessToken, "tools/call", { name, arguments: args });
  const body = (await response.json()) as { result?: { isError?: boolean; content: Array<{ type: string; text: string }> }; error?: { message: string } };
  const text = body.result?.content[0]?.text ?? body.error?.message ?? "";
  const isError = body.result?.isError === true || body.error !== undefined;
  return { isError, text, data: isError ? {} : (JSON.parse(text) as Record<string, any>) };
}

const web = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  send(env, path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Approves the example outlet: a primary outlet covering Michigan and the Midwest by wedding location. */
async function approveExample() {
  const proposed = await web("POST", "/research/revisions", admin, {
    file: loadYaml("fixtures/research/pub-example-weddings.yaml"),
    contacts: null,
    git_sha: "abc1234",
  });
  expect(proposed.status, await proposed.clone().text()).toBe(201);
  const { revisionId } = (await proposed.json()) as { revisionId: string };
  expect((await web("POST", `/research/revisions/${revisionId}/approve`, partner, {})).status).toBe(200);
}

async function seedWedding(slug: string, extra: { location?: string | null; rights?: string; tags?: string[] } = {}) {
  const id = slug.replace(/-2026$/, "");
  await db
    .prepare(
      `INSERT INTO events (id, slug, couple_names, event_date, location_code, rights_status, consent_status)
       VALUES (?, ?, 'Ada & Bo', '2026-07-31', ?, ?, 'granted')`,
    )
    .bind(id, slug, extra.location === undefined ? "US-MI:detroit" : extra.location, extra.rights ?? "own_contract")
    .run();
  for (const tag of extra.tags ?? []) {
    await db.prepare("INSERT INTO event_tags (event_id, tag_id, state, source) VALUES (?, ?, 'confirmed', 'photographer')").bind(id, tag).run();
  }
  return id;
}

async function auditResults() {
  const { results } = await db
    .prepare("SELECT entity_id, detail_json FROM audit_log WHERE entity = 'mcp_tool' ORDER BY rowid")
    .all<{ entity_id: string; detail_json: string }>();
  return results.map((row) => [row.entity_id, (JSON.parse(row.detail_json) as { result: string }).result]);
}

beforeEach(async () => {
  db = createTestD1();
  env = connectorEnv(db);
  await seedUser(db, "user-1", "partner@example.com", "a-long-studio-password");
  await seedUser(db, "user-admin", "admin@example.com", "a-long-admin-password", "admin");
  ({ accessToken } = await connect(env, "partner@example.com", "a-long-studio-password"));
  admin = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-admin", role: "admin" })}` };
  partner = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" })}` };
  const vocab = { tags: loadYaml("../../research/vocab/tags.yaml"), geo: loadYaml("../../research/vocab/geo.yaml") };
  expect((await web("PUT", "/research/vocab", admin, vocab)).status).toBe(200);
});

afterEach(() => db.close());

describe("tools/list", () => {
  it("adds publications and rank_publications_for_wedding as reads", async () => {
    const response = await mcp(env, accessToken, "tools/list");
    const { result } = (await response.json()) as { result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> } };
    const byName = new Map(result.tools.map((tool) => [tool.name, tool.annotations]));
    expect(result.tools).toHaveLength(10);
    expect(byName.get("publications")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get("rank_publications_for_wedding")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});

describe("publications", () => {
  it("lists the active outlets ten at a time, primary first, flagging unresearched ones", async () => {
    await approveExample();
    const first = await callTool("publications");
    expect(first.data["total"]).toBe(11);
    expect(first.data["next"]).toBe("10");
    expect(first.data["outlets"]).toHaveLength(10);
    expect(first.data["outlets"].map((line: { tier: string }) => line.tier).indexOf("secondary")).toBeGreaterThan(0);
    const example = first.data["outlets"].find((line: { id: string }) => line.id === "pub-example-weddings");
    expect(example).toEqual({
      id: "pub-example-weddings",
      name: "Example Weddings",
      tier: "primary",
      about: "Light-filled lakeside and garden weddings with full vendor detail.",
    });
    expect(first.data["outlets"].filter((line: { unresearched?: boolean }) => line.unresearched === true)).toHaveLength(9);
    expect((await callTool("publications", { cursor: "10" })).data["outlets"]).toHaveLength(1);
  });

  it("filters by place, style, kind and wedding date, keeping outlets that do not say and marking them unsure", async () => {
    await approveExample();
    const detroit = await callTool("publications", { place: "Detroit", styles: ["Romantic"], kind: "elopement", married_on: "2026-07-31" });
    expect(detroit.data["outlets"].find((line: { id: string }) => line.id === "pub-example-weddings")).not.toHaveProperty("unsure");
    expect(detroit.data["outlets"].every((line: { id: string; unsure?: string[] }) => line.id === "pub-example-weddings" || line.unsure !== undefined)).toBe(true);

    const florida = await callTool("publications", { place: "US-FL" });
    expect(florida.data["outlets"].map((line: { id: string }) => line.id)).not.toContain("pub-example-weddings");
    const old = await callTool("publications", { married_on: "2024-01-01" });
    expect(old.data["outlets"].map((line: { id: string }) => line.id)).not.toContain("pub-example-weddings");
  });

  it("refuses a filter it cannot read, and says what would work", async () => {
    expect((await callTool("publications", { place: "Springfield" })).text).toMatch(/is not clear enough|No place in the list/);
    expect((await callTool("publications", { styles: ["mountains"] })).text).toBe(
      "Not in the tag list: mountains (closest: mountain_west_us, mountain_alpine). Call get_wedding with tag_choices set to true for the list.",
    );
    expect((await callTool("publications", { married_on: "July 2026" })).text).toBe("Give married_on as a date, YYYY-MM-DD.");
    expect((await callTool("publications", { cursor: "99" })).text).toContain("cursor is not valid");
    expect((await auditResults()).map(([, result]) => result)).toEqual(["unclear_place", "unknown_tag", "bad_date", "invalid_cursor"]);
  });

  it("gives one outlet's fact card, and its package with detail", async () => {
    await approveExample();
    const card = await callTool("publications", { publication: "pub-example-weddings" });
    expect(card.data).toMatchObject({
      id: "pub-example-weddings",
      name: "Example Weddings",
      tier: "primary",
      takes: "real weddings and elopements",
      where: "Michigan and Midwest, by where the wedding was, no destination weddings",
      fresh: "weddings up to 12 months old",
    });
    expect(card.data).not.toHaveProperty("package");
    expect(JSON.stringify(card.data).length).toBeLessThan(2000);

    const detail = await callTool("publications", { publication: "pub-example-weddings", detail: true });
    expect(detail.data).toHaveProperty("package");
    expect(detail.data["styles"]).toEqual(["garden_botanical", "lakefront", "romantic"]);
  });

  it("marks an outlet taken off the list, and says so for one that does not exist", async () => {
    await db.prepare("UPDATE publications SET active = 0 WHERE id = 'pub-brides'").run();
    expect((await callTool("publications", { publication: "pub-brides" })).data).toMatchObject({ id: "pub-brides", inactive: true, unresearched: true });
    const missing = await callTool("publications", { publication: "pub-nobody" });
    expect(missing.text).toBe("There is no outlet with that id. Call publications without one to list them.");
  });
});

describe("rank_publications_for_wedding", () => {
  it("ranks the outlets for a wedding the same way the web app's chooser does", async () => {
    await approveExample();
    const id = await seedWedding("ada-bo-2026", { tags: ["lakefront", "romantic"] });
    const reply = await callTool("rank_publications_for_wedding", { wedding: "ada-bo-2026" });
    expect(reply.data["wedding"]).toBe("ada-bo-2026");
    expect(reply.data["counts"]).toEqual({ fits: 1, check: 10, excluded: 0 });
    expect(reply.data["outlets"][0]).toMatchObject({ id: "pub-example-weddings", name: "Example Weddings", tier: "primary" });
    expect(reply.data["outlets"][0]["match"]).toMatch(/^(Strong|Good) match \(\d+ of 100\)$/);
    expect(reply.data["outlets"][0]["why"]).toContain("Covers Michigan specifically.");
    expect(reply.data["outlets"]).toHaveLength(8);
    expect(reply.data["next"]).toBe("8");
    expect(reply.data).not.toHaveProperty("sharpen");
    expect(reply.data).not.toHaveProperty("onHold");

    const walkthrough = (await (await web("GET", `/events/${id}/walkthrough`, partner)).json()) as { outlets: Array<{ id: string }> };
    const second = await callTool("rank_publications_for_wedding", { wedding: "ada-bo-2026", cursor: "8" });
    expect([...reply.data["outlets"], ...second.data["outlets"]].map((line: { id: string }) => line.id)).toEqual(walkthrough.outlets.map((outlet) => outlet.id));
  });

  it("shows the ruled-out outlets with why on request", async () => {
    await approveExample();
    await seedWedding("cy-di-2026", { location: "US-FL:florida-keys" });
    const open = await callTool("rank_publications_for_wedding", { wedding: "cy-di-2026" });
    expect(open.data["counts"]).toMatchObject({ excluded: 1 });
    const excluded = await callTool("rank_publications_for_wedding", { wedding: "cy-di-2026", show: "excluded" });
    expect(excluded.data["outlets"]).toEqual([
      {
        id: "pub-example-weddings",
        name: "Example Weddings",
        tier: "primary",
        excluded: ["Covers only Michigan and Midwest; this wedding was in Florida Keys, Florida."],
      },
    ]);
  });

  it("says what would sharpen the ranking, and what holds the wedding back", async () => {
    await seedWedding("ed-fi-2026", { location: null, rights: "unverified" });
    // Tags kept on another wedding are hers, but not this wedding's.
    await seedWedding("gil-hu-2026", { tags: ["romantic"] });
    const reply = await callTool("rank_publications_for_wedding", { wedding: "ed-fi-2026" });
    expect(reply.data["sharpen"]).toHaveLength(2);
    expect(reply.data["onHold"]).toHaveLength(1);
  });

  it("says so for an unknown wedding or cursor", async () => {
    await seedWedding("ada-bo-2026");
    expect((await callTool("rank_publications_for_wedding", { wedding: "nobody-2026" })).text).toContain("list_weddings");
    expect((await callTool("rank_publications_for_wedding", { wedding: "ada-bo-2026", cursor: "x" })).text).toContain("cursor is not valid");
    expect(await auditResults()).toEqual([
      ["rank_publications_for_wedding", "not_found"],
      ["rank_publications_for_wedding", "invalid_cursor"],
    ]);
  });
});
