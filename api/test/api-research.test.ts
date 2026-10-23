import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { signAccessToken } from "../src/domain/tokens.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2 } from "./helpers/r2.js";

const here = dirname(fileURLToPath(import.meta.url));
const RESEARCH = join(here, "../../research");
const loadYaml = (path: string): Record<string, any> => parse(readFileSync(path, "utf8"));
const outletFile = (id: string) => loadYaml(join(RESEARCH, `publications/${id}.yaml`));
const exampleFile = () => loadYaml(join(here, "fixtures/research/pub-example-weddings.yaml"));
const vocabBody = () => ({ tags: loadYaml(join(RESEARCH, "vocab/tags.yaml")), geo: loadYaml(join(RESEARCH, "vocab/geo.yaml")) });

const JWT_SECRET = "test-signing-secret";
let db: TestD1;
let env: Env;
let admin: Record<string, string>;
let partner: Record<string, string>;
const app = createApp();

beforeEach(async () => {
  db = createTestD1();
  env = { DB: db, IMAGES: createTestR2(), JWT_SECRET, ALLOWED_ORIGIN: "https://studio.example.com" };
  db.exec(`INSERT INTO users (id, email, name, role, pw_hash) VALUES
    ('user-admin', 'admin@example.com', 'Admin', 'admin', 'x'),
    ('user-1', 'partner@example.com', 'Partner', 'photographer', 'x')`);
  admin = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-admin", role: "admin" })}` };
  partner = { authorization: `Bearer ${await signAccessToken(JWT_SECRET, { userId: "user-1", role: "photographer" })}` };
});

afterEach(() => db.close());

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );

const loadVocab = async () => expect((await send("PUT", "/research/vocab", admin, vocabBody())).status).toBe(200);
const propose = (file: unknown, contacts: unknown = null, headers = admin) =>
  send("POST", "/research/revisions", headers, { file, contacts, git_sha: "abc1234" });
const proposeOk = async (file: unknown, contacts: unknown = null): Promise<string> => {
  const res = await propose(file, contacts);
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { revisionId: string }).revisionId;
};
const pending = async () =>
  ((await (await send("GET", "/research/revisions", partner)).json()) as { revisions: Array<Record<string, any>> }).revisions;
const approve = (id: string, headers = partner) => send("POST", `/research/revisions/${id}/approve`, headers, {});
async function tagRows(publicationId: string) {
  const { results } = await db
    .prepare("SELECT tag_id, origin FROM publication_tags WHERE publication_id = ? ORDER BY tag_id")
    .bind(publicationId)
    .all<{ tag_id: string; origin: string }>();
  return results;
}

describe("PUT /research/vocab", () => {
  it("is for the operator only", async () => {
    expect((await send("PUT", "/research/vocab", partner, vocabBody())).status).toBe(403);
    expect((await send("PUT", "/research/vocab", {}, vocabBody())).status).toBe(401);
  });

  it("refuses a vocabulary that does not validate", async () => {
    const res = await send("PUT", "/research/vocab", admin, { tags: [], geo: {} });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("VALIDATION");
  });

  it("adds new seed tags without touching the photographer's own", async () => {
    db.exec("INSERT INTO tags (id, category, sort_order, origin) VALUES ('candlelit', 'aesthetic', 99, 'custom')");
    const res = await send("PUT", "/research/vocab", admin, vocabBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tags: expect.any(Number), geo: expect.any(Number) });
    const florida = await db.prepare("SELECT category, origin FROM tags WHERE id = 'florida'").first();
    expect(florida).toEqual({ category: "region", origin: "seed" });
    const custom = await db.prepare("SELECT origin FROM tags WHERE id = 'candlelit'").first();
    expect(custom).toEqual({ origin: "custom" });
    expect((await send("PUT", "/research/vocab", admin, vocabBody())).status).toBe(200);
  });
});

