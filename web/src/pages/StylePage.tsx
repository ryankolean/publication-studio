import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useSession } from "../session-context.js";
import { CATEGORY_LABEL, tagLabel, type Feature, type ProfileBody } from "../style/tags.js";
import { Alert, BUTTON, INPUT, LABEL, Loading, PRIMARY } from "../wizard/Frame.js";
import { errorText, friendlyDate } from "../wizard/model.js";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const FIRST_YEAR = 2015;

/** "2025-06" -> "June 2025"; a full date reads as one. */
function publishedLabel(value: string): string {
  if (/^\d{4}-\d{2}$/.test(value)) return `${MONTHS[Number(value.slice(5, 7)) - 1] ?? ""} ${value.slice(0, 4)}`;
  return friendlyDate(value);
}

const plural = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`);

/** /style: her style profile, the photo-suggestion switch, her weddings' tags and where she has been featured. */
export function StylePage() {
  const { api, user } = useSession();
  const [profile, setProfile] = useState<ProfileBody | null>(null);
  const [outlets, setOutlets] = useState<Array<{ id: string; name: string }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [editing, setEditing] = useState<Feature | null>(null);

  const load = useCallback(async () => {
    const [body, list] = await Promise.all([
      api.get<ProfileBody>("/style/profile"),
      api.get<{ publications: Array<{ id: string; name: string }> }>("/publications"),
    ]);
    setProfile(body);
    setOutlets(list.publications.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
  }, [api]);

  useEffect(() => {
    load().catch((caught: unknown) => setLoadError(errorText(caught, "Could not load your work.")));
  }, [load]);

  async function setAnalysis(enabled: boolean) {
    setSwitching(true);
    setSwitchError(null);
    try {
      await api.put("/style/settings/photo-analysis", { enabled });
      await load();
    } catch (caught) {
      setSwitchError(errorText(caught, "Could not change that setting."));
    } finally {
      setSwitching(false);
    }
  }

  if (loadError !== null) return <Alert>{loadError}</Alert>;
  if (profile === null) return <Loading what="your work" />;

  const isPhotographer = user?.role === "photographer";

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header>
        <h2 className="text-xl font-semibold text-slate-900">Your work</h2>
        <p className="mt-1 text-sm text-slate-600">
          Your style, from the weddings you have tagged, and where your work has been published. Both help pick the
          outlets that suit you best.
        </p>
      </header>

      <section aria-labelledby="suggestions-heading" className="space-y-2 rounded-lg border border-slate-200 p-4">
        <h3 id="suggestions-heading" className="text-sm font-semibold text-slate-900">
          Photo suggestions
        </h3>
        <p className="text-sm text-slate-600">
          When this is on, pressing Suggest tags on a wedding sends up to 20 of its photos to Claude, an AI made by
          Anthropic, which suggests tags for you to keep or turn down. Nothing is sent until you press that button.
          Anthropic says it does not train on these photos or keep them after the request.
        </p>
        {!profile.analysis.available && (
          <p className="text-sm text-slate-600">Suggestions are not set up yet. You can still choose tags yourself.</p>
        )}
        {isPhotographer ? (
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              checked={profile.analysis.enabled}
              disabled={switching}
              onChange={(change) => void setAnalysis(change.target.checked)}
              className="h-4 w-4"
            />
            Let Claude suggest tags from my photos
          </label>
        ) : (
          <p className="text-sm text-slate-800">
            {profile.analysis.enabled ? "Switched on." : "Switched off."} Only the photographer can change this.
          </p>
        )}
        {switchError !== null && <Alert>{switchError}</Alert>}
      </section>

      <section aria-labelledby="style-heading" className="space-y-3">
        <h3 id="style-heading" className="text-sm font-semibold text-slate-900">
          Your style
        </h3>
        {profile.tagged === 0 ? (
          <p className="text-sm text-slate-600">Keep a few tags on one of your weddings and your style shows up here.</p>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              {`From ${profile.tagged} of your weddings. Weddings where you were the second shooter are not counted.`}
            </p>
            {profile.categories.map((group) => (
              <div key={group.category}>
                <h4 className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                  {CATEGORY_LABEL[group.category] ?? group.category}
                </h4>
                <ul aria-label={CATEGORY_LABEL[group.category] ?? group.category} className="mt-1 flex flex-wrap gap-1.5">
                  {group.tags.map((tag) => (
                    <li key={tag.id} className="rounded-full border border-slate-300 px-2.5 py-1 text-xs text-slate-800">
                      {`${tagLabel(tag.id)}, ${plural(tag.weddings, "wedding", "weddings")}`}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
      </section>

      <section aria-labelledby="weddings-heading" className="space-y-2">
        <h3 id="weddings-heading" className="text-sm font-semibold text-slate-900">
          Tag your weddings
        </h3>
        {profile.weddings.length === 0 ? (
          <p className="text-sm text-slate-600">No weddings yet.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
            {profile.weddings.map((wedding) => (
              <li key={wedding.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium break-words text-slate-900">{wedding.coupleNames}</p>
                  <p className="text-xs text-slate-600">
                    {[
                      friendlyDate(wedding.eventDate),
                      `${wedding.confirmed} kept`,
                      ...(wedding.suggested > 0 ? [`${wedding.suggested} to answer`] : []),
                      ...(wedding.secondShooter ? ["second shooter, not counted"] : []),
                    ].join(", ")}
                  </p>
                </div>
                <Link to={`/wizard/${wedding.id}/look`} aria-label={`Tag the look of ${wedding.coupleNames}`} className={BUTTON}>
                  Tag the look
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="features-heading" className="space-y-3">
        <h3 id="features-heading" className="text-sm font-semibold text-slate-900">
          Where you have been featured
        </h3>
        {profile.features.length === 0 ? (
          <p className="text-sm text-slate-600">None recorded yet. Add each feature below, newest or oldest, in any order.</p>
        ) : (
          <ul className="space-y-2">
            {profile.features.map((feature) => (
              <FeatureLine key={feature.id} feature={feature} onEdit={() => setEditing(feature)} onRemoved={load} />
            ))}
          </ul>
        )}
        <FeatureForm
          key={editing?.id ?? "new"}
          editing={editing}
          outlets={outlets}
          weddings={profile.weddings}
          onDone={async () => {
            setEditing(null);
            await load();
          }}
          onCancel={() => setEditing(null)}
        />
      </section>
    </div>
  );
}

function FeatureLine({ feature, onEdit, onRemoved }: { feature: Feature; onEdit: () => void; onRemoved: () => Promise<void> }) {
  const { api } = useSession();
  const [error, setError] = useState<string | null>(null);
  const details = [
    ...(feature.publishedOn === null ? [] : [publishedLabel(feature.publishedOn)]),
    ...(feature.coupleNames === null ? [] : [feature.coupleNames]),
    ...(feature.role === "second_shooter" ? ["as second shooter"] : []),
  ];

  async function remove() {
    setError(null);
    try {
      await api.delete(`/style/features/${feature.id}`);
      await onRemoved();
    } catch (caught) {
      setError(errorText(caught, "Could not remove that feature."));
    }
  }

  return (
    <li className="rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium break-words text-slate-900">{feature.outletName}</p>
          {details.length > 0 && <p className="text-xs break-words text-slate-600">{details.join(", ")}</p>}
          {feature.notes !== null && <p className="mt-1 text-xs break-words text-slate-600">{feature.notes}</p>}
          {feature.featureUrl !== null && (
            <a href={feature.featureUrl} target="_blank" rel="noopener noreferrer" className="text-xs break-all underline">
              See the feature
            </a>
          )}
        </div>
        <span className="flex shrink-0 gap-1">
          <button type="button" onClick={onEdit} aria-label={`Edit ${feature.outletName}`} className={BUTTON}>
            Edit
          </button>
          <button type="button" onClick={() => void remove()} aria-label={`Remove ${feature.outletName}`} className={BUTTON}>
            Remove
          </button>
        </span>
      </div>
      {error !== null && <Alert>{error}</Alert>}
    </li>
  );
}

const ANOTHER = "another";

function FeatureForm({
  editing,
  outlets,
  weddings,
  onDone,
  onCancel,
}: {
  editing: Feature | null;
  outlets: Array<{ id: string; name: string }>;
  weddings: ProfileBody["weddings"];
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const { api } = useSession();
  const [outlet, setOutlet] = useState(editing === null ? "" : (editing.publicationId ?? ANOTHER));
  const [outletName, setOutletName] = useState(editing !== null && editing.publicationId === null ? editing.outletName : "");
  const [wedding, setWedding] = useState(editing?.eventId ?? "");
  const [link, setLink] = useState(editing?.featureUrl ?? "");
  const [year, setYear] = useState(editing?.publishedOn?.slice(0, 4) ?? "");
  const [month, setMonth] = useState(editing?.publishedOn?.slice(5, 7) ?? "");
  const [second, setSecond] = useState(editing?.role === "second_shooter");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear - FIRST_YEAR + 1 }, (_, index) => String(thisYear - index));

  function problem(): string | null {
    if (outlet === "") return "Choose the outlet.";
    if (outlet === ANOTHER && outletName.trim() === "") return "Type the outlet's name.";
    if ((year === "") !== (month === "")) return "Pick both the month and the year, or neither.";
    return null;
  }

  async function save() {
    setSaving(true);
    setError(null);
    // A feature first saved with a full date keeps its day unless the month or year changes.
    const kept = editing?.publishedOn ?? null;
    const publishedOn = year === "" ? null : kept !== null && kept.startsWith(`${year}-${month}`) ? kept : `${year}-${month}`;
    const body = {
      publicationId: outlet === ANOTHER ? null : outlet,
      outletName: outlet === ANOTHER ? outletName : null,
      eventId: wedding === "" ? null : wedding,
      featureUrl: link.trim() === "" ? null : link.trim(),
      publishedOn,
      role: second ? "second_shooter" : "lead",
      notes: notes.trim() === "" ? null : notes,
    };
    try {
      if (editing === null) await api.post("/style/features", body);
      else await api.put(`/style/features/${editing.id}`, body);
      await onDone();
    } catch (caught) {
      setError(errorText(caught, "Could not save that feature."));
      setSaving(false);
    }
  }

  const blocker = problem();

  return (
    <form
      aria-label={editing === null ? "Add a feature" : "Edit the feature"}
      onSubmit={(submit) => {
        submit.preventDefault();
        void save();
      }}
      className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4"
    >
      <h4 className="text-sm font-semibold text-slate-900">{editing === null ? "Add a feature" : `Edit ${editing.outletName}`}</h4>
      <div>
        <label htmlFor="feature-outlet" className={LABEL}>
          Outlet
        </label>
        <select id="feature-outlet" value={outlet} onChange={(change) => setOutlet(change.target.value)} className={INPUT}>
          <option value="">Choose the outlet</option>
          {outlets.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
          <option value={ANOTHER}>Another outlet</option>
        </select>
      </div>
      {outlet === ANOTHER && (
        <div>
          <label htmlFor="feature-outlet-name" className={LABEL}>
            Outlet name
          </label>
          <input id="feature-outlet-name" value={outletName} onChange={(change) => setOutletName(change.target.value)} className={INPUT} />
        </div>
      )}
      <div>
        <label htmlFor="feature-wedding" className={LABEL}>
          Wedding, if it is here
        </label>
        <select id="feature-wedding" value={wedding} onChange={(change) => setWedding(change.target.value)} className={INPUT}>
          <option value="">Not one of these</option>
          {weddings.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.coupleNames}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="feature-link" className={LABEL}>
          Link to the feature
        </label>
        <input id="feature-link" type="url" value={link} onChange={(change) => setLink(change.target.value)} className={INPUT} />
      </div>
      <fieldset>
        <legend className={LABEL}>When it was published</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          <select aria-label="Month" value={month} onChange={(change) => setMonth(change.target.value)} className="rounded-md border border-slate-300 px-2 py-2 text-sm">
            <option value="">Month</option>
            {MONTHS.map((name, index) => (
              <option key={name} value={String(index + 1).padStart(2, "0")}>
                {name}
              </option>
            ))}
          </select>
          <select aria-label="Year" value={year} onChange={(change) => setYear(change.target.value)} className="rounded-md border border-slate-300 px-2 py-2 text-sm">
            <option value="">Year</option>
            {years.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm text-slate-800">
        <input type="checkbox" checked={second} onChange={(change) => setSecond(change.target.checked)} className="h-4 w-4" />
        I was the second shooter
      </label>
      <div>
        <label htmlFor="feature-notes" className={LABEL}>
          Notes
        </label>
        <textarea id="feature-notes" rows={2} value={notes} onChange={(change) => setNotes(change.target.value)} className={INPUT} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={blocker !== null || saving} className={PRIMARY}>
          {editing === null ? "Save feature" : "Save changes"}
        </button>
        {editing !== null && (
          <button type="button" onClick={onCancel} className={BUTTON}>
            Cancel
          </button>
        )}
        {blocker !== null && <p className="text-sm text-slate-600">{blocker}</p>}
      </div>
      {error !== null && <Alert>{error}</Alert>}
    </form>
  );
}
