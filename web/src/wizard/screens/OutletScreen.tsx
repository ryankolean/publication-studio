import { useState } from "react";
import { Link } from "react-router-dom";

import { useSession } from "../../session-context.js";
import { SubmissionBadge } from "../../components/SubmissionBadge.js";
import type { StepContext } from "../context.js";
import { Alert, Frame } from "../Frame.js";
import { GUIDE } from "../guide.js";
import {
  TIER_LABEL,
  countRange,
  errorText,
  firstSentence,
  routeWords,
  wizardPath,
  type OutletOption,
} from "../model.js";

/** "30 to 40 photos - replies in about 28 days - web form" */
function facts(outlet: OutletOption): string {
  const range = countRange(outlet.imgMin, outlet.imgMax);
  return [
    range === null ? "no stated count" : `${range} photos`,
    outlet.typicalResponseDays === null
      ? "no stated reply time"
      : `replies in about ${outlet.typicalResponseDays} days`,
    routeWords(outlet.method),
  ].join(" - ");
}

/** The groups she chooses from, in the matcher's order; ruled-out outlets sit apart. */
const GROUPS: Array<{ group: "fits" | "check"; title: string }> = [
  { group: "fits", title: "Best fits" },
  { group: "check", title: "Check first" },
];

const LABEL_TONE: Record<string, string> = {
  "Strong match": "border-emerald-300 bg-emerald-50 text-emerald-900",
  "Good match": "border-sky-300 bg-sky-50 text-sky-900",
  "Worth a look": "border-slate-300 text-slate-700",
};

const cardClass = (selected: boolean) =>
  `flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${
    selected ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200 hover:border-slate-400"
  }`;

/**
 * [outlet] Choose an outlet. Continue starts the package for the chosen
 * outlet (the server hands back the existing one for a pairing it already
 * has), or carries on with a package already started. A wedding the rights
 * gate holds stops here, with the gate's reasons.
 */
