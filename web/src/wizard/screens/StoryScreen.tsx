import { useEffect, useState } from "react";

import { useSession } from "../../session-context.js";
import type { StepContext } from "../context.js";
import { Alert, BUTTON, Frame, INPUT, LABEL, Loading } from "../Frame.js";
import { GUIDE } from "../guide.js";
import { errorText, eventPayload, textOrNull, type StoredEvent } from "../model.js";

interface VendorRow {
  role: string;
  businessName: string;
  website: string;
  instagram: string;
}

const EMPTY_ROW: VendorRow = { role: "", businessName: "", website: "", instagram: "" };

const started = (row: VendorRow) => row.role.trim() !== "" || row.businessName.trim() !== "";
const finished = (row: VendorRow) => row.role.trim() !== "" && row.businessName.trim() !== "";

/** [story] Story and vendors. */
export function StoryScreen({ ctx }: { ctx: StepContext }) {
  const { api } = useSession();
  const [stored, setStored] = useState<StoredEvent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [angle, setAngle] = useState("");
  const [story, setStory] = useState("");
  const [vendors, setVendors] = useState<VendorRow[]>([{ ...EMPTY_ROW }]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<StoredEvent>(`/events/${ctx.eventId}`)
      .then((event) => {
        if (cancelled) return;
        setStored(event);
        setAngle(event.uniqueAngle ?? "");
        setStory(event.coupleStory ?? "");
        setVendors(
          event.vendorCredits.length === 0
            ? [{ ...EMPTY_ROW }]
            : event.vendorCredits.map((credit) => ({
                role: credit.role,
                businessName: credit.businessName,
                website: credit.website ?? "",
                instagram: credit.instagram ?? "",
              })),
        );
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorText(caught, "Could not load this wedding."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, ctx.eventId]);

  function missing(): string | null {
    if (angle.trim() === "" && story.trim() === "") return "Add what made this wedding stand out to continue.";
    if (vendors.some((row) => started(row) && !finished(row))) return "Each vendor needs a role and a business name.";
    if (!vendors.some(finished)) return "Add at least one vendor to continue.";
    return null;
  }

  const update = (index: number, key: keyof VendorRow, value: string) =>
    setVendors((rows) => rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));

  async function save() {
    if (stored === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch(
        `/events/${ctx.eventId}`,
        eventPayload(stored, {
          uniqueAngle: textOrNull(angle),
          coupleStory: textOrNull(story),
          // Rows left blank are dropped rather than sent as empty credits.
          vendorCredits: vendors.filter(started).map((row) => ({
            role: row.role.trim(),
            businessName: row.businessName.trim(),
            website: textOrNull(row.website),
            instagram: textOrNull(row.instagram),
          })),
        }),
      );
      ctx.go("outlet");
    } catch (caught) {
      setSaveError(errorText(caught, "Could not save the story."));
      setSaving(false);
    }
  }

  return (
    <Frame
      guide={GUIDE.story}
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
            <label htmlFor="angle" className={LABEL}>
              What made this wedding stand out?
            </label>
            <textarea id="angle" rows={3} className={INPUT} value={angle} onChange={(e) => setAngle(e.target.value)} />
          </div>
          <div>
            <label htmlFor="story" className={LABEL}>
              How they met, or anything the couple shared
            </label>
            <p className="text-xs text-slate-500">Optional.</p>
            <textarea id="story" rows={4} className={INPUT} value={story} onChange={(e) => setStory(e.target.value)} />
          </div>

          <fieldset className="space-y-3">
            <legend className={LABEL}>Vendors</legend>
            {vendors.map((row, index) => {
              const n = index + 1;
              return (
                <div key={index} className="grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-2">
                  {(
                    [
                      ["role", "Role", "Florist"],
                      ["businessName", "Business", ""],
                      ["website", "Website", ""],
                      ["instagram", "Instagram", ""],
                    ] as const
                  ).map(([key, label, placeholder]) => (
                    <div key={key}>
                      <label htmlFor={`vendor-${key}-${index}`} className="block text-sm text-slate-700">
                        {label}
                        <span className="sr-only">{`, vendor ${n}`}</span>
                      </label>
                      <input
                        id={`vendor-${key}-${index}`}
                        className={INPUT}
                        placeholder={placeholder}
                        value={row[key]}
                        onChange={(e) => update(index, key, e.target.value)}
                      />
                    </div>
                  ))}
                  {vendors.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setVendors((rows) => rows.filter((_, i) => i !== index))}
                      className="justify-self-start text-sm text-slate-600 underline hover:text-slate-900"
                    >
                      {`Remove vendor ${n}`}
                    </button>
                  )}
                </div>
              );
            })}
            <button type="button" onClick={() => setVendors((rows) => [...rows, { ...EMPTY_ROW }])} className={BUTTON}>
              Add a vendor
            </button>
            <p className="text-sm text-slate-600">Outlets will not publish without complete credits.</p>
          </fieldset>
        </div>
      )}
    </Frame>
  );
}
