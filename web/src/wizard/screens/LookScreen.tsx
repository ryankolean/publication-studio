import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { API_BASE_URL } from "../../config.js";
import { useSession } from "../../session-context.js";
import { CATEGORY_LABEL, tagLabel, type LookBody, type LookTag, type TagState } from "../../style/tags.js";
import type { StepContext } from "../context.js";
import { Alert, BUTTON, Frame, LABEL, Loading, Tick } from "../Frame.js";
import { GUIDE } from "../guide.js";
import { errorText } from "../model.js";
import type { PoolImage } from "../package.js";
import { AddPhotos } from "./AddPhotos.js";

const SMALL = "rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:border-slate-900 disabled:opacity-40";
const SHOWN_PHOTOS = 12;

/** Why "Suggest tags" cannot run right now, in her words; null when it can. */
function suggestBlocker(look: LookBody): string | null {
  if (!look.analysis.available) return "Suggestions are not set up yet. Choose the tags yourself for now.";
  if (!look.analysis.enabled) return "Suggestions are switched off. Turn them on under Your work.";
  if (look.photos.count === 0) return "Add a few photos first.";
  if (look.photos.usable === 0) return "Every photo here is over 7.5 MB. Add web-size copies first.";
  if (look.analysis.current) return "These photos already have suggestions. Add more for a fresh look.";
  return null;
}

/** [look] Photos in, tag suggestions out, and her answer to each. Never holds the wedding back. */
export function LookScreen({ ctx }: { ctx: StepContext }) {
  const { api } = useSession();
  const [look, setLook] = useState<LookBody | null>(null);
  const [pool, setPool] = useState<PoolImage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [choice, setChoice] = useState("");

  const load = useCallback(async () => {
    const [body, images] = await Promise.all([
      api.get<LookBody>(`/style/events/${ctx.eventId}`),
      api.get<{ images: PoolImage[] }>(`/events/${ctx.eventId}/images`),
    ]);
    setLook(body);
    setPool(images.images);
  }, [api, ctx.eventId]);

  useEffect(() => {
    load().catch((caught: unknown) => setLoadError(errorText(caught, "Could not load the look of this wedding.")));
  }, [load]);

  const reload = useCallback(async () => {
    try {
      await load();
    } catch (caught) {
      setError(errorText(caught, "Could not refresh the photos."));
    }
  }, [load]);

  async function suggest() {
    setSuggesting(true);
    setError(null);
    try {
      setLook(await api.post<LookBody>(`/style/events/${ctx.eventId}/suggest`, {}));
    } catch (caught) {
      setError(errorText(caught, "Could not suggest tags just now."));
    } finally {
      setSuggesting(false);
    }
  }

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

  const blocker = look === null ? null : suggestBlocker(look);
  const shown = (look?.tags ?? []).filter((tag) => tag.state !== "rejected");
  const listed = new Set(shown.map((tag) => tag.id));
  const addable = (look?.vocabulary ?? []).filter((tag) => !listed.has(tag.id));
  const kept = shown.filter((tag) => tag.state === "confirmed").length;

  return (
    <Frame
      guide={GUIDE.look}
      rail={ctx.rail}
      back={ctx.back}
      primary={{ label: "Continue", onClick: () => ctx.go("outlet"), disabledReason: null, busy: suggesting || uploading }}
      after={error !== null && <Alert>{error}</Alert>}
    >
      {loadError !== null ? (
        <Alert>{loadError}</Alert>
      ) : look === null ? (
        <Loading what="the look of this wedding" />
      ) : (
        <>
          <section aria-label="Your photos" className="space-y-3">
            <AddPhotos eventId={ctx.eventId} onAdded={reload} onUploading={setUploading} />
            {pool.length > 0 && (
              <>
                <p className="text-sm text-slate-600">
                  {pool.length === 1 ? "1 photo here." : `${pool.length} photos here.`}
                </p>
                <ul aria-label="Photos so far" className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {pool.slice(0, SHOWN_PHOTOS).map((image) => (
                    <li key={image.key} className="min-w-0">
                      <img
                        src={`${API_BASE_URL}${image.readUrl}`}
                        alt=""
                        loading="lazy"
                        className="aspect-square w-full rounded bg-slate-50 object-cover"
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section aria-label="Suggestions" className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void suggest()}
                disabled={blocker !== null || suggesting || uploading}
                aria-describedby={blocker !== null ? "suggest-reason" : undefined}
                className={BUTTON}
              >
                Suggest tags
              </button>
              {suggesting ? (
                <p role="status" className="text-sm text-slate-600">
                  Looking at your photos. This can take a minute.
                </p>
              ) : (
                blocker !== null && (
                  <p id="suggest-reason" className="min-w-0 text-sm break-words text-slate-600">
                    {blocker}
                  </p>
                )
              )}
            </div>
            {!look.analysis.enabled && look.analysis.available && (
              <Link to="/style" className="text-sm underline">
                Your work
              </Link>
            )}
          </section>

          <section aria-label="Tags" className="space-y-4">
            <p role="status" className="text-sm font-medium text-slate-900">
              {kept === 0 ? "No tags kept yet." : kept === 1 ? "1 tag kept." : `${kept} tags kept.`}
            </p>
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
            <button type="button" disabled={choice === "" || saving !== null} onClick={() => void answer(choice, "confirmed")} className={BUTTON}>
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
