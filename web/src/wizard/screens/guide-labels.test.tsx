import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { GUIDE } from "../guide.js";
import type { StepId } from "../model.js";
import {
  fakeApi,
  OUTLET_B,
  packageView,
  renderWizard,
  serve,
  storedEvent,
  walkthrough,
  wizardAt,
  type FakeApi,
} from "../test-utils.js";

let api: FakeApi;

beforeEach(() => {
  api = fakeApi();
});

/** Every "quoted label" in a guide's lines. */
const quoted = (lines: string[]): string[] =>
  lines.flatMap((line) => [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string));

/** Everything outside the guide box, which quotes the labels itself. */
const outsideGuide = (elements: HTMLElement[]) =>
  elements.filter((element) => element.closest('[aria-label="What to do here"]') === null);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The label is on screen, outside the guide box, as a button, a link, a form
 * control's label, or text that starts with it ("Not done: ..."), never as a
 * fragment of a longer word.
 */
function onScreen(label: string): boolean {
  const found = [
    ...screen.queryAllByRole("button", { name: label }),
    ...screen.queryAllByRole("link", { name: label }),
    ...screen.queryAllByLabelText(label),
    ...screen.queryAllByText(new RegExp(`^${escape(label)}(?![\\w])`)),
  ];
  return outsideGuide(found).length > 0;
}

const image = (name: string) => ({
  key: `events/w1/${name}.jpg`,
  originalName: `${name}.jpg`,
  contentType: "image/jpeg",
  bytes: 5,
  createdAt: "",
  readUrl: `/images/events/w1/${name}.jpg?token=${name}`,
  expiresIn: 900,
});
const pool = [image("a"), image("b")];

const submission = (status: string) => ({ id: "s1", status, sentAt: null, responseDueAt: null });

/** Each step rendered in the state its guide describes, with the text that proves it loaded. */
const OPEN: Record<StepId, () => Promise<unknown>> = {
  wedding: async () => {
    serve(api, { "/events/w1/walkthrough": walkthrough(wizardAt("wedding")), "/events/w1": storedEvent() });
    renderWizard(api, "/wizard/w1/wedding");
    return screen.findByLabelText("Couple names, as they should appear");
  },
  permissions: async () => {
    serve(api, { "/events/w1/walkthrough": walkthrough(wizardAt("permissions")), "/events/w1": storedEvent() });
    renderWizard(api, "/wizard/w1/permissions");
    return screen.findByRole("group", { name: "Has the couple agreed to a submission?" });
  },
  story: async () => {
    serve(api, { "/events/w1/walkthrough": walkthrough(wizardAt("story")), "/events/w1": storedEvent() });
    renderWizard(api, "/wizard/w1/story");
    return screen.findByLabelText("What made this wedding stand out?");
  },
  look: async () => {
    serve(api, {
      "/events/w1/walkthrough": walkthrough(wizardAt("look")),
      "/style/events/w1": {
        tags: [{ id: "romantic", category: "aesthetic", state: "suggested", source: "operator", confidence: "high", reason: "Photo 2." }],
        vocabulary: [{ id: "romantic", category: "aesthetic" }, { id: "whimsical", category: "aesthetic" }],
      },
    });
    renderWizard(api, "/wizard/w1/look");
    return screen.findByText("Photo 2.");
  },
  outlet: async () => {
    serve(api, { "/events/w1/walkthrough": walkthrough(wizardAt("outlet")) });
    renderWizard(api, "/wizard/w1/outlet");
    return screen.findByText("Outlet A");
  },
  photos: async () => {
    serve(api, {
      "/events/w1/walkthrough?package=pk1": walkthrough(wizardAt("photos")),
      "/packages/pk1": packageView({ imageKeys: ["events/w1/a.jpg"] }),
      "/events/w1/images": { images: pool },
    });
    renderWizard(api, "/wizard/w1/photos?package=pk1");
    return screen.findByRole("status");
  },
  writeup: async () => {
    serve(api, { "/events/w1/walkthrough?package=pk1": walkthrough(wizardAt("writeup")), "/packages/pk1": packageView() });
    renderWizard(api, "/wizard/w1/writeup?package=pk1");
    return screen.findByLabelText("The write-up");
  },
  confirm: async () => {
    serve(api, {
      "/events/w1/walkthrough?package=pk1": walkthrough(wizardAt("confirm")),
      "/packages/pk1": packageView({
        checklist: [
          { id: "image_count", kind: "derived", label: "Image count within range", satisfied: false, detail: "1 selected; 2 to 3." },
          { id: "no_watermarks", kind: "attested", label: "Confirm no image carries a watermark", satisfied: false },
        ],
        complete: false,
        missing: ["image_count", "no_watermarks"],
      }),
    });
    renderWizard(api, "/wizard/w1/confirm?package=pk1");
    return screen.findByRole("list", { name: "Checks" });
  },
  review: async () => {
    serve(api, {
      "/events/w1/walkthrough?package=pk1": walkthrough(wizardAt("review")),
      "/events/w1": storedEvent(),
      "/packages/pk1": packageView({ imageKeys: pool.map((entry) => entry.key), complete: true }),
      "/packages/pk1/images": { images: pool },
    });
    renderWizard(api, "/wizard/w1/review?package=pk1");
    return screen.findByRole("button", { name: "Add to the queue" });
  },
  send: async () => {
    serve(api, {
      "/events/w1/walkthrough?package=pk1": walkthrough(wizardAt("send")),
      "/packages/pk1": packageView({ complete: true, submission: submission("queued") }),
      "/packages/pk1/images": { images: pool },
    });
    renderWizard(api, "/wizard/w1/send?package=pk1");
    // The heading renders before the submission loads; the button proves it did.
    return screen.findByRole("button", { name: "I sent it" });
  },
  track: async () => {
    serve(api, {
      "/events/w1/walkthrough?package=pk1": walkthrough(
        wizardAt("track", {
          submission: { id: "s1", status: "sent", due: null, publishedUrl: null },
          reply: { dueAt: "2026-11-16T12:00:00Z", daysRemaining: 28, outletWords: null, silenceMeansPass: null },
        }),
      ),
    });
    renderWizard(api, "/wizard/w1/track?package=pk1");
    return screen.findByRole("button", { name: "Accepted" });
  },
};

