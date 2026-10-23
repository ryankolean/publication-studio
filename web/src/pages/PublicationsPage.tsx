import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "../api/client.js";
import type { ApiClient } from "../api/client.js";
import { useSession } from "../session-context.js";
import { fieldLabel, formatValue } from "../research/labels.js";

interface Spec {
  imgMin: number | null;
  imgMax: number | null;
  size: string;
  watermarksAllowed: boolean | null;
  videoAccepted: boolean | null;
  videoNotes: string | null;
  requirements: string[];
  notes: string | null;
}

interface Publication {
  id: string;
  name: string;
  tier: string;
  method: string | null;
  submissionUrl: string | null;
  spec: Spec;
  exclusivityPolicy: string;
  typicalResponseDays: number | null;
  responseWindowNote: string | null;
  earnedOrPaid: string;
  tasteNotes: string | null;
  lastVerified: string;
  tags: string[];
  corrections: Correction[];
}

interface Correction {
  field: string;
  value: unknown;
  note: string | null;
}

interface VocabTag {
  id: string;
  category: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  region: "Region",
  landscape_venue: "Landscape and venue",
  architecture: "Architecture",
  aesthetic: "Look",
  dress_style: "Dress",
  season: "Season",
};

/** The details she can correct here; each is one research fact. */
const CORRECTABLE = [
  { field: "timing.response_window", kind: "window" },
  { field: "package.image_min", kind: "number" },
  { field: "package.image_max", kind: "number" },
  { field: "rules.freshness_window_months", kind: "number" },
  { field: "rules.exclusivity", kind: "policy" },
] as const;

const POLICY_LABEL: Record<string, string> = {
  exclusive_required: "Must be exclusive",
  exclusive_preferred: "Prefers exclusive",
  non_exclusive: "Not exclusive",
};

const reason = (caught: unknown, fallback: string) => (caught instanceof ApiError ? caught.message : fallback);

