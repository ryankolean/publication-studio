import { describe, expect, it } from "vitest";

import { buildWalkthrough, evaluateIntake, outletFit } from "../src/domain/walkthrough.js";
import type {
  WalkthroughEvent,
  WalkthroughInput,
  WalkthroughOutlet,
  WalkthroughPackage,
  WalkthroughStep,
  WalkthroughSubmission,
} from "../src/domain/walkthrough.js";
import type { SubmissionStatus } from "../src/domain/submission-status.js";

const event = (overrides: Partial<WalkthroughEvent> = {}): WalkthroughEvent => ({
  id: "e1",
  coupleNames: "Sarah and James",
  eventDate: "2026-06-14",
  venueName: "The Barn",
  city: "Detroit",
  hasGalleryUrl: true,
  coupleStory: "They met at a bookshop.",
  uniqueAngle: null,
  nameDisplay: null,
  consentNotes: null,
  rightsStatus: "own_contract",
  consentStatus: "granted",
  priorExposure: { ownBlog: false, igPosted: false, priorPubs: [] },
  ...overrides,
});

const outlet = (overrides: Partial<WalkthroughOutlet> = {}): WalkthroughOutlet => ({
  id: "pub-a",
  name: "Outlet A",
  tier: "primary",
  method: "web_form",
  submissionUrl: "https://a.example.com/submit",
  exclusivityPolicy: "non_exclusive",
  countsOwnBlogAsPublished: null,
  typicalResponseDays: 28,
  responseWindowNote: null,
  earnedOrPaid: "earned",
  spec: { imgMin: null, imgMax: null, requirements: [] },
  ...overrides,
});

const withRequirements = (...requirements: string[]): Partial<WalkthroughOutlet> => ({
  spec: { imgMin: null, imgMax: null, requirements },
});

const open = (items: ReturnType<typeof evaluateIntake>) =>
  items.filter((item) => !item.done).map((item) => item.id);

describe("evaluateIntake", () => {
  it("lists the six things outlets ask of an event record, in order", () => {
    expect(evaluateIntake(event(), 1).map((item) => item.id)).toEqual([
      "couple_names",
      "event_date",
      "venue_or_city",
      "gallery_link",
      "vendor_credit",
      "story",
    ]);
  });

  it("gives every item a readable label", () => {
    for (const item of evaluateIntake(event(), 1)) expect(item.label).toMatch(/\S/);
  });

  it("is all done for a complete record", () => {
    expect(open(evaluateIntake(event(), 1))).toEqual([]);
  });

  it("opens couple names when blank", () => {
    expect(open(evaluateIntake(event({ coupleNames: "  " }), 1))).toEqual(["couple_names"]);
  });

  it("opens the event date when blank", () => {
    expect(open(evaluateIntake(event({ eventDate: "" }), 1))).toEqual(["event_date"]);
  });

  it("accepts a venue without a city", () => {
    expect(open(evaluateIntake(event({ city: null }), 1))).toEqual([]);
  });

  it("accepts a city without a venue", () => {
    expect(open(evaluateIntake(event({ venueName: null }), 1))).toEqual([]);
  });

  it("opens the place when neither venue nor city has text", () => {
    expect(open(evaluateIntake(event({ venueName: " ", city: null }), 1))).toEqual([
      "venue_or_city",
    ]);
  });

  it("opens the gallery link when none is on file", () => {
    expect(open(evaluateIntake(event({ hasGalleryUrl: false }), 1))).toEqual(["gallery_link"]);
  });

  it("opens vendor credits when there are none", () => {
    expect(open(evaluateIntake(event(), 0))).toEqual(["vendor_credit"]);
  });

  it("accepts a unique angle in place of a story", () => {
    expect(
      open(evaluateIntake(event({ coupleStory: null, uniqueAngle: "A ferry ceremony." }), 1)),
    ).toEqual([]);
  });

  it("opens the story when neither story nor angle has text", () => {
    expect(open(evaluateIntake(event({ coupleStory: "  ", uniqueAngle: null }), 1))).toEqual([
      "story",
    ]);
  });
});

