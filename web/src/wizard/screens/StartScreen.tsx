import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useSession } from "../../session-context.js";
import { Alert, BUTTON, Frame, Loading } from "../Frame.js";
import { errorText, friendlyDate } from "../model.js";

type ChipKind = "ready" | "needs_details" | "blocked" | "queued" | "live" | "accepted" | "published";

/** GET /events, reduced to what a wedding card shows. */
interface WeddingCard {
  id: string;
  coupleNames: string;
  eventDate: string;
  chip: { kind: ChipKind; label: string };
}

const CHIP_TONE: Record<ChipKind, string> = {
  ready: "border-emerald-300 bg-emerald-50 text-emerald-900",
  needs_details: "border-amber-300 bg-amber-50 text-amber-900",
  blocked: "border-rose-300 bg-rose-50 text-rose-900",
  queued: "border-sky-300 bg-sky-50 text-sky-900",
  live: "border-sky-300 bg-sky-50 text-sky-900",
  accepted: "border-emerald-300 bg-emerald-50 text-emerald-900",
  published: "border-slate-300 bg-slate-100 text-slate-800",
};

/** [start] Choose a wedding. The chip on each card is the server's verdict. */
export function StartScreen() {
  const { api } = useSession();
  const navigate = useNavigate();
  const [weddings, setWeddings] = useState<WeddingCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ events: WeddingCard[] }>("/events")
      .then((body) => {
        if (!cancelled) setWeddings(body.events);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught, "Could not load your weddings."));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <Frame
      guide={{
        title: "Choose a wedding",
        lead: "Pick the wedding you want to submit, or add a new one.",
        todo: ["Tap a wedding, or add one.", 'Press "Continue".'],
        next: "Next up: the wedding.",
      }}
      back="/"
      primary={{
        label: "Continue",
        onClick: () => {
          if (chosen !== null) navigate(`/wizard/${chosen}`);
        },
        disabledReason: chosen === null ? "Pick a wedding to continue." : null,
      }}
    >
      <Link to="/wizard/new/wedding" className={BUTTON}>
        Add a wedding
      </Link>

      {error !== null ? (
        <Alert>{error}</Alert>
      ) : weddings === null ? (
        <Loading what="your weddings" />
      ) : weddings.length === 0 ? (
        <p className="text-sm text-slate-600">No weddings yet. Add one to start.</p>
      ) : (
        <fieldset>
          <legend className="sr-only">Weddings</legend>
          <ul className="space-y-3">
            {weddings.map((wedding) => {
              const selected = chosen === wedding.id;
              return (
                <li key={wedding.id}>
                  <label
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${
                      selected ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200 hover:border-slate-400"
                    }`}
                  >
                    <input
                      type="radio"
                      name="wedding"
                      value={wedding.id}
                      checked={selected}
                      onChange={() => setChosen(wedding.id)}
                      className="mt-1"
                    />
                    <span className="min-w-0 grow">
                      <span className="block font-medium break-words text-slate-900">{wedding.coupleNames}</span>
                      <span className="block text-sm text-slate-500">{friendlyDate(wedding.eventDate)}</span>
                      <span
                        className={`mt-2 inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium break-words ${CHIP_TONE[wedding.chip.kind]}`}
                      >
                        {wedding.chip.label}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
    </Frame>
  );
}
