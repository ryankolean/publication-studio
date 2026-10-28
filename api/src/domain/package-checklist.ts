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

/**
 * Limits the couple placed on the submission -- design doc section 9 requires
 * consent notes to be honoured in packaging. The software cannot verify that a
 * caption says "Sarah and James" rather than their surnames, so it makes a
 * person confirm it, with the couple's own words in front of them.
 */
export interface ConsentConstraints {
  nameDisplay: string | null;
  consentNotes: string | null;
}

export interface PackageEvaluation {
  complete: boolean;
  items: ChecklistItem[];
  /** Ids of everything unsatisfied, in checklist order. */
  missing: string[];
}

const hasText = (value: string | null): boolean =>
  value !== null && value.trim().length > 0;

const text = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

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
  // Requirements transcribed from the outlets' live guidelines (migration
  // 0006). Each reads as the thing to do or confirm, in the words a
  // photographer would use, because this text is the checklist she ticks.
  account_required: "Have an account with this outlet ready; the form is behind a login",
  anti_bride_partner_required_if_accepted: "Understand that if accepted, you must become one of the outlet's paid brand partners",
  authorization_to_submit_images: "Confirm you are authorised to submit these photos",
  budget_tier: "Know the wedding's budget tier; the form asks for it",
  color_palette_and_style: "Describe the colour palette and style in the write-up",
  couple_instagram_handles: "Have the couple's Instagram handles ready; the form asks for them",
  couple_professions: "Know the couple's professions; the form asks for them",
  detailed_form_after_selection: "Expect a longer form after the outlet selects the wedding",
  dropbox_folder_only: "Put the photos in a Dropbox folder; this outlet reviews Dropbox only",
  dropbox_link_to_images: "Have a Dropbox link to the photos ready",
  email_subject_real_wedding_plus_couple_names: "Use the subject line Real Wedding plus the couple's names",
  embargo_other_features_2_months_after_publication: "Agree that no other outlet runs this wedding for 2 months after it publishes",
  exclusive_30_days_after_publication: "Agree to 30 days of exclusivity after it publishes",
  gallery_via_pixieset_not_dropbox: "Share the gallery through Pixieset or similar, not Dropbox",
  grants_publication_rights: "Confirm you grant the outlet the right to publish these photos",
  guest_count: "Know the guest count; the form asks for it",
  hi_res_and_web_size_images_both: "Make both high-resolution and web-size files downloadable from the gallery",
  image_file_size_1_to_3mb: "Export each photo at 1 to 3 MB",
  image_max_2mb: "Keep each photo under 2 MB",
  image_width_1500_to_2400px: "Export each photo 1500 to 2400 px wide",
  images_chronological_order: "Put the photos in the order of the day",
  instagram_handle: "Have your Instagram handle ready; the form asks for it",
  mix_of_portrait_and_landscape: "Choose a mix of portrait and landscape photos",
  no_styled_shoots: "Confirm this is a real wedding, not a styled shoot",
  no_wetransfer: "Do not use WeTransfer; the link must not expire",
  non_expiring_dropbox_style_link: "Share a link that does not expire, such as Dropbox or Google Drive",
  non_traditional_wedding_only: "Confirm the wedding reads as non-traditional, which is all this outlet runs",
  not_accepted_from_couples: "Submit as the photographer; this outlet does not take submissions from couples",
  permission_from_couple_and_photographer: "Confirm the couple and the photographer have both given permission",
  photographer_full_gallery_link: "Share the complete gallery, not a folder of selects",
  photographer_name: "Give the photographer's name on the form",
  processing_fee_if_selected: "Understand that a processing fee is charged if the wedding is selected",
  professional_photo_gallery: "Confirm the photos come from a professional gallery",
  professional_photos_only: "Confirm every photo is professional, not from a guest",
  recent_within_12_months: "Confirm the wedding took place within the last 12 months",
  registry_question_answered: "Answer the registry question on the form",
  styled_shoot_concept_description: "Styled shoots only: describe the concept in a few sentences",
  styled_shoot_key_vendors: "Styled shoots only: list the key vendors",
  submitter_must_be_photographer_or_planner: "Submit as the photographer or planner, which is all this outlet accepts",
  submitter_role_declared: "State your role on the form",
  unpublished_only: "Confirm this wedding has not been published anywhere, including blogs and social media",
  variety_of_details_pre_reception_to_reception: "Cover the day from the details through to the reception",
  vendor_account_dashboard: "Submit from your vendor account dashboard on the outlet's site",
  vendor_emails_for_new_vendors: "Have email addresses ready for any vendor not already on the outlet",
  venue_and_location: "Give the venue and location on the form",
  venue_and_photographer_required: "Name the venue and the photographer; the outlet will not run it without both",
};

/** "some_new_outlet_rule" -> "Some new outlet rule". */
function humanise(requirement: string): string {
  const words = requirement.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** How the checklist words one of an outlet's requirements. */
export function requirementLabel(requirement: string): string {
  return DERIVED_REQUIREMENTS[requirement]?.label ?? ATTESTED_REQUIREMENT_LABELS[requirement] ?? humanise(requirement);
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

export function buildChecklist(
  spec: PublicationSpec,
  pkg: PackageInput,
  consent: ConsentConstraints | null = null,
): ChecklistItem[] {
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

  const limits = [
    consent === null ? null : text(consent.nameDisplay),
    consent === null ? null : text(consent.consentNotes),
  ].filter((value): value is string => value !== null);

  if (limits.length > 0) {
    items.push({
      id: "consent_limits",
      kind: "attested",
      label: "Confirm the package honours the couple's limits",
      satisfied: isAttested(pkg, "consent_limits"),
      detail: limits.join(" / "),
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
  consent: ConsentConstraints | null = null,
): PackageEvaluation {
  const items = buildChecklist(spec, pkg, consent);
  const missing = items.filter((item) => !item.satisfied).map((item) => item.id);
  return { complete: missing.length === 0, items, missing };
}
