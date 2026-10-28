/**
 * Guided plans (SUMMIT-344 slice 6, spec section 6a): plan first, act
 * second. Claude picks one of these server-side templates from her words;
 * the studio says the steps in plain sentences and works out which are done
 * from the wedding's own data, the way the wizard does, so a plan never
 * drifts from what is really there. Each step names who does it and the
 * tool that does it; nothing here runs a tool.
 *
 * DECISION: the spec's six templates become five. "submit" and "follow up"
 * are one plan, since the studio never sends: she sends, and the follow-up
 * is waiting for that one answer.
 *
 * Pure: no database, no clock, no network.
 */

import type { SubmissionStatus } from "./submission-status.js";
import { isAnswered, isSentOrLater } from "./walkthrough.js";

export const PLAN_TEMPLATES = ["new_wedding", "pick_outlets", "build_package", "send_and_follow_up", "after_acceptance"] as const;
export type PlanTemplate = (typeof PLAN_TEMPLATES)[number];

export const TEMPLATE_TITLES: Record<PlanTemplate, string> = {
  new_wedding: "Bring in a new wedding",
  pick_outlets: "Choose the outlets",
  build_package: "Build the package",
  send_and_follow_up: "Send it and follow up",
  after_acceptance: "After an acceptance",
};

/** The template that usually comes after each one is finished. */
const AFTER: Record<PlanTemplate, PlanTemplate | null> = {
  new_wedding: "pick_outlets",
  pick_outlets: "build_package",
  build_package: "send_and_follow_up",
  send_and_follow_up: "after_acceptance",
  after_acceptance: null,
};

/** What a plan reads about one wedding; the tool loads it. */
export interface PlanSnapshot {
  wedding: {
    slug: string;
    hasDate: boolean;
    hasVenueOrCity: boolean;
    placeSet: boolean;
    permissionsAnswered: boolean;
    gateOpen: boolean;
    story: boolean;
    vendorCredits: number;
    photos: number;
    keptTags: number;
  } | null;
  /** Her order of outlets is set. */
  orderSet: boolean;
  /** The plan's outlet: the one it names, or the one up next in her order. */
  outlet: { id: string; name: string } | null;
  pkg: { photosChosen: boolean; writeUp: boolean; toConfirm: number } | null;
  submission: SubmissionStatus | null;
}

type Who = "Claude" | "you";

interface StepDef {
  text: (s: PlanSnapshot) => string;
  who: Who;
  tool: string | null;
  done: (s: PlanSnapshot) => boolean;
  how: (s: PlanSnapshot) => string;
  /** For her steps: the one question to ask her. */
  ask?: (s: PlanSnapshot) => string;
}

const outletName = (s: PlanSnapshot) => s.outlet?.name ?? "the outlet up next";
const slug = (s: PlanSnapshot) => s.wedding?.slug ?? "the new wedding";
const sentOrLater = (s: PlanSnapshot) => s.submission !== null && isSentOrLater(s.submission);
const placed = (s: PlanSnapshot) => s.submission === "accepted" || s.submission === "published";