const codes = (o: WalkthroughOutlet, e: WalkthroughEvent = event()) =>
  outletFit(o, e).warnings.map((warning) => warning.code);

const textOf = (o: WalkthroughOutlet, code: string, e: WalkthroughEvent = event()) =>
  outletFit(o, e).warnings.find((warning) => warning.code === code)?.text ?? "";

const posted = (overrides: Partial<WalkthroughEvent["priorExposure"]>) =>
  event({ priorExposure: { ownBlog: false, igPosted: false, priorPubs: [], ...overrides } });

describe("outletFit", () => {
  it("has nothing to say about an open, earned outlet with a known window", () => {
    expect(outletFit(outlet(), event())).toEqual({ warnings: [] });
  });

  it("gives every warning readable text", () => {
    const busy = outlet({
      exclusivityPolicy: "exclusive_required",
      earnedOrPaid: "paid",
      method: null,
      typicalResponseDays: null,
      ...withRequirements(
        "unpublished_only",
        "anti_bride_partner_required_if_accepted",
        "embargo_other_features_2_months_after_publication",
      ),
    });
    const warnings = outletFit(busy, event()).warnings;
    expect(warnings).toHaveLength(7);
    for (const warning of warnings) expect(warning.text).toMatch(/\S/);
  });

  describe("exclusivity", () => {
    it("warns that an exclusive_required outlet holds the event until it answers", () => {
      const required = outlet({ exclusivityPolicy: "exclusive_required" });
      expect(codes(required)).toEqual(["exclusive"]);
      expect(textOf(required, "exclusive")).toMatch(/blocks every other outlet/i);
    });

    it("treats the 30-day post-publication exclusivity requirement the same way", () => {
      const thirty = outlet(withRequirements("exclusive_30_days_after_publication"));
      expect(codes(thirty)).toEqual(["exclusive"]);
      expect(textOf(thirty, "exclusive")).toMatch(/30 days/);
    });

    it("says nothing about 30 days when only the policy is exclusive", () => {
      expect(textOf(outlet({ exclusivityPolicy: "exclusive_required" }), "exclusive")).not.toMatch(
        /30 days/,
      );
    });

    it("warns once when both the policy and the requirement apply", () => {
      const both = outlet({
        exclusivityPolicy: "exclusive_required",
        ...withRequirements("exclusive_30_days_after_publication"),
      });
      expect(codes(both)).toEqual(["exclusive"]);
    });

    it("does not warn for a preferred or unknown policy", () => {
      expect(codes(outlet({ exclusivityPolicy: "exclusive_preferred" }))).toEqual([]);
      expect(codes(outlet({ exclusivityPolicy: "unknown" }))).toEqual([]);
    });
  });

  describe("unpublished only", () => {
    const strict = (counts: boolean | null) =>
      outlet({ countsOwnBlogAsPublished: counts, ...withRequirements("unpublished_only") });

    it("warns that the outlet takes only unpublished work", () => {
      expect(codes(strict(null))).toEqual(["unpublished_only"]);
      expect(textOf(strict(null), "unpublished_only")).toMatch(/not been published/i);
    });

    it("is a conflict when the outlet counts the blog as published and the blog ran it", () => {
      const e = posted({ ownBlog: true });
      expect(codes(strict(true), e)).toEqual(["prior_exposure_conflict"]);
      expect(textOf(strict(true), "prior_exposure_conflict", e)).toMatch(/posted on your blog\./);
    });

    it("is a conflict when the outlet counts it and Instagram ran it", () => {
      const e = posted({ igPosted: true });
      expect(codes(strict(true), e)).toEqual(["prior_exposure_conflict"]);
      expect(textOf(strict(true), "prior_exposure_conflict", e)).toMatch(/posted to Instagram/);
    });

    it("names both places when both ran it", () => {
      const e = posted({ ownBlog: true, igPosted: true });
      expect(textOf(strict(true), "prior_exposure_conflict", e)).toMatch(
        /posted on your blog and to Instagram/,
      );
    });

    it("is not a conflict when the outlet counts it but nothing was posted", () => {
      expect(codes(strict(true))).toEqual(["unpublished_only"]);
    });

    it("is not a conflict when the outlet says the blog does not count", () => {
      expect(codes(strict(false), posted({ ownBlog: true }))).toEqual(["unpublished_only"]);
      expect(textOf(strict(false), "unpublished_only", posted({ ownBlog: true }))).not.toMatch(
        /does not say/,
      );
    });

    it("flags the open question when the outlet's view of the blog is unknown", () => {
      expect(textOf(strict(null), "unpublished_only", posted({ igPosted: true }))).toMatch(
        /posted to Instagram; the outlet does not say/,
      );
    });

    it("stays quiet about the blog when nothing was posted and the view is unknown", () => {
      expect(textOf(strict(null), "unpublished_only")).not.toMatch(/does not say/);
    });

    it("names earlier outlets on record so they can be checked", () => {
      const e = posted({ priorPubs: ["Somewhere", "Elsewhere"] });
      expect(textOf(strict(null), "unpublished_only", e)).toMatch(/Somewhere, Elsewhere/);
    });

    it("does not warn about prior exposure when the outlet takes published work", () => {
      expect(codes(outlet({ countsOwnBlogAsPublished: true }), posted({ ownBlog: true }))).toEqual(
        [],
      );
    });
  });

  describe("money", () => {
    it("warns of a fee on selection for a paid outlet", () => {
      expect(codes(outlet({ earnedOrPaid: "paid" }))).toEqual(["fee_on_selection"]);
      expect(textOf(outlet({ earnedOrPaid: "paid" }), "fee_on_selection")).toMatch(/fee/i);
    });

    it("warns of a fee on selection for the processing-fee requirement", () => {
      expect(codes(outlet(withRequirements("processing_fee_if_selected")))).toEqual([
        "fee_on_selection",
      ]);
    });

    it("warns that a mixed outlet may be paid", () => {
      expect(codes(outlet({ earnedOrPaid: "mixed" }))).toEqual(["may_be_paid"]);
    });

    it("prefers the definite fee over the maybe when a mixed outlet states one", () => {
      expect(
        codes(outlet({ earnedOrPaid: "mixed", ...withRequirements("processing_fee_if_selected") })),
      ).toEqual(["fee_on_selection"]);
    });
  });

  it("warns that acceptance requires a brand partnership", () => {
    expect(codes(outlet(withRequirements("anti_bride_partner_required_if_accepted")))).toEqual([
      "partnership_required",
    ]);
  });

  it("warns of the two-month embargo after publication", () => {
    const embargo = outlet(withRequirements("embargo_other_features_2_months_after_publication"));
    expect(codes(embargo)).toEqual(["embargo"]);
    expect(textOf(embargo, "embargo")).toMatch(/2 months/);
  });

  it("warns that an outlet with no method is a pitch, not a form", () => {
    expect(codes(outlet({ method: null }))).toEqual(["no_public_route"]);
  });

  it("warns that an outlet with no stated window has no due date", () => {
    expect(codes(outlet({ typicalResponseDays: null }))).toEqual(["window_unknown"]);
  });

  it("orders warnings consistently", () => {
    const all = outlet({
      exclusivityPolicy: "exclusive_required",
      earnedOrPaid: "mixed",
      method: null,
      typicalResponseDays: null,
      ...withRequirements(
        "embargo_other_features_2_months_after_publication",
        "anti_bride_partner_required_if_accepted",
        "unpublished_only",
      ),
    });
    expect(codes(all)).toEqual([
      "exclusive",
      "unpublished_only",
      "may_be_paid",
      "partnership_required",
      "embargo",
      "no_public_route",
      "window_unknown",
    ]);
  });
});

