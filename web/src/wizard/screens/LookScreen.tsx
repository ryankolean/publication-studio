import { useEffect, useState } from "react";

import { useSession } from "../../session-context.js";
import { CATEGORY_LABEL, tagLabel, type LookBody, type LookTag, type TagState } from "../../style/tags.js";
import type { StepContext } from "../context.js";
import { Alert, BUTTON, Frame, LABEL, Loading, Tick } from "../Frame.js";
import { GUIDE } from "../guide.js";
import { errorText } from "../model.js";

const SMALL = "rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:border-slate-900 disabled:opacity-40";

/** [look] The suggested tags with their reasons, her answer to each, and any she adds. Never holds the wedding back. */
export function LookScreen({ ctx }: { ctx: StepContext }) {
  const { api } = useSession();
  const [look, setLook] = useState<LookBody | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [choice, setChoice] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get<LookBody>(`/style/events/${ctx.eventId}`)
      .then((body) => {
        if (!cancelled) setLook(body);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorText(caught, "Could not load the look of this wedding."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, ctx.eventId]);

  async function answer(tag: string, state: Exclude<TagState, "suggested">) {
    setSaving(tag);
    setError(null);
    try {
      setLook(await api.put<LookBody>(`/style/events/${ctx.eventId}/tags/${tag}`, { state }));
      setChoice("");
    } catch (caught) {
      setError(errorText(caught, "Could not save that tag."));
    } finally {
      setSaving(null);
    }
  }

  const shown = (look?.tags ?? []).filter((tag) => tag.state !== "rejected");
  const listed = new Set(shown.map((tag) => tag.id));
  const addable = (look?.vocabulary ?? []).filter((tag) => !listed.has(tag.id));
  const kept = shown.filter((tag) => tag.state === "confirmed").length;

  return (
    <Frame
      guide={GUIDE.look}
      rail={ctx.rail}
      back={ctx.back}
      primary={{ label: "Continue", onClick: () => ctx.go("outlet"), disabledReason: null, busy: saving !== null }}
      after={error !== null && <Alert>{error}</Alert>}
    >
      {loadError !== null ? (
        <Alert>{loadError}</Alert>
      ) : look === null ? (
        <Loading what="the look of this wedding" />
      ) : (
        <>
          <section aria-label="Tags" className="space-y-4">
            <p role="status" className="text-sm font-medium text-slate-900">
              {kept === 0 ? "No tags kept yet." : kept === 1 ? "1 tag kept." : `${kept} tags kept.`}
            </p>
            {shown.length === 0 && <p className="text-sm text-slate-600">No suggestions for this wedding. Add tags below.</p>}
            {Object.entries(CATEGORY_LABEL).map(([category, categoryLabel]) => {
              const tags = shown.filter((tag) => tag.category === category);
              if (tags.length === 0) return null;
              return (
                <div key={category}>
                  <h3 className="text-sm font-semibold text-slate-900">{categoryLabel}</h3>
                  <ul aria-label={categoryLabel} className="mt-2 space-y-2">
                    {tags.map((tag) => (
                      <TagLine key={tag.id} tag={tag} busy={saving === tag.id} onAnswer={(state) => void answer(tag.id, state)} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0">
              <label htmlFor="add-tag" className={LABEL}>
                Add a tag
              </label>
              <select
                id="add-tag"
                value={choice}
                onChange={(change) => setChoice(change.target.value)}
                className="mt-1 max-w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
              >
                <option value="">Choose a tag</option>
                {Object.entries(CATEGORY_LABEL).map(([category, categoryLabel]) => (
                  <optgroup key={category} label={categoryLabel}>
                    {addable
                      .filter((tag) => tag.category === category)
                      .map((tag) => (
                        <option key={tag.id} value={tag.id}>
                          {tagLabel(tag.id)}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={choice === "" || saving !== null}
              onClick={() => void answer(choice, "confirmed")}
              className={BUTTON}
            >
              Add
            </button>
          </div>
        </>
      )}
    </Frame>
  );
}

function TagLine({ tag, busy, onAnswer }: { tag: LookTag; busy: boolean; onAnswer: (state: "confirmed" | "rejected") => void }) {
  const name = tagLabel(tag.id);
  const kept = tag.state === "confirmed";
  return (
    <li className={`rounded-md border p-2 ${kept ? "border-emerald-300 bg-emerald-50" : "border-slate-200"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-slate-900">
          {kept && <Tick />}
          <span className="break-words">{name}</span>
          {kept && <span className="sr-only">(kept)</span>}
        </span>
        <span className="flex shrink-0 gap-1">
          {kept ? (
            <button type="button" disabled={busy} aria-label={`Remove ${name}`} onClick={() => onAnswer("rejected")} className={SMALL}>
              Remove
            </button>
          ) : (
            <>
              <button type="button" disabled={busy} aria-label={`Keep ${name}`} onClick={() => onAnswer("confirmed")} className={SMALL}>
                Keep
              </button>
              <button type="button" disabled={busy} aria-label={`Not this: ${name}`} onClick={() => onAnswer("rejected")} className={SMALL}>
                Not this
              </button>
            </>
          )}
        </span>
      </div>
      {tag.reason !== null && tag.reason !== "" && <p className="mt-1 text-xs break-words text-slate-600">{tag.reason}</p>}
    </li>
  );
}
