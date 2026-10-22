import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { ApiError } from "../../api/client.js";
import { API_BASE_URL } from "../../config.js";
import { useSession } from "../../session-context.js";
import type { StepContext } from "../context.js";
import { Alert, Frame, Loading, PRIMARY } from "../Frame.js";
import { GUIDE } from "../guide.js";
import { countRange, errorText } from "../model.js";
import { outletNameOf, type PackageView, type PoolImage } from "../package.js";
import { NO_OUTLET, NeedsEarlier } from "./shared.js";

const ACCEPT = "image/jpeg,image/png,image/webp";

interface UploadLine {
  name: string;
  text: string;
}

/** "12 chosen; Outlet A wants 30 to 40", or "12 chosen; no stated count". */
export function chosenLine(count: number, outlet: string, min: number | null, max: number | null): string {
  const range = countRange(min, max);
  return range === null ? `${count} chosen; no stated count` : `${count} chosen; ${outlet} wants ${range}`;
}

/**
 * DECISION: Continue is held above the outlet's maximum as well as below its
 * minimum. The server will not call the photos done outside the range, so
 * letting her past with too many would only send her back here on resume.
 */
function uploadSummary(lines: Array<{ name: string; text: string }>): string {
  const done = lines.filter((line) => line.text === "uploaded").length;
  const failed = lines.length - done;
  if (failed === 0) return done === 1 ? "1 photo added." : `${done} photos added.`;
  return `${done} added, ${failed} failed.`;
}

function countReason(count: number, min: number | null, max: number | null): string | null {
  const floor = Math.max(min ?? 1, 1);
  if (count < floor) return floor === 1 ? "Choose at least one photo to continue." : `Choose at least ${floor} to continue.`;
  if (max !== null && count > max) return `Choose no more than ${max} to continue.`;
  return null;
}

/** [photos] Upload into the wedding's pool, then pick and order the selection. */
export function PhotosScreen({ ctx }: { ctx: StepContext }) {
  if (ctx.packageId === null) return <NeedsEarlier ctx={ctx} guide={GUIDE.photos} {...NO_OUTLET} />;
  return <Photos ctx={ctx} packageId={ctx.packageId} />;
}