export function OutletScreen({ ctx }: { ctx: StepContext }) {
  const { api } = useSession();
  const { walkthrough } = ctx;
  const blocked = walkthrough.wizard.blocked?.step === "outlet" ? walkthrough.wizard.blocked : null;

  const [choice, setChoice] = useState<string | null>(ctx.packageId === null ? null : `package:${ctx.packageId}`);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const started = new Set(walkthrough.packages.map((pkg) => pkg.publicationId));
  const fresh = walkthrough.outlets.filter((outlet) => !started.has(outlet.id));
  const ruledOut = fresh.filter((outlet) => outlet.match.group === "excluded");

  async function next() {
    if (choice === null) return;
    const [kind, id] = choice.split(":") as ["package" | "outlet", string];
    if (kind === "package") {
      ctx.go("photos", id);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      // 201 for a new package, 200 for the one that already exists.
      const created = await api.post<{ id: string }>("/packages", { eventId: ctx.eventId, publicationId: id });
      ctx.go("photos", created.id);
    } catch (caught) {
      setSaveError(errorText(caught, "Could not start with this outlet."));
      setSaving(false);
    }
  }

  return (
    <Frame
      guide={GUIDE.outlet}
      rail={ctx.rail}
      back={ctx.back}
      primary={{
        label: "Continue",
        onClick: () => void next(),
        disabledReason:
          blocked !== null
            ? "This wedding cannot go to an outlet yet."
            : choice === null
              ? "Pick an outlet to continue."
              : null,
        busy: saving,
      }}
      after={saveError !== null && <Alert>{saveError}</Alert>}
    >
      {blocked !== null ? (
        <section aria-label="Why this wedding is on hold" className="rounded-lg border border-rose-200 bg-rose-50 p-4">
          <p className="text-sm font-medium text-rose-900">This wedding cannot go to an outlet yet.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-rose-900">
            {blocked.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <Link
            to={wizardPath(ctx.eventId, "permissions", ctx.packageId)}
            className="mt-3 inline-block text-sm font-medium text-rose-900 underline"
          >
            Edit permissions
          </Link>
        </section>
      ) : (
        <fieldset className="space-y-6">
          <legend className="sr-only">Outlets</legend>
          {walkthrough.packages.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Already started</h3>
              <ul className="mt-2 space-y-3">
                {walkthrough.packages.map((pkg) => {
                  const value = `package:${pkg.id}`;
                  return (
                    <li key={pkg.id}>
                      <label className={cardClass(choice === value)}>
                        <input
                          type="radio"
                          name="outlet"
                          value={value}
                          checked={choice === value}
                          onChange={() => setChoice(value)}
                          className="mt-1"
                        />
                        <span className="min-w-0 grow">
                          <span className="block font-medium break-words text-slate-900">
                            {pkg.publicationName ?? "An outlet no longer listed"}
                          </span>
                          <span className="mt-1 block">
                            {pkg.submission === null ? (
                              <span className="text-sm text-slate-500">Not in the queue yet</span>
                            ) : (
                              <SubmissionBadge status={pkg.submission.status} />
                            )}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {walkthrough.event.locationCode === null && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Outlets that cover only one place cannot be checked until you say where the wedding was.{" "}
              <Link to={wizardPath(ctx.eventId, "wedding", ctx.packageId)} className="font-medium underline">
                Add where it was
              </Link>
            </p>
          )}

          {GROUPS.map(({ group, title }) => {
            const outlets = fresh.filter((outlet) => outlet.match.group === group);
            if (outlets.length === 0) return null;
            return (
              <div key={group}>
                <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
                <ul className="mt-2 space-y-3">
                  {outlets.map((outlet) => (
                    <OutletCard
                      key={outlet.id}
                      outlet={outlet}
                      selected={choice === `outlet:${outlet.id}`}
                      onSelect={() => setChoice(`outlet:${outlet.id}`)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}

          {ruledOut.length > 0 && (
            <details className="rounded-lg border border-slate-200 p-4">
              <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                {`Not for this wedding (${ruledOut.length})`}
              </summary>
              <ul className="mt-3 space-y-3">
                {ruledOut.map((outlet) => (
                  <li key={outlet.id} className="text-sm">
                    <span className="font-medium break-words text-slate-900">{outlet.name}</span>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-xs break-words text-slate-600">
                      {outlet.match.excluded.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </fieldset>
      )}
    </Frame>
  );
}

/** One outlet she can choose: how well it fits and why, what to check, and what choosing it commits to. */
function OutletCard({ outlet, selected, onSelect }: { outlet: OutletOption; selected: boolean; onSelect: () => void }) {
  const taste = firstSentence(outlet.tasteNotes);
  const { match } = outlet;
  return (
    <li>
      <label className={cardClass(selected)}>
        <input type="radio" name="outlet" value={`outlet:${outlet.id}`} checked={selected} onChange={onSelect} className="mt-1" />
        <div className="min-w-0 grow space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium break-words text-slate-900">{outlet.name}</span>
            <span className={`rounded-full border px-2 py-0.5 text-xs ${LABEL_TONE[match.label] ?? LABEL_TONE["Worth a look"]}`}>
              {match.label}
            </span>
            <span className="rounded-full border border-slate-300 px-2 py-0.5 text-xs text-slate-700">
              {TIER_LABEL[outlet.tier] ?? outlet.tier}
            </span>
          </div>
          {match.reasons.length > 0 && (
            <ul aria-label={`Why ${outlet.name}`} className="space-y-0.5 text-sm break-words text-slate-700">
              {match.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {match.checks.length > 0 && (
            <ul aria-label={`To check for ${outlet.name}`} className="list-disc space-y-1 pl-5 text-xs break-words text-sky-900">
              {match.checks.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {match.deadline !== null && <p className="text-xs font-medium break-words text-amber-900">{match.deadline}</p>}
          {taste !== null && <p className="text-sm break-words text-slate-600">{taste}</p>}
          <p className="text-sm break-words text-slate-500">{`${facts(outlet)} - match score ${match.score} of 100`}</p>
          {outlet.warnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs break-words text-amber-900">
              {outlet.warnings.map((warning) => (
                <li key={warning.code}>{warning.text}</li>
              ))}
            </ul>
          )}
        </div>
      </label>
    </li>
  );
}
