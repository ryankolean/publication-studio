import type { SubmissionSummary } from "../components/SubmissionBadge.js";

export interface ChecklistItem {
  id: string;
  kind: "derived" | "attested";
  label: string;
  satisfied: boolean;
  detail?: string;
}

/** GET /packages/:id, the parts the wizard reads. */
export interface PackageView {
  id: string;
  eventId: string;
  publicationId: string;
  publication: {
    id: string;
    name: string;
    method: string | null;
    submissionUrl: string | null;
    spec: { imgMin: number | null; imgMax: number | null };
  } | null;
  imageKeys: string[];
  descriptionMd: string | null;
  creditsBlockMd: string | null;
  consent: { nameDisplay: string | null; consentNotes: string | null };
  checklist: ChecklistItem[];
  complete: boolean;
  missing: string[];
  submission: SubmissionSummary | null;
}

/** GET /events/:id/images. */
export interface PoolImage {
  key: string;
  originalName: string | null;
  contentType: string;
  bytes: number;
  createdAt: string;
  readUrl: string;
  expiresIn: number;
}

export const outletNameOf = (pkg: PackageView): string => pkg.publication?.name ?? "The outlet";

/** The couple's limits, as lines to show beside the work. */
export function limitsOf(consent: PackageView["consent"]): string[] {
  return [consent.nameDisplay, consent.consentNotes].filter(
    (value): value is string => value !== null && value.trim() !== "",
  );
}
