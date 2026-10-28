import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestD1 } from "./helpers/d1.js";
import type { TestD1 } from "./helpers/d1.js";
import { connect, connectorEnv, mcp, seedUser } from "./helpers/connector.js";
import type { ConnectorEnv } from "./helpers/connector.js";

let db: TestD1;
let env: ConnectorEnv;
let accessToken: string;

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

const statuses = (reply: ToolReply) => (reply.data["steps"] as Array<{ status: string }>).map((step) => step.status);

beforeEach(async () => {
  db = createTestD1();
  env = connectorEnv(db);
  await seedUser(db, "user-1", "partner@example.com", "a-long-studio-password");
  ({ accessToken } = await connect(env, "partner@example.com", "a-long-studio-password"));
  db.exec(`INSERT INTO events (id, slug, couple_names, event_date, venue_name, location_code, rights_status, consent_status, couple_story)
      VALUES ('w1', 'w1-2026', 'Casey & Jordan', '2026-06-14', 'Hawks Cay', 'US-FL', 'own_contract', 'granted', 'They met sailing.');
    INSERT INTO events (id, slug, couple_names, event_date) VALUES ('w2', 'w2-2026', 'Ed & Fi', '2026-06-14');
    INSERT INTO vendor_credits (event_id, role, business_name, sort_order) VALUES ('w1', 'Florist', 'Petal and Stem', 0);
    INSERT INTO event_images (key, event_id, content_type, bytes) VALUES ('events/w1/11111111-0000-4000-8000-000000000001.jpg', 'w1', 'image/jpeg', 10);
    INSERT INTO event_tags (event_id, tag_id, state, source) VALUES ('w1', 'romantic', 'confirmed', 'photographer');
    INSERT INTO publications (id, name, tier, spec_json, exclusivity_policy, earned_or_paid, last_verified)
      VALUES ('pub-simple', 'Simple Weddings', 'secondary', '{"size":"web","requirements":[]}', 'unknown', 'mixed', '2026-10-27');`);
});

afterEach(() => db.close());

describe("tools/list", () => {
  it("adds plan as a write and run_plan_step as a read", async () => {
    const { result } = (await (await mcp(env, accessToken, "tools/list")).json()) as {
      result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> };
    };
    const byName = new Map(result.tools.map((tool) => [tool.name, tool.annotations]));
    expect(result.tools).toHaveLength(14);
    expect(byName.get("plan")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get("run_plan_step")).toMatchObject({ readOnlyHint: true });
  });
});

