/**
 * Package checklist -- design doc section 7.2.
 *
 * "Nothing reaches ready until every checklist item is checked." This module
 * decides what those items are for a given publication spec and package, and
 * whether they are met.
 *
 * The central distinction is between two kinds of item:
 *
 *   derived  -- the package data answers it. Is there a description? Are there
 *               between 25 and 40 images? These recompute every time and cannot
 *               be ticked off by hand, because a tick is not a description.
 *   attested -- only a person can answer it. Are the files web-size? Are the
 *               watermarks gone? Did you tag every vendor in the portal? The
 *               software cannot see the answer, so it records a human saying so.
 *
 * A requirement this module has never heard of becomes an attestation rather
 * than being ignored or assumed met. Specs drift (section 10), and the failure
 * that matters is a package going out believing a rule was satisfied.
 */

import type { PublicationSpec } from "./publication-spec.js";

export type ChecklistItemKind = "derived" | "attested";

export interface ChecklistItem {
  /** Stable across rebuilds; attestation state is stored against it. */
  id: string;
  kind: ChecklistItemKind;
  label: string;
  satisfied: boolean;
  /** Why it is not satisfied, when saying so helps. */
  detail?: string;
}

export interface PackageInput {
  imageKeys: string[];
  descriptionMd: string | null;
  creditsBlockMd: string | null;
  /** Item id to checked state, as stored in packages.checklist_json. */
  attestations: Record<string, boolean>;
}

export interface PackageEvaluation {
  complete: boolean;
  items: ChecklistItem[];
  /** Ids of everything unsatisfied, in checklist order. */
  missing: string[];
}

const hasText = (value: string | null): boolean =>
  value !== null && value.trim().length > 0;

/** Requirements the package data can answer on its own. */
const DERIVED_REQUIREMENTS: Record<
  string,
  { label: string; satisfied: (pkg: PackageInput) => boolean; detail: string }
> = {
  event_description: {
    label: "Event description written",
    satisfied: (pkg) => hasText(pkg.descriptionMd),
    detail: "This outlet requires a written event description.",
  },
  couple_love_story: {
    label: "Couple story written",
    satisfied: (pkg) => hasText(pkg.descriptionMd),
    detail: "This outlet puts the couple's story at the centre.",
  },
  full_vendor_credits: {
    label: "Vendor credits block prepared",
    satisfied: (pkg) => hasText(pkg.creditsBlockMd),
    detail: "This outlet prioritises complete vendor credits.",
  },
};

/** Human-readable text for the attestations we know by name. */
const ATTESTED_REQUIREMENT_LABELS: Record<string, string> = {
  no_watermarks: "Confirm no image carries a watermark",
  web_size_images_only: "Confirm every image is web-size",
  tag_all_vendors: "Confirm every vendor is tagged in the submission",
  upload_3_to_5_images_at_a_time: "Upload images 3 to 5 at a time, as the portal expects",
  complete_the_form_in_one_session: "Complete the form in one session; it does not save drafts",
};

/** "some_new_outlet_rule" -> "Some new outlet rule". */
function humanise(requirement: string): string {
  const words = requirement.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const isAttested = (pkg: PackageInput, id: string): boolean =>
  pkg.attestations[id] === true;

function imageCountItem(spec: PublicationSpec, count: number): ChecklistItem | null {
  const { imgMin, imgMax } = spec;
  if (imgMin === null && imgMax === null) return null;

  const belowMin = imgMin !== null && count < imgMin;
  const aboveMax = imgMax !== null && count > imgMax;

  const range =
    imgMin !== null && imgMax !== null
      ? `${imgMin} to ${imgMax}`
      : imgMin !== null
        ? `at least ${imgMin}`
        : `at most ${imgMax}`;

  return {
    id: "image_count",
    kind: "derived",
    label: `Image count within the outlet's range (${range})`,
    satisfied: !belowMin && !aboveMax,
    detail: `${count} selected; this outlet expects ${range}.`,
  };
}

export function buildChecklist(spec: PublicationSpec, pkg: PackageInput): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  // Universal: a submission with no images is not a submission.
  items.push({
    id: "images_present",
    kind: "derived",
    label: "At least one image selected",
    satisfied: pkg.imageKeys.length > 0,
    detail: "Select the images to submit.",
  });

  const countItem = imageCountItem(spec, pkg.imageKeys.length);
  if (countItem !== null) items.push(countItem);

  // Only a known false becomes a rule. Unknown stays silent rather than
  // inventing a constraint the outlet never published.
  if (spec.watermarksAllowed === false) {
    items.push({
      id: "no_watermarks",
      kind: "attested",
      label: "Confirm no image carries a watermark",
      satisfied: isAttested(pkg, "no_watermarks"),
    });
  }

  if (spec.size === "web") {
    items.push({
      id: "web_size",
      kind: "attested",
      label: "Confirm every image is a web-size derivative",
      satisfied: isAttested(pkg, "web_size"),
    });
  }

  const seen = new Set(items.map((item) => item.id));

  for (const requirement of spec.requirements) {
    const id = `req:${requirement}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const derived = DERIVED_REQUIREMENTS[requirement];
    if (derived !== undefined) {
      items.push({
        id,
        kind: "derived",
        label: derived.label,
        satisfied: derived.satisfied(pkg),
        detail: derived.detail,
      });
      continue;
    }

    items.push({
      id,
      kind: "attested",
      label: ATTESTED_REQUIREMENT_LABELS[requirement] ?? humanise(requirement),
      satisfied: isAttested(pkg, id),
    });
  }

  return items;
}

export function evaluatePackage(
  spec: PublicationSpec,
  pkg: PackageInput,
): PackageEvaluation {
  const items = buildChecklist(spec, pkg);
  const missing = items.filter((item) => !item.satisfied).map((item) => item.id);
  return { complete: missing.length === 0, items, missing };
}
