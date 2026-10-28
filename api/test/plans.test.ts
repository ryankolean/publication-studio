import { describe, expect, it } from "vitest";

import { PLAN_TEMPLATES, TEMPLATE_TITLES, nextStep, planSteps, reviseSkips, stepCount } from "../src/domain/plans.js";
import type { PlanSnapshot } from "../src/domain/plans.js";

const wedding = (overrides: Partial<NonNullable<PlanSnapshot["wedding"]>> = {}): NonNullable<PlanSnapshot["wedding"]> => ({
  slug: "casey-jordan-2026",
  hasDate: true,
  hasVenueOrCity: true,
  placeSet: true,
  permissionsAnswered: true,
  gateOpen: true,
  story: true,
  vendorCredits: 2,
  photos: 40,
  keptTags: 5,
  ...overrides,
});

const snap = (overrides: Partial<PlanSnapshot> = {}): PlanSnapshot => ({
  wedding: wedding(),
  orderSet: true,
  outlet: { id: "pub-the-knot", name: "The Knot" },
  pkg: { photosChosen: true, writeUp: true, toConfirm: 0 },
  submission: null,
  ...overrides,
});

const statuses = (template: (typeof PLAN_TEMPLATES)[number], snapshot: PlanSnapshot, skipped: number[] = []) =>
  planSteps(template, snapshot, skipped).map((step) => step.status);

describe("new_wedding", () => {
  it("reads every step from the wedding's own data", () => {
    expect(statuses("new_wedding", snap())).toEqual(["done", "done", "done", "done", "done"]);
    expect(statuses("new_wedding", snap({ wedding: null }))).toEqual(["next", "to do", "to do", "to do", "to do"]);
    expect(statuses("new_wedding", snap({ wedding: wedding({ placeSet: false }) }))).toEqual(["next", "done", "done", "done", "done"]);
    expect(statuses("new_wedding", snap({ wedding: wedding({ hasVenueOrCity: false }) }))[0]).toBe("next");
    expect(statuses("new_wedding", snap({ wedding: wedding({ hasDate: false }) }))[0]).toBe("next");
    expect(statuses("new_wedding", snap({ wedding: wedding({ permissionsAnswered: false, photos: 0 }) }))).toEqual(["done", "next", "to do", "done", "done"]);
    expect(statuses("new_wedding", snap({ wedding: wedding({ vendorCredits: 0 }) }))[3]).toBe("next");
    expect(statuses("new_wedding", snap({ wedding: wedding({ story: false }) }))[3]).toBe("next");
    expect(statuses("new_wedding", snap({ wedding: wedding({ keptTags: 0 }) }))[4]).toBe("next");
  });

  it("says how, and asks her the one question, for each step", () => {
    expect(nextStep("new_wedding", snap({ wedding: null }), [])).toMatchObject({
      done: false,
      progress: "0 of 5 done",
      step: { n: 1, who: "Claude" },
      use: "save_wedding",
      how: expect.stringContaining("couple_names and date"),
    });
    expect(nextStep("new_wedding", snap({ wedding: wedding({ placeSet: false }) }), [])).toMatchObject({ how: expect.stringContaining("wedding casey-jordan-2026") });
    expect(nextStep("new_wedding", snap({ wedding: null }), [1])).toMatchObject({ step: { n: 2 }, how: expect.stringContaining("for the new wedding") });
    expect(nextStep("new_wedding", snap({ wedding: wedding({ permissionsAnswered: false }) }), [])).toMatchObject({
      step: { n: 2, who: "you" },
      use: "confirm_permissions",
      askHer: expect.stringContaining("lead photographer"),
    });
    expect(nextStep("new_wedding", snap({ wedding: wedding({ photos: 0 }) }), [])).toMatchObject({ use: "get_upload_link", how: expect.stringContaining("give her the link") });
    expect(nextStep("new_wedding", snap({ wedding: wedding({ photos: 0, gateOpen: false }) }), [])).toMatchObject({
      how: "The permission answers do not allow photos yet; settle those first.",
    });
    expect(nextStep("new_wedding", snap({ wedding: wedding({ story: false }) }), [])).toMatchObject({ askHer: expect.stringContaining("vendors") });
    expect(nextStep("new_wedding", snap({ wedding: wedding({ keptTags: 0 }) }), [])).toMatchObject({ use: "set_tags", how: expect.stringContaining("tag_choices") });
  });
});

