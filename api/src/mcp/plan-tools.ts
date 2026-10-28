import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { PLAN_TEMPLATES, TEMPLATE_TITLES, nextStep, planSteps, reviseSkips } from "../domain/plans.js";
import type { PlanSnapshot, PlanTemplate } from "../domain/plans.js";
import { evaluateRightsGate } from "../domain/rights-gate.js";
import type { ConsentStatus, RightsStatus } from "../domain/rights-gate.js";
import type { OAuthEnv } from "../env.js";
import { loadQueue } from "../routes/events.js";
import { loadPackageView } from "../routes/packages.js";
import { READ_ONLY, WRITES, audited } from "./audit.js";
import type { McpContext, Outcome } from "./audit.js";
import { NOT_FOUND } from "./wedding-tools.js";

/**
 * plan and run_plan_step (SUMMIT-344 slice 6, spec section 6a). plan takes
 * the place of the spec's plan_request and revise_plan. The steps and their
 * progress are domain/plans.ts's; this file loads the wedding's data they
 * read and keeps her plans so a new chat can pick one up.
 *
 * DECISION: plans have no web screen, so plan writes the plans table itself
 * rather than through a route. Only her choices are stored (the outlet, her
 * words, skipped steps); progress is always worked out afresh.
 */

// Built once per isolate, not per request: zod schemas are costly to build,
// and every /mcp request builds its own server (handler.ts).
const PLAN_ARGS = z.object({
  wedding: z.string().min(1).max(100).optional().describe("The wedding's short id."),
  template: z
    .enum(PLAN_TEMPLATES)
    .optional()
    .describe("Start this plan: new_wedding, pick_outlets, build_package, send_and_follow_up or after_acceptance."),
  outlet: z.string().max(100).optional().describe("For build_package and later: the outlet's id. Default: the one up next in her order."),
  goal: z.string().max(300).optional().describe("What she asked for, in her words."),
  plan: z.string().max(200).optional().describe("An existing plan's id, such as blake-and-anne-2026/build_package."),
  skip: z.array(z.number().int()).max(10).optional().describe("With plan: step numbers she wants to skip."),
  unskip: z.array(z.number().int()).max(10).optional().describe("With plan: skipped step numbers to bring back."),
});

const RUN_ARGS = z.object({
  plan: z.string().min(1).max(200).describe("The plan's id, from plan."),
});

type PlanArgs = z.infer<typeof PLAN_ARGS>;

interface PlanRow {
  id: string;
  event_id: string;
  template: PlanTemplate;
  publication_id: string | null;
  goal: string | null;
  skipped_json: string;
}

const blank = (text: string | null) => text === null || text.trim() === "";
const planId = (slug: string, template: PlanTemplate) => `${slug}/${template}`;

const UNKNOWN_PLAN: Outcome = {
  ok: false,
  result: "plan_not_found",
  message: "There is no plan with that id. Call plan with the wedding to see its plans, or with a template to start one.",
};

