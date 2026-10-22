import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useSession } from "../session-context.js";
import { Alert, BUTTON, Loading, PRIMARY } from "../wizard/Frame.js";
import { WELCOME } from "../wizard/guide.js";
import { errorText, friendlyDate } from "../wizard/model.js";
import type { SubmissionView } from "./QueuePage.js";

export type ChipKind = "ready" | "needs_details" | "blocked" | "queued" | "live" | "accepted" | "published";

/** GET /events, reduced to what a wedding card shows. */
export interface WeddingCard {
  id: string;
  coupleNames: string;
  eventDate: string;
  chip: { kind: ChipKind; label: string; packageId: string | null };
  /** True once the wedding has ever had a submission started. */
  hasPackage: boolean;
  inProgress: boolean;
}

/** The one button on each card, and the sentence above it, by where the wedding stands. */
export const CARD_ACTION: Record<ChipKind, { button: string; next: string }> = {
  ready: { button: "Start this one", next: "Everything is in place. Choose an outlet when you are ready." },
  needs_details: { button: "Finish the details", next: "A few details are still missing. The next screen shows which." },
  blocked: { button: "See what is holding it", next: "This wedding is on hold until its permissions are in place." },
  queued: { button: "Send it", next: "Your submission is ready. Send it to the outlet, then mark it sent." },
  live: { button: "Record the reply", next: "Waiting on the outlet. Record the answer when it comes." },
  accepted: { button: "Add the live link", next: "Accepted. Paste the link once the feature is live." },
  published: { button: "See how it went", next: "Published. Nothing more to do here." },
};

const CHIP_TONE: Record<ChipKind, string> = {
  ready: "border-emerald-300 bg-emerald-50 text-emerald-900",
  needs_details: "border-amber-300 bg-amber-50 text-amber-900",
  blocked: "border-rose-300 bg-rose-50 text-rose-900",
  queued: "border-sky-300 bg-sky-50 text-sky-900",
  live: "border-sky-300 bg-sky-50 text-sky-900",
  accepted: "border-emerald-300 bg-emerald-50 text-emerald-900",
  published: "border-slate-300 bg-slate-100 text-slate-800",
};

/**
 * Where the card's button goes. With a package named, the server resumes on
 * that package (a published wedding lands on its reply, not the outlet
 * chooser); without one it picks the first unfinished step.
 */
export function cardHref(card: { id: string; chip: { kind: ChipKind; packageId: string | null } }): string {
  const { id, chip } = card;
  return chip.packageId === null ? `/wizard/${id}` : `/wizard/${id}?package=${encodeURIComponent(chip.packageId)}`;
}

/** "2 ready to send, 1 waiting on a reply, earliest due November 3, 2026." or null when there is nothing to say. */
export function queueLine(submissions: SubmissionView[]): string | null {
  const ready = submissions.filter((entry) => entry.status === "ready" || entry.status === "queued").length;
  const live = submissions.filter((entry) => entry.status === "sent");
  if (ready === 0 && live.length === 0) return null;
  const parts: string[] = [];
  if (ready > 0) parts.push(`${ready} ready to send`);
  if (live.length > 0) parts.push(`${live.length} waiting on a reply`);
  const earliest = live
    .map((entry) => entry.responseDueAt)
    .filter((due): due is string => due !== null)
    .sort()[0];
  if (earliest !== undefined) parts.push(`earliest due ${friendlyDate(earliest.slice(0, 10))}`);
  return `${parts.join(", ")}.`;
}

function Welcome() {
  return (
    <section aria-label="Welcome" className="rounded-lg border border-slate-200 bg-slate-50 p-5">
      <h2 className="text-xl font-semibold text-slate-900">{WELCOME.title}</h2>
      <p className="mt-2 text-sm text-slate-700">{WELCOME.lead}</p>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-800">
        {WELCOME.journey.map((stage) => (
          <li key={stage}>{stage}</li>
        ))}
      </ol>
      <p className="mt-3 text-sm text-slate-700">{WELCOME.closing}</p>
    </section>
  );
}

function QueueLine() {
  const { api } = useSession();
  const [submissions, setSubmissions] = useState<SubmissionView[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ submissions: SubmissionView[] }>("/submissions")
      .then((body) => {
        if (!cancelled) setSubmissions(body.submissions);
      })
      .catch(() => {
        // The home page still works without the queue line; the queue page says what went wrong.
        if (!cancelled) setSubmissions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const line = submissions === null ? null : queueLine(submissions);
  if (line === null) return null;
  return (
    <p className="text-sm text-slate-700">
      {`${line} `}
      <Link to="/queue" className="underline">
        Open the queue
      </Link>
    </p>
  );
}

function Card({ wedding }: { wedding: WeddingCard }) {
  const action = CARD_ACTION[wedding.chip.kind];
  return (
    <li className="rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium break-words text-slate-900">{wedding.coupleNames}</h3>
          <p className="text-sm text-slate-500">{friendlyDate(wedding.eventDate)}</p>
        </div>
        <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium break-words ${CHIP_TONE[wedding.chip.kind]}`}>
          {wedding.chip.label}
        </span>
      </div>
      <p className="mt-3 text-sm break-words text-slate-700">{action.next}</p>
      <Link to={cardHref(wedding)} aria-label={`${action.button}: ${wedding.coupleNames}`} className={`mt-3 ${PRIMARY}`}>
        {action.button}
      </Link>
    </li>
  );
}

/** The home page: a welcome until the first submission, the queue in one line, and a card per wedding. */
export function HomePage() {
  const { api } = useSession();
  const [weddings, setWeddings] = useState<WeddingCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ events: WeddingCard[] }>("/events")
      .then((body) => {
        if (!cancelled) setWeddings(body.events);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught, "Could not load your weddings. Try again in a moment."));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (error !== null) return <Alert>{error}</Alert>;
  if (weddings === null) return <Loading what="your weddings" />;

  const firstVisit = weddings.every((wedding) => !wedding.hasPackage);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {firstVisit ? (
        <Welcome />
      ) : (
        <p className="text-sm text-slate-600">
          {"Each screen tells you what to do. "}
          <Link to="/help" className="underline">
            How it works
          </Link>
        </p>
      )}
      <QueueLine />
      <section aria-label="Your weddings" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">Your weddings</h2>
          <Link to="/wizard/new/wedding" className={BUTTON}>
            Add a wedding
          </Link>
        </div>
        {weddings.length === 0 ? (
          <p className="text-sm text-slate-600">No weddings yet. Add one to begin.</p>
        ) : (
          <ul className="space-y-3">
            {weddings.map((wedding) => (
              <Card key={wedding.id} wedding={wedding} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
