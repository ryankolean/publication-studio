import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signAccessToken } from "../src/domain/tokens.js";
import { createTestD1 } from "./helpers/d1.js";
import type { TestD1 } from "./helpers/d1.js";
import { JWT_SECRET, connect, connectorEnv, mcp, seedUser, send } from "./helpers/connector.js";
import type { ConnectorEnv } from "./helpers/connector.js";

let db: TestD1;
let env: ConnectorEnv;
let accessToken: string;
let clientId: string;

const GALLERY = "https://studio.pic-time.com/-secret-invite-token/gallery";

async function createWedding(body: Record<string, unknown>): Promise<{ id: string; slug: string }> {
  const web = await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" });
  const response = await send(env, "/events", {
    method: "POST",
    headers: { authorization: `Bearer ${web}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; slug: string };
}

async function chipOf(id: string): Promise<string> {
  const web = await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" });
  const { events } = (await (await send(env, "/events", { headers: { authorization: `Bearer ${web}` } })).json()) as {
    events: Array<{ id: string; chip: { label: string } }>;
  };
  return events.find((event) => event.id === id)?.chip.label ?? "";
}

interface ToolReply {
  status: number;
  raw: string;
  isError: boolean;
  data: Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  const response = await mcp(env, accessToken, "tools/call", { name, arguments: args });
  const raw = await response.text();
  const body = JSON.parse(raw) as { result?: { isError?: boolean; content: Array<{ text: string }> } };
  const text = body.result?.content[0]?.text ?? "{}";
  return {
    status: response.status,
    raw,
    isError: body.result?.isError === true,
    data: body.result?.isError === true ? { message: text } : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function auditRows() {
  const { results } = await db
    .prepare("SELECT user_id, entity_id, action, detail_json FROM audit_log WHERE entity = 'mcp_tool' ORDER BY rowid")
    .all<{ user_id: string; entity_id: string; action: string; detail_json: string }>();
  return results.map((row) => ({ ...row, detail: JSON.parse(row.detail_json) as Record<string, unknown> }));
}

beforeEach(async () => {
  db = createTestD1();
  env = connectorEnv(db);
  await seedUser(db, "user-1", "partner@example.com", "a-long-studio-password");
  ({ accessToken, clientId } = await connect(env, "partner@example.com", "a-long-studio-password"));
});

afterEach(() => {
  db.close();
});

describe("tools/list", () => {
  it("offers the three read tools, each marked read-only", async () => {
    const response = await mcp(env, accessToken, "tools/list");
    const { result } = (await response.json()) as {
      result: { tools: Array<{ name: string; description: string; annotations: Record<string, unknown> }> };
    };
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(["get_wedding", "list_weddings", "studio_overview"]);
    for (const tool of result.tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
  });
});

describe("studio_overview", () => {
  it("reads the studio through the web app's own view of it", async () => {
    const wedding = await createWedding({ coupleNames: "Blake and Anne", eventDate: "2026-01-31", city: "Duck Key", state: "FL" });
    const reply = await callTool("studio_overview");
    expect(reply.isError).toBe(false);
    expect(reply.data["weddings"]).toMatchObject({ total: 1 });
    expect(reply.data["nextSteps"]).toEqual([{ wedding: wedding.slug, couple: "Blake and Anne", step: await chipOf(wedding.id) }]);
  });

  it("lists a reply that is due soon", async () => {
    const wedding = await createWedding({ coupleNames: "Blake and Anne", eventDate: "2026-01-31" });
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await db
      .prepare("INSERT INTO submissions (id, event_id, publication_id, status, response_due_at) VALUES ('s1', ?, 'pub-over-the-moon', 'sent', ?)")
      .bind(wedding.id, due)
      .run();
    const reply = await callTool("studio_overview");
    expect(reply.data["deadlines"]).toEqual([
      { wedding: wedding.slug, outlet: expect.any(String), due: due.slice(0, 10), daysLeft: 3 },
    ]);
    expect(reply.data["queue"]).toEqual({ waitingToSend: 0, withOutlets: 1, accepted: 0 });
  });
});

describe("list_weddings", () => {
  it("pages through the weddings with short ids", async () => {
    for (let n = 1; n <= 3; n++) await createWedding({ coupleNames: `Couple ${n}`, eventDate: `2026-0${n}-10` });
    const first = await callTool("list_weddings", { limit: 2 });
    expect(first.data["total"]).toBe(3);
    expect((first.data["weddings"] as Array<{ wedding: string }>).map((line) => line.wedding)).toEqual(["couple-3-2026", "couple-2-2026"]);
    const second = await callTool("list_weddings", { limit: 2, cursor: first.data["next"] });
    expect((second.data["weddings"] as Array<{ wedding: string }>).map((line) => line.wedding)).toEqual(["couple-1-2026"]);
  });

  it("says so when the cursor is not one it gave out", async () => {
    const reply = await callTool("list_weddings", { cursor: "99" });
    expect(reply.isError).toBe(true);
    expect(reply.data["message"]).toContain("cursor is not valid");
    expect((await auditRows()).at(-1)?.detail["result"]).toBe("invalid_cursor");
  });
});

describe("get_wedding", () => {
  it("summarises one wedding by its short id, and never shows the gallery link", async () => {
    const wedding = await createWedding({ coupleNames: "Blake and Anne", eventDate: "2026-01-31", galleryUrl: GALLERY, venueName: "Hawks Cay" });
    const reply = await callTool("get_wedding", { wedding: wedding.slug });
    expect(reply.data).toMatchObject({ wedding: wedding.slug, couple: "Blake and Anne", venue: "Hawks Cay", gallery: true, outlets: [] });
    expect(reply.data).not.toHaveProperty("credits");
    expect(reply.raw).not.toContain("pic-time");
    expect(reply.raw).not.toContain("secret-invite-token");
  });

  it("adds the story and credits on request, with business names and no contact details", async () => {
    const wedding = await createWedding({
      coupleNames: "Blake and Anne",
      eventDate: "2026-01-31",
      coupleStory: "They met sailing.",
      vendorCredits: [{ role: "Florist", businessName: "Petal and Stem", website: "https://petal.example", instagram: "@petalandstem" }],
    });
    const reply = await callTool("get_wedding", { wedding: wedding.slug, detail: true });
    expect(reply.data).toMatchObject({ story: "They met sailing.", credits: [{ role: "Florist", business: "Petal and Stem" }] });
    expect(reply.raw).not.toContain("petal.example");
    expect(reply.raw).not.toContain("@petalandstem");
  });

  it("says so when there is no such wedding", async () => {
    const reply = await callTool("get_wedding", { wedding: "nobody-2026" });
    expect(reply.isError).toBe(true);
    expect(reply.data["message"]).toContain("list_weddings");
    expect((await auditRows()).at(-1)?.detail["result"]).toBe("not_found");
  });
});

describe("the audit log", () => {
  it("has one row per tool call: who, which client, what was asked, the outcome and the time taken", async () => {
    await callTool("studio_overview");
    await callTool("get_wedding", { wedding: "no-such-2026", detail: true });
    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ user_id: "user-1", entity_id: "studio_overview", action: "call" });
    expect(rows[0]?.detail).toMatchObject({ client: clientId, args: {}, result: "ok" });
    expect(typeof rows[0]?.detail["ms"]).toBe("number");
    expect(rows[1]?.detail).toMatchObject({ args: { wedding: "no-such-2026", detail: true }, result: "not_found" });
  });

  it("keeps free text out of the log", async () => {
    await callTool("get_wedding", { wedding: "the Macon wedding, the one in Florida" });
    expect((await auditRows())[0]?.detail["args"]).toEqual({ wedding: "[text]" });
  });

  it("logs a tool that fails as an internal error and returns no data", async () => {
    await createWedding({ coupleNames: "Blake and Anne", eventDate: "2026-01-31" });
    await db.prepare("ALTER TABLE events RENAME TO events_away").run();
    const reply = await callTool("studio_overview");
    expect(reply.isError).toBe(true);
    expect(reply.data["message"]).toBe("Something went wrong in the studio. Try again.");
    expect(reply.raw).not.toContain("Blake and Anne");
    expect((await auditRows()).at(-1)?.detail).toMatchObject({ result: "internal" });
  });

  it("returns nothing if the call cannot be logged", async () => {
    await createWedding({ coupleNames: "Blake and Anne", eventDate: "2026-01-31" });
    await db.prepare("DROP TABLE audit_log").run();
    const response = await mcp(env, accessToken, "tools/call", { name: "studio_overview", arguments: {} });
    const raw = await response.text();
    expect(raw).not.toContain("Blake and Anne");
    expect(raw).not.toContain("blake-and-anne");
  });
});