describe("POST /research/revisions", () => {
  it("is for the operator only", async () => {
    await loadVocab();
    expect((await propose(exampleFile(), null, partner)).status).toBe(403);
  });

  it("needs the vocabulary loaded first", async () => {
    const res = await propose(exampleFile());
    expect(res.status).toBe(409);
  });

  it("refuses a file that breaks the research rules, saying where", async () => {
    await loadVocab();
    const file = exampleFile();
    delete file["rules"].freshness_window_months;
    const res = await propose(file);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details: Array<{ field: string }> };
    expect(body.details.map((error) => error.field)).toContain("rules.freshness_window_months");
  });

  it("refuses contacts that belong to another outlet", async () => {
    await loadVocab();
    const res = await propose(exampleFile(), { id: "pub-brides" });
    expect(res.status).toBe(422);
  });

  it("holds new research as pending, and skips an import that changed nothing", async () => {
    await loadVocab();
    const first = await proposeOk(exampleFile());
    const again = await propose(exampleFile());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "unchanged", revisionId: first });
  });

  it("replaces a pending revision with newer research", async () => {
    await loadVocab();
    const first = await proposeOk(exampleFile());
    const changed = exampleFile();
    changed["tier"] = "secondary";
    const second = await proposeOk(changed);
    const rows = await db
      .prepare("SELECT id, status FROM research_revisions ORDER BY proposed_at, id")
      .all<{ id: string; status: string }>();
    expect(rows.results).toEqual(
      expect.arrayContaining([
        { id: first, status: "superseded" },
        { id: second, status: "pending" },
      ]),
    );
  });

  it("does not raise again research that was turned down", async () => {
    await loadVocab();
    const id = await proposeOk(exampleFile());
    expect((await send("POST", `/research/revisions/${id}/reject`, partner, { note: "Not for us" })).status).toBe(200);
    expect(await (await propose(exampleFile())).json()).toEqual({ status: "rejected", revisionId: id });
  });
});

describe("GET /research/revisions", () => {
  it("lists what waits for approval, with what changed", async () => {
    await loadVocab();
    await proposeOk(exampleFile());
    await proposeOk(outletFile("pub-brides"));
    const list = await pending();
    expect(list.map((revision) => revision["name"])).toEqual(["Brides", "Example Weddings"]);
    const brides = list[0] as Record<string, any>;
    expect(brides).toMatchObject({ publicationId: "pub-brides", isNew: false, firstResearch: true, gitSha: "abc1234", conflicts: [] });
    expect(list[1]).toMatchObject({ publicationId: "pub-example-weddings", isNew: true });
    expect((list[1] as Record<string, any>)["changes"]).toContainEqual({ field: "tier", before: null, after: "primary" });
  });

  it("shows one revision in full", async () => {
    await loadVocab();
    const id = await proposeOk(exampleFile());
    const res = await send("GET", `/research/revisions/${id}`, partner);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, status: "pending", payload: { file: { id: "pub-example-weddings" }, contacts: null } });
    expect((await send("GET", "/research/revisions/nope", partner)).status).toBe(404);
  });
});

