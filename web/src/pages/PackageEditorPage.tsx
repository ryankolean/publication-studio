import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";

import { ApiError } from "../api/client.js";
import { API_BASE_URL } from "../config.js";
import { useSession } from "../session-context.js";
import type { PoolImage } from "./EventDetailPage.js";
import { SubmissionBadge, type SubmissionSummary } from "../components/SubmissionBadge.js";

interface ChecklistItem {
  id: string;
  kind: "derived" | "attested";
  label: string;
  satisfied: boolean;
  detail?: string;
}

interface PackageView {
  id: string;
  eventId: string;
  publicationId: string;
  publication: {
    id: string;
    name: string;
    spec: { imgMin: number | null; imgMax: number | null };
  } | null;
  imageKeys: string[];
  descriptionMd: string | null;
  creditsBlockMd: string | null;
  consent: { nameDisplay: string | null; consentNotes: string | null };
  checklist: ChecklistItem[];
  complete: boolean;
  missing: string[];
  submission: SubmissionSummary | null;
}

/** "6 selected, outlet wants 40 to 80", or "no stated bounds" when there are none. */
function countLine(count: number, spec: { imgMin: number | null; imgMax: number | null } | null): string {
  const min = spec?.imgMin ?? null;
  const max = spec?.imgMax ?? null;
  const range =
    min !== null && max !== null
      ? `${min} to ${max}`
      : min !== null
        ? `at least ${min}`
        : max !== null
          ? `at most ${max}`
          : null;
  return range === null
    ? `${count} selected, no stated bounds`
    : `${count} selected, outlet wants ${range}`;
}

/** Attested items only; derived items are the server's to decide. */
function attestationsOf(checklist: ChecklistItem[]): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const item of checklist) if (item.kind === "attested") result[item.id] = item.satisfied;
  return result;
}

function errorText(caught: unknown, fallback: string): string {
  if (!(caught instanceof ApiError)) return fallback;
  const details = caught.details.map((detail) => detail.message).filter(Boolean);
  return details.length > 0 ? `${caught.message} ${details.join(" ")}` : caught.message;
}

