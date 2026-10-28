import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLinkToken, hashLinkToken } from "../src/domain/upload-link.js";
import { createTestD1 } from "./helpers/d1.js";
import type { TestD1 } from "./helpers/d1.js";
import { ORIGIN, connect, connectorEnv, mcp, seedUser, send } from "./helpers/connector.js";
import type { ConnectorEnv } from "./helpers/connector.js";

let db: TestD1;
let env: ConnectorEnv;
let accessToken: string;

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface ToolReply {
  isError: boolean;
  text: string;
  data: Record<string, unknown>;
  content: Block[];
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  const response = await mcp(env, accessToken, "tools/call", { name, arguments: args });
  const body = (await response.json()) as { result?: { isError?: boolean; content: Block[] }; error?: { message: string } };
  const content = body.result?.content ?? [];
  const first = content[0];
  const text = first?.type === "text" ? first.text : (body.error?.message ?? "");
  const isError = body.result?.isError === true || body.error !== undefined;
  return { isError, text, content, data: isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function seedWedding(id: string, rights = "own_contract", consent = "granted") {
  await db
    .prepare(
      `INSERT INTO events (id, slug, couple_names, event_date, rights_status, consent_status)
       VALUES (?, ?, 'Casey & Jordan', '2026-06-14', ?, ?)`,
    )
    .bind(id, `${id}-2026`, rights, consent)
    .run();
}

/** A photo in the pool, with a preview stored unless told otherwise. */
async function seedPhoto(eventId: string, index: number, options: { name?: string | null; preview?: boolean } = {}) {
  const id = `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const key = `events/${eventId}/${id}.jpg`;
  const previewKey = options.preview === false ? null : `previews/${eventId}/${id}.jpg`;
  await db
    .prepare(
      `INSERT INTO event_images (key, event_id, content_type, bytes, original_name, preview_key, created_at)
       VALUES (?, ?, 'image/jpeg', 10, ?, ?, ?)`,
    )
    .bind(key, eventId, options.name === undefined ? `IMG_${index}.jpg` : options.name, previewKey, `2026-10-27T10:00:${String(index).padStart(2, "0")}Z`)
    .run();
  if (previewKey !== null) await env.IMAGES.put(previewKey, new Uint8Array([0xff, 0xd8, index]).buffer, { httpMetadata: { contentType: "image/jpeg" } });
}

const tokenOf = (link: string) => link.slice(link.indexOf("#") + 1);

beforeEach(async () => {
  db = createTestD1();
  env = connectorEnv(db);
  await seedUser(db, "user-1", "partner@example.com", "a-long-studio-password");
  ({ accessToken } = await connect(env, "partner@example.com", "a-long-studio-password"));
  await seedWedding("w1");
});

afterEach(() => {
  db.close();
});

describe("tools/list", () => {
  it("adds get_upload_link as a write and review_photos as a read", async () => {
    const response = await mcp(env, accessToken, "tools/list");
    const { result } = (await response.json()) as { result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> } };
    const byName = new Map(result.tools.map((tool) => [tool.name, tool.annotations]));
    expect([...byName.keys()].sort()).toEqual([
      "build_package_draft",
      "confirm_permissions",
      "get_upload_link",
      "get_wedding",
      "list_weddings",
      "publications",
      "rank_publications_for_wedding",
      "review_photos",
      "save_wedding",
      "set_queue",
      "set_tags",
      "studio_overview",
    ]);
    expect(byName.get("get_upload_link")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get("review_photos")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});

describe("get_upload_link", () => {
  it("returns a link to the page whose token opens it for that wedding", async () => {
    const reply = await callTool("get_upload_link", { wedding: "w1-2026" });
    expect(reply.isError).toBe(false);
    expect(reply.data).toMatchObject({ wedding: "w1-2026", couple: "Casey & Jordan", expiresInHours: 24, takesUpTo: 200, photosSoFar: 0 });
    const link = String(reply.data["link"]);
    expect(link).toMatch(new RegExp(`^${ORIGIN}/upload#[A-Za-z0-9_-]{43}$`));

    const opened = await send(env, "/upload/link", { headers: { authorization: `Bearer ${tokenOf(link)}` } });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ couple: "Casey & Jordan", photos: 0 });

    const row = await db.prepare("SELECT id, user_id, event_id, expires_at FROM upload_links").first<{ id: string; user_id: string; event_id: string; expires_at: string }>();
    expect(row).toMatchObject({ id: await hashLinkToken(tokenOf(link)), user_id: "user-1", event_id: "w1" });
    const hours = (Date.parse(row?.expires_at ?? "") - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it("closes the earlier link for the same wedding, and only that one", async () => {
    await seedWedding("w2");
    const other = await callTool("get_upload_link", { wedding: "w2-2026" });
    const first = await callTool("get_upload_link", { wedding: "w1-2026" });
    const second = await callTool("get_upload_link", { wedding: "w1-2026" });
    const status = async (reply: ToolReply) =>
      (await send(env, "/upload/link", { headers: { authorization: `Bearer ${tokenOf(String(reply.data["link"]))}` } })).status;
    expect(await status(first)).toBe(401);
    expect(await status(second)).toBe(200);
    expect(await status(other)).toBe(200);
  });

  it("makes no link until the permission answers say yes", async () => {
    await seedWedding("w3", "unverified", "unverified");
    const reply = await callTool("get_upload_link", { wedding: "w3-2026" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/^Photos can be added once her permission answers say yes\. .+ Record them with confirm_permissions first\. No link was made\.$/);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM upload_links").first()).toEqual({ n: 0 });
  });

  it("says when the wedding does not exist", async () => {
    const reply = await callTool("get_upload_link", { wedding: "nobody-2026" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("list_weddings");
  });

  it("counts the photos already in, and keeps the token out of the audit row", async () => {
    await seedPhoto("w1", 1);
    const reply = await callTool("get_upload_link", { wedding: "w1-2026" });
    expect(reply.data["photosSoFar"]).toBe(1);
    const audit = await db
      .prepare("SELECT detail_json FROM audit_log WHERE entity = 'mcp_tool' AND entity_id = 'get_upload_link'")
      .first<{ detail_json: string }>();
    expect(JSON.parse(audit?.detail_json ?? "{}")).toMatchObject({ result: "ok", args: { wedding: "w1-2026" } });
    expect(audit?.detail_json).not.toContain(tokenOf(String(reply.data["link"])));
  });
});

describe("review_photos", () => {
  it("shows each preview after a caption naming it, in the order they were added", async () => {
    await seedPhoto("w1", 2);
    await seedPhoto("w1", 1, { name: null });
    const reply = await callTool("review_photos", { wedding: "w1-2026" });
    expect(reply.isError).toBe(false);
    expect(reply.data).toEqual({ wedding: "w1-2026", photos: 2, page: 1, pages: 1, next: "That is all of them." });
    expect(reply.content.slice(1)).toEqual([
      { type: "text", text: "Photo 1: Photo 1, ref 00000001" },
      { type: "image", data: Buffer.from([0xff, 0xd8, 1]).toString("base64"), mimeType: "image/jpeg" },
      { type: "text", text: "Photo 2: IMG_2.jpg, ref 00000002" },
      { type: "image", data: Buffer.from([0xff, 0xd8, 2]).toString("base64"), mimeType: "image/jpeg" },
    ]);
  });

  it("pages through twelve at a time", async () => {
    for (let index = 1; index <= 14; index++) await seedPhoto("w1", index);
    const first = await callTool("review_photos", { wedding: "w1-2026" });
    expect(first.data).toMatchObject({ photos: 14, page: 1, pages: 2, next: "Call review_photos with page 2 for the next twelve." });
    expect(first.content.filter((block) => block.type === "image")).toHaveLength(12);
    const second = await callTool("review_photos", { wedding: "w1-2026", page: 2 });
    expect(second.content.filter((block) => block.type === "text").slice(1).map((block) => (block as { text: string }).text)).toEqual([
      "Photo 13: IMG_13.jpg, ref 00000013",
      "Photo 14: IMG_14.jpg, ref 00000014",
    ]);
    const past = await callTool("review_photos", { wedding: "w1-2026", page: 3 });
    expect(past.isError).toBe(true);
    expect(past.text).toBe("There are 2 pages of photos. Ask for a page from 1 to 2.");
  });

  it("lists the photos it cannot show, including a preview missing from storage", async () => {
    await seedPhoto("w1", 1, { preview: false });
    await seedPhoto("w1", 2);
    await seedPhoto("w1", 3);
    await env.IMAGES.delete("previews/w1/00000003-0000-4000-8000-000000000000.jpg");
    const reply = await callTool("review_photos", { wedding: "w1-2026" });
    expect(reply.data["withoutPreview"]).toEqual([
      { n: 1, name: "IMG_1.jpg", ref: "00000001" },
      { n: 3, name: "IMG_3.jpg", ref: "00000003" },
    ]);
    expect(reply.content.filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("points to get_upload_link when there is nothing yet", async () => {
    const reply = await callTool("review_photos", { wedding: "w1-2026" });
    expect(reply.data).toEqual({ wedding: "w1-2026", photos: 0, next: "No photos yet. Use get_upload_link to give her a page to add them." });
  });

  it("says when the wedding does not exist", async () => {
    expect((await callTool("review_photos", { wedding: "nobody-2026" })).isError).toBe(true);
  });

  it("shows only the wedding asked for", async () => {
    await seedWedding("w2");
    await seedPhoto("w2", 1);
    expect((await callTool("review_photos", { wedding: "w1-2026" })).data["photos"]).toBe(0);
  });
});

describe("the whole intake, as Claude and her browser do it", () => {
  it("gets a link, adds a photo and its preview, and shows it back", async () => {
    const link = String((await callTool("get_upload_link", { wedding: "w1-2026" })).data["link"]);
    const auth = { authorization: `Bearer ${tokenOf(link)}` };
    const stored = await send(env, "/upload/photos", {
      method: "POST",
      headers: { ...auth, "content-type": "image/png", "x-file-name": "First%20look.png" },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    const { photo, ref } = (await stored.json()) as { photo: string; ref: string };
    const preview = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02]);
    await send(env, `/upload/photos/${photo}/preview`, { method: "PUT", headers: { ...auth, "content-type": "image/jpeg" }, body: preview });
    await send(env, "/upload/done", { method: "POST", headers: auth });

    const reply = await callTool("review_photos", { wedding: "w1-2026" });
    expect(reply.content.slice(1)).toEqual([
      { type: "text", text: `Photo 1: First look.png, ref ${ref}` },
      { type: "image", data: Buffer.from(preview).toString("base64"), mimeType: "image/jpeg" },
    ]);
  });

  it("never lets a link token stand in for Claude's own", async () => {
    const { token, id } = await createLinkToken();
    await db.prepare("INSERT INTO upload_links (id, user_id, event_id, expires_at) VALUES (?, 'user-1', 'w1', '2099-01-01T00:00:00Z')").bind(id).run();
    const response = await mcp(env, token, "tools/list");
    expect(response.status).toBe(401);
  });
});
