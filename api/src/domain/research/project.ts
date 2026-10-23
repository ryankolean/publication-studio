/**
 * Projects an approved research file onto the publication columns that the
 * wizard, the walkthrough and the package checklist already read (SUMMIT-335).
 * The full research, with every source, is kept beside them in research_json;
 * these columns are the narrow view the existing screens understand.
 *
 * Unknown stays unknown wherever a column can hold it. Two columns cannot be
 * NULL, so they take their most cautious value: exclusivity_policy uses its own
 * 'unknown', and earned_or_paid reads an unknown publication fee as 'mixed',
 * which the screens show as "paid placement possible" rather than promising a
 * free feature nobody confirmed.
 */

import type { EarnedOrPaid, ExclusivityPolicy, PublicationTier, SubmissionMethod } from "../publication.js";
import type { Contacts } from "./contacts.js";
import type { Fact, PublicationFile } from "./schema.js";

export interface PublicationColumns {
  id: string;
  name: string;
  tier: PublicationTier;
  kind: PublicationFile["kind"];
  method: SubmissionMethod | null;
  submission_url: string | null;
  contact_email: string | null;
  spec_json: string;
  exclusivity_policy: ExclusivityPolicy;
  counts_own_blog_as_published: 0 | 1 | null;
  typical_response_days: number | null;
  response_window_note: string | null;
  earned_or_paid: EarnedOrPaid;
  taste_notes: string | null;
  last_verified: string;
}

export interface Projection {
  columns: PublicationColumns;
  /** The research style tags, in file order. */
  tags: string[];
}

type Route = Extract<PublicationFile["routes"], { known: true }>["value"][number];

const known = <T>(fact: Fact<T>): T | undefined => (fact.known ? fact.value : undefined);

const METHOD: Record<Route["platform"], SubmissionMethod | null> = {
  two_bright_lights: "aggregator",
  matchology: "aggregator",
  email: "email",
  web_form: "web_form",
  portal: "portal",
  pitch_only: null,
};

/** The spec parser knows web, print and unknown; a request for both is not one size. */
const SIZE: Record<string, "web" | "print" | "unknown"> = { web: "web", print: "print", both: "unknown" };

function preferredRoute(file: PublicationFile): Route | null {
  const routes = known(file.routes);
  if (routes === undefined) return null;
  // A known route list always has at least one route.
  return routes.find((route) => route.preferred === true) ?? (routes[0] as Route);
}

/** Checklist seeds in the vocabulary package-checklist.ts already labels, then the outlet's own words. */
function requirements(file: PublicationFile, route: Route | null): string[] {
  const out: string[] = [];
  const pkg = file.package;
  if (known(pkg.watermarks_allowed) === false) out.push("no_watermarks");
  if (known(pkg.vendor_credits)?.required === true) out.push("full_vendor_credits");
  if (known(pkg.story)?.required === true) out.push("event_description");
  if (route?.account_required === true) out.push("account_required");
  if (known(file.rules.prior_exposure.publications) === "disqualifies") out.push("unpublished_only");
  out.push(...(known(pkg.other_requirements) ?? []));
  return out;
}

function specJson(file: PublicationFile, route: Route | null): string {
  const pkg = file.package;
  const spec: Record<string, unknown> = {};
  const min = known(pkg.image_min);
  const max = known(pkg.image_max);
  if (typeof min === "number") spec["img_min"] = min;
  if (typeof max === "number") spec["img_max"] = max;
  const size = known(pkg.size);
  spec["size"] = size === undefined ? "unknown" : SIZE[size];
  const watermarks = known(pkg.watermarks_allowed);
  if (watermarks !== undefined) spec["watermarks_allowed"] = watermarks;
  const video = known(pkg.video_accepted);
  if (video !== undefined) spec["video_accepted"] = video;
  spec["requirements"] = requirements(file, route);
  return JSON.stringify(spec);
}

function earnedOrPaid(file: PublicationFile): EarnedOrPaid {
  const fee = known(file.economics.publication_fee);
  if (fee === undefined) return "mixed";
  return fee === "none" ? "earned" : "paid";
}

export function projectPublication(file: PublicationFile, contacts: Contacts | null): Projection {
  const route = preferredRoute(file);
  const blogs = known(file.rules.prior_exposure.blogs);
  const window = file.timing.response_window;

  return {
    columns: {
      id: file.id,
      name: file.name,
      tier: file.tier,
      kind: file.kind,
      method: route === null ? null : METHOD[route.platform],
      submission_url: route?.url ?? null,
      contact_email: contacts?.submission_inbox?.email ?? null,
      spec_json: specJson(file, route),
      exclusivity_policy: known(file.rules.exclusivity)?.policy ?? "unknown",
      counts_own_blog_as_published: blogs === undefined ? null : blogs === "disqualifies" ? 1 : 0,
      typical_response_days: window.known ? window.value.days : null,
      // A corrected fact carries no cite, and so no wording of the outlet's own.
      response_window_note: window.known ? (window.cite[0]?.quote ?? null) : null,
      earned_or_paid: earnedOrPaid(file),
      taste_notes: file.taste_summary,
      last_verified: Object.values(file.sources)
        .map((source) => source.read)
        .sort()
        .at(-1) as string,
    },
    tags: known(file.content.style_tags) ?? [],
  };
}
