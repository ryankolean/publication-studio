import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { hashConfirmationCode } from "../src/domain/confirmation.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { createTestD1 } from "./helpers/d1.js";
import type { TestD1 } from "./helpers/d1.js";
import { JWT_SECRET, connect, connectorEnv, mcp, seedUser, send } from "./helpers/connector.js";
import type { ConnectorEnv } from "./helpers/connector.js";

const here = dirname(fileURLToPath(import.meta.url));

let db: TestD1;
let env: ConnectorEnv;
let accessToken: string;

interface ToolReply {
  isError: boolean;
  text: string;
  data: Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown> = {}, token = accessToken): Promise<ToolReply> {
  const response = await mcp(env, token, "tools/call", { name, arguments: args });
  const body = (await response.json()) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: { message: string } };
  const text = body.result?.content[0]?.text ?? body.error?.message ?? "";
  const isError = body.result?.isError === true || body.error !== undefined;
  return { isError, text, data: isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function eventRow(slug: string) {
  return db
    .prepare("SELECT id, rights_status, consent_status, consent_notes, gallery_url, venue_name, couple_story, location_code FROM events WHERE slug = ?")
    .bind(slug)
    .first<{ id: string; rights_status: string; consent_status: string; consent_notes: string | null; gallery_url: string | null; venue_name: string | null; couple_story: string | null; location_code: string | null }>();
}

async function webCreate(body: Record<string, unknown>): Promise<string> {
  const web = await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" });
  const response = await send(env, "/events", {
    method: "POST",
    headers: { authorization: `Bearer ${web}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return ((await response.json()) as { slug: string }).slug;
}

beforeEach(async () => {
  db = createTestD1();
  env = connectorEnv(db);
  await db
    .prepare("INSERT INTO research_vocab (kind, json, content_hash) VALUES ('geo', ?, 'test')")
    .bind(JSON.stringify(parse(readFileSync(join(here, "../../research/vocab/geo.yaml"), "utf8"))))
    .run();
  await seedUser(db, "user-1", "partner@example.com", "a-long-studio-password");
  ({ accessToken } = await connect(env, "partner@example.com", "a-long-studio-password"));
});

afterEach(() => {
  db.close();
});

describe("tools/list", () => {
  it("adds save_wedding and confirm_permissions, neither read-only nor destructive", async () => {
    const response = await mcp(env, accessToken, "tools/list");
    const { result } = (await response.json()) as { result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> } };
    const byName = new Map(result.tools.map((tool) => [tool.name, tool.annotations]));
    expect([...byName.keys()].sort()).toEqual(["confirm_permissions", "get_wedding", "list_weddings", "save_wedding", "studio_overview"]);
    for (const name of ["save_wedding", "confirm_permissions"]) {
      expect(byName.get(name)).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    }
  });
});

describe("save_wedding", () => {
  it("creates a wedding from names and a date, and says what is still needed", async () => {
    const reply = await callTool("save_wedding", { couple_names: "Casey and Jordan", date: "2026-06-14" });
    expect(reply.isError).toBe(false);
    expect(reply.data).toMatchObject({ wedding: "casey-and-jordan-2026", saved: "created", couple: "Casey and Jordan", date: "2026-06-14" });
    expect(reply.data["stillNeeded"]).toEqual(["Venue or city", "At least one vendor credit", "A story or unique angle"]);
    const listed = await callTool("list_weddings");
    expect((listed.data["weddings"] as Array<{ wedding: string }>).map((line) => line.wedding)).toContain("casey-and-jordan-2026");
  });

  it("needs names and a date to create one, naming the arguments to fix", async () => {
    const reply = await callTool("save_wedding", { venue: "Hawks Cay" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("couple_names");
    expect(reply.text).toContain("date");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>())?.n).toBe(0);
  });

  it("explains a bad value by the argument's own name", async () => {
    const reply = await callTool("save_wedding", { couple_names: "A and B", date: "2026-13-45" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/date:/);
  });

  it("changes only what is given and keeps the vendors unless new ones are given", async () => {
    await callTool("save_wedding", {
      couple_names: "Casey and Jordan",
      date: "2026-06-14",
      vendors: [{ role: "Florist", business: "Petal and Stem" }],
    });
    const updated = await callTool("save_wedding", { wedding: "casey-and-jordan-2026", venue: "Hawks Cay", story: "They met sailing." });
    expect(updated.data).toMatchObject({ saved: "updated" });
    const detail = await callTool("get_wedding", { wedding: "casey-and-jordan-2026", detail: true });
    expect(detail.data).toMatchObject({
      couple: "Casey and Jordan",
      venue: "Hawks Cay",
      story: "They met sailing.",
      credits: [{ role: "Florist", business: "Petal and Stem" }],
    });
  });

  it("resolves a place by name to its code", async () => {
    const reply = await callTool("save_wedding", { couple_names: "A and B", date: "2026-01-31", place: "the Florida Keys" });
    expect(reply.data).toMatchObject({ place: "Florida Keys, Florida" });
    expect((await eventRow("a-and-b-2026"))?.location_code).toBe("US-FL:florida-keys");
  });

  it("offers close places for an unclear one and saves nothing", async () => {
    const reply = await callTool("save_wedding", { couple_names: "A and B", date: "2026-01-31", place: "Duck Key, Florida" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("US-FL:florida-keys (Florida Keys, Florida)");
    expect(await eventRow("a-and-b-2026")).toBeNull();
  });

  it("never changes the permission answers or the gallery link", async () => {
    const slug = await webCreate({
      coupleNames: "Blake and Anne",
      eventDate: "2026-01-31",
      galleryUrl: "https://studio.pic-time.com/-invite-token/gallery",
      rightsStatus: "own_contract",
      consentStatus: "granted",
    });
    await callTool("save_wedding", { wedding: slug, venue: "Hawks Cay" });
    expect(await eventRow(slug)).toMatchObject({
      rights_status: "own_contract",
      consent_status: "granted",
      gallery_url: "https://studio.pic-time.com/-invite-token/gallery",
      venue_name: "Hawks Cay",
    });
  });

  it("says so for a wedding that does not exist", async () => {
    const reply = await callTool("save_wedding", { wedding: "nobody-2026", venue: "Anywhere" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("list_weddings");
  });

  it("writes the web app's own update row and an mcp_tool row with free text hidden", async () => {
    await callTool("save_wedding", { couple_names: "Casey and Jordan", date: "2026-06-14", story: "A long story about the day" });
    const rows = await db.prepare("SELECT entity, action, detail_json FROM audit_log WHERE entity IN ('event', 'mcp_tool') ORDER BY rowid").all<{ entity: string; action: string; detail_json: string }>();
    expect(rows.results.map((row) => `${row.entity}:${row.action}`)).toEqual(["event:create", "mcp_tool:call"]);
    expect(JSON.parse(rows.results[1]?.detail_json ?? "{}")).toMatchObject({ args: { couple_names: "[text]", date: "2026-06-14", story: "[text]" }, result: "ok" });
  });
});

describe("confirm_permissions", () => {
  let slug: string;

  beforeEach(async () => {
    slug = await webCreate({ coupleNames: "Blake and Anne", eventDate: "2026-01-31" });
  });

  const answers = { lead_photographer: true, couple_agreed: "yes_with_limits", limits: "First names only" };

  async function preview(extra: Record<string, unknown> = {}) {
    return callTool("confirm_permissions", { wedding: slug, ...answers, ...extra });
  }

  it("first shows exactly what it will record, with a code, and records nothing", async () => {
    const reply = await preview();
    expect(reply.isError).toBe(false);
    expect(reply.data["willRecord"]).toEqual([
      "For Blake and Anne:",
      "You were the lead photographer, under your own contract.",
      "The couple agreed to a submission, with these limits: First names only",
    ]);
    expect(reply.data["confirm"]).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(reply.data["expiresInMinutes"]).toBe(15);
    expect(await eventRow(slug)).toMatchObject({ rights_status: "unverified", consent_status: "unverified" });
  });

  it("records the previewed answers once the code comes back, and the wedding is no longer held by them", async () => {
    const code = (await preview()).data["confirm"] as string;
    const done = await callTool("confirm_permissions", { wedding: slug, ...answers, confirmation: code });
    expect(done.isError).toBe(false);
    expect(done.data).toMatchObject({ wedding: slug, recorded: expect.arrayContaining(["You were the lead photographer, under your own contract."]) });
    expect(done.data).not.toHaveProperty("onHold");
    expect(await eventRow(slug)).toMatchObject({ rights_status: "own_contract", consent_status: "granted_limited", consent_notes: "First names only" });
  });

  it("records what was previewed, not different answers sent with the code", async () => {
    const code = (await preview()).data["confirm"] as string;
    await callTool("confirm_permissions", { wedding: slug, lead_photographer: false, couple_agreed: "no", confirmation: code });
    expect(await eventRow(slug)).toMatchObject({ rights_status: "own_contract", consent_status: "granted_limited" });
  });

  it("accepts a code read back with dashes and lower case", async () => {
    const code = (await preview()).data["confirm"] as string;
    const done = await callTool("confirm_permissions", { wedding: slug, ...answers, confirmation: `${code.slice(0, 5).toLowerCase()}-${code.slice(5)}` });
    expect(done.isError).toBe(false);
  });

  it("works once", async () => {
    const code = (await preview()).data["confirm"] as string;
    await callTool("confirm_permissions", { wedding: slug, ...answers, confirmation: code });
    const again = await callTool("confirm_permissions", { wedding: slug, ...answers, confirmation: code });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("not valid");
  });

  it("expires after fifteen minutes", async () => {
    const code = (await preview()).data["confirm"] as string;
    await db.prepare("UPDATE confirmations SET expires_at = '2020-01-01T00:00:00Z'").run();
    const late = await callTool("confirm_permissions", { wedding: slug, ...answers, confirmation: code });
    expect(late.isError).toBe(true);
    expect(await eventRow(slug)).toMatchObject({ rights_status: "unverified" });
  });

  it("only works for the wedding it was shown for", async () => {
    const other = await webCreate({ coupleNames: "Casey and Jordan", eventDate: "2026-06-14" });
    const code = (await preview()).data["confirm"] as string;
    const wrong = await callTool("confirm_permissions", { wedding: other, ...answers, confirmation: code });
    expect(wrong.isError).toBe(true);
    expect(await eventRow(other)).toMatchObject({ rights_status: "unverified" });
    expect(await eventRow(slug)).toMatchObject({ rights_status: "unverified" });
  });

  it("only works for the person it was shown to", async () => {
    await seedUser(db, "user-2", "operator@example.com", "another-long-password", "admin");
    const other = await connect(env, "operator@example.com", "another-long-password");
    const code = (await preview()).data["confirm"] as string;
    const stolen = await callTool("confirm_permissions", { wedding: slug, ...answers, confirmation: code }, other.accessToken);
    expect(stolen.isError).toBe(true);
    expect(await eventRow(slug)).toMatchObject({ rights_status: "unverified" });
  });

  it("only works for the action it was issued for", async () => {
    const row = await eventRow(slug);
    await db
      .prepare("INSERT INTO confirmations (id, user_id, action, target_id, payload_json, preview_json, expires_at) VALUES (?, 'user-1', 'submit_package', ?, ?, '[]', '2999-01-01T00:00:00Z')")
      .bind(await hashConfirmationCode("ABCDEFGHJK"), row?.id, JSON.stringify({ rightsStatus: "own_contract", consentStatus: "granted", consentNotes: null }))
      .run();
    const other = await callTool("confirm_permissions", { wedding: slug, confirmation: "ABCDEFGHJK" });
    expect(other.isError).toBe(true);
    expect(await eventRow(slug)).toMatchObject({ rights_status: "unverified" });
  });

  it("asks for the limits instead of issuing a code when they are missing", async () => {
    const reply = await preview({ limits: undefined });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("limits");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM confirmations").first<{ n: number }>())?.n).toBe(0);
  });

  it("logs the preview and the confirmation as separate tool calls", async () => {
    const code = (await preview()).data["confirm"] as string;
    await callTool("confirm_permissions", { wedding: slug, ...answers, confirmation: code });
    const rows = await db.prepare("SELECT detail_json FROM audit_log WHERE entity = 'mcp_tool' ORDER BY rowid").all<{ detail_json: string }>();
    expect(rows.results.map((row) => (JSON.parse(row.detail_json) as { result: string }).result)).toEqual(["awaiting_yes", "ok"]);
  });
});