describe("pick_outlets", () => {
  it("is done once her order is set, after the place and tags", () => {
    expect(statuses("pick_outlets", snap({ orderSet: false, wedding: wedding({ keptTags: 0 }) }))).toEqual(["next", "to do", "to do"]);
    expect(statuses("pick_outlets", snap({ orderSet: false, wedding: wedding({ placeSet: false }) }))[0]).toBe("next");
    expect(statuses("pick_outlets", snap({ orderSet: false, wedding: null }))[0]).toBe("next");
    expect(nextStep("pick_outlets", snap({ orderSet: false }), [])).toMatchObject({ step: { n: 2 }, use: "rank_publications_for_wedding" });
    expect(nextStep("pick_outlets", snap({ orderSet: false }), [2])).toMatchObject({ step: { n: 3, who: "you" }, use: "set_queue", askHer: expect.any(String) });
    expect(nextStep("pick_outlets", snap({ orderSet: false, wedding: wedding({ keptTags: 0 }) }), [])).toMatchObject({ how: expect.stringContaining("set_tags") });
    expect(nextStep("pick_outlets", snap(), [])).toEqual({
      done: true,
      progress: "3 of 3 done",
      next: "This plan is finished. The usual next plan is build_package: Build the package.",
    });
  });
});

describe("build_package", () => {
  it("follows the package from started to ready", () => {
    expect(statuses("build_package", snap({ pkg: null }))).toEqual(["next", "to do", "to do", "to do", "to do"]);
    expect(statuses("build_package", snap({ pkg: { photosChosen: false, writeUp: false, toConfirm: 2 } }))).toEqual(["done", "next", "to do", "to do", "to do"]);
    expect(statuses("build_package", snap({ submission: "ready" }))).toEqual(["done", "done", "done", "done", "done"]);
    expect(planSteps("build_package", snap(), [])[0]?.text).toBe("Start the package for The Knot.");
  });

  it("says how for each step, and what to do with no outlet", () => {
    expect(nextStep("build_package", snap({ pkg: null }), [])).toMatchObject({ how: "Call build_package_draft with wedding casey-jordan-2026 and publication pub-the-knot." });
    expect(nextStep("build_package", snap({ pkg: null, outlet: null, wedding: null }), [])).toMatchObject({
      step: { text: "Start the package for the outlet up next." },
      how: "There is no outlet to build for: choose the order first (the pick_outlets plan).",
    });
    expect(nextStep("build_package", snap({ pkg: { photosChosen: false, writeUp: true, toConfirm: 0 } }), [])).toMatchObject({
      how: expect.stringContaining("pub-the-knot"),
      askHer: "Which photos should go to The Knot? I can show them to you a page at a time.",
    });
    expect(nextStep("build_package", snap({ outlet: null, pkg: { photosChosen: false, writeUp: true, toConfirm: 0 } }), [])).toMatchObject({
      how: expect.stringContaining("for the outlet."),
      askHer: expect.stringContaining("the outlet up next"),
    });
    expect(nextStep("build_package", snap({ pkg: { photosChosen: true, writeUp: false, toConfirm: 1 } }), [])).toMatchObject({ step: { n: 3 }, how: expect.stringContaining("write_up") });
    expect(nextStep("build_package", snap({ pkg: { photosChosen: true, writeUp: true, toConfirm: 1 } }), [])).toMatchObject({ step: { n: 4, who: "you" }, how: expect.stringContaining("only after her yes") });
    expect(nextStep("build_package", snap(), [])).toMatchObject({ step: { n: 5 }, use: "set_queue" });
  });
});

