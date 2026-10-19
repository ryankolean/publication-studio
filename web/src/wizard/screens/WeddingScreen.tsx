import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useSession } from "../../session-context.js";
import type { StepContext } from "../context.js";
import { Alert, Frame, INPUT, LABEL, Loading } from "../Frame.js";
import type { RailProps } from "../Frame.js";
import { STEPS, errorText, eventPayload, textOrNull, wizardPath, type StoredEvent } from "../model.js";

interface Fields {
  coupleNames: string;
  eventDate: string;
  venueName: string;
  city: string;
  state: string;
  country: string;
  isDestination: boolean;
}

const EMPTY: Fields = {
  coupleNames: "",
  eventDate: "",
  venueName: "",
  city: "",
  state: "",
  country: "",
  isDestination: false,
};

/** A new wedding has no record yet, so nothing on the rail is done. */
const NEW_RAIL: RailProps = {
  eventId: "new",
  packageId: null,
  current: "wedding",
  steps: STEPS.map((id) => ({ id, done: false })),
};

/** Why Continue is off, mirroring the server's rule for this screen. */
function missing(fields: Fields): string | null {
  if (fields.coupleNames.trim() === "") return "Add the couple's names to continue.";
  if (fields.eventDate.trim() === "") return "Add the wedding date to continue.";
  if (fields.venueName.trim() === "" && fields.city.trim() === "") return "Add the venue or the city to continue.";
  return null;
}

/**
 * [wedding] The wedding. For a new one (ctx null) nothing exists until
 * Continue, which creates it; for an existing one Continue saves the record.
 */
export function WeddingScreen({ ctx }: { ctx: StepContext | null }) {
  const { api } = useSession();
  const navigate = useNavigate();
  const eventId = ctx?.eventId ?? null;

  const [stored, setStored] = useState<StoredEvent | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (eventId === null) return;
    let cancelled = false;
    api
      .get<StoredEvent>(`/events/${eventId}`)
      .then((event) => {
        if (cancelled) return;
        setStored(event);
        setFields({
          coupleNames: event.coupleNames,
          eventDate: event.eventDate,
          venueName: event.venueName ?? "",
          city: event.city ?? "",
          state: event.state ?? "",
          country: event.country ?? "",
          isDestination: event.isDestination,
        });
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorText(caught, "Could not load this wedding."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, eventId]);

  const set = (key: keyof Fields) => (value: string) => setFields((current) => ({ ...current, [key]: value }));

  async function save() {
    setSaving(true);
    setSaveError(null);
    const changes = {
      coupleNames: fields.coupleNames.trim(),
      eventDate: fields.eventDate,
      venueName: textOrNull(fields.venueName),
      city: textOrNull(fields.city),
      state: textOrNull(fields.state),
      country: textOrNull(fields.country),
      isDestination: fields.isDestination,
    };
    try {
      if (ctx === null) {
        const created = await api.post<{ id: string }>("/events", changes);
        navigate(wizardPath(created.id, "permissions"));
      } else if (stored !== null) {
        await api.patch(`/events/${ctx.eventId}`, eventPayload(stored, changes));
        ctx.go("permissions");
      }
    } catch (caught) {
      setSaveError(errorText(caught, "Could not save the wedding."));
      setSaving(false);
    }
  }

  const loading = ctx !== null && stored === null;

  return (
    <Frame
      title="The wedding"
      lead="Outlets print exactly what you enter here."
      rail={ctx?.rail ?? NEW_RAIL}
      back={ctx?.back ?? "/wizard"}
      primary={
        loading
          ? null
          : { label: "Continue", onClick: () => void save(), disabledReason: missing(fields), busy: saving }
      }
      after={saveError !== null && <Alert>{saveError}</Alert>}
    >
      {loadError !== null ? (
        <Alert>{loadError}</Alert>
      ) : loading ? (
        <Loading what="the wedding" />
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="couple-names" className={LABEL}>
              Couple names, as they should appear
            </label>
            <input id="couple-names" className={INPUT} value={fields.coupleNames} onChange={(e) => set("coupleNames")(e.target.value)} />
          </div>
          <div>
            <label htmlFor="wedding-date" className={LABEL}>
              Wedding date
            </label>
            <input id="wedding-date" type="date" className={INPUT} value={fields.eventDate} onChange={(e) => set("eventDate")(e.target.value)} />
          </div>
          <div>
            <label htmlFor="venue" className={LABEL}>
              Venue
            </label>
            <input id="venue" className={INPUT} value={fields.venueName} onChange={(e) => set("venueName")(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="city" className={LABEL}>
                City
              </label>
              <input id="city" className={INPUT} value={fields.city} onChange={(e) => set("city")(e.target.value)} />
            </div>
            <div>
              <label htmlFor="state" className={LABEL}>
                State
              </label>
              <input id="state" className={INPUT} value={fields.state} onChange={(e) => set("state")(e.target.value)} />
            </div>
            <div>
              <label htmlFor="country" className={LABEL}>
                Country
              </label>
              <input id="country" className={INPUT} value={fields.country} onChange={(e) => set("country")(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              checked={fields.isDestination}
              onChange={(e) => setFields((current) => ({ ...current, isDestination: e.target.checked }))}
            />
            Reads as a destination wedding
          </label>
        </div>
      )}
    </Frame>
  );
}