function Photos({ ctx, packageId }: { ctx: StepContext; packageId: string }) {
  const { api } = useSession();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pkg, setPkg] = useState<PackageView | null>(null);
  const [pool, setPool] = useState<PoolImage[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadLine[]>([]);
  const [uploading, setUploading] = useState(false);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<PackageView>(`/packages/${packageId}`),
      api.get<{ images: PoolImage[] }>(`/events/${ctx.eventId}/images`),
    ])
      .then(([view, body]) => {
        if (cancelled) return;
        setPkg(view);
        setSelection(view.imageKeys);
        setPool(body.images);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorText(caught, "Could not load the photos."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, ctx.eventId, packageId]);

  const reloadPool = useCallback(async () => {
    try {
      const body = await api.get<{ images: PoolImage[] }>(`/events/${ctx.eventId}/images`);
      setPool(body.images);
    } catch (caught) {
      setPoolError(errorText(caught, "Could not refresh the photos."));
    }
  }, [api, ctx.eventId]);

  async function upload(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setPoolError(null);
    setUploads(files.map((file) => ({ name: file.name, text: "waiting" })));
    const update = (index: number, text: string) =>
      setUploads((lines) => lines.map((line, i) => (i === index ? { ...line, text } : line)));

    for (const [index, file] of files.entries()) {
      update(index, "uploading");
      try {
        const grant = await api.post<{ uploadUrl: string; fileName: string | null }>(`/events/${ctx.eventId}/images`, {
          contentType: file.type,
          fileName: file.name,
        });
        await api.putBytes(grant.uploadUrl, file, file.type, grant.fileName);
        update(index, "uploaded");
      } catch (caught) {
        update(index, errorText(caught, "Upload failed."));
        if (caught instanceof ApiError && caught.code === "RIGHTS_BLOCKED") break;
      }
    }

    setUploading(false);
    if (fileInput.current !== null) fileInput.current.value = "";
    await reloadPool();
  }

  // Adds every pool photo not yet chosen, oldest upload first, so the order
  // of the day survives when the files were named or sorted that way.
  function chooseAll() {
    setSelection((current) => {
      const missing = [...pool]
        .reverse()
        .map((image) => image.key)
        .filter((key) => !current.includes(key));
      return [...current, ...missing];
    });
  }

  function toggle(key: string) {
    setSelection((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]));
  }

  function move(index: number, offset: -1 | 1) {
    setSelection((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target] as string, next[index] as string];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch(`/packages/${packageId}`, { imageKeys: selection });
      ctx.go("writeup");
    } catch (caught) {
      setSaveError(errorText(caught, "Could not save the selection."));
      setSaving(false);
    }
  }

  const min = pkg?.publication?.spec.imgMin ?? null;
  const max = pkg?.publication?.spec.imgMax ?? null;
  const number = new Map(pool.map((image, index) => [image.key, index + 1]));
  const byKey = new Map(pool.map((image) => [image.key, image]));
  const nameOf = (key: string) => {
    const image = byKey.get(key);
    return image?.originalName ?? `Photo ${number.get(key) ?? "?"}`;
  };

  return (
    <Frame
      guide={GUIDE.photos}
      rail={ctx.rail}
      back={ctx.back}
      primary={
        pkg === null
          ? null
          : {
              label: "Continue",
              onClick: () => void save(),
              disabledReason: countReason(selection.length, min, max),
              busy: saving || uploading,
            }
      }
      after={saveError !== null && <Alert>{saveError}</Alert>}
    >
      {loadError !== null ? (
        <Alert>{loadError}</Alert>
      ) : pkg === null ? (
        <Loading what="the photos" />
      ) : (
        <>
          <div>
            {/* The native picker is hidden; the button carries the name the guide uses. */}
            <input
              ref={fileInput}
              id="add-photos"
              aria-label="Add photos"
              type="file"
              multiple
              accept={ACCEPT}
              disabled={uploading}
              onChange={(change: ChangeEvent<HTMLInputElement>) => void upload(Array.from(change.target.files ?? []))}
              className="sr-only"
            />
            <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()} className={PRIMARY}>
              {uploading ? "Adding photos" : "Add photos"}
            </button>
            <p className="mt-1 text-xs text-slate-500">JPEG, PNG or WebP, up to 12 MB each.</p>
            {uploads.length > 0 && uploading && (
              <ul aria-label="Upload progress" className="mt-2 space-y-1 text-sm text-slate-600">
                {uploads.map((line, index) => (
                  <li key={`${line.name}-${index}`} className="break-all">{`${line.name}: ${line.text}`}</li>
                ))}
              </ul>
            )}
            {uploads.length > 0 && !uploading && (
              <div role="status" className="mt-2 text-sm text-slate-600">
                <p>{uploadSummary(uploads)}</p>
                {uploads
                  .filter((line) => line.text !== "uploaded")
                  .map((line, index) => (
                    <p key={`${line.name}-${index}`} className="break-all text-rose-700">{`${line.name}: ${line.text}`}</p>
                  ))}
              </div>
            )}
            {poolError !== null && <Alert>{poolError}</Alert>}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" className="text-sm font-medium text-slate-900">
              {chosenLine(selection.length, outletNameOf(pkg), min, max)}
            </p>
            {pool.length > 0 && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={chooseAll}
                  disabled={pool.every((image) => selection.includes(image.key))}
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 disabled:opacity-40"
                >
                  Choose all
                </button>
                <button
                  type="button"
                  onClick={() => setSelection([])}
                  disabled={selection.length === 0}
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 disabled:opacity-40"
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          {pool.length === 0 ? (
            <p className="text-sm text-slate-500">No photos yet. Add them above.</p>
          ) : (
            <div>
              <p className="text-sm text-slate-600">Tap a photo to add it. Tap it again to take it out.</p>
              <ul aria-label="Your photos" className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {pool.map((image) => {
                  const position = selection.indexOf(image.key);
                  const selected = position !== -1;
                  const name = nameOf(image.key);
                  return (
                    <li key={image.key} className="min-w-0">
                      <button
                        type="button"
                        aria-pressed={selected}
                        aria-label={name}
                        onClick={() => toggle(image.key)}
                        className={`relative block w-full overflow-hidden rounded-md border-2 ${
                          selected ? "border-slate-900" : "border-transparent"
                        }`}
                      >
                        <img
                          src={`${API_BASE_URL}${image.readUrl}`}
                          alt=""
                          loading="lazy"
                          className="aspect-square w-full bg-slate-50 object-cover"
                        />
                        {selected && (
                          <span className="absolute top-1 left-1 rounded bg-slate-900 px-1.5 text-xs font-medium text-white">
                            {position + 1}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {selection.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Your selection, in order</h3>
              <ol aria-label="Selected photos" className="mt-2 space-y-2">
                {selection.map((key, index) => {
                  const name = nameOf(key);
                  const image = byKey.get(key);
                  return (
                    <li key={key} className="flex items-center gap-2 rounded-md border border-slate-200 p-2">
                      <span className="w-6 shrink-0 text-right text-sm font-medium text-slate-900">{index + 1}</span>
                      {image === undefined ? (
                        <span className="h-10 w-10 shrink-0 rounded bg-slate-100" />
                      ) : (
                        <img src={`${API_BASE_URL}${image.readUrl}`} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                      )}
                      <span className="min-w-0 grow truncate text-sm text-slate-700">{name}</span>
                      <span className="flex shrink-0 gap-1 text-xs">
                        <button
                          type="button"
                          aria-label={`Move ${name} up`}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                          className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${name} down`}
                          disabled={index === selection.length - 1}
                          onClick={() => move(index, 1)}
                          className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                        >
                          Down
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${name}`}
                          onClick={() => toggle(key)}
                          className="rounded border border-slate-300 px-2 py-1"
                        >
                          Remove
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </>
      )}
    </Frame>
  );
}