describe("approving and rejecting research", () => {
  it("adds a new outlet to the publications, with its research tags", async () => {
    await loadVocab();
    const id = await proposeOk(exampleFile(), { id: "pub-example-weddings", submission_inbox: { email: "weddings@example.com", source: "https://example.com/submit", read: "2026-10-20" } });
    const res = await approve(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publication: Record<string, unknown> };
    expect(body.publication).toMatchObject({
      id: "pub-example-weddings",
      name: "Example Weddings",
      method: "web_form",
      contactEmail: "weddings@example.com",
      typicalResponseDays: 42,
      tags: ["garden_botanical", "lakefront", "romantic"],
    });
    expect(await pending()).toEqual([]);
    const audit = await db.prepare("SELECT action FROM audit_log WHERE entity_id = 'pub-example-weddings'").first();
    expect(audit).toEqual({ action: "research_approved" });
  });

  it("updates a seeded outlet in place, so its packages and submissions keep their link", async () => {
    await loadVocab();
    const id = await proposeOk(outletFile("pub-brides"));
    expect((await approve(id)).status).toBe(200);
    const row = await db
      .prepare("SELECT kind, research_revision_id, typical_response_days FROM publications WHERE id = 'pub-brides'")
      .first();
    expect(row).toEqual({ kind: "national_magazine", research_revision_id: id, typical_response_days: 60 });
  });

  it("keeps the photographer's own tags and corrections through newer research", async () => {
    await loadVocab();
    expect((await approve(await proposeOk(exampleFile()))).status).toBe(200);
    expect((await send("DELETE", "/publications/pub-example-weddings/tags/romantic", partner)).status).toBe(200);
    expect((await send("POST", "/publications/pub-example-weddings/tags/whimsical", partner)).status).toBe(200);
    expect((await send("PUT", "/publications/pub-example-weddings/edits/tier", partner, { value: "dream" })).status).toBe(422);
    expect(
      (await send("PUT", "/publications/pub-example-weddings/edits/timing.response_window", partner, { value: { days: 30, replies: "all" }, note: "Editor told me" })).status,
    ).toBe(200);

    const newer = exampleFile();
    newer["timing"].response_window.value.days = 56;
    const id = await proposeOk(newer);
    const [revision] = await pending();
    expect(revision?.["conflicts"]).toEqual([
      { field: "timing.response_window", before: { days: 42, replies: "success_only" }, after: { days: 56, replies: "success_only" } },
    ]);
    expect((await approve(id)).status).toBe(200);

    expect(await tagRows("pub-example-weddings")).toEqual([
      { tag_id: "garden_botanical", origin: "research" },
      { tag_id: "lakefront", origin: "research" },
      { tag_id: "romantic", origin: "removed" },
      { tag_id: "whimsical", origin: "added" },
    ]);
    const research = (await (await send("GET", "/publications/pub-example-weddings/research", partner)).json()) as Record<string, any>;
    expect(research["edits"]).toEqual([
      { field: "timing.response_window", value: { days: 30, replies: "all" }, note: "Editor told me", updatedAt: expect.any(String) },
    ]);
    const list = (await (await send("GET", "/publications", partner)).json()) as { publications: Array<{ id: string; tags: string[] }> };
    expect(list.publications.find((p) => p.id === "pub-example-weddings")?.tags).toEqual(["garden_botanical", "lakefront", "whimsical"]);
  });

  it("supersedes the research it replaces", async () => {
    await loadVocab();
    const first = await proposeOk(exampleFile());
    await approve(first);
    const newer = exampleFile();
    newer["tier"] = "secondary";
    await approve(await proposeOk(newer));
    const row = await db.prepare("SELECT status FROM research_revisions WHERE id = ?").bind(first).first();
    expect(row).toEqual({ status: "superseded" });
  });

  it("approves or rejects only what is pending", async () => {
    await loadVocab();
    const id = await proposeOk(exampleFile());
    expect((await approve(id)).status).toBe(200);
    expect((await approve(id)).status).toBe(409);
    expect((await send("POST", `/research/revisions/${id}/reject`, partner, {})).status).toBe(409);
    expect((await approve("nope")).status).toBe(404);
  });
});

