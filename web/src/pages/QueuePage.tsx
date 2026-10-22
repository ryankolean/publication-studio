import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "../api/client.js";
import { useSession } from "../session-context.js";
import { SubmissionBadge, type SubmissionStatus } from "../components/SubmissionBadge.js";

export interface SubmissionView {
  id: string;
  eventId: string;
  coupleNames: string;
  publicationId: string;
  publicationName: string;
  status: SubmissionStatus;
  packageId: string | null;
  queuedAt: string | null;
  sentAt: string | null;
  responseDueAt: string | null;
  outcomeAt: string | null;
  outcomeNotes: string | null;
  publishedUrl: string | null;
  /** Whole days to the due date, negative once passed, null with no due date. */
  daysRemaining: number | null;
}

type Outcome = "accepted" | "declined";

const messageOf = (caught: unknown, fallback: string): string =>
  caught instanceof ApiError ? caught.message : fallback;

function windowText(days: number | null): string {
  if (days === null) return "Window unknown";
  if (days < 0) return "Window passed";
  if (days === 0) return "Less than a day remaining";
  return days === 1 ? "1 day remaining" : `${days} days remaining`;
}

const BUTTON = "rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-slate-900";
const PRIMARY = "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";

function RowHeader({ submission, badge }: { submission: SubmissionView; badge: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="font-medium break-words text-slate-900">{submission.coupleNames}</p>
        <p className="text-sm break-words text-slate-500">{submission.publicationName}</p>
      </div>
      {badge && <SubmissionBadge status={submission.status} />}
    </div>
  );
}

/** Opens the wizard on this submission, where the server picks the step. */
function OpenWedding({ submission }: { submission: SubmissionView }) {
  const target =
    submission.packageId === null
      ? `/wizard/${submission.eventId}`
      : `/wizard/${submission.eventId}?package=${encodeURIComponent(submission.packageId)}`;
  return (
    <Link to={target} className="text-sm text-slate-600 underline hover:text-slate-900">
      Open this wedding
    </Link>
  );
}

