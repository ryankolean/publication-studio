/** Mirrors SUBMISSION_STATUSES in the API (design doc section 6.2). */
export type SubmissionStatus =
  | "draft"
  | "ready"
  | "queued"
  | "sent"
  | "accepted"
  | "published"
  | "declined"
  | "expired"
  | "withdraw_pending"
  | "withdrawn"
  | "cancelled";

/** What the package view and the event's package list carry about a pairing's submission. */
export interface SubmissionSummary {
  id: string;
  status: SubmissionStatus;
  sentAt: string | null;
  responseDueAt: string | null;
}

const LABEL: Record<SubmissionStatus, string> = {
  draft: "Draft",
  ready: "Ready to send",
  queued: "Queued",
  sent: "Sent",
  accepted: "Accepted",
  published: "Published",
  declined: "Declined",
  expired: "Expired",
  withdraw_pending: "Withdrawal pending",
  withdrawn: "Withdrawn",
  cancelled: "Cancelled",
};

const TONE: Partial<Record<SubmissionStatus, string>> = {
  ready: "border-amber-300 bg-amber-50 text-amber-900",
  queued: "border-amber-300 bg-amber-50 text-amber-900",
  sent: "border-sky-300 bg-sky-50 text-sky-900",
  accepted: "border-emerald-300 bg-emerald-50 text-emerald-800",
  published: "border-emerald-300 bg-emerald-50 text-emerald-800",
  declined: "border-rose-300 bg-rose-50 text-rose-900",
  expired: "border-rose-300 bg-rose-50 text-rose-900",
  withdraw_pending: "border-rose-300 bg-rose-50 text-rose-900",
};

export function SubmissionBadge({ status }: { status: SubmissionStatus }) {
  const tone = TONE[status] ?? "border-slate-300 bg-slate-50 text-slate-700";
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}>
      {LABEL[status] ?? status}
    </span>
  );
}
