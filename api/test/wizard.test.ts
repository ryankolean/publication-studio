import { describe, expect, it } from "vitest";

import {
  WIZARD_STEPS,
  buildWizard,
  followedPackageId,
  gateWords,
  weddingChip,
} from "../src/domain/wizard.js";
import type { WizardInput, WizardPackage } from "../src/domain/wizard.js";
import type { WalkthroughEvent, WalkthroughOutlet } from "../src/domain/walkthrough.js";
import type { SubmissionStatus } from "../src/domain/submission-status.js";

const event = (overrides: Partial<WalkthroughEvent> = {}): WalkthroughEvent => ({
  id: "e1",
  coupleNames: "Sarah and James",
  eventDate: "2026-06-14",
  venueName: "The Barn",
  city: "Detroit",
  hasGalleryUrl: true,
  coupleStory: null,
  uniqueAngle: "A ceremony on a frozen lake.",
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

const pkg = (overrides: Partial<WizardPackage> = {}): WizardPackage => ({
  id: "pk1",
  outlet: outlet(),
  imagesReady: true,
  writeupReady: true,
  complete: true,
  submission: null,
  ...overrides,
});

const submitted = (status: SubmissionStatus, extra: Partial<NonNullable<WizardPackage["submission"]>> = {}) =>
  pkg({ submission: { id: "s1", status, due: null, publishedUrl: null, ...extra } });

const input = (overrides: Partial<WizardInput> = {}): WizardInput => ({
  event: event(),
  vendorCreditCount: 1,
  followed: null,
  liveElsewhere: [],
  ...overrides,
});

const done = (wizard: ReturnType<typeof buildWizard>) =>
  wizard.steps.filter((entry) => entry.done).map((entry) => entry.id);

describe("WIZARD_STEPS", () => {
  it("is the ten screens after choosing a wedding, in order", () => {
    expect(WIZARD_STEPS).toEqual([
      "wedding",
      "permissions",
      "story",
      "outlet",
      "photos",
      "writeup",
      "confirm",
      "review",
      "send",
      "track",
    ]);
  });
});

describe("buildWizard: where to resume", () => {
  it("lists every step with its done flag, in order", () => {
    const wizard = buildWizard(input());
    expect(wizard.steps.map((entry) => entry.id)).toEqual([...WIZARD_STEPS]);
  });

  it("resumes at the wedding when its names are missing", () => {
    expect(buildWizard(input({ event: event({ coupleNames: " " }) })).step).toBe("wedding");
  });

  it("resumes at the wedding when its date is missing", () => {
    expect(buildWizard(input({ event: event({ eventDate: "" }) })).step).toBe("wedding");
  });

  it("resumes at the wedding when neither venue nor city is known", () => {
    const wizard = buildWizard(input({ event: event({ venueName: null, city: " " }) }));
    expect(wizard.step).toBe("wedding");
    expect(done(wizard)).not.toContain("wedding");
  });

  it("counts the wedding done with a city and no venue", () => {
    expect(done(buildWizard(input({ event: event({ venueName: null }) })))).toContain("wedding");
  });

  it("resumes at permissions when no gallery link is on file", () => {
    expect(buildWizard(input({ event: event({ hasGalleryUrl: false }) })).step).toBe("permissions");
  });

  it("resumes at permissions while the contract question is unanswered", () => {
    expect(buildWizard(input({ event: event({ rightsStatus: "unverified" }) })).step).toBe("permissions");
  });

  it("resumes at permissions while the couple has not been asked", () => {
    expect(buildWizard(input({ event: event({ consentStatus: "unverified" }) })).step).toBe("permissions");
  });

  it("counts permissions done once both are answered, even with a no", () => {
    const wizard = buildWizard(input({ event: event({ rightsStatus: "second_shooter", consentStatus: "declined" }) }));
    expect(done(wizard)).toEqual(["wedding", "permissions", "story"]);
  });

  it("resumes at the story with no standout detail and no story", () => {
    expect(buildWizard(input({ event: event({ uniqueAngle: null, coupleStory: "  " }) })).step).toBe("story");
  });

  it("accepts the couple's story in place of the standout detail", () => {
    const wizard = buildWizard(input({ event: event({ uniqueAngle: null, coupleStory: "Met at a bookshop." }) }));
    expect(done(wizard)).toContain("story");
  });

  it("resumes at the story with no vendor credited", () => {
    expect(buildWizard(input({ vendorCreditCount: 0 })).step).toBe("story");
  });

  it("resumes at the outlet once the record is complete and nothing is chosen", () => {
    const wizard = buildWizard(input());
    expect(wizard.step).toBe("outlet");
    expect(wizard.packageId).toBeNull();
    expect(done(wizard)).toEqual(["wedding", "permissions", "story"]);
  });

  it("resumes at the photos when the selection is short of the outlet's count", () => {
    const wizard = buildWizard(input({ followed: pkg({ imagesReady: false, complete: false }) }));
    expect(wizard.step).toBe("photos");
    expect(wizard.packageId).toBe("pk1");
  });

  it("resumes at the write-up when it or the credits are empty", () => {
    expect(buildWizard(input({ followed: pkg({ writeupReady: false, complete: false }) })).step).toBe("writeup");
  });

  it("resumes at the final checks while the package is incomplete", () => {
    expect(buildWizard(input({ followed: pkg({ complete: false }) })).step).toBe("confirm");
  });

  it("resumes at the review once the package is complete and not queued", () => {
    expect(buildWizard(input({ followed: pkg() })).step).toBe("review");
  });

  it.each(["ready", "queued"] as const)("resumes at the send while the submission is %s", (status) => {
    expect(buildWizard(input({ followed: submitted(status) })).step).toBe("send");
  });

  it("resumes at the reply once sent", () => {
    const wizard = buildWizard(input({ followed: submitted("sent") }));
    expect(wizard.step).toBe("track");
    expect(wizard.finished).toBe(false);
    expect(done(wizard)).not.toContain("track");
  });

  it.each(["accepted", "published", "declined", "expired", "withdraw_pending", "withdrawn"] as const)(
    "is finished once the outlet's answer is %s",
    (status) => {
      const wizard = buildWizard(input({ followed: submitted(status) }));
      expect(wizard.step).toBe("track");
      expect(wizard.finished).toBe(true);
      expect(done(wizard)).toEqual([...WIZARD_STEPS]);
    },
  );

  it("goes back to the first unfinished step, even after later ones are done", () => {
    const wizard = buildWizard(input({ vendorCreditCount: 0, followed: submitted("sent") }));
    expect(wizard.step).toBe("story");
    expect(done(wizard)).toEqual(expect.arrayContaining(["review", "send"]));
  });
});

describe("buildWizard: the rights gate", () => {
  it("lets a blocked wedding through the first three steps and stops it at the outlet", () => {
    const wizard = buildWizard(input({ event: event({ rightsStatus: "second_shooter" }) }));
    expect(wizard.step).toBe("outlet");
    expect(done(wizard)).toEqual(["wedding", "permissions", "story"]);
    expect(wizard.blocked).toEqual({
      step: "outlet",
      reasons: ["Second-shooter weddings cannot be submitted under your name."],
    });
  });

  it("reports the block even while an earlier step is the one to resume", () => {
    const wizard = buildWizard(input({ event: event({ consentStatus: "unverified" }) }));
    expect(wizard.step).toBe("permissions");
    expect(wizard.blocked?.step).toBe("outlet");
  });

  it("does not count the outlet done behind a closed gate, even with a package", () => {
    const wizard = buildWizard(input({ event: event({ consentStatus: "declined" }), followed: pkg() }));
    expect(wizard.step).toBe("outlet");
    expect(done(wizard)).not.toContain("outlet");
  });

  it("is not blocked with the gate open", () => {
    expect(buildWizard(input()).blocked).toBeNull();
  });
});

describe("buildWizard: holding the send", () => {
  it("holds the send while the wedding is live at another outlet", () => {
    const wizard = buildWizard(input({ followed: submitted("queued"), liveElsewhere: ["Outlet B"] }));
    expect(wizard.step).toBe("send");
    expect(wizard.blocked).toEqual({
      step: "send",
      reasons: ["This wedding is waiting on Outlet B. Record Outlet B's answer before sending it here."],
    });
  });

  it("does not hold a send that already happened", () => {
    expect(buildWizard(input({ followed: submitted("sent"), liveElsewhere: ["Outlet B"] })).blocked).toBeNull();
  });

  it("does not hold a send before the submission exists", () => {
    expect(buildWizard(input({ followed: pkg(), liveElsewhere: ["Outlet B"] })).blocked).toBeNull();
  });

  it("stops at the send for a submission cancelled before it went", () => {
    const wizard = buildWizard(input({ followed: submitted("cancelled") }));
    expect(wizard.step).toBe("send");
    expect(wizard.finished).toBe(false);
    expect(wizard.blocked).toEqual({
      step: "send",
      reasons: ["This submission was cancelled before it was sent. Choose another outlet to go on."],
    });
  });
});

describe("buildWizard: the followed outlet and its reply", () => {
  it("carries the outlet's name, route and warnings", () => {
    const wizard = buildWizard(
      input({ followed: pkg({ outlet: outlet({ method: "portal", exclusivityPolicy: "exclusive_required" }) }) }),
    );
    expect(wizard.outlet).toMatchObject({
      id: "pub-a",
      name: "Outlet A",
      method: "portal",
      submissionUrl: "https://a.example.com/submit",
      typicalResponseDays: 28,
    });
    expect(wizard.outlet?.warnings.map((warning) => warning.code)).toEqual(["exclusive"]);
  });

  it("has no outlet and no reply before a package is chosen", () => {
    const wizard = buildWizard(input());
    expect(wizard.outlet).toBeNull();
    expect(wizard.submission).toBeNull();
    expect(wizard.reply).toBeNull();
  });

  it("has no reply before the send", () => {
    expect(buildWizard(input({ followed: submitted("queued") })).reply).toBeNull();
  });

  it("carries the due date and days remaining once sent", () => {
    const wizard = buildWizard(
      input({ followed: submitted("sent", { due: { at: "2026-11-16T12:00:00Z", daysRemaining: 28 } }) }),
    );
    expect(wizard.submission).toEqual({
      id: "s1",
      status: "sent",
      due: { at: "2026-11-16T12:00:00Z", daysRemaining: 28 },
      publishedUrl: null,
    });
    expect(wizard.reply).toEqual({
      dueAt: "2026-11-16T12:00:00Z",
      daysRemaining: 28,
      outletWords: null,
      silenceMeansPass: null,
    });
  });

  it("quotes the outlet's words and reads silence as a pass when they say so", () => {
    const note = "Only successful submissions hear back.";
    const wizard = buildWizard(
      input({ followed: { ...submitted("sent"), outlet: outlet({ typicalResponseDays: null, responseWindowNote: note }) } }),
    );
    expect(wizard.reply).toEqual({ dueAt: null, daysRemaining: null, outletWords: note, silenceMeansPass: true });
  });

  it("does not guess when the words do not say what silence means", () => {
    const wizard = buildWizard(
      input({ followed: { ...submitted("declined"), outlet: outlet({ responseWindowNote: "Replies within a month." }) } }),
    );
    expect(wizard.reply?.silenceMeansPass).toBe(false);
  });
});

describe("followedPackageId", () => {
  const entry = (id: string, status: SubmissionStatus | null) => ({
    id,
    submission: status === null ? null : { status },
  });

  it("is null for an event with no packages", () => {
    expect(followedPackageId([])).toBeNull();
  });

  it("follows the newest package whose submission is still open", () => {
    expect(followedPackageId([entry("new", null), entry("live", "sent"), entry("older", "ready")])).toBe("live");
  });

  it.each(["ready", "queued", "sent", "accepted", "expired", "withdraw_pending"] as const)(
    "counts a %s submission as open",
    (status) => {
      expect(followedPackageId([entry("a", null), entry("b", status)])).toBe("b");
    },
  );

  it("falls back to the newest package not yet queued", () => {
    expect(followedPackageId([entry("done", "declined"), entry("new", null), entry("old", null)])).toBe("new");
  });

  it.each(["published", "declined", "withdrawn", "cancelled", "draft"] as const)(
    "does not follow a package whose submission is %s",
    (status) => {
      expect(followedPackageId([entry("a", status)])).toBeNull();
    },
  );
});

describe("weddingChip", () => {
  it("says ready when the record is complete and the gate is open", () => {
    expect(weddingChip(event(), 1)).toMatchObject({ kind: "ready", label: "Ready to send" });
  });

  it("says details are needed when an intake item is open", () => {
    expect(weddingChip(event({ hasGalleryUrl: false }), 1)).toMatchObject({ kind: "needs_details", label: "Needs details" });
    expect(weddingChip(event(), 0)).toMatchObject({ kind: "needs_details", label: "Needs details" });
  });

  it("says where the wedding stands with an outlet once a submission exists", () => {
    const pkg = (status: string, publicationName = "Loverly") => ({
      id: `pk-${status}`,
      publicationName,
      submission: { status: status as never },
    });
    expect(weddingChip(event(), 1, [pkg("ready")])).toMatchObject({ kind: "queued", label: "In the queue for Loverly" });
    expect(weddingChip(event(), 1, [pkg("queued")]).label).toBe("In the queue for Loverly");
    expect(weddingChip(event(), 1, [pkg("sent")])).toMatchObject({ kind: "live", label: "Sent to Loverly" });
    expect(weddingChip(event(), 1, [pkg("accepted")])).toMatchObject({ kind: "accepted", label: "Accepted by Loverly" });
    expect(weddingChip(event(), 1, [pkg("expired")]).label).toBe("Reply overdue from Loverly");
    expect(weddingChip(event(), 1, [pkg("published")])).toMatchObject({ kind: "published", label: "Published at Loverly" });
    // Newest package first: a fresh queue entry outranks an older published one.
    expect(weddingChip(event(), 1, [pkg("queued", "Brides"), pkg("published")]).label).toBe("In the queue for Brides");
    // A declined or cancelled submission releases the wedding.
    expect(weddingChip(event(), 1, [pkg("declined")]).label).toBe("Ready to send");
    expect(weddingChip(event({ hasGalleryUrl: false }), 0, [pkg("cancelled")]).label).toBe("Needs details");
    // The outlet's state outranks a tidy record, but never the gate.
    expect(weddingChip(event({ hasGalleryUrl: false }), 0, [pkg("sent")]).label).toBe("Sent to Loverly");
    expect(weddingChip(event({ consentStatus: "declined" }), 1, [pkg("sent")]).kind).toBe("blocked");
  });


  it("names the package the chip describes", () => {
    const sent = { id: "pk2", publicationName: "Outlet A", submission: { status: "sent" as const } };
    const old = { id: "pk1", publicationName: "Outlet B", submission: { status: "declined" as const } };
    expect(weddingChip(event(), 1, [sent, old]).packageId).toBe("pk2");
    expect(weddingChip(event(), 1, [old]).packageId).toBeNull();
    expect(weddingChip(event(), 1).packageId).toBeNull();
    const published = { id: "pk3", publicationName: "Outlet A", submission: { status: "published" as const } };
    expect(weddingChip(event(), 1, [published])).toMatchObject({ kind: "published", packageId: "pk3" });
  });
  it("says blocked, and why, before anything else", () => {
    expect(weddingChip(event({ rightsStatus: "unverified", consentStatus: "unverified", hasGalleryUrl: false }), 0)).toMatchObject({
      kind: "blocked",
      label: "On hold: your contract is not confirmed and the couple has not agreed yet",
    });
    expect(weddingChip(event({ rightsStatus: "second_shooter" }), 1).label).toBe("On hold: second-shooter wedding");
    expect(weddingChip(event({ rightsStatus: "blocked" }), 1).label).toBe("On hold: marked blocked");
    expect(weddingChip(event({ consentStatus: "declined" }), 1).label).toBe("On hold: the couple said no");
  });
});

describe("gateWords", () => {
  it("is empty with the gate open", () => {
    expect(gateWords({ rightsStatus: "own_contract", consentStatus: "granted_limited" })).toEqual([]);
  });

  it("says each reason in plain words, contract first", () => {
    expect(gateWords({ rightsStatus: "unverified", consentStatus: "declined" })).toEqual([
      "Confirm you were the lead photographer, under your own contract.",
      "The couple said no. It cannot be submitted unless they change their answer in writing.",
    ]);
    expect(gateWords({ rightsStatus: "blocked", consentStatus: "unverified" })).toEqual([
      "This wedding is marked blocked. Sort out who holds the rights before changing that.",
      "The couple has not agreed to a submission yet. Ask them, then record their answer.",
    ]);
  });
});