describe("the photographer's corrections and tags", () => {
  beforeEach(async () => {
    await loadVocab();
    expect((await approve(await proposeOk(exampleFile()))).status).toBe(200);
  });

  it("checks a correction like the research file would", async () => {
    const res = await send("PUT", "/publications/pub-example-weddings/edits/timing.response_window", partner, { value: { days: -3, replies: "all" } });
    expect(res.status).toBe(422);
    expect((await send("PUT", "/publications/pub-missing/edits/tier", partner, { value: "dream" })).status).toBe(404);
  });

  it("removes a correction", async () => {
    await send("PUT", "/publications/pub-example-weddings/edits/package.image_max", partner, { value: 80 });
    expect((await send("DELETE", "/publications/pub-example-weddings/edits/package.image_max", partner)).status).toBe(204);
    expect((await send("DELETE", "/publications/pub-example-weddings/edits/package.image_max", partner)).status).toBe(404);
  });

  it("adds and removes tags, from the vocabulary only", async () => {
    expect((await send("POST", "/publications/pub-example-weddings/tags/not_a_tag", partner)).status).toBe(404);
    expect((await send("DELETE", "/publications/pub-example-weddings/tags/whimsical", partner)).status).toBe(404);
    expect((await send("POST", "/publications/pub-example-weddings/tags/lakefront", partner)).status).toBe(200);
    const removed = await send("DELETE", "/publications/pub-example-weddings/tags/lakefront", partner);
    expect(await removed.json()).toEqual({ tags: ["garden_botanical", "romantic"] });
    const back = await send("POST", "/publications/pub-example-weddings/tags/lakefront", partner);
    expect(await back.json()).toEqual({ tags: ["garden_botanical", "lakefront", "romantic"] });
    await send("POST", "/publications/pub-example-weddings/tags/whimsical", partner);
    expect(await (await send("DELETE", "/publications/pub-example-weddings/tags/whimsical", partner)).json()).toEqual({
      tags: ["garden_botanical", "lakefront", "romantic"],
    });
  });

  it("creates a custom tag she can then use", async () => {
    const res = await send("POST", "/tags", partner, { label: "Candlelit Evening", category: "aesthetic" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "candlelit_evening", category: "aesthetic", origin: "custom" });
    expect((await send("POST", "/tags", partner, { label: "Candlelit Evening", category: "aesthetic" })).status).toBe(409);
    expect((await send("POST", "/tags", partner, { label: "!!", category: "aesthetic" })).status).toBe(422);
    expect((await send("POST", "/tags", partner, { label: "Calm", category: "mood" })).status).toBe(422);
    expect((await send("POST", "/publications/pub-example-weddings/tags/candlelit_evening", partner)).status).toBe(200);
  });

  it("shows an outlet's research and contacts, or nothing for an outlet with no research yet", async () => {
    const res = await send("GET", "/publications/pub-example-weddings/research", partner);
    expect(await res.json()).toMatchObject({ research: { id: "pub-example-weddings" }, contacts: null, edits: [] });
    expect(await (await send("GET", "/publications/pub-brides/research", partner)).json()).toEqual({
      research: null,
      contacts: null,
      edits: [],
      revisionId: null,
    });
    expect((await send("GET", "/publications/pub-missing/research", partner)).status).toBe(404);
  });
});


describe("corrections take effect", () => {
  const view = async (id: string) =>
    ((await (await send("GET", `/publications/${id}`, partner)).json()) as Record<string, any>);

  it("changes what the app uses, and removing it restores the research", async () => {
    await loadVocab();
    await approve(await proposeOk(exampleFile()));
    expect((await view("pub-example-weddings"))["typicalResponseDays"]).toBe(42);

    await send("PUT", "/publications/pub-example-weddings/edits/timing.response_window", partner, { value: { days: 30, replies: "all" }, note: "Editor told me" });
    const corrected = await view("pub-example-weddings");
    expect(corrected["typicalResponseDays"]).toBe(30);
    expect(corrected["responseWindowNote"]).toBeNull();
    expect(corrected["corrections"]).toEqual([{ field: "timing.response_window", value: { days: 30, replies: "all" }, note: "Editor told me" }]);

    await send("DELETE", "/publications/pub-example-weddings/edits/timing.response_window", partner);
    expect(await view("pub-example-weddings")).toMatchObject({ typicalResponseDays: 42, corrections: [] });
  });

  it("keeps a correction in force when newer research is approved", async () => {
    await loadVocab();
    await approve(await proposeOk(exampleFile()));
    await send("PUT", "/publications/pub-example-weddings/edits/timing.response_window", partner, { value: { days: 30, replies: "all" } });
    const newer = exampleFile();
    newer["timing"].response_window.value.days = 56;
    await approve(await proposeOk(newer));
    expect((await view("pub-example-weddings"))["typicalResponseDays"]).toBe(30);
  });

  it("holds a correction to an outlet with no research yet until its research is approved", async () => {
    await loadVocab();
    expect((await send("PUT", "/publications/pub-brides/edits/timing.response_window", partner, { value: { days: 45, replies: "all" } })).status).toBe(200);
    expect((await view("pub-brides"))["typicalResponseDays"]).toBe(60);
    await approve(await proposeOk(outletFile("pub-brides")));
    expect((await view("pub-brides"))["typicalResponseDays"]).toBe(45);
  });

  it("leaves style tags to the tag buttons", async () => {
    await loadVocab();
    await approve(await proposeOk(exampleFile()));
    const res = await send("PUT", "/publications/pub-example-weddings/edits/content.style_tags", partner, { value: ["romantic"] });
    expect(res.status).toBe(422);
  });
});