const TEMPLATES: Record<PlanTemplate, StepDef[]> = {
  new_wedding: [
    {
      text: () => "Record the wedding: the couple, the date, the venue and where it was.",
      who: "Claude",
      tool: "save_wedding",
      done: (s) => s.wedding !== null && s.wedding.hasDate && s.wedding.hasVenueOrCity && s.wedding.placeSet,
      how: (s) =>
        s.wedding === null
          ? "Call save_wedding with couple_names and date from what she told you, plus venue and place if she gave them."
          : `Call save_wedding with wedding ${slug(s)} and the missing details: the date, the venue or city, and place.`,
    },
    {
      text: () => "Answer the two permission questions.",
      who: "you",
      tool: "confirm_permissions",
      done: (s) => s.wedding?.permissionsAnswered === true,
      how: (s) => `Ask her both questions, then call confirm_permissions for ${slug(s)} and follow its two steps.`,
      ask: () => "Were you the lead photographer, under your own contract, and has the couple agreed to a submission?",
    },
    {
      text: () => "Add the photos through a one-time upload link.",
      who: "you",
      tool: "get_upload_link",
      done: (s) => (s.wedding?.photos ?? 0) > 0,
      how: (s) =>
        s.wedding?.gateOpen === false
          ? "The permission answers do not allow photos yet; settle those first."
          : `Call get_upload_link for ${slug(s)} and give her the link exactly as it is.`,
      ask: () => "Are your web-size exports ready to drag onto the upload page?",
    },
    {
      text: () => "Tell me the couple's story and the vendors, and I will write them up with you.",
      who: "you",
      tool: "save_wedding",
      done: (s) => s.wedding !== null && s.wedding.story && s.wedding.vendorCredits > 0,
      how: (s) => `Draft the story and the vendor list with her, then call save_wedding for ${slug(s)} with story and vendors.`,
      ask: () => "How did the couple meet, what made the day theirs, and who were the vendors?",
    },
    {
      text: () => "Look through the photos and choose the style tags together.",
      who: "Claude",
      tool: "set_tags",
      done: (s) => (s.wedding?.keptTags ?? 0) > 0,
      how: (s) =>
        `Call get_wedding for ${slug(s)} with tag_choices, look at the photos with review_photos, suggest a few tags, and record what she keeps with set_tags.`,
    },
  ],
  pick_outlets: [
    {
      text: () => "Check that the place and the style tags are set.",
      who: "Claude",
      tool: "set_tags",
      done: (s) => s.wedding !== null && s.wedding.placeSet && s.wedding.keptTags > 0,
      how: (s) => `Add the place with save_wedding and the tags with set_tags for ${slug(s)}; the ranking leans on both.`,
    },
    {
      text: () => "Rank the outlets for this wedding and talk through the best ones.",
      who: "Claude",
      tool: "rank_publications_for_wedding",
      done: (s) => s.orderSet,
      how: (s) => `Call rank_publications_for_wedding for ${slug(s)} and walk her through the top few; publications gives any outlet's card.`,
    },
    {
      text: () => "Choose the order to try them in, one at a time.",
      who: "you",
      tool: "set_queue",
      done: (s) => s.orderSet,
      how: (s) => `Once she has chosen, call set_queue for ${slug(s)} with the outlets in her order.`,
      ask: () => "Which outlet should get it first, and which next if that one passes?",
    },
  ],
  build_package: [
    {
      text: (s) => `Start the package for ${outletName(s)}.`,
      who: "Claude",
      tool: "build_package_draft",
      done: (s) => s.pkg !== null,
      how: (s) =>
        s.outlet === null
          ? "There is no outlet to build for: choose the order first (the pick_outlets plan)."
          : `Call build_package_draft with wedding ${slug(s)} and publication ${s.outlet.id}.`,
    },
    {
      text: () => "Choose the photos to send.",
      who: "you",
      tool: "build_package_draft",
      done: (s) => s.pkg?.photosChosen === true,
      how: (s) => `Look at the photos with review_photos, agree the selection with her, and pass it as photos to build_package_draft for ${s.outlet?.id ?? "the outlet"}.`,
      ask: (s) => `Which photos should go to ${outletName(s)}? I can show them to you a page at a time.`,
    },
    {
      text: () => "Write the write-up together, within the couple's limits.",
      who: "Claude",
      tool: "build_package_draft",
      done: (s) => s.pkg?.writeUp === true,
      how: () => "Draft it with her from the couple's story, keeping to the couple's limits, and save it as write_up with build_package_draft.",
    },
    {
      text: () => "Confirm the checklist items only you can vouch for.",
      who: "you",
      tool: "build_package_draft",
      done: (s) => s.pkg !== null && s.pkg.toConfirm === 0,
      how: () => "Ask her about each item marked sheConfirms; call build_package_draft with confirm, show her the lines, and only after her yes call again with the code.",
      ask: () => "Can you confirm the items on the outlet's checklist that only you can vouch for? I will read each one to you.",
    },
    {
      text: () => "Put it in your order so it is ready to send.",
      who: "Claude",
      tool: "set_queue",
      done: (s) => s.submission !== null,
      how: (s) => `Call set_queue for ${slug(s)} with her order; it readies the package once it is complete.`,
    },
  ],
  send_and_follow_up: [
    {
      text: (s) => `Make sure the package for ${outletName(s)} is ready to send.`,
      who: "Claude",
      tool: "set_queue",
      done: (s) => s.submission !== null,
      how: (s) => `If it is not ready, follow the build_package plan for ${slug(s)}.`,
    },
    {
      text: (s) => `Send it yourself through ${outletName(s)}'s own route, then mark it sent in the studio.`,
      who: "you",
      tool: null,
      done: sentOrLater,
      how: () => "The studio never sends. Remind her where the package is in the studio and that marking it sent starts the reply window.",
      ask: (s) => `Have you sent it to ${outletName(s)} and marked it sent in the studio?`,
    },
    {
      text: () => "Wait for the answer; the studio keeps the reply window.",
      who: "you",
      tool: "get_wedding",
      done: (s) => s.submission !== null && isAnswered(s.submission),
      how: (s) => `Check where it stands with get_wedding for ${slug(s)}; keep the wedding off other outlets and social media while it waits.`,
      ask: () => "Has the outlet answered yet?",
    },
    {
      text: () => "If it is declined or not answered in time, move on to the next outlet in your order.",
      who: "Claude",
      tool: "set_queue",
      done: (s) => placed(s) || s.submission === "declined" || s.submission === "withdrawn",
      how: (s) =>
        s.submission === "expired"
          ? "It was not answered in time: she withdraws it in the studio first, then the next outlet is up."
          : `Start the build_package plan for the next outlet in ${slug(s)}'s order.`,
    },
  ],
  after_acceptance: [
    {
      text: (s) => `Record ${outletName(s)}'s acceptance in the studio.`,
      who: "you",
      tool: null,
      done: placed,
      how: () => "She marks it accepted in the studio; that keeps every other outlet away from the wedding.",
      ask: () => "Has the acceptance been marked in the studio?",
    },
    {
      text: () => "Send the outlet anything it asks for, and keep the wedding off everything else until it runs.",
      who: "you",
      tool: null,
      done: (s) => s.submission === "published",
      how: () => "Help her answer the outlet's requests; nothing goes anywhere else until it is published.",
    },
    {
      text: () => "Record the link once the feature runs.",
      who: "you",
      tool: null,
      done: (s) => s.submission === "published",
      how: () => "She marks it published in the studio with the web address of the feature.",
      ask: () => "Has the feature run yet? If so, what is its web address?",
    },
  ],
};