const submission = (
  status: SubmissionStatus,
  overrides: Partial<WalkthroughSubmission> = {},
): WalkthroughSubmission => ({ id: "s1", status, due: null, publishedUrl: null, ...overrides });

const pkg = (overrides: Partial<WalkthroughPackage> = {}): WalkthroughPackage => ({
  id: "pk1",
  outlet: outlet(),
  imageCount: 30,
  complete: true,
  missingLabels: [],
  submission: null,
  ...overrides,
});

const input = (overrides: Partial<WalkthroughInput> = {}): WalkthroughInput => ({
  event: event(),
  vendorCreditCount: 2,
  poolCount: 40,
  outlets: [outlet()],
  selected: null,
  liveElsewhere: [],
  ...overrides,
});

const walk = (overrides: Partial<WalkthroughInput> = {}) => buildWalkthrough(input(overrides));

/** The walkthrough with a package selected whose submission is in this state. */
const at = (status: SubmissionStatus, extra: Partial<WalkthroughSubmission> = {}) =>
  walk({ selected: pkg({ submission: submission(status, extra) }) });

function step(steps: WalkthroughStep[], id: string): WalkthroughStep {
  const found = steps.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no ${id} step`);
  return found;
}

const statuses = (steps: WalkthroughStep[]) =>
  Object.fromEntries(steps.map((entry) => [entry.id, entry.status]));

const currentIds = (steps: WalkthroughStep[]) =>
  steps.filter((entry) => entry.status === "current").map((entry) => entry.id);

const SENT_OR_LATER: SubmissionStatus[] = [
  "sent",
  "accepted",
  "published",
  "declined",
  "expired",
  "withdraw_pending",
  "withdrawn",
];

const ANSWERED: SubmissionStatus[] = [
  "accepted",
  "published",
  "declined",
  "expired",
  "withdraw_pending",
  "withdrawn",
];

describe("buildWalkthrough", () => {
  describe("shape", () => {
    it("lists eight steps in order before anything is accepted", () => {
      expect(walk().map((entry) => entry.id)).toEqual([
        "intake",
        "rights",
        "outlet",
        "images",
        "package",
        "submission",
        "send",
        "response",
      ]);
    });

    it("titles and summarises every step", () => {
      for (const entry of walk()) {
        expect(entry.title).toMatch(/\S/);
        expect(entry.summary).toMatch(/\S/);
      }
    });

    it("adds the live-link step once the outlet accepts", () => {
      expect(at("accepted").map((entry) => entry.id).at(-1)).toBe("published");
      expect(at("published", { publishedUrl: "https://x.example.com/f" }).map((e) => e.id).at(-1)).toBe(
        "published",
      );
    });

    it("leaves the live-link step out for every other status", () => {
      for (const status of ["ready", "queued", "sent", "declined", "expired", "cancelled"] as const) {
        expect(at(status), status).toHaveLength(8);
        expect(at(status).some((entry) => entry.id === "published"), status).toBe(false);
      }
    });
  });

  describe("the current step", () => {
    it("is the first step not done", () => {
      expect(statuses(walk())).toEqual({
        intake: "done",
        rights: "done",
        outlet: "current",
        images: "done",
        package: "todo",
        submission: "todo",
        send: "todo",
        response: "todo",
      });
    });

    it("is exactly one step while anything is open", () => {
      expect(currentIds(walk())).toEqual(["outlet"]);
      expect(currentIds(walk({ vendorCreditCount: 0 }))).toEqual(["intake"]);
      expect(currentIds(at("sent"))).toEqual(["response"]);
    });

    it("is a blocked step when that comes first, with everything after it to do", () => {
      const steps = walk({
        event: event({ consentStatus: "unverified" }),
        selected: pkg({ submission: submission("cancelled") }),
      });
      expect(statuses(steps)).toMatchObject({
        intake: "done",
        rights: "current",
        outlet: "done",
        send: "todo",
        response: "todo",
      });
      expect(step(steps, "rights").summary).toMatch(/^Blocked/);
    });

    it("shows a later blocked step as blocked while an earlier step is current", () => {
      const steps = walk({ vendorCreditCount: 0, event: event({ consentStatus: "unverified" }) });
      expect(statuses(steps)).toMatchObject({ intake: "current", rights: "blocked", outlet: "todo" });
    });

    it("is none once every step is done", () => {
      const steps = at("published", { publishedUrl: "https://x.example.com/f" });
      expect(steps).toHaveLength(9);
      expect(steps.every((entry) => entry.status === "done")).toBe(true);
    });
  });

  describe("intake", () => {
    it("lists the open items and links to the edit page", () => {
      const intake = step(walk({ vendorCreditCount: 0, event: event({ hasGalleryUrl: false }) }), "intake");
      expect(intake.status).toBe("current");
      expect(intake.detail).toEqual(["Gallery link on file", "At least one vendor credit"]);
      expect(intake.summary).toMatch(/2 of 6/);
      expect(intake.action).toEqual({ label: "Edit the event", href: "/events/e1/edit" });
    });

    it("is done with nothing listed when the record is complete", () => {
      const intake = step(walk(), "intake");
      expect(intake.status).toBe("done");
      expect(intake.detail).toEqual([]);
    });
  });

  describe("rights", () => {
    it("is done when the gate allows, and links to the edit page", () => {
      const rights = step(walk(), "rights");
      expect(rights.status).toBe("done");
      expect(rights.detail).toEqual([]);
      expect(rights.action).toEqual({ label: "Edit rights and consent", href: "/events/e1/edit" });
    });

    it("accepts consent granted with limits", () => {
      expect(step(walk({ event: event({ consentStatus: "granted_limited" }) }), "rights").status).toBe(
        "done",
      );
    });

    it("blocks with the gate's own remedies", () => {
      const rights = step(walk({ event: event({ rightsStatus: "unverified" }) }), "rights");
      expect(rights.status).toBe("current");
      expect(rights.detail.join(" ")).toMatch(/contracted lead/);
    });

    it("sends second-shooter work to credit recovery", () => {
      const rights = step(walk({ event: event({ rightsStatus: "second_shooter" }) }), "rights");
      expect(rights.summary).toMatch(/credit recovery/);
    });

    it("quotes the couple's limits when there are any", () => {
      const rights = step(
        walk({ event: event({ nameDisplay: "First names only", consentNotes: " No guest faces " }) }),
        "rights",
      );
      expect(rights.detail).toEqual([
        'Name display: "First names only"',
        'Consent notes: "No guest faces"',
      ]);
    });

    it("skips blank limits", () => {
      expect(step(walk({ event: event({ nameDisplay: " ", consentNotes: null }) }), "rights").detail).toEqual(
        [],
      );
    });
  });

  describe("outlet", () => {
    it("asks for a choice and leaves the chooser to the page", () => {
      const choice = step(walk(), "outlet");
      expect(choice.status).toBe("current");
      expect(choice.action).toBeNull();
    });

    it("is done once a package is loaded, naming its outlet", () => {
      const choice = step(walk({ selected: pkg() }), "outlet");
      expect(choice.status).toBe("done");
      expect(choice.summary).toMatch(/Outlet A/);
    });

    it("describes every active outlet with tier, method, bounds, window and warnings", () => {
      const choice = step(
        walk({
          outlets: [
            outlet({ spec: { imgMin: 30, imgMax: 40, requirements: [] } }),
            outlet({
              name: "Outlet B",
              tier: "dream",
              method: null,
              typicalResponseDays: null,
              spec: { imgMin: 100, imgMax: null, requirements: [] },
            }),
            outlet({ name: "Outlet C", method: "portal", spec: { imgMin: null, imgMax: 150, requirements: [] } }),
            outlet({ name: "Outlet D", method: "email" }),
            outlet({ name: "Outlet E", method: "aggregator" }),
          ],
        }),
        "outlet",
      );
      expect(choice.detail).toHaveLength(5);
      expect(choice.detail[0]).toBe("Outlet A (primary, web form): 30 to 40 images; replies in about 28 days.");
      expect(choice.detail[1]).toMatch(
        /^Outlet B \(dream, no public route\): at least 100 images; response window unknown\. .*pitch to an editor.*no due date/,
      );
      expect(choice.detail[2]).toMatch(/^Outlet C \(primary, portal\): at most 150 images;/);
      expect(choice.detail[3]).toMatch(/^Outlet D \(primary, email\): no stated image count;/);
      expect(choice.detail[4]).toMatch(/^Outlet E \(primary, aggregator\):/);
    });
  });

  describe("images", () => {
    const withMin = (imgMin: number | null, imgMax: number | null = null) =>
      pkg({ outlet: outlet({ spec: { imgMin, imgMax, requirements: [] } }) });

    it("is done when the pool reaches the outlet's minimum", () => {
      expect(step(walk({ selected: withMin(30), poolCount: 30 }), "images").status).toBe("done");
    });

    it("is open below the outlet's minimum and says how many are needed", () => {
      const images = step(walk({ selected: withMin(30), poolCount: 29 }), "images");
      expect(images.status).toBe("current");
      expect(images.summary).toMatch(/at least 30/);
    });

    it("stays done past the outlet's maximum, because the package selects from the pool", () => {
      expect(step(walk({ selected: withMin(30, 40), poolCount: 60 }), "images").status).toBe("done");
    });

    it("needs at least one image when there are no bounds", () => {
      expect(step(walk({ poolCount: 0 }), "images").status).toBe("todo");
      expect(step(walk({ poolCount: 1 }), "images").status).toBe("done");
      expect(step(walk({ selected: withMin(null), poolCount: 0 }), "images").status).toBe("current");
    });

    it("needs at least one image even when an outlet states a minimum of zero", () => {
      expect(step(walk({ selected: withMin(0), poolCount: 0 }), "images").status).toBe("current");
    });

    it("explains where the images come from and what to cover, and links to the event", () => {
      const images = step(walk({ selected: withMin(30, 40), poolCount: 12 }), "images");
      expect(images.detail[0]).toMatch(/web-size files from the gallery/);
      expect(images.detail[1]).toMatch(/getting ready, details, ceremony, portraits, reception/);
      expect(images.detail[2]).toBe("Outlet A asks for 30 to 40 images; the pool has 12.");
      expect(images.action).toEqual({ label: "Open the event", href: "/events/e1" });
    });

    it("says when the outlet states no count", () => {
      expect(step(walk({ selected: withMin(null), poolCount: 3 }), "images").detail[2]).toBe(
        "Outlet A states no image count; the pool has 3.",
      );
    });

    it("waits for an outlet before naming a count", () => {
      expect(step(walk(), "images").detail[2]).toMatch(/Choose an outlet/);
    });

    it("points at the edit page when no gallery link is on file", () => {
      expect(step(walk({ event: event({ hasGalleryUrl: false }) }), "images").detail[0]).toMatch(
        /No gallery link is on file/,
      );
      expect(step(walk(), "images").detail[0]).not.toMatch(/No gallery link/);
    });
  });

  describe("package", () => {
    it("waits for an outlet, with nowhere to go yet", () => {
      const build = step(walk(), "package");
      expect(build.status).toBe("todo");
      expect(build.detail).toEqual([]);
      expect(build.action).toBeNull();
    });

    it("lists the missing checklist labels and links to the editor", () => {
      const build = step(
        walk({ selected: pkg({ complete: false, missingLabels: ["Event description written", "Confirm web-size"] }) }),
        "package",
      );
      expect(build.status).toBe("current");
      expect(build.detail).toEqual(["Event description written", "Confirm web-size"]);
      expect(build.summary).toMatch(/2 checklist items open/);
      expect(build.action).toEqual({ label: "Open the package", href: "/packages/pk1" });
    });

    it("is done when the checklist is complete", () => {
      expect(step(walk({ selected: pkg() }), "package").status).toBe("done");
    });
  });

  describe("submission", () => {
    it("is open until a submission exists, pointing at the editor's button", () => {
      const queue = step(walk({ selected: pkg() }), "submission");
      expect(queue.status).toBe("current");
      expect(queue.action).toEqual({ label: "Open the package", href: "/packages/pk1" });
    });

    it("is done once a submission exists", () => {
      expect(step(at("ready"), "submission").status).toBe("done");
    });

    it("has nowhere to go before an outlet is chosen", () => {
      expect(step(walk(), "submission").action).toBeNull();
    });
  });

  describe("send", () => {
    it("is open while the submission waits in the queue", () => {
      expect(step(at("ready"), "send").status).toBe("current");
      expect(step(at("queued"), "send").status).toBe("current");
    });

    it("is done once marked sent, and at every later status", () => {
      for (const status of SENT_OR_LATER) {
        expect(step(at(status), "send").status, status).toBe("done");
      }
    });

    it("spells out the route, what to paste, the warnings, and that nothing is sent", () => {
      const send = step(
        walk({
          selected: pkg({
            imageCount: 32,
            outlet: outlet({ exclusivityPolicy: "exclusive_required" }),
            submission: submission("ready"),
          }),
        }),
        "send",
      );
      expect(send.detail).toEqual([
        "How to send: the outlet's web form.",
        "Submission page: https://a.example.com/submit",
        "Paste the description from the package.",
        "Paste the credits block from the package.",
        "Upload the selected images (32) in the package's order.",
        "Exclusive: sending here blocks every other outlet for this wedding until it answers.",
        "Nothing is sent by this tool. Send it yourself, then mark it sent in the queue.",
      ]);
      expect(send.action).toEqual({ label: "Open the queue", href: "/queue" });
    });

    it("names each route, and leaves out a submission page the outlet does not have", () => {
      const route = (method: WalkthroughOutlet["method"]) =>
        step(walk({ selected: pkg({ outlet: outlet({ method, submissionUrl: null }) }) }), "send").detail;
      expect(route("portal")[0]).toBe("How to send: the outlet's portal.");
      expect(route("email")[0]).toBe("How to send: email to the outlet's submissions inbox.");
      expect(route("aggregator")[0]).toBe("How to send: the aggregator's submission form.");
      expect(route(null)[0]).toMatch(/no public route/);
      expect(route("portal")[1]).toBe("Paste the description from the package.");
    });

    it("still says nothing is sent before an outlet is chosen", () => {
      expect(step(walk(), "send").detail).toEqual([
        "Nothing is sent by this tool. Send it yourself, then mark it sent in the queue.",
      ]);
    });

    it("is blocked when the submission was cancelled before it went out", () => {
      const send = step(walk({ vendorCreditCount: 0, selected: pkg({ submission: submission("cancelled") }) }), "send");
      expect(send.status).toBe("blocked");
      expect(send.summary).toMatch(/Cancelled/);
      expect(send.detail[0]).toMatch(/cancelled before it was sent/);
    });

    it("is blocked while the event is live at another outlet", () => {
      const send = step(
        walk({ vendorCreditCount: 0, selected: pkg({ submission: submission("ready") }), liveElsewhere: ["Outlet Z"] }),
        "send",
      );
      expect(send.status).toBe("blocked");
      expect(send.summary).toMatch(/Outlet Z/);
      expect(send.detail[0]).toMatch(/live at Outlet Z/);
    });

    it("is not blocked by another outlet once this one was sent", () => {
      const steps = walk({ selected: pkg({ submission: submission("sent") }), liveElsewhere: ["Outlet Z"] });
      expect(step(steps, "send").status).toBe("done");
      expect(step(steps, "send").detail.join(" ")).not.toMatch(/Outlet Z/);
    });
  });

  describe("response", () => {
    it("is current once sent and done at every answer", () => {
      expect(step(at("sent"), "response").status).toBe("current");
      for (const status of ANSWERED) {
        expect(step(at(status), "response").status, status).toBe("done");
      }
    });

    it("is not done for a submission cancelled before it was sent", () => {
      expect(step(at("cancelled"), "response").status).not.toBe("done");
    });

    it("summarises each answer", () => {
      expect(step(at("sent"), "response").summary).toMatch(/Waiting/);
      expect(step(at("accepted"), "response").summary).toBe("Accepted.");
      expect(step(at("published"), "response").summary).toMatch(/published/);
      expect(step(at("declined"), "response").summary).toMatch(/free for another outlet/);
      expect(step(at("expired"), "response").summary).toMatch(/No answer/);
      expect(step(at("withdraw_pending"), "response").summary).toMatch(/Withdrawal pending/);
      expect(step(at("withdrawn"), "response").summary).toMatch(/free for another outlet/);
      expect(step(at("cancelled"), "response").summary).toMatch(/Cancelled/);
      expect(step(walk(), "response").summary).toMatch(/once you mark it sent/);
    });

    it("gives the due date and the days left", () => {
      const due = (daysRemaining: number) =>
        step(at("sent", { due: { at: "2026-11-16T12:00:00Z", daysRemaining } }), "response").detail[0];
      expect(due(28)).toBe("Due 2026-11-16: 28 days remaining.");
      expect(due(1)).toBe("Due 2026-11-16: 1 day remaining.");
      expect(due(0)).toBe("Due 2026-11-16: today is the last day.");
      expect(due(-3)).toBe("Due 2026-11-16: the window has passed.");
    });

    it("says when there is no due date", () => {
      expect(step(at("sent"), "response").detail[0]).toMatch(/no response window/);
      expect(step(at("ready"), "response").detail[0]).toMatch(/set when you mark it sent/);
    });

    it("quotes the outlet's own words and reads silence as a pass when they tie replies to success", () => {
      for (const note of [
        "we will be in touch within 10 business days to confirm successful submissions only",
        "will contact you within 15 days if the wedding has been selected",
        "not heard back from our team within two months",
      ]) {
        const detail = step(
          walk({ selected: pkg({ outlet: outlet({ responseWindowNote: note }), submission: submission("sent") }) }),
          "response",
        ).detail;
        expect(detail[1]).toBe(`The outlet's own words: "${note}".`);
        expect(detail[2], note).toMatch(/no reply by the due date means it passed/);
      }
    });

    it("does not guess what silence means when the wording does not say", () => {
      const detail = step(
        walk({
          selected: pkg({
            outlet: outlet({ responseWindowNote: "Approval typically takes about two weeks." }),
            submission: submission("sent"),
          }),
        }),
        "response",
      ).detail;
      expect(detail[2]).toMatch(/does not say what silence means/);
    });

    it("says when the outlet publishes no wording", () => {
      expect(step(at("sent"), "response").detail[1]).toMatch(/no wording about its replies/);
    });

    it("advises a withdrawal note while waiting, and once the window has passed", () => {
      expect(step(at("sent"), "response").detail.at(-1)).toMatch(/If the due date passes/);
      expect(step(walk(), "response").detail.at(-1)).toMatch(/If the due date passes/);
      expect(step(at("expired"), "response").detail.at(-1)).toMatch(/window passed without an answer/);
      expect(step(at("withdraw_pending"), "response").detail.at(-1)).toMatch(/withdrawal note/);
      expect(step(at("declined"), "response").detail.join(" ")).not.toMatch(/withdrawal/);
    });

    it("links to the queue", () => {
      expect(step(at("sent"), "response").action).toEqual({ label: "Open the queue", href: "/queue" });
    });
  });

  describe("published", () => {
    it("asks for the live link once accepted, rendered by the page", () => {
      const live = step(at("accepted"), "published");
      expect(live.status).toBe("current");
      expect(live.detail).toEqual(["Paste the address of the live feature."]);
      expect(live.action).toBeNull();
    });

    it("is done with the link once published", () => {
      const live = step(at("published", { publishedUrl: "https://x.example.com/feature" }), "published");
      expect(live.status).toBe("done");
      expect(live.detail).toEqual(["Live at https://x.example.com/feature"]);
    });
  });
});
