import { useEffect, useState } from "react";

import { useSession } from "../../session-context.js";
import type { StepContext } from "../context.js";
import { Alert, Frame, INPUT, LABEL, Loading } from "../Frame.js";
import { GUIDE } from "../guide.js";
import { errorText, eventPayload, textOrNull, type StoredEvent } from "../model.js";

const RIGHTS = [
  { value: "own_contract", label: "Yes" },
  { value: "second_shooter", label: "No, I was the second shooter" },
  { value: "unverified", label: "Not sure" },
];

const CONSENT = [
  { value: "granted", label: "Yes" },
  { value: "granted_limited", label: "Yes, with limits" },
  { value: "unverified", label: "Not yet" },
  { value: "declined", label: "No" },
];

function Choice({
  name,
  legend,
  options,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset>
      <legend className={LABEL}>{legend}</legend>
      <div className="mt-2 space-y-2">
        {options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** [permissions] Your gallery and permissions. */
export function PermissionsScreen({ ctx }: { ctx: StepContext }) {
  const { api } = useSession();
  const [stored, setStored] = useState<StoredEvent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gallery, setGallery] = useState("");
  const [rights, setRights] = useState("");
  const [consent, setConsent] = useState("");
  const [nameDisplay, setNameDisplay] = useState("");
  const [limits, setLimits] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<StoredEvent>(`/events/${ctx.eventId}`)
      .then((event) => {
        if (cancelled) return;
        setStored(event);
        setRights(event.rightsStatus);
        setConsent(event.consentStatus);
        setNameDisplay(event.nameDisplay ?? "");
        setLimits(event.consentNotes ?? "");
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorText(caught, "Could not load this wedding."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, ctx.eventId]);

  const withLimits = consent === "granted_limited";

  function missing(): string | null {
    if (stored === null) return null;
    if (!stored.hasGalleryUrl && gallery.trim() === "") return "Add the gallery link to continue.";
    if (withLimits && nameDisplay.trim() === "" && limits.trim() === "") {
      return "Write down the couple's limits to continue.";
    }
    return null;
  }

  async function save() {
    if (stored === null) return;
    setSaving(true);
    setSaveError(null);
    // DECISION: a plain "Yes" means the couple set no limits, so any limits
    // stored earlier are cleared rather than left to haunt the final checks.
    // "Not yet" and "No" keep them: they are not an answer about limits.
    const plainYes = consent === "granted";
    try {
      await api.patch(
        `/events/${ctx.eventId}`,
        eventPayload(stored, {
          galleryUrl: gallery,
          rightsStatus: rights,
          consentStatus: consent,
          nameDisplay: plainYes ? null : textOrNull(nameDisplay),
          consentNotes: plainYes ? null : textOrNull(limits),
        }),
      );
      ctx.go("story");
    } catch (caught) {
      setSaveError(errorText(caught, "Could not save the permissions."));
      setSaving(false);
    }
  }

  return (
    <Frame
      guide={GUIDE.permissions}
      rail={ctx.rail}
      back={ctx.back}
      primary={
        stored === null
          ? null
          : { label: "Continue", onClick: () => void save(), disabledReason: missing(), busy: saving }
      }
      after={saveError !== null && <Alert>{saveError}</Alert>}
    >
      {loadError !== null ? (
        <Alert>{loadError}</Alert>
      ) : stored === null ? (
        <Loading what="the wedding" />
      ) : (
        <div className="space-y-6">
          <div>
            {stored.hasGalleryUrl ? (
              <>
                <p className={LABEL}>
                  Gallery link{" "}
                  <span className="ml-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-900">
                    On file
                  </span>
                </p>
                <label htmlFor="gallery" className="mt-3 block text-sm text-slate-700">
                  Replace the gallery link
                </label>
              </>
            ) : (
              <label htmlFor="gallery" className={LABEL}>
                Gallery link
              </label>
            )}
            <input id="gallery" type="url" className={INPUT} value={gallery} onChange={(e) => setGallery(e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">It stays private. Once saved, it is never shown again.</p>
          </div>

          <Choice
            name="rights"
            legend="Were you the lead photographer under your own contract?"
            options={RIGHTS}
            value={rights}
            onChange={setRights}
          />
          {rights === "blocked" && (
            <p className="text-sm text-slate-600">This wedding is marked blocked. Pick an answer only to change that.</p>
          )}
          {rights === "second_shooter" && (
            <p role="note" className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              Second-shooter weddings cannot be submitted under your name. The tool can help you ask the lead
              photographer for a credit instead.
            </p>
          )}

          <Choice
            name="consent"
            legend="Has the couple agreed to a submission?"
            options={CONSENT}
            value={consent}
            onChange={setConsent}
          />
          {withLimits && (
            <div className="space-y-4 rounded-md border border-slate-200 p-3">
              <div>
                <label htmlFor="name-display" className={LABEL}>
                  How their names should appear
                </label>
                <input
                  id="name-display"
                  className={INPUT}
                  placeholder="First names only"
                  value={nameDisplay}
                  onChange={(e) => setNameDisplay(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="limits" className={LABEL}>
                  What is off limits
                </label>
                <textarea
                  id="limits"
                  rows={2}
                  className={INPUT}
                  placeholder="No photos of the flower girl"
                  value={limits}
                  onChange={(e) => setLimits(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </Frame>
  );
}
