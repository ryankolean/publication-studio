import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useSession } from "../../session-context.js";
import type { StepContext } from "../context.js";
import { Alert, Frame, Loading, Tick } from "../Frame.js";
import { errorText, wizardPath, type StepId } from "../model.js";
import { outletNameOf, type ChecklistItem, type PackageView } from "../package.js";
import { NO_OUTLET, NeedsEarlier } from "./shared.js";

const TITLE = "Final checks";

/** Which screen fixes an item the package data answers. */
const FIXED_ON: Record<string, StepId> = {
  images_present: "photos",
  image_count: "photos",
  "req:event_description": "writeup",
  "req:couple_love_story": "writeup",
  "req:full_vendor_credits": "writeup",
};

/**
 * The wizard's words for the checks it knows by id. The server's labels serve
 * the package editor too, which says "description" and "image"; this screen
 * says "write-up" and "photo". Anything else is shown as the server words it.
 */
const PLAIN_LABEL: Record<string, string> = {
  images_present: "At least one photo chosen",
  image_count: "The number of photos fits the outlet's range",
  no_watermarks: "Confirm no photo carries a watermark",
  web_size: "Confirm every photo is a web-size file, not full size",
  consent_limits: "Confirm the photos and write-up respect the couple's limits",
  "req:event_description": "The write-up is written",
  "req:couple_love_story": "The write-up tells the couple's story",
  "req:full_vendor_credits": "The credits are written",
};

const labelOf = (item: ChecklistItem): string => PLAIN_LABEL[item.id] ?? item.label;

/** Every attested item with its ticked state, so an unticked box clears a stored one. */
function attestations(checklist: ChecklistItem[], ticks: Record<string, boolean>): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const item of checklist) if (item.kind === "attested") result[item.id] = ticks[item.id] ?? false;
  return result;
}

/**
 * [confirm] The outlet's checklist. Each tick is saved as it is made, so
 * Continue reads the server's verdict rather than the screen's.
 */
export function ConfirmScreen({ ctx }: { ctx: StepContext }) {
  if (ctx.packageId === null) {
    return <NeedsEarlier ctx={ctx} title={TITLE} lead="The outlet's own rules." {...NO_OUTLET} />;
  }
  return <Confirm ctx={ctx} packageId={ctx.packageId} />;
}

function Confirm({ ctx, packageId }: { ctx: StepContext; packageId: string }) {
  const { api } = useSession();
  const [pkg, setPkg] = useState<PackageView | null>(null);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stillOpen, setStillOpen] = useState<string[]>([]);

  const apply = (view: PackageView) => {
    setPkg(view);
    const next: Record<string, boolean> = {};
    for (const item of view.checklist) if (item.kind === "attested") next[item.id] = item.satisfied;
    setTicks(next);
  };

  useEffect(() => {
    let cancelled = false;
    api
      .get<PackageView>(`/packages/${packageId}`)
      .then((view) => {
        if (!cancelled) apply(view);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorText(caught, "Could not load the checks."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, packageId]);

  async function tick(id: string, checked: boolean) {
    if (pkg === null) return;
    const next = { ...ticks, [id]: checked };
    setTicks(next);
    setSaving(true);
    setError(null);
    try {
      apply(await api.patch<PackageView>(`/packages/${packageId}`, { attestations: attestations(pkg.checklist, next) }));
    } catch (caught) {
      setError(errorText(caught, "Could not save that check."));
    } finally {
      setSaving(false);
    }
  }

  async function next() {
    if (pkg === null) return;
    setSaving(true);
    setError(null);
    setStillOpen([]);
    try {
      await api.patch(`/packages/${packageId}`, { attestations: attestations(pkg.checklist, ticks) });
      // Read back: the server's verdict decides, not this screen's ticks.
      const fresh = await api.get<PackageView>(`/packages/${packageId}`);
      apply(fresh);
      if (fresh.complete) {
        ctx.go("review");
        return;
      }
      setStillOpen(
        fresh.missing.map((id) => {
          const item = fresh.checklist.find((entry) => entry.id === id);
          return item === undefined ? id : labelOf(item);
        }),
      );
    } catch (caught) {
      setError(errorText(caught, "Could not save the checks."));
    }
    setSaving(false);
  }

  const derivedOpen = pkg?.checklist.some((item) => item.kind === "derived" && !item.satisfied) === true;
  const reason =
    pkg === null || pkg.complete
      ? null
      : derivedOpen
        ? "Fix the open items above to continue."
        : "Tick every check to continue.";
  const outlet = pkg === null ? "The outlet" : outletNameOf(pkg);

  return (
    <Frame
      title={TITLE}
      lead={`${outlet} asks for these. Tick what you can confirm.`}
      rail={ctx.rail}
      back={ctx.back}
      primary={pkg === null ? null : { label: "Continue", onClick: () => void next(), disabledReason: reason, busy: saving }}
      after={
        <>
          {error !== null && <Alert>{error}</Alert>}
          {stillOpen.length > 0 && <Alert>{`Still open: ${stillOpen.join(", ")}.`}</Alert>}
        </>
      }
    >
      {loadError !== null ? (
        <Alert>{loadError}</Alert>
      ) : pkg === null ? (
        <Loading what="the checks" />
      ) : (
        <ul aria-label="Checks" className="space-y-3">
          {pkg.checklist.map((item) =>
            item.kind === "attested" ? (
              <li key={item.id} className="text-sm text-slate-800">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={ticks[item.id] ?? false}
                    disabled={saving}
                    onChange={(change) => void tick(item.id, change.target.checked)}
                    className="mt-0.5"
                  />
                  <span>{labelOf(item)}</span>
                </label>
                {item.detail !== undefined && <p className="ml-6 text-xs break-words text-slate-500">{item.detail}</p>}
              </li>
            ) : item.satisfied ? (
              <li key={item.id} className="flex items-start gap-2 text-sm text-slate-800">
                <span className="mt-0.5 text-emerald-700">
                  <Tick />
                </span>
                <span>
                  {labelOf(item)}
                  <span className="sr-only"> (done)</span>
                </span>
              </li>
            ) : (
              <li key={item.id} className="text-sm text-slate-800">
                <p className="font-medium text-rose-800">{`Not done: ${labelOf(item)}`}</p>
                {item.id === "image_count" && item.detail !== undefined && (
                  <p className="text-xs break-words text-slate-600">{item.detail.replace("selected", "chosen")}</p>
                )}
                {FIXED_ON[item.id] !== undefined && (
                  <Link
                    to={wizardPath(ctx.eventId, FIXED_ON[item.id] as StepId, packageId)}
                    className="text-xs font-medium text-slate-900 underline"
                  >
                    Fix this
                  </Link>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </Frame>
  );
}