function TagEditor({
  api,
  publication,
  vocabulary,
  onTags,
}: {
  api: ApiClient;
  publication: Publication;
  vocabulary: VocabTag[];
  onTags: (tags: string[]) => void;
}) {
  const [choice, setChoice] = useState("");
  const [label, setLabel] = useState("");
  const [group, setGroup] = useState("aesthetic");
  const [error, setError] = useState<string | null>(null);
  const available = vocabulary.filter((tag) => !publication.tags.includes(tag.id));

  async function add(tagId: string) {
    setError(null);
    try {
      const body = await api.post<{ tags: string[] }>(`/publications/${publication.id}/tags/${tagId}`, {});
      onTags(body.tags);
      setChoice("");
    } catch (caught: unknown) {
      setError(reason(caught, "Could not add that tag."));
    }
  }

  async function create() {
    setError(null);
    try {
      const created = await api.post<{ id: string }>("/tags", { label, category: group });
      setLabel("");
      await add(created.id);
    } catch (caught: unknown) {
      setError(reason(caught, "Could not create that tag."));
    }
  }

  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-slate-600">Add a tag</summary>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-slate-600">
          Tag to add
          <select value={choice} onChange={(e) => setChoice(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1">
            <option value="">Choose a tag</option>
            {Object.entries(CATEGORY_LABEL).map(([category, categoryLabel]) => (
              <optgroup key={category} label={categoryLabel}>
                {available
                  .filter((tag) => tag.category === category)
                  .map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {requirementLabel(tag.id)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={choice === ""}
          onClick={() => void add(choice)}
          className="rounded-md border border-slate-300 px-3 py-1 text-slate-700 disabled:opacity-50"
        >
          Add tag
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-slate-600">
          New tag
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1 text-slate-600">
          New tag group
          <select value={group} onChange={(e) => setGroup(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1">
            {Object.entries(CATEGORY_LABEL).map(([category, categoryLabel]) => (
              <option key={category} value={category}>
                {categoryLabel}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={label.trim() === ""}
          onClick={() => void create()}
          className="rounded-md border border-slate-300 px-3 py-1 text-slate-700 disabled:opacity-50"
        >
          Create and add
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 text-rose-700">
          {error}
        </p>
      )}
    </details>
  );
}

function CorrectionForm({ api, publication, onSaved }: { api: ApiClient; publication: Publication; onSaved: () => void }) {
  const [field, setField] = useState("");
  const [days, setDays] = useState("");
  const [replies, setReplies] = useState("all");
  const [number, setNumber] = useState("");
  const [policy, setPolicy] = useState("exclusive_required");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const kind = CORRECTABLE.find((entry) => entry.field === field)?.kind ?? null;

  async function save() {
    setError(null);
    const value =
      kind === "window" ? { days: Number(days), replies } : kind === "policy" ? { policy } : Number(number);
    try {
      await api.put(`/publications/${publication.id}/edits/${field}`, { value, note: note.trim() === "" ? null : note.trim() });
      setField("");
      setNote("");
      onSaved();
    } catch (caught: unknown) {
      setError(reason(caught, "Could not save that correction."));
    }
  }

  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-slate-600">Correct a detail</summary>
      <p className="mt-2 text-slate-500">Your correction is used in place of the research, and newer research never overwrites it.</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-slate-600">
          Detail
          <select value={field} onChange={(e) => setField(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1">
            <option value="">Choose a detail</option>
            {CORRECTABLE.map((entry) => (
              <option key={entry.field} value={entry.field}>
                {fieldLabel(entry.field)}
              </option>
            ))}
          </select>
        </label>
        {kind === "window" && (
          <>
            <label className="flex flex-col gap-1 text-slate-600">
              Days
              <input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} className="w-24 rounded-md border border-slate-300 px-2 py-1" />
            </label>
            <label className="flex flex-col gap-1 text-slate-600">
              Replies
              <select value={replies} onChange={(e) => setReplies(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1">
                <option value="all">They reply to everyone</option>
                <option value="success_only">They reply only if accepted</option>
              </select>
            </label>
          </>
        )}
        {kind === "number" && (
          <label className="flex flex-col gap-1 text-slate-600">
            Number
            <input type="number" min={0} value={number} onChange={(e) => setNumber(e.target.value)} className="w-24 rounded-md border border-slate-300 px-2 py-1" />
          </label>
        )}
        {kind === "policy" && (
          <label className="flex flex-col gap-1 text-slate-600">
            Policy
            <select value={policy} onChange={(e) => setPolicy(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1">
              {Object.entries(POLICY_LABEL).map(([value, policyLabel]) => (
                <option key={value} value={value}>
                  {policyLabel}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind !== null && (
          <>
            <label className="flex flex-col gap-1 text-slate-600">
              Why (optional)
              <input value={note} onChange={(e) => setNote(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1" />
            </label>
            <button type="button" onClick={() => void save()} className="rounded-md bg-slate-900 px-3 py-1 font-medium text-white">
              Save correction
            </button>
          </>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 text-rose-700">
          {error}
        </p>
      )}
    </details>
  );
}

const TIER_LABEL: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  dream: "Dream",
};

const METHOD_LABEL: Record<string, string> = {
  portal: "Portal",
  web_form: "Web form",
  email: "Email",
  aggregator: "Aggregator",
};

function imageCount(spec: Spec): string {
  if (spec.imgMin !== null && spec.imgMax !== null) return `${spec.imgMin} to ${spec.imgMax} images`;
  if (spec.imgMax !== null) return `Up to ${spec.imgMax} images`;
  if (spec.imgMin !== null) return `At least ${spec.imgMin} images`;
  return "No published image count";
}

function requirementLabel(requirement: string): string {
  const words = requirement.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function PublicationsPage() {
  const { api } = useSession();
  const [publications, setPublications] = useState<Publication[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [vocabulary, setVocabulary] = useState<VocabTag[]>([]);

  const refresh = useCallback(
    () =>
      api
        .get<{ publications: Publication[] }>("/publications")
        .then((body) => setPublications(body.publications))
        .catch((caught: unknown) => setError(reason(caught, "Could not load publications."))),
    [api],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ publications: Publication[] }>("/publications")
      .then((body) => {
        if (!cancelled) setPublications(body.publications);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : "Could not load publications.");
        }
      });
    // Neither is needed to read the list, so a failure here only hides the extras.
    Promise.resolve(api.get<{ revisions?: unknown[] } | undefined>("/research/revisions"))
      .then((body) => {
        if (!cancelled) setPending(body?.revisions?.length ?? 0);
      })
      .catch(() => undefined);
    Promise.resolve(api.get<{ tags?: VocabTag[] } | undefined>("/tags"))
      .then((body) => {
        if (!cancelled) setVocabulary(body?.tags ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  const setTags = (id: string, tags: string[]) =>
    setPublications((current) => (current ?? []).map((p) => (p.id === id ? { ...p, tags } : p)));

  async function removeTag(publication: Publication, tag: string) {
    try {
      const body = await api.delete<{ tags: string[] }>(`/publications/${publication.id}/tags/${tag}`);
      setTags(publication.id, body.tags);
    } catch (caught: unknown) {
      setError(reason(caught, "Could not remove that tag."));
    }
  }

  async function undo(publication: Publication, field: string) {
    try {
      await api.delete(`/publications/${publication.id}/edits/${field}`);
      await refresh();
    } catch (caught: unknown) {
      setError(reason(caught, "Could not undo that correction."));
    }
  }

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-rose-700">
        {error}
      </p>
    );
  }

  if (publications === null) return <p className="text-sm text-slate-500">Loading publications.</p>;

  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900">Publications</h2>
      <p className="mt-1 text-sm text-slate-500">
        Specs are transcribed by hand and drift. Re-verify before first use and quarterly after.
      </p>

      {pending > 0 && (
        <p role="status" className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {pending === 1 ? "1 outlet update is waiting for your OK." : `${pending} outlet updates are waiting for your OK.`}{" "}
          <Link to="/publications/updates" className="underline">
            Review them
          </Link>
        </p>
      )}

      <ul className="mt-6 space-y-3">
        {publications.map((publication) => (
          <li key={publication.id}>
            <article aria-label={publication.name} className="rounded-lg border border-slate-200 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-medium text-slate-900">{publication.name}</h3>
                <p className="text-sm text-slate-500">
                  {TIER_LABEL[publication.tier] ?? publication.tier}
                  {" - "}
                  {publication.method === null
                    ? "No public submission route"
                    : (METHOD_LABEL[publication.method] ?? publication.method)}
                  {publication.earnedOrPaid !== "earned" ? " - paid placement possible" : ""}
                </p>
              </div>
              <span className="text-xs text-slate-500">Verified {publication.lastVerified}</span>
            </div>

            {publication.tasteNotes !== null && (
              <p className="mt-2 text-sm text-slate-600">{publication.tasteNotes}</p>
            )}

            {publication.tags.length > 0 && (
              <ul aria-label={`${publication.name} tags`} className="mt-2 flex flex-wrap gap-1.5">
                {publication.tags.map((tag) => (
                  <li
                    key={tag}
                    className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600"
                  >
                    {requirementLabel(tag)}
                    <button
                      type="button"
                      aria-label={`Remove ${requirementLabel(tag)}`}
                      onClick={() => void removeTag(publication, tag)}
                      className="text-slate-400 hover:text-slate-900"
                    >
                      {"\u00d7"}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-600">
              <div className="flex gap-2">
                <dt className="text-slate-500">Images</dt>
                <dd>{imageCount(publication.spec)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">Response</dt>
                <dd>
                  {publication.typicalResponseDays === null
                    ? "Unknown"
                    : `About ${publication.typicalResponseDays} days`}
                  {publication.responseWindowNote !== null && (
                    <span className="block text-xs text-slate-500">
                      {"\u201c"}
                      {publication.responseWindowNote}
                      {"\u201d"}
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">Watermarks</dt>
                <dd>
                  {publication.spec.watermarksAllowed === null
                    ? "Unknown"
                    : publication.spec.watermarksAllowed
                      ? "Allowed"
                      : "Not allowed"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">Exclusivity</dt>
                <dd>{publication.exclusivityPolicy === "unknown" ? "Unknown" : publication.exclusivityPolicy.replace(/_/g, " ")}</dd>
              </div>
            </dl>

            {publication.spec.requirements.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-slate-600">
                {publication.spec.requirements.map((requirement) => (
                  <li key={requirement}>{requirementLabel(requirement)}</li>
                ))}
              </ul>
            )}

            {publication.submissionUrl !== null && (
              <a
                href={publication.submissionUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-3 inline-block text-sm text-slate-900 underline"
              >
                Open the submission page
              </a>
            )}

            {publication.corrections.length > 0 && (
              <ul aria-label={`${publication.name} corrections`} className="mt-3 space-y-1 text-sm text-slate-700">
                {publication.corrections.map((correction) => (
                  <li key={correction.field} className="flex flex-wrap items-center gap-2">
                    <span>{`${fieldLabel(correction.field)}: ${formatValue(correction.value)}`}</span>
                    <button
                      type="button"
                      aria-label={`Undo the ${fieldLabel(correction.field)} correction`}
                      onClick={() => void undo(publication, correction.field)}
                      className="text-xs text-slate-500 underline hover:text-slate-900"
                    >
                      Undo
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <TagEditor api={api} publication={publication} vocabulary={vocabulary} onTags={(tags) => setTags(publication.id, tags)} />
            <CorrectionForm api={api} publication={publication} onSaved={() => void refresh()} />
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