function ReadyRow({ submission, onChanged }: { submission: SubmissionView; onChanged: () => Promise<void> }) {
  const { api } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markSent() {
    setBusy(true);
    setError(null);
    try {
      // DECISION: the lifecycle has no ready -> sent edge, and the server
      // refuses one. A ready row is walked through queued first, each step its
      // own PATCH so the server checks and audit-logs both. If the send is then
      // refused, the row stays queued, which is still "ready to send".
      if (submission.status === "ready") {
        await api.patch(`/submissions/${submission.id}`, { status: "queued" });
      }
      await api.patch(`/submissions/${submission.id}`, { status: "sent" });
    } catch (caught) {
      setError(messageOf(caught, "Could not record the send."));
    }
    setConfirming(false);
    setBusy(false);
    await onChanged();
  }

  return (
    <li className="rounded-lg border border-slate-200 p-4">
      <RowHeader submission={submission} badge />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <OpenWedding submission={submission} />
        {confirming ? (
          <>
            <button type="button" disabled={busy} onClick={() => void markSent()} className={PRIMARY}>
              Confirm: I sent it
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={BUTTON}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            className={BUTTON}
          >
            Mark as sent
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        This tool does not send anything. Send the package yourself through the outlet's form, portal or email, then
        mark it sent here.
      </p>
      {error !== null && (
        <p role="alert" className="mt-2 text-sm break-words text-rose-700">
          {error}
        </p>
      )}
    </li>
  );
}

function LiveRow({ submission, onChanged }: { submission: SubmissionView; onChanged: () => Promise<void> }) {
  const { api } = useSession();
  const [choice, setChoice] = useState<Outcome | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notesId = `outcome-notes-${submission.id}`;

  async function record(outcome: Outcome) {
    setBusy(true);
    setError(null);
    const trimmed = notes.trim();
    try {
      await api.patch(`/submissions/${submission.id}`, {
        status: outcome,
        ...(trimmed === "" ? {} : { outcomeNotes: trimmed }),
      });
      await onChanged();
    } catch (caught) {
      setError(messageOf(caught, "Could not record the outcome."));
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-slate-200 p-4">
      <RowHeader submission={submission} badge={false} />
      <p className="mt-2 text-sm text-slate-700">
        {windowText(submission.daysRemaining)}
        {submission.responseDueAt !== null ? (
          <span className="text-slate-500">{` - Due ${submission.responseDueAt.slice(0, 10)}`}</span>
        ) : null}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <OpenWedding submission={submission} />
        {choice === null && (
          <>
            <button type="button" onClick={() => setChoice("accepted")} className={BUTTON}>
              Accepted
            </button>
            <button type="button" onClick={() => setChoice("declined")} className={BUTTON}>
              Declined
            </button>
          </>
        )}
      </div>
      {choice !== null && (
        <div className="mt-3 space-y-2">
          <label htmlFor={notesId} className="block text-sm font-medium text-slate-700">
            Notes (optional)
          </label>
          <textarea
            id={notesId}
            rows={2}
            value={notes}
            onChange={(change) => setNotes(change.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={busy} onClick={() => void record(choice)} className={PRIMARY}>
              {`Confirm ${choice}`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setChoice(null);
                setNotes("");
              }}
              className={BUTTON}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="mt-2 text-sm break-words text-rose-700">
          {error}
        </p>
      )}
    </li>
  );
}

function FinishedRow({ submission }: { submission: SubmissionView }) {
  return (
    <li className="rounded-lg border border-slate-200 p-4">
      <RowHeader submission={submission} badge />
      {submission.publishedUrl !== null && (
        <a
          href={submission.publishedUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block text-sm break-all text-slate-700 underline hover:text-slate-900"
        >
          {submission.publishedUrl}
        </a>
      )}
      {submission.outcomeNotes !== null && (
        <p className="mt-2 text-sm break-words text-slate-600">{submission.outcomeNotes}</p>
      )}
    </li>
  );
}

function Group({ title, empty, children }: { title: string; empty: string; children: ReactElement[] }) {
  return (
    <section>
      <h3 className="font-medium text-slate-900">{title}</h3>
      {children.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">{empty}</p>
      ) : (
        <ul aria-label={title} className="mt-3 space-y-3">
          {children}
        </ul>
      )}
    </section>
  );
}

export function QueuePage() {
  const { api } = useSession();
  const [submissions, setSubmissions] = useState<SubmissionView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ submissions: SubmissionView[] }>("/submissions")
      .then((body) => {
        if (!cancelled) setSubmissions(body.submissions);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(messageOf(caught, "Could not load the queue."));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  /** Re-reads the queue after a change; the server's order and state are the truth. */
  const refresh = useCallback(async () => {
    try {
      const body = await api.get<{ submissions: SubmissionView[] }>("/submissions");
      setSubmissions(body.submissions);
      setRefreshError(null);
    } catch (caught) {
      setRefreshError(messageOf(caught, "Could not refresh the queue."));
    }
  }, [api]);

  if (loadError !== null) {
    return (
      <p role="alert" className="text-sm text-rose-700">
        {loadError}
      </p>
    );
  }

  if (submissions === null) return <p className="text-sm text-slate-500">Loading the queue.</p>;

  // The server orders the list; grouping keeps that order within each group.
  const ready = submissions.filter((s) => s.status === "ready" || s.status === "queued");
  const live = submissions.filter((s) => s.status === "sent");
  const finished = submissions.filter((s) => !["ready", "queued", "sent"].includes(s.status));

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-lg font-semibold text-slate-900">Queue</h2>
        <p className="mt-1 text-sm text-slate-600">
          Every send happens outside this tool. This page records what you sent and what came back.
        </p>
        {refreshError !== null && <p className="mt-2 text-sm text-rose-700">{refreshError}</p>}
      </header>

      <Group title="Ready to send" empty="Nothing is waiting to be sent. Create a submission from a complete package.">
        {ready.map((s) => (
          <ReadyRow key={s.id} submission={s} onChanged={refresh} />
        ))}
      </Group>

      <Group title="Live" empty="Nothing is live at an outlet.">
        {live.map((s) => (
          <LiveRow key={s.id} submission={s} onChanged={refresh} />
        ))}
      </Group>

      <Group title="Finished" empty="No finished submissions yet.">
        {finished.map((s) => (
          <FinishedRow key={s.id} submission={s} />
        ))}
      </Group>
    </div>
  );
}