export function PackageEditorPage() {
  const { id = "" } = useParams();
  const { api } = useSession();

  const [pkg, setPkg] = useState<PackageView | null>(null);
  const [pool, setPool] = useState<PoolImage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selection, setSelection] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [credits, setCredits] = useState("");
  const [attestations, setAttestations] = useState<Record<string, boolean>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);

  /** Everything on screen is re-derived from what the server returned. */
  function apply(view: PackageView) {
    setPkg(view);
    setSelection(view.imageKeys);
    setDescription(view.descriptionMd ?? "");
    setCredits(view.creditsBlockMd ?? "");
    setAttestations(attestationsOf(view.checklist));
    setDirty(false);
  }

  useEffect(() => {
    let cancelled = false;
    api
      .get<PackageView>(`/packages/${id}`)
      .then(async (view) => {
        const body = await api.get<{ images: PoolImage[] }>(`/events/${view.eventId}/images`);
        if (cancelled) return;
        setPool(body.images);
        apply(view);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorText(caught, "Could not load this package."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, id]);

  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setDirty(true);
  };

  function toggle(key: string) {
    setSelection((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
    setDirty(true);
  }

  function move(index: number, offset: -1 | 1) {
    setSelection((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target] as string, next[index] as string];
      return next;
    });
    setDirty(true);
  }

  async function save(submit: FormEvent) {
    submit.preventDefault();
    if (pkg === null) return;
    setSaving(true);
    setSaveError(null);

    // Every attested item is sent with its current state, so an unticked box
    // clears a stored attestation rather than leaving it behind.
    const sentAttestations: Record<string, boolean> = {};
    for (const item of pkg.checklist) {
      if (item.kind === "attested") sentAttestations[item.id] = attestations[item.id] ?? false;
    }

    try {
      const view = await api.patch<PackageView>(`/packages/${pkg.id}`, {
        imageKeys: selection,
        descriptionMd: description,
        creditsBlockMd: credits,
        attestations: sentAttestations,
      });
      apply(view);
    } catch (caught) {
      setSaveError(errorText(caught, "Could not save the package."));
    } finally {
      setSaving(false);
    }
  }

  /** The server re-checks the gates and the stored checklist; this button is only a convenience. */
  async function createSubmission() {
    if (pkg === null) return;
    setCreating(true);
    setSubmissionError(null);
    try {
      const created = await api.post<SubmissionSummary>("/submissions", { packageId: pkg.id });
      const submission: SubmissionSummary = {
        id: created.id,
        status: created.status,
        sentAt: created.sentAt,
        responseDueAt: created.responseDueAt,
      };
      setPkg((current) => (current === null ? current : { ...current, submission }));
    } catch (caught) {
      setSubmissionError(errorText(caught, "Could not create the submission."));
    } finally {
      setCreating(false);
    }
  }

  if (loadError !== null) {
    return (
      <p role="alert" className="text-sm text-rose-700">
        {loadError}
      </p>
    );
  }

  if (pkg === null) return <p className="text-sm text-slate-500">Loading package.</p>;

  const poolNumber = new Map(pool.map((image, index) => [image.key, index + 1]));
  const thumbFor = new Map(pool.map((image) => [image.key, `${API_BASE_URL}${image.readUrl}`]));
  const nameFor = (key: string) => {
    const n = poolNumber.get(key);
    return n === undefined ? `image ${key.split("/").pop() ?? key}` : `pool image ${n}`;
  };

  const missingLabels = pkg.missing.map(
    (missing) => pkg.checklist.find((item) => item.id === missing)?.label ?? missing,
  );
  const limits = [pkg.consent.nameDisplay, pkg.consent.consentNotes].filter(
    (value): value is string => value !== null && value.trim() !== "",
  );

  return (
    <form onSubmit={(submit) => void save(submit)} className="space-y-6">
      <header>
        <Link to={`/events/${pkg.eventId}`} className="text-sm text-slate-600 hover:text-slate-900">
          Back to event
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">
            {`${pkg.publication?.name ?? pkg.publicationId} package`}
          </h2>
          <div className="flex items-center gap-3">
            {dirty && <span className="text-sm text-amber-700">Unsaved changes</span>}
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Save package
            </button>
          </div>
        </div>
        <p
          role="status"
          className={`mt-3 rounded-md border px-3 py-2 text-sm break-words ${
            pkg.complete
              ? "border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border-amber-300 bg-amber-50 text-amber-900"
          }`}
        >
          {pkg.complete ? "Package complete" : `Missing: ${missingLabels.join(", ")}`}
        </p>
        {pkg.submission !== null ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="text-slate-700">Submission</span>
            <SubmissionBadge status={pkg.submission.status} />
            <Link to="/queue" className="text-slate-600 underline hover:text-slate-900">
              Open the queue
            </Link>
          </div>
        ) : pkg.complete ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={creating || dirty}
              onClick={() => void createSubmission()}
              className="rounded-md border border-slate-900 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
            >
              Create submission
            </button>
            <span className="text-xs text-slate-500">
              {dirty ? "Save your changes first." : "Adds it to the queue. Nothing is sent from here."}
            </span>
          </div>
        ) : null}
        {submissionError !== null && (
          <p role="alert" className="mt-2 text-sm break-words text-rose-700">
            {submissionError}
          </p>
        )}
        {saveError !== null && (
          <p role="alert" className="mt-2 text-sm text-rose-700">
            {saveError}
          </p>
        )}
      </header>

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="min-w-0">
          <h3 className="font-medium text-slate-900">Images</h3>
          <p className="mt-1 text-sm text-slate-600">{countLine(selection.length, pkg.publication?.spec ?? null)}</p>

          {pool.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              No images in this event's pool yet. Upload them from the event page.
            </p>
          ) : (
            <ul aria-label="Image pool" className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3">
              {pool.map((image, index) => {
                const position = selection.indexOf(image.key);
                const selected = position !== -1;
                return (
                  <li key={image.key} className="min-w-0">
                    <button
                      type="button"
                      aria-pressed={selected}
                      aria-label={`Pool image ${index + 1}`}
                      onClick={() => toggle(image.key)}
                      className={`relative block w-full overflow-hidden rounded-md border-2 ${
                        selected ? "border-slate-900" : "border-transparent"
                      }`}
                    >
                      <img
                        src={`${API_BASE_URL}${image.readUrl}`}
                        alt={`Pool image ${index + 1}`}
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
          )}

          <h4 className="mt-6 text-sm font-medium text-slate-900">Selection order</h4>
          <ol aria-label="Selected images" className="mt-2 space-y-2">
            {selection.map((key, index) => {
              const name = nameFor(key);
              const thumb = thumbFor.get(key);
              return (
                <li key={key} data-key={key} className="flex items-center gap-3 rounded-md border border-slate-200 p-2">
                  <span className="w-6 shrink-0 text-right text-sm font-medium text-slate-900">{index + 1}</span>
                  {thumb === undefined ? (
                    <span className="h-10 w-10 shrink-0 rounded bg-slate-100" />
                  ) : (
                    <img src={thumb} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                  )}
                  <span className="min-w-0 grow truncate text-sm text-slate-600">{name}</span>
                  <div className="flex shrink-0 gap-1 text-xs">
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
                  </div>
                </li>
              );
            })}
          </ol>
          {selection.length === 0 && (
            <p className="mt-2 text-sm text-slate-500">Click images in the pool to add them in order.</p>
          )}
        </section>

        <section className="min-w-0 space-y-5">
          {limits.length > 0 && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm break-words text-slate-700">
              <p className="font-medium">The couple's limits</p>
              {limits.map((limit) => (
                <p key={limit}>{limit}</p>
              ))}
            </div>
          )}

          <div>
            <label htmlFor="package-description" className="block text-sm font-medium text-slate-700">
              Description
            </label>
            <textarea
              id="package-description"
              rows={10}
              value={description}
              onChange={(change) => edit(setDescription)(change.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </div>

          <div>
            <label htmlFor="package-credits" className="block text-sm font-medium text-slate-700">
              Credits block
            </label>
            <textarea
              id="package-credits"
              rows={6}
              value={credits}
              onChange={(change) => edit(setCredits)(change.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </div>

          <div>
            <h3 className="font-medium text-slate-900">Checklist</h3>
            <p className="mt-1 text-xs text-slate-500">
              Items the package data answers update when you save.
            </p>
            <ul aria-label="Checklist" className="mt-2 space-y-2">
              {pkg.checklist.map((item) =>
                item.kind === "attested" ? (
                  <li key={item.id} className="text-sm text-slate-700">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={attestations[item.id] ?? false}
                        onChange={(change) =>
                          edit(setAttestations)({ ...attestations, [item.id]: change.target.checked })
                        }
                        className="mt-0.5"
                      />
                      <span>{item.label}</span>
                    </label>
                    {item.detail !== undefined && (
                      <p className="ml-6 text-xs break-words text-slate-500">{item.detail}</p>
                    )}
                  </li>
                ) : (
                  <li key={item.id} className="text-sm text-slate-700">
                    <div className="flex items-start gap-2">
                      <span
                        className={`mt-0.5 shrink-0 text-xs font-medium ${
                          item.satisfied ? "text-emerald-700" : "text-rose-700"
                        }`}
                      >
                        {item.satisfied ? "Met" : "Not met"}
                      </span>
                      <span>{item.label}</span>
                    </div>
                    {!item.satisfied && item.detail !== undefined && (
                      <p className="ml-6 text-xs break-words text-slate-500">{item.detail}</p>
                    )}
                  </li>
                ),
              )}
            </ul>
          </div>
        </section>
      </div>
    </form>
  );
}