/** Everything the plan's steps read, in as few D1 round trips as it takes. */
async function loadSnapshot(env: OAuthEnv, slug: string, outletId: string | null) {
  const [eventRows, countRows, outletRows] = await env.DB.batch([
    env.DB
      .prepare(
        `SELECT id, slug, event_date, venue_name, city, location_code, rights_status, consent_status, couple_story
         FROM events WHERE slug = ?`,
      )
      .bind(slug),
    env.DB
      .prepare(
        `SELECT (SELECT COUNT(*) FROM vendor_credits v WHERE v.event_id = e.id) AS credits,
                (SELECT COUNT(*) FROM event_images i WHERE i.event_id = e.id) AS photos,
                (SELECT COUNT(*) FROM event_tags t WHERE t.event_id = e.id AND t.state = 'confirmed') AS tags
         FROM events e WHERE e.slug = ?`,
      )
      .bind(slug),
    env.DB
      .prepare(
        `SELECT publications.id, publications.name,
                (SELECT packages.id FROM packages JOIN events ON events.id = packages.event_id
                 WHERE events.slug = ? AND packages.publication_id = publications.id
                 ORDER BY packages.version DESC LIMIT 1) AS package_id
         FROM publications WHERE id = ?`,
      )
      .bind(slug, outletId ?? ""),
  ]);
  const event = eventRows?.results[0] as
    | {
        id: string;
        slug: string;
        event_date: string;
        venue_name: string | null;
        city: string | null;
        location_code: string | null;
        rights_status: RightsStatus;
        consent_status: ConsentStatus;
        couple_story: string | null;
      }
    | undefined;
  if (event === undefined) return null;
  const counts = (countRows?.results[0] ?? { credits: 0, photos: 0, tags: 0 }) as { credits: number; photos: number; tags: number };
  const named = outletRows?.results[0] as { id: string; name: string; package_id: string | null } | undefined;

  const queue = await loadQueue(env.DB, event.id);
  // The outlet the plan names, or else the one up next in her order.
  let outlet: { id: string; name: string; packageId: string | null } | null = null;
  if (outletId !== null) {
    if (named === undefined) return { event, unknownOutlet: true as const };
    outlet = { id: named.id, name: named.name, packageId: named.package_id };
  } else if (queue?.upNext != null) {
    outlet = { id: queue.upNext.publicationId, name: queue.upNext.name, packageId: queue.upNext.packageId };
  }

  const pkg = outlet === null || outlet.packageId === null ? null : await loadPackageView({ env }, outlet.packageId);
  const ids = new Map((pkg?.checklist ?? []).map((item) => [item.id, item.satisfied]));
  const snapshot: PlanSnapshot = {
    wedding: {
      slug: event.slug,
      hasDate: !blank(event.event_date),
      hasVenueOrCity: !blank(event.venue_name) || !blank(event.city),
      placeSet: event.location_code !== null,
      permissionsAnswered: event.rights_status !== "unverified" && event.consent_status !== "unverified",
      gateOpen: evaluateRightsGate({ rightsStatus: event.rights_status, consentStatus: event.consent_status }).allowed,
      story: !blank(event.couple_story),
      vendorCredits: counts.credits,
      photos: counts.photos,
      keptTags: counts.tags,
    },
    orderSet: (queue?.entries.length ?? 0) > 0,
    outlet: outlet === null ? null : { id: outlet.id, name: outlet.name },
    pkg:
      pkg === null
        ? null
        : {
            photosChosen: ids.get("images_present") === true && ids.get("image_count") !== false,
            writeUp: !blank(pkg.descriptionMd),
            toConfirm: pkg.checklist.filter((item) => item.kind === "attested" && !item.satisfied).length,
          },
    submission: pkg?.submission?.status ?? null,
  };
  return { event, snapshot };
}

const EMPTY: PlanSnapshot = { wedding: null, orderSet: false, outlet: null, pkg: null, submission: null };

function view(id: string | null, template: PlanTemplate, snapshot: PlanSnapshot, skipped: number[], goal: string | null) {
  const next = nextStep(template, snapshot, skipped);
  return {
    plan: id,
    title: TEMPLATE_TITLES[template],
    ...(snapshot.wedding === null ? {} : { wedding: snapshot.wedding.slug }),
    ...(snapshot.outlet === null ? {} : { outlet: snapshot.outlet.name }),
    ...(goal === null ? {} : { goal }),
    steps: planSteps(template, snapshot, skipped),
    progress: next.progress,
    ...(next.done ? { next: next.next } : { next: `Step ${next.step.n}: ${next.step.text}`, ...(next.askHer === undefined ? {} : { askHer: next.askHer }) }),
  };
}

async function loadPlan(env: OAuthEnv, id: string) {
  return env.DB.prepare("SELECT id, event_id, template, publication_id, goal, skipped_json FROM plans WHERE id = ?").bind(id).first<PlanRow>();
}

