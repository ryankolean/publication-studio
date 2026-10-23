/**
 * Plain words for research fields and values, for the outlet update review
 * and the correction form. Field keys are the paths the research files and
 * the API use (for example timing.response_window).
 */

export const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  url: "Website",
  kind: "Kind of outlet",
  tier: "Tier",
  recheck_every_days: "Checked again every (days)",
  taste_summary: "What they like",
  notes: "Research notes",
  "identity.parent_company": "Parent company",
  "identity.sister_publications": "Sister titles",
  "identity.shared_inbox_with": "Shares an inbox with",
  "coverage.regions": "Places covered",
  "coverage.basis": "Covered by",
  "coverage.destination_accepted": "Takes destination weddings",
  "content.real_wedding": "Real weddings",
  "content.elopement": "Elopements",
  "content.styled_shoot": "Styled shoots",
  "content.style_tags": "Style",
  "content.seasonality": "Seasons",
  routes: "How to submit",
  "package.image_min": "Fewest photos",
  "package.image_max": "Most photos",
  "package.resolution": "Photo dimensions",
  "package.size": "File size",
  "package.orientation_mix": "Vertical and horizontal mix",
  "package.watermarks_allowed": "Watermarks allowed",
  "package.gallery_hosts": "Gallery links accepted",
  "package.vendor_credits": "Vendor credits",
  "package.story": "Written story",
  "package.video_accepted": "Video accepted",
  "package.other_requirements": "Other things they ask for",
  "rules.exclusivity": "Exclusivity",
  "rules.prior_exposure.publications": "Already in another outlet",
  "rules.prior_exposure.blogs": "Already on a blog",
  "rules.prior_exposure.social": "Already on social media",
  "rules.freshness_window_months": "How recent the wedding must be (months)",
  "rules.photographer_frequency": "How often one photographer can run",
  "rules.submitter_roles": "Who may submit",
  "rights.image_usage": "How they use the photos",
  "rights.credit_format": "How they credit",
  "rights.couple_consent_required": "Couple's consent needed",
  "rights.vendor_consent_required": "Vendor consent needed",
  "economics.submission_fee": "Fee to submit",
  "economics.publication_fee": "Fee to publish",
  "economics.priority_paid_tier": "Paid faster review",
  "economics.reach": "Audience",
  "timing.response_window": "Reply time",
  "timing.publish_lead_days": "Time to publish",
  "timing.publishing_cycle": "How often they publish",
  "people.editors": "Editors",
  "insight.secret_sauce": "Tips",
  "insight.recent_features": "Recent features",
};

const humanize = (token: string): string => {
  const words = token.replace(/[_.]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? humanize(field);

/** A research value in a few words: "Unknown", "Yes", "42", "Days: 42; replies: success only". */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "Not recorded";
  if (value === "unknown") return "Unknown";
  if (value === "none") return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (typeof value === "string") return /^[a-z0-9]+(_[a-z0-9]+)*$/.test(value) ? humanize(value) : value;
  if (Array.isArray(value)) return value.length === 0 ? "None listed" : value.map(formatValue).join(", ");
  const pairs = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== null && inner !== undefined)
    .map(([key, inner]) => `${key.replace(/_/g, " ")}: ${formatValue(inner)}`)
    .join("; ");
  return pairs.charAt(0).toUpperCase() + pairs.slice(1);
}
