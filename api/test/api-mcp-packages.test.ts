import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signAccessToken } from "../src/domain/tokens.js";
import { createTestD1 } from "./helpers/d1.js";
import type { TestD1 } from "./helpers/d1.js";
import { JWT_SECRET, connect, connectorEnv, mcp, seedUser, send } from "./helpers/connector.js";
import type { ConnectorEnv } from "./helpers/connector.js";

let db: TestD1;
let env: ConnectorEnv;
let accessToken: string;
let web: Record<string, string>;

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

const KEYS = [1, 2, 3].map((n) => `events/w1/${String(n).repeat(8)}-0000-4000-8000-00000000000${n}.jpg`);

async function seedOutlet(id: string, name: string, spec: Record<string, unknown>) {
  await db
    .prepare(
      `INSERT INTO publications (id, name, tier, spec_json, exclusivity_policy, earned_or_paid, last_verified)
       VALUES (?, ?, 'secondary', ?, 'unknown', 'mixed', '2026-10-27')`,
    )
    .bind(id, name, JSON.stringify(spec))
    .run();
}

const packageRow = () =>
  db.prepare("SELECT image_keys, description_md, checklist_json FROM packages WHERE event_id = 'w1' AND publication_id = 'pub-simple'").first<{
    image_keys: string;
    description_md: string | null;
    checklist_json: string;
  }>();

beforeEach(async () => {
  db = createTestD1();
  env = connectorEnv(db);
  await seedUser(db, "user-1", "partner@example.com", "a-long-studio-password");
  ({ accessToken } = await connect(env, "partner@example.com", "a-long-studio-password"));
  web = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" })}` };
  db.exec(`INSERT INTO events (id, slug, couple_names, event_date, rights_status, consent_status, couple_story)
      VALUES ('w1', 'w1-2026', 'Casey & Jordan', '2026-06-14', 'own_contract', 'granted', 'They met sailing.');
    INSERT INTO events (id, slug, couple_names, event_date) VALUES ('w2', 'w2-2026', 'Ed & Fi', '2026-06-14');
    INSERT INTO vendor_credits (event_id, role, business_name, sort_order) VALUES ('w1', 'Florist', 'Petal and Stem', 0);`);
  for (const [index, key] of KEYS.entries()) {
    await db
      .prepare("INSERT INTO event_images (key, event_id, content_type, bytes, created_at) VALUES (?, 'w1', 'image/jpeg', 10, ?)")
      .bind(key, `2026-10-27T10:00:0${index}Z`)
      .run();
  }
  await seedOutlet("pub-simple", "Simple Weddings", { img_min: 1, img_max: 5, size: "web", requirements: ["full_vendor_credits"] });
  await seedOutlet("pub-second", "Second Weddings", { requirements: [] });
});

afterEach(() => db.close());

