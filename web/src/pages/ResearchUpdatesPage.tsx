import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "../api/client.js";
import { useSession } from "../session-context.js";
import { fieldLabel, formatValue } from "../research/labels.js";

interface Change {
  field: string;
  before: unknown;
  after: unknown;
}

interface Revision {
  id: string;
  publicationId: string;
  name: string;
  isNew: boolean;
  firstResearch: boolean;
  proposedAt: string;
  gitSha: string | null;
  changes: Change[];
  conflicts: Change[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summary(revision: Revision): string {
  const unknown = revision.changes.filter((change) => change.after === "unknown").length;
  const facts = `${plural(revision.changes.length - unknown, "fact", "facts")} found, ${unknown} unknown`;
  if (revision.isNew) return `New outlet: ${facts}.`;
  if (revision.firstResearch) return `Full research for an outlet already in the app: ${facts}.`;
  if (revision.changes.length === 0) return "Checked again. Nothing changed.";
  return plural(revision.changes.length, "change", "changes");
}

const reason = (caught: unknown, fallback: string) => (caught instanceof ApiError ? caught.message : fallback);

/**
 * Outlet research waiting for approval (SUMMIT-335). Nothing new reaches the
 * outlets list until it is approved here.
 */
export function ResearchUpdatesPage() {
  const { api } = useSession();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ revisions: Revision[] }>("/research/revisions")
      .then((body) => {
        if (!cancelled) setRevisions(body.revisions);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(reason(caught, "Could not load the outlet updates."));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function decide(revision: Revision, action: "approve" | "reject"): Promise<boolean> {
    try {
      await api.post(`/research/revisions/${revision.id}/${action}`, {});
    } catch (caught: unknown) {
      setError(reason(caught, "That did not go through. Try again."));
      return false;
    }
    setRevisions((current) => (current ?? []).filter((r) => r.id !== revision.id));
    setNotice(action === "approve" ? `Approved ${revision.name}.` : `Turned down ${revision.name}.`);
    return true;
  }

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    await work();
    setBusy(false);
  }

  async function approveAll(clean: Revision[]) {
    for (const revision of clean) {
      if (!(await decide(revision, "approve"))) return;
    }
    setNotice(`Approved ${plural(clean.length, "outlet update", "outlet updates")}.`);
  }

  if (revisions === null) {
    return error !== null ? (
      <p role="alert" className="text-sm text-rose-700">
        {error}
      </p>
    ) : (
      <p className="text-sm text-slate-500">Loading outlet updates.</p>
    );
  }

  const clean = revisions.filter((revision) => revision.conflicts.length === 0);

  return (
    <section>
      <p className="text-sm">
        <Link to="/publications" className="text-slate-600 underline hover:text-slate-900">
          Back to publications
        </Link>
      </p>
      <h2 className="mt-2 text-lg font-semibold text-slate-900">Outlet updates</h2>
      <p className="mt-1 text-sm text-slate-500">
        New and changed outlet research waits here until you approve it. Your own corrections and tags stay as they are.
      </p>

      {error !== null && (
        <p role="alert" className="mt-4 text-sm text-rose-700">
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="mt-4 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      {revisions.length === 0 ? (
        <p className="mt-6 text-sm text-slate-600">No outlet updates are waiting.</p>
      ) : (
        <>
          {clean.length > 1 && (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => approveAll(clean))}
                className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {`Approve all ${clean.length}`}
              </button>
              <span className="text-sm text-slate-500">Updates that touch one of your corrections are left for you to look at.</span>
            </div>
          )}

          <ul className="mt-6 space-y-3">
            {revisions.map((revision) => (
              <li key={revision.id}>
                <article aria-label={revision.name} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-medium text-slate-900">{revision.name}</h3>
                      <p className="text-sm text-slate-600">{summary(revision)}</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Approve ${revision.name}`}
                        onClick={() => void run(() => decide(revision, "approve"))}
                        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Turn down ${revision.name}`}
                        onClick={() => void run(() => decide(revision, "reject"))}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-50"
                      >
                        Turn down
                      </button>
                    </div>
                  </div>

                  {revision.conflicts.map((conflict) => (
                    <p key={conflict.field} className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      {`You corrected ${fieldLabel(conflict.field)}. Your correction stays in force; the new research says ${formatValue(conflict.after)}.`}
                    </p>
                  ))}

                  {revision.changes.length > 0 && (
                    <details className="mt-3" open={!revision.isNew && !revision.firstResearch}>
                      <summary className="cursor-pointer text-sm text-slate-600">
                        {revision.isNew || revision.firstResearch ? "See the facts" : "See what changed"}
                      </summary>
                      <dl className="mt-2 space-y-2 text-sm">
                        {revision.changes.map((change) => (
                          <div key={change.field} className="grid gap-1 sm:grid-cols-3">
                            <dt className="text-slate-500">{fieldLabel(change.field)}</dt>
                            {revision.isNew || revision.firstResearch ? (
                              <dd className="text-slate-800 sm:col-span-2">{formatValue(change.after)}</dd>
                            ) : (
                              <>
                                <dd className="text-slate-500 line-through">{formatValue(change.before)}</dd>
                                <dd className="text-slate-800">{formatValue(change.after)}</dd>
                              </>
                            )}
                          </div>
                        ))}
                      </dl>
                    </details>
                  )}
                </article>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