describe("send_and_follow_up", () => {
  it("follows the submission she sends herself to its answer", () => {
    expect(statuses("send_and_follow_up", snap())).toEqual(["next", "to do", "to do", "to do"]);
    expect(statuses("send_and_follow_up", snap({ submission: "ready" }))).toEqual(["done", "next", "to do", "to do"]);
    expect(statuses("send_and_follow_up", snap({ submission: "sent" }))).toEqual(["done", "done", "next", "to do"]);
    expect(statuses("send_and_follow_up", snap({ submission: "expired" }))).toEqual(["done", "done", "done", "next"]);
    expect(statuses("send_and_follow_up", snap({ submission: "declined" }))).toEqual(["done", "done", "done", "done"]);
    expect(statuses("send_and_follow_up", snap({ submission: "withdrawn" }))[3]).toBe("done");
    expect(statuses("send_and_follow_up", snap({ submission: "accepted" }))[3]).toBe("done");
  });

  it("never sends: her step says so, and an expired one is withdrawn first", () => {
    expect(nextStep("send_and_follow_up", snap({ submission: "ready" }), [])).toMatchObject({ use: null, how: expect.stringContaining("never sends"), askHer: expect.stringContaining("The Knot") });
    expect(nextStep("send_and_follow_up", snap(), [])).toMatchObject({ how: expect.stringContaining("build_package plan") });
    expect(nextStep("send_and_follow_up", snap({ submission: "sent" }), [])).toMatchObject({ use: "get_wedding", askHer: "Has the outlet answered yet?" });
    expect(nextStep("send_and_follow_up", snap({ submission: "expired" }), [])).toMatchObject({ how: expect.stringContaining("withdraws it") });
    expect(nextStep("send_and_follow_up", snap({ submission: "expired" }), [4])).toMatchObject({ done: true, next: expect.stringContaining("after_acceptance") });
  });

  it("points to the next outlet's package after a decline is answered but not yet released", () => {
    const step = nextStep("send_and_follow_up", snap({ submission: "withdraw_pending" }), []);
    expect(step).toMatchObject({ step: { n: 4 }, how: expect.stringContaining("next outlet") });
  });
});

describe("after_acceptance", () => {
  it("runs from the acceptance to the published link", () => {
    expect(statuses("after_acceptance", snap({ submission: "sent" }))).toEqual(["next", "to do", "to do"]);
    expect(statuses("after_acceptance", snap({ submission: "accepted" }))).toEqual(["done", "next", "to do"]);
    expect(nextStep("after_acceptance", snap({ submission: "accepted" }), [])).toMatchObject({ step: { n: 2 }, use: null, how: expect.any(String) });
    expect(nextStep("after_acceptance", snap({ submission: "accepted" }), [2])).toMatchObject({ step: { n: 3 }, askHer: expect.stringContaining("web address") });
    expect(nextStep("after_acceptance", snap({ submission: "sent" }), [])).toMatchObject({ askHer: expect.stringContaining("acceptance") });
    expect(nextStep("after_acceptance", snap({ submission: "published" }), [])).toEqual({ done: true, progress: "3 of 3 done", next: "This plan is finished." });
  });
});

describe("skips", () => {
  it("skips and brings back steps, checked against the template", () => {
    expect(reviseSkips("build_package", [2], [4, 2], [])).toEqual({ ok: true, skipped: [2, 4] });
    expect(reviseSkips("build_package", [2, 4], [], [2])).toEqual({ ok: true, skipped: [4] });
    expect(reviseSkips("build_package", [], [6, 0], [1.5])).toEqual({ ok: false, message: "This plan has steps 1 to 5; there is no step 6, 0, 1.5." });
    expect(statuses("build_package", snap({ pkg: null }), [1])).toEqual(["skipped", "next", "to do", "to do", "to do"]);
  });

  it("has a title and a step count for every template", () => {
    expect(PLAN_TEMPLATES.map((template) => [stepCount(template), TEMPLATE_TITLES[template].length > 0])).toEqual([
      [5, true],
      [3, true],
      [5, true],
      [4, true],
      [3, true],
    ]);
  });
});