describe("tools/list", () => {
  it("adds build_package_draft and set_queue as writes", async () => {
    const { result } = (await (await mcp(env, accessToken, "tools/list")).json()) as {
      result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> };
    };
    const byName = new Map(result.tools.map((tool) => [tool.name, tool.annotations]));
    expect(result.tools).toHaveLength(12);
    expect(byName.get("build_package_draft")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get("set_queue")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe("build_package_draft", () => {
  it("creates the package with a started write-up and credits, and says what is left", async () => {
    const reply = await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple" });
    expect(reply.data).toMatchObject({
      wedding: "w1-2026",
      created: true,
      outlet: "Simple Weddings",
      photos: { chosen: 0, wanted: "1 to 5" },
      credits: "set",
      complete: false,
    });
    expect(reply.data["writeUp"]).toMatch(/^\d+ characters$/);
    const toDo = reply.data["toDo"] as Array<{ id: string; sheConfirms?: boolean }>;
    expect(toDo.map((entry) => entry.id)).toEqual(["images_present", "image_count", "web_size"]);
    expect(toDo.find((entry) => entry.id === "web_size")?.sheConfirms).toBe(true);
    expect(toDo.find((entry) => entry.id === "images_present")).not.toHaveProperty("sheConfirms");

    const again = await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple" });
    expect(again.data).not.toHaveProperty("created");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM packages").first<{ n: number }>())?.n).toBe(1);
  });

  it("takes photos by number or ref in her order, and records her confirmations only with the code from her yes", async () => {
    const asked = await callTool("build_package_draft", {
      wedding: "w1-2026",
      publication: "pub-simple",
      photos: ["3", "11111111"],
      confirm: ["confirm every image is a web-size derivative"],
      write_up: "A sunny June day on the water.",
    });
    expect(asked.data).toMatchObject({ photos: { chosen: 2 }, writeUp: "30 characters", complete: false, expiresInMinutes: 15 });
    expect(asked.data["willRecord"]).toEqual(["For Casey & Jordan's package for Simple Weddings, she confirms:", "- Confirm every image is a web-size derivative"]);
    expect(asked.data["toDo"]).toEqual([expect.objectContaining({ id: "web_size", sheConfirms: true })]);
    const row = await packageRow();
    expect(JSON.parse(row?.image_keys ?? "[]")).toEqual([KEYS[2], KEYS[0]]);
    expect(row?.description_md).toBe("A sunny June day on the water.");
    expect(JSON.parse(row?.checklist_json ?? "{}")).toEqual({});

    const yes = await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple", confirmation: asked.data["confirm"] });
    expect(yes.data).toMatchObject({ complete: true, toDo: [], recorded: ["- Confirm every image is a web-size derivative"] });
    expect(yes.data["next"]).toContain("set_queue");
    expect(JSON.parse((await packageRow())?.checklist_json ?? "{}")).toEqual({ web_size: true });

    const reused = await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple", confirmation: asked.data["confirm"] });
    expect(reused.text).toMatch(/^That code is not valid/);
    const both = await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple", confirm: ["web_size"], confirmation: "ABCD-EFGH" });
    expect(both.text).toBe("Pass confirm to get the lines and a code, or confirmation with the code after her yes, not both. Nothing was changed.");

    const text = await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple", show_text: true });
    expect(text.data["writeUpText"]).toBe("A sunny June day on the water.");
    expect(text.data["creditsText"]).toContain("Petal and Stem");
  });

  it("refuses a photo or a confirmation it cannot place, and changes nothing in the package", async () => {
    const photo = await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple", photos: ["1", "9"] });
    expect(photo.text).toBe("No photo matches: 9. Use the numbers or refs review_photos shows. The package exists, but nothing in it was changed.");
    const item = await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple", confirm: ["images_present"] });
    expect(item.text).toContain("Not something she confirms on this outlet's checklist: images_present.");
    expect(await packageRow()).toEqual({ image_keys: "[]", description_md: expect.any(String), checklist_json: "{}" });
  });

  it("refuses a wedding whose permissions hold it back, an unknown outlet and an unknown wedding", async () => {
    const blocked = await callTool("build_package_draft", { wedding: "w2-2026", publication: "pub-simple" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/^This wedding cannot go to an outlet yet\./);
    expect((await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-nobody" })).text).toBe("No such publication.");
    expect((await callTool("build_package_draft", { wedding: "nobody-2026", publication: "pub-simple" })).text).toContain("list_weddings");
  });
});

describe("set_queue", () => {
  it("sets her order and readies the outlet up next once its package is complete", async () => {
    const asked = await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple", photos: ["1"], confirm: ["web_size"] });
    await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple", confirmation: asked.data["confirm"] });
    const reply = await callTool("set_queue", { wedding: "w1-2026", outlets: ["pub-simple", "pub-second"] });
    expect(reply.data).toEqual({
      wedding: "w1-2026",
      order: [
        { position: 1, outlet: "pub-simple", name: "Simple Weddings", state: "ready to send" },
        { position: 2, outlet: "pub-second", name: "Second Weddings", state: "no package yet" },
      ],
      upNext: "Simple Weddings",
      readied: "Simple Weddings",
      next: "Ready to send to Simple Weddings. She sends it herself through the outlet's own route, then marks it sent in the studio.",
    });
    expect(await db.prepare("SELECT publication_id, status FROM submissions").all().then((r) => r.results)).toEqual([
      { publication_id: "pub-simple", status: "ready" },
    ]);
  });

  it("leaves an incomplete package as it is and says what to do, and replaces an earlier order", async () => {
    await callTool("set_queue", { wedding: "w1-2026", outlets: ["pub-second", "pub-simple"] });
    await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple" });
    const reply = await callTool("set_queue", { wedding: "w1-2026", outlets: ["pub-simple"] });
    expect(reply.data).toMatchObject({
      order: [{ position: 1, outlet: "pub-simple", state: "package started, not complete" }],
      upNext: "Simple Weddings",
      next: "Finish the package for Simple Weddings with build_package_draft; it lists what is left.",
    });
    expect(reply.data).not.toHaveProperty("readied");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM submissions").first<{ n: number }>())?.n).toBe(0);
  });

  it("refuses an unknown outlet, a held-back wedding and an unknown wedding", async () => {
    expect((await callTool("set_queue", { wedding: "w1-2026", outlets: ["pub-simple", "pub-nobody"] })).text).toBe(
      "Some fields need attention. No such outlet: pub-nobody.",
    );
    expect((await callTool("set_queue", { wedding: "w2-2026", outlets: ["pub-simple"] })).text).toMatch(/^This wedding cannot go to an outlet yet\./);
    expect((await callTool("set_queue", { wedding: "nobody-2026", outlets: ["pub-simple"] })).text).toContain("list_weddings");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM event_queue").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("the queue routes", () => {
  const put = (id: string, body: unknown) =>
    send(env, `/events/${id}/queue`, { method: "PUT", headers: { ...web, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("stores the order with one audit row, and reads it back", async () => {
    expect((await put("w1", { publicationIds: ["pub-second", "pub-simple"] })).status).toBe(200);
    const read = (await (await send(env, "/events/w1/queue", { headers: web })).json()) as { entries: Array<{ publicationId: string }> };
    expect(read.entries.map((entry) => entry.publicationId)).toEqual(["pub-second", "pub-simple"]);
    expect(await db.prepare("SELECT action, detail_json FROM audit_log WHERE action = 'queue_set'").all().then((r) => r.results)).toEqual([
      { action: "queue_set", detail_json: JSON.stringify({ publicationIds: ["pub-second", "pub-simple"] }) },
    ]);
  });

  it("refuses a bad body, an inactive outlet and a missing wedding, and needs a signed-in user", async () => {
    expect((await put("w1", {})).status).toBe(400);
    expect((await put("w1", "not json")).status).toBe(400);
    await db.prepare("UPDATE publications SET active = 0 WHERE id = 'pub-second'").run();
    const inactive = await put("w1", { publicationIds: ["pub-second"] });
    expect(((await inactive.json()) as { details: unknown }).details).toEqual([{ field: "publicationIds.0", message: "No longer active: pub-second." }]);
    expect((await put("nope", { publicationIds: ["pub-simple"] })).status).toBe(404);
    expect((await send(env, "/events/nope/queue", { headers: web })).status).toBe(404);
    expect((await send(env, "/events/w1/queue")).status).toBe(401);
  });
});
