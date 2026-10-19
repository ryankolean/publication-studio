/** Publication vocabularies - design doc section 5. Mirrored by D1 CHECK constraints. */

export const PUBLICATION_TIERS = ["primary", "secondary", "dream"] as const;

export const SUBMISSION_METHODS = ["portal", "web_form", "email", "aggregator"] as const;

export const EXCLUSIVITY_POLICIES = [
  "exclusive_required",
  "exclusive_preferred",
  "non_exclusive",
  "unknown",
] as const;

export const EARNED_OR_PAID_VALUES = ["earned", "paid", "mixed"] as const;

export type PublicationTier = (typeof PUBLICATION_TIERS)[number];
export type SubmissionMethod = (typeof SUBMISSION_METHODS)[number];
export type ExclusivityPolicy = (typeof EXCLUSIVITY_POLICIES)[number];
export type EarnedOrPaid = (typeof EARNED_OR_PAID_VALUES)[number];