export type StepStatus = "done" | "next" | "to do" | "skipped";

export interface PlanStep {
  n: number;
  text: string;
  who: Who;
  status: StepStatus;
}

/** The plan's steps with where each stands; the first open step that is not skipped is next. */
export function planSteps(template: PlanTemplate, snapshot: PlanSnapshot, skipped: readonly number[]): PlanStep[] {
  let nextGiven = false;
  return TEMPLATES[template].map((def, index) => {
    const n = index + 1;
    let status: StepStatus;
    if (skipped.includes(n)) status = "skipped";
    else if (def.done(snapshot)) status = "done";
    else if (nextGiven) status = "to do";
    else {
      status = "next";
      nextGiven = true;
    }
    return { n, text: def.text(snapshot), who: def.who, status };
  });
}

/** How many steps a template has, for checking skips. */
export function stepCount(template: PlanTemplate): number {
  return TEMPLATES[template].length;
}

/**
 * The next step to run: what it is, who does it, the tool and how. Done
 * when every step is done or skipped, with the plan that usually follows.
 */
export function nextStep(template: PlanTemplate, snapshot: PlanSnapshot, skipped: readonly number[]) {
  const steps = planSteps(template, snapshot, skipped);
  const progress = `${steps.filter((step) => step.status === "done").length} of ${steps.length} done`;
  const index = steps.findIndex((step) => step.status === "next");
  if (index === -1) {
    const after = AFTER[template];
    return {
      done: true as const,
      progress,
      next: after === null ? "This plan is finished." : `This plan is finished. The usual next plan is ${after}: ${TEMPLATE_TITLES[after]}.`,
    };
  }
  const def = TEMPLATES[template][index] as StepDef;
  const step = steps[index] as PlanStep;
  return {
    done: false as const,
    progress,
    step,
    use: def.tool,
    how: def.how(snapshot),
    ...(def.ask === undefined ? {} : { askHer: def.ask(snapshot) }),
  };
}

/** Steps to skip or bring back, checked against the template. */
export function reviseSkips(
  template: PlanTemplate,
  current: readonly number[],
  skip: readonly number[],
  unskip: readonly number[],
): { ok: true; skipped: number[] } | { ok: false; message: string } {
  const count = stepCount(template);
  const bad = [...skip, ...unskip].filter((n) => !Number.isInteger(n) || n < 1 || n > count);
  if (bad.length > 0) return { ok: false, message: `This plan has steps 1 to ${count}; there is no step ${bad.join(", ")}.` };
  const skipped = [...new Set([...current, ...skip])].filter((n) => !unskip.includes(n)).sort((a, b) => a - b);
  return { ok: true, skipped };
}
