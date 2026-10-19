import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "../api/client.js";
import { useSession } from "../session-context.js";
import { GateReasons, RightsBadge, type Gate } from "../components/RightsBadge.js";
import type { SubmissionView } from "./QueuePage.js";

export interface EventSummary {
  id: string;
  slug: string;
  coupleNames: string;
  eventDate: string;
  venueName: string | null;
  city: string | null;
  state: string | null;
  hasGalleryUrl: boolean;
  gate: Gate;
  /** The server follows a package for it in the wizard: something is under way. */
  inProgress: boolean;
}

function place(event: EventSummary): string {
  return [event.venueName, [event.city, event.state].filter(Boolean).join(", ")]
    .filter((part) => part !== null && part !== "")
    .join(" - ");
}

/** One read of the queue, reduced to what needs a person today. */
function ActionStrip() {
  const { api } = useSession();
  const [submissions, setSubmissions] = useState<SubmissionView[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ submissions: SubmissionView[] }>("/submissions")
      .then((body) => {
        if (!cancelled) setSubmissions(body.submissions);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (failed) return <p className="text-sm text-slate-500">Could not load the queue.</p>;
  if (submissions === null) return null;

  const ready = submissions.filter((s) => s.status === "ready" || s.status === "queued").length;
  const live = submissions.filter((s) => s.status === "sent");
  const earliest = live
    .map((s) => s.responseDueAt)
    .filter((due): due is string => due !== null)
    .sort()[0];

  return (
    <section aria-label="Action needed" className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Action needed</h2>
        <Link to="/queue" className="text-sm text-slate-600 underline hover:text-slate-900">
          Open the queue
        </Link>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-700">
        <p>{`Ready to send: ${ready}`}</p>
        <p>{`Live: ${live.length}`}</p>
        <p>{`Earliest due: ${earliest === undefined ? "none" : earliest.slice(0, 10)}`}</p>
      </div>
    </section>
  );
}

export function DashboardPage() {
  return (
    <div className="space-y-8">
      <section aria-label="Start" className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">Get a wedding ready for an outlet, one step at a time.</p>
        <Link to="/wizard" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          Start a submission
        </Link>
      </section>
      <ActionStrip />
      <Inventory />
    </div>
  );
}

function Inventory() {
  const { api } = useSession();
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ events: EventSummary[] }>("/events")
      .then((body) => {
        if (!cancelled) setEvents(body.events);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : "Could not load events.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-rose-700">
        {error}
      </p>
    );
  }

  if (events === null) return <p className="text-sm text-slate-500">Loading events.</p>;

  return (
    <section>
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Inventory</h2>
        <Link
          to="/events/new"
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-slate-900"
        >
          Add an event
        </Link>
      </header>

      {events.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">
          No events yet. Add one to see its rights and consent status.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {events.map((event) => (
            <li key={event.id} className="rounded-lg border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-medium text-slate-900">
                    <Link to={`/events/${event.id}`} className="hover:underline">
                      {event.coupleNames}
                    </Link>
                  </h3>
                  <p className="text-sm text-slate-500">
                    {event.eventDate}
                    {place(event) !== "" ? ` - ${place(event)}` : ""}
                  </p>
                  {event.inProgress && (
                    <Link
                      to={`/wizard/${event.id}`}
                      aria-label={`Continue ${event.coupleNames}`}
                      className="mt-2 inline-block rounded-md border border-slate-900 px-3 py-1 text-sm font-medium text-slate-900"
                    >
                      Continue
                    </Link>
                  )}
                </div>
                <RightsBadge gate={event.gate} />
              </div>
              <GateReasons gate={event.gate} />
              {!event.hasGalleryUrl && (
                <p className="mt-2 text-sm text-slate-500">No gallery link on file.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
