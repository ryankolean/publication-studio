import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";

import { useSession } from "../../session-context.js";
import type { StepContext } from "../context.js";
import { Alert, BUTTON, Frame, INPUT, LABEL, PRIMARY } from "../Frame.js";
import { errorText, friendlyDate, type WizardState } from "../model.js";
import { NeedsEarlier } from "./shared.js";

const TITLE = "Track the reply";
const LEAD = "Record the outlet's answer here when it comes.";

type Outcome = "accepted" | "declined";

const OUTCOME_TEXT: Partial<Record<string, string>> = {
  accepted: "Accepted. Record the live link when the feature runs.",
  published: "Published.",
  declined: "Declined. The wedding is free for another outlet.",
  expired: "No answer by the due date.",
  withdraw_pending: "Withdrawal pending.",
  withdrawn: "Withdrawn. The wedding is free for another outlet.",
};

function dueLine(reply: NonNullable<WizardState["reply"]>, outlet: string): string {
  if (reply.dueAt === null || reply.daysRemaining === null) {
    return reply.outletWords === null
      ? `${outlet} gives no reply window, so there is no due date.`
      : `${outlet} gives no reply window. In its own words: "${reply.outletWords}"`;
  }
  const date = friendlyDate(reply.dueAt.slice(0, 10));
  const days = reply.daysRemaining;
  if (days < 0) return `The reply was due ${date}. The window has passed.`;
  if (days === 0) return `The reply is due today, ${date}.`;
  return `Reply due ${date}: ${days === 1 ? "1 day" : `${days} days`} remaining.`;
}

function silenceLine(reply: NonNullable<WizardState["reply"]>, outlet: string): string {
  if (reply.outletWords === null) return `${outlet} does not say what silence means.`;
  // With no due date the words were already quoted in the due line.
  const quote = reply.dueAt === null ? "" : `${outlet} says: "${reply.outletWords}" `;
  if (reply.silenceMeansPass !== true) return `${quote}That does not say what silence means.`;
  return reply.dueAt === null
    ? "So no reply means it was a pass."
    : `${quote}So no reply by the due date means it was a pass.`;
}

/** [track] The due date, what silence means, and the outlet's answer. */
export function TrackScreen({ ctx }: { ctx: StepContext }) {
  const { api } = useSession();
  const { wizard } = ctx.walkthrough;
  const outlet = wizard.outlet?.name ?? "The outlet";

  const [choice, setChoice] = useState<Outcome | null>(null);
  const [note, setNote] = useState("");
  const [liveLink, setLiveLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submission = wizard.submission;
  if (submission === null || wizard.reply === null) {
    return (
      <NeedsEarlier
        ctx={ctx}
        title={TITLE}
        lead={LEAD}
        message="Mark it as sent first. The reply window starts then."
        step="send"
        linkLabel="Go to the send step"
      />
    );
  }
  const reply = wizard.reply;

  async function record(status: string, extra: Record<string, unknown>) {
    if (submission === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/submissions/${submission.id}`, { status, ...extra });
      setChoice(null);
      setNote("");
      ctx.reload();
    } catch (caught) {
      setError(errorText(caught, "Could not record that."));
    }
    setBusy(false);
  }

  function recordLink(submit: FormEvent) {
    submit.preventDefault();
    void record("published", { publishedUrl: liveLink.trim() });
  }

  const status = submission.status;

  return (
    <Frame title={TITLE} lead={LEAD} rail={ctx.rail} back={ctx.back} after={error !== null && <Alert>{error}</Alert>}>
      {status === "sent" ? (
        <>
          <section aria-label="When to expect an answer" className="space-y-2 text-sm text-slate-800">
            <p className="font-medium">{dueLine(reply, outlet)}</p>
            <p>{silenceLine(reply, outlet)}</p>
          </section>

          <section aria-label="Record the answer" className="space-y-3">
            <p className="text-sm font-medium text-slate-900">{`Did ${outlet} answer?`}</p>
            {choice === null ? (
              <div className="flex flex-wrap gap-3">
                <button type="button" onClick={() => setChoice("accepted")} className={BUTTON}>
                  Accepted
                </button>
                <button type="button" onClick={() => setChoice("declined")} className={BUTTON}>
                  Declined
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <label htmlFor="outcome-note" className={LABEL}>
                  Note (optional)
                </label>
                <textarea id="outcome-note" rows={2} className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} />
                <p className="text-sm text-slate-800">
                  {choice === "accepted" ? `Record that ${outlet} accepted it?` : `Record that ${outlet} declined it?`}
                </p>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void record(choice, note.trim() === "" ? {} : { outcomeNotes: note.trim() })}
                    className={PRIMARY}
                  >
                    {choice === "accepted" ? "Yes, it was accepted" : "Yes, it was declined"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setChoice(null)} className={BUTTON}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      ) : (
        <section aria-label="The answer" className="space-y-3">
          <p className="text-sm font-medium text-slate-900">{OUTCOME_TEXT[status] ?? "Recorded."}</p>
          {status === "published" && submission.publishedUrl !== null && (
            <a
              href={submission.publishedUrl}
              target="_blank"
              rel="noreferrer"
              className="block text-sm break-all text-slate-700 underline"
            >
              {submission.publishedUrl}
            </a>
          )}
          {status === "accepted" && (
            <form onSubmit={recordLink} className="space-y-2" noValidate>
              <label htmlFor="live-link" className={LABEL}>
                Live link
              </label>
              <input id="live-link" type="url" className={INPUT} value={liveLink} onChange={(e) => setLiveLink(e.target.value)} />
              <button type="submit" disabled={busy || liveLink.trim() === ""} className={PRIMARY}>
                Record it
              </button>
            </form>
          )}
        </section>
      )}

      {wizard.finished && (
        <Link to="/wizard" className={`${PRIMARY} w-fit`}>
          Done. Start another submission
        </Link>
      )}
    </Frame>
  );
}
