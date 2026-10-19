import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "../api/client.js";
import { useSession } from "../session-context.js";
import { GateReasons, RightsBadge, type Gate } from "../components/RightsBadge.js";

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
}

function place(event: EventSummary): string {
  return [event.venueName, [event.city, event.state].filter(Boolean).join(", ")]
    .filter((part) => part !== null && part !== "")
    .join(" - ");
}

export function DashboardPage() {
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
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
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
                  <h3 className="font-medium text-slate-900">{event.coupleNames}</h3>
                  <p className="text-sm text-slate-500">
                    {event.eventDate}
                    {place(event) !== "" ? ` - ${place(event)}` : ""}
                  </p>
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