/** Labels a step's guide quotes for a later state, proven by their own test below. */
const LATER: Partial<Record<StepId, string[]>> = { track: ["Live link", "Record it"] };

describe("every quoted control in a step's guide is on that screen", () => {
  for (const step of Object.keys(OPEN) as StepId[]) {
    it(step, async () => {
      await OPEN[step]();
      const later = LATER[step] ?? [];
      const labels = quoted(GUIDE[step].todo).filter((label) => !later.includes(label));
      expect(labels.length, `${step} quotes nothing`).toBeGreaterThan(0);
      for (const label of labels) expect(onScreen(label), `${step}: "${label}"`).toBe(true);
    });
  }

  it("track, once accepted: the live link and its button", async () => {
    serve(api, {
      "/events/w1/walkthrough?package=pk1": walkthrough(
        wizardAt("track", {
          submission: { id: "s1", status: "accepted", due: null, publishedUrl: null },
          reply: { dueAt: null, daysRemaining: null, outletWords: null, silenceMeansPass: null },
        }),
      ),
    });
    renderWizard(api, "/wizard/w1/track?package=pk1");
    await screen.findByRole("heading", { name: GUIDE.track.title });
    expect(quoted(GUIDE.track.todo)).toEqual(expect.arrayContaining(LATER.track ?? []));
    for (const label of LATER.track ?? []) expect(onScreen(label), label).toBe(true);
  });

  it("send, for an outlet with no page: the guide still reads true and no page link is offered", async () => {
    serve(api, {
      "/events/w1/walkthrough?package=pk1": walkthrough(
        wizardAt("send", {
          outlet: { id: OUTLET_B.id, name: OUTLET_B.name, method: null, submissionUrl: null, typicalResponseDays: null, warnings: [] },
        }),
      ),
      "/packages/pk1": packageView({
        complete: true,
        submission: submission("queued"),
        publication: { id: OUTLET_B.id, name: OUTLET_B.name, method: null, submissionUrl: null, spec: { imgMin: null, imgMax: null } },
      }),
      "/packages/pk1/images": { images: pool },
    });
    renderWizard(api, "/wizard/w1/send?package=pk1");
    await screen.findByRole("button", { name: "I sent it" });
    expect(screen.getByRole("heading", { name: "Send it to Outlet B" })).toBeInTheDocument();
    expect(screen.getAllByText(GUIDE.send.todo[2] as string)).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /submission page/ })).toBeNull();
    expect(screen.getByText("Outlet B has no public form. Reaching it is a pitch to an editor.")).toBeInTheDocument();
  });
});