describe("plan", () => {
  it("gives a new wedding's plan before the wedding exists, without keeping it", async () => {
    const reply = await callTool("plan", { template: "new_wedding", goal: "Add the Macon wedding" });
    expect(reply.data).toMatchObject({ plan: null, title: "Bring in a new wedding", goal: "Add the Macon wedding", progress: "0 of 5 done", next: "Step 1: Record the wedding: the couple, the date, the venue and where it was." });
    expect(statuses(reply)).toEqual(["next", "to do", "to do", "to do", "to do"]);
    expect(reply.data["note"]).toContain("call plan again");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM plans").first<{ n: number }>())?.n).toBe(0);
    expect((await callTool("plan", { template: "pick_outlets" })).text).toBe("Name the wedding: every plan but new_wedding is for one wedding.");
  });

  it("keeps a wedding's plan under a short id, with each step read from its data", async () => {
    const reply = await callTool("plan", { template: "new_wedding", wedding: "w2-2026" });
    expect(reply.data).toMatchObject({ plan: "w2-2026/new_wedding", wedding: "w2-2026", progress: "0 of 5 done" });
    expect(statuses(reply)).toEqual(["next", "to do", "to do", "to do", "to do"]);

    const done = await callTool("plan", { template: "new_wedding", wedding: "w1-2026" });
    expect(done.data).toMatchObject({ progress: "5 of 5 done", next: "This plan is finished. The usual next plan is pick_outlets: Choose the outlets." });
    expect(await db.prepare("SELECT id, event_id, template FROM plans ORDER BY id").all().then((r) => r.results)).toEqual([
      { id: "w1-2026/new_wedding", event_id: "w1", template: "new_wedding" },
      { id: "w2-2026/new_wedding", event_id: "w2", template: "new_wedding" },
    ]);
  });

  it("skips and brings back steps, and a fresh start clears them", async () => {
    await callTool("plan", { template: "new_wedding", wedding: "w2-2026" });
    const skipped = await callTool("plan", { plan: "w2-2026/new_wedding", skip: [1, 2] });
    expect(statuses(skipped)).toEqual(["skipped", "skipped", "next", "to do", "to do"]);
    const back = await callTool("plan", { plan: "w2-2026/new_wedding", unskip: [1] });
    expect(statuses(back)).toEqual(["next", "skipped", "to do", "to do", "to do"]);
    expect((await callTool("plan", { plan: "w2-2026/new_wedding", skip: [9] })).text).toBe("This plan has steps 1 to 5; there is no step 9.");
    const fresh = await callTool("plan", { template: "new_wedding", wedding: "w2-2026" });
    expect(statuses(fresh)).toEqual(["next", "to do", "to do", "to do", "to do"]);
    expect(statuses(await callTool("plan", { plan: "w2-2026/new_wedding" }))).toEqual(["next", "to do", "to do", "to do", "to do"]);
  });

  it("lists a wedding's plans so a new chat can pick one up", async () => {
    await callTool("plan", { template: "new_wedding", wedding: "w1-2026" });
    await callTool("plan", { template: "pick_outlets", wedding: "w1-2026", goal: "Where should this go?" });
    const listed = await callTool("plan", { wedding: "w1-2026" });
    expect((listed.data["plans"] as Array<{ plan: string }>).map((entry) => entry.plan).sort()).toEqual(["w1-2026/new_wedding", "w1-2026/pick_outlets"]);
    expect(listed.data["next"]).toContain("run_plan_step");
    expect((await callTool("plan", { wedding: "w2-2026" })).data["next"]).toContain("No plans yet");
    expect((await callTool("plan", { plan: "w1-2026/pick_outlets" })).data).toMatchObject({ goal: "Where should this go?" });
  });

  it("builds the package for the outlet up next in her order, or the one it names", async () => {
    await callTool("set_queue", { wedding: "w1-2026", outlets: ["pub-simple"] });
    const reply = await callTool("plan", { template: "build_package", wedding: "w1-2026" });
    expect(reply.data).toMatchObject({ plan: "w1-2026/build_package", outlet: "Simple Weddings", next: "Step 1: Start the package for Simple Weddings." });
    await callTool("build_package_draft", { wedding: "w1-2026", publication: "pub-simple" });
    const started = await callTool("plan", { plan: "w1-2026/build_package" });
    // Started from the story, with the web-size check still hers to confirm.
    expect(statuses(started)).toEqual(["done", "next", "done", "to do", "to do"]);
    const named = await callTool("plan", { template: "build_package", wedding: "w1-2026", outlet: "pub-simple" });
    expect(named.data).toMatchObject({ outlet: "Simple Weddings" });
  });

  it("says so for an unknown wedding, outlet or plan, and for no arguments", async () => {
    expect((await callTool("plan", { template: "pick_outlets", wedding: "nobody-2026" })).text).toContain("list_weddings");
    expect((await callTool("plan", { template: "build_package", wedding: "w1-2026", outlet: "pub-nobody" })).text).toBe("There is no outlet with that id. Use publications to find it.");
    expect((await callTool("plan", { plan: "w1-2026/nothing" })).text).toContain("There is no plan with that id.");
    expect((await callTool("plan", {})).text).toContain("Give a template and wedding");
  });
});

describe("run_plan_step", () => {
  it("gives the next step, its tool and how, and the question for her own steps", async () => {
    await callTool("plan", { template: "new_wedding", wedding: "w2-2026" });
    const first = await callTool("run_plan_step", { plan: "w2-2026/new_wedding" });
    expect(first.data).toMatchObject({ plan: "w2-2026/new_wedding", done: false, progress: "0 of 5 done", step: { n: 1, who: "Claude" }, use: "save_wedding" });
    expect(first.data).not.toHaveProperty("askHer");

    // The venue alone, or the place alone, does not finish the first step.
    await db.prepare("UPDATE events SET venue_name = 'Hawks Cay' WHERE id = 'w2'").run();
    expect((await callTool("run_plan_step", { plan: "w2-2026/new_wedding" })).data).toMatchObject({ step: { n: 1 } });
    await db.prepare("UPDATE events SET venue_name = NULL, location_code = 'US-FL' WHERE id = 'w2'").run();
    expect((await callTool("run_plan_step", { plan: "w2-2026/new_wedding" })).data).toMatchObject({ step: { n: 1 } });
    await db.prepare("UPDATE events SET venue_name = 'Hawks Cay' WHERE id = 'w2'").run();
    const second = await callTool("run_plan_step", { plan: "w2-2026/new_wedding" });
    expect(second.data).toMatchObject({ progress: "1 of 5 done", step: { n: 2, who: "you" }, use: "confirm_permissions", askHer: expect.stringContaining("lead photographer") });
  });

  it("says when the plan is finished, and what usually follows", async () => {
    await callTool("plan", { template: "pick_outlets", wedding: "w1-2026" });
    await callTool("set_queue", { wedding: "w1-2026", outlets: ["pub-simple"] });
    expect((await callTool("run_plan_step", { plan: "w1-2026/pick_outlets" })).data).toEqual({
      plan: "w1-2026/pick_outlets",
      done: true,
      progress: "3 of 3 done",
      next: "This plan is finished. The usual next plan is build_package: Build the package.",
    });
    expect((await callTool("run_plan_step", { plan: "nope/new_wedding" })).text).toContain("There is no plan with that id.");
  });
});