export function registerPlanTools(server: McpServer, env: OAuthEnv, ctx: McpContext): void {
  const userId = ctx.props.userId;

  server.registerTool(
    "plan",
    {
      title: "Plan",
      description:
        "Plan first, act second: use this before any multi-step request. Pick the template that fits her words: new_wedding (bring a wedding in), pick_outlets (rank and choose the order), build_package (prepare one outlet's package), send_and_follow_up (she sends it, then waiting for the answer) or after_acceptance. Returns 3 to 5 numbered plain steps, each for Claude or for her, with which are done; show them to her numbered, ask the askHer question, and wait. To skip or bring back steps, call with plan and skip or unskip. With only wedding, lists that wedding's plans, so she can pick one up in a new chat. Then use run_plan_step for each step.",
      inputSchema: PLAN_ARGS,
      annotations: WRITES,
    },
    audited(env, ctx, "plan", async (args: PlanArgs): Promise<Outcome> => {
      if (args.template !== undefined) {
        if (args.wedding === undefined) {
          if (args.template !== "new_wedding") {
            return { ok: false, result: "needs_wedding", message: "Name the wedding: every plan but new_wedding is for one wedding." };
          }
          return {
            ok: true,
            result: "not_kept",
            data: {
              ...view(null, "new_wedding", EMPTY, [], args.goal ?? null),
              note: "Not kept yet: once step 1 has saved the wedding, call plan again with its id and this template to keep the plan.",
            },
          };
        }
        const loaded = await loadSnapshot(env, args.wedding, args.outlet ?? null);
        if (loaded === null) return NOT_FOUND;
        if ("unknownOutlet" in loaded) {
          return { ok: false, result: "unknown_outlet", message: "There is no outlet with that id. Use publications to find it." };
        }
        const id = planId(loaded.event.slug, args.template);
        await env.DB.batch([
          env.DB
            .prepare(
              `INSERT INTO plans (id, event_id, template, publication_id, goal, skipped_json, created_by)
               VALUES (?, ?, ?, ?, ?, '[]', ?)
               ON CONFLICT (id) DO UPDATE SET publication_id = excluded.publication_id, goal = excluded.goal,
                 skipped_json = '[]', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
            )
            .bind(id, loaded.event.id, args.template, args.outlet ?? null, args.goal ?? null, userId),
        ]);
        return { ok: true, data: view(id, args.template, loaded.snapshot, [], args.goal ?? null) };
      }

      if (args.plan !== undefined) {
        const row = await loadPlan(env, args.plan);
        if (row === null) return UNKNOWN_PLAN;
        const slug = row.id.slice(0, row.id.lastIndexOf("/"));
        let skipped = JSON.parse(row.skipped_json) as number[];
        if ((args.skip?.length ?? 0) > 0 || (args.unskip?.length ?? 0) > 0) {
          const revised = reviseSkips(row.template, skipped, args.skip ?? [], args.unskip ?? []);
          if (!revised.ok) return { ok: false, result: "unknown_step", message: revised.message };
          skipped = revised.skipped;
          await env.DB.prepare("UPDATE plans SET skipped_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
            .bind(JSON.stringify(skipped), row.id)
            .run();
        }
        const loaded = await loadSnapshot(env, slug, row.publication_id);
        if (loaded === null || "unknownOutlet" in loaded) return UNKNOWN_PLAN;
        return { ok: true, data: view(row.id, row.template, loaded.snapshot, skipped, row.goal) };
      }

      if (args.wedding !== undefined) {
        const { results } = await env.DB.prepare(
          `SELECT plans.id, plans.template, plans.updated_at FROM plans JOIN events ON events.id = plans.event_id
           WHERE events.slug = ? ORDER BY plans.updated_at DESC`,
        )
          .bind(args.wedding)
          .all<{ id: string; template: PlanTemplate; updated_at: string }>();
        return {
          ok: true,
          data: {
            wedding: args.wedding,
            plans: results.map((row) => ({ plan: row.id, title: TEMPLATE_TITLES[row.template], updated: row.updated_at.slice(0, 10) })),
            next: results.length === 0 ? "No plans yet for this wedding. Start one with a template." : "Call run_plan_step with a plan to carry on.",
          },
        };
      }

      return { ok: false, result: "needs_arguments", message: "Give a template and wedding to start a plan, a plan id to see or revise one, or a wedding to list its plans." };
    }),
  );

  server.registerTool(
    "run_plan_step",
    {
      title: "Run a plan step",
      description:
        "The next step of a plan: what it is, whether it is for Claude or for her, which tool does it (use) and how, and for her steps the one question to ask (askHer). Do that step, report it to her in one line, then call this again. Steps are marked done from the wedding's own data, so a step done in the studio counts too. The studio never sends anything; steps for sending are hers.",
      inputSchema: RUN_ARGS,
      annotations: READ_ONLY,
    },
    audited(env, ctx, "run_plan_step", async (args: { plan: string }): Promise<Outcome> => {
      const row = await loadPlan(env, args.plan);
      if (row === null) return UNKNOWN_PLAN;
      const loaded = await loadSnapshot(env, row.id.slice(0, row.id.lastIndexOf("/")), row.publication_id);
      if (loaded === null || "unknownOutlet" in loaded) return UNKNOWN_PLAN;
      const next = nextStep(row.template, loaded.snapshot, JSON.parse(row.skipped_json) as number[]);
      return { ok: true, data: { plan: row.id, ...next } };
    }),
  );
}
