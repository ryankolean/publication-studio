import { useEffect, useState } from "react";

import { useSession } from "../../session-context.js";
import type { StepContext } from "../context.js";
import { Alert, Frame, INPUT, LABEL, Loading } from "../Frame.js";
import { errorText } from "../model.js";
import { limitsOf, type PackageView } from "../package.js";
import { NO_OUTLET, NeedsEarlier } from "./shared.js";

const TITLE = "Write-up and credits";
const LEAD = "Say what happened, not how beautiful it was. The outlet's editor rewrites anyway.";

/** [writeup] The write-up and credits, drafted from the wedding when the package started. */
export function WriteupScreen({ ctx }: { ctx: StepContext }) {
  if (ctx.packageId === null) return <NeedsEarlier ctx={ctx} title={TITLE} lead={LEAD} {...NO_OUTLET} />;
  return <Writeup ctx={ctx} packageId={ctx.packageId} />;
}

function Writeup({ ctx, packageId }: { ctx: StepContext; packageId: string }) {
  const { api } = useSession();
  const [pkg, setPkg] = useState<PackageView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeup, setWriteup] = useState("");
  const [credits, setCredits] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<PackageView>(`/packages/${packageId}`)
      .then((view) => {
        if (cancelled) return;
        setPkg(view);
        setWriteup(view.descriptionMd ?? "");
        setCredits(view.creditsBlockMd ?? "");
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorText(caught, "Could not load the write-up."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, packageId]);

  const reason =
    writeup.trim() === ""
      ? "Add the write-up to continue."
      : credits.trim() === ""
        ? "Add the credits to continue."
        : null;

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch(`/packages/${packageId}`, { descriptionMd: writeup, creditsBlockMd: credits });
      ctx.go("confirm");
    } catch (caught) {
      setSaveError(errorText(caught, "Could not save the write-up."));
      setSaving(false);
    }
  }

  const limits = pkg === null ? [] : limitsOf(pkg.consent);

  return (
    <Frame
      title={TITLE}
      lead={LEAD}
      rail={ctx.rail}
      back={ctx.back}
      primary={
        pkg === null ? null : { label: "Continue", onClick: () => void save(), disabledReason: reason, busy: saving }
      }
      after={saveError !== null && <Alert>{saveError}</Alert>}
    >
      {loadError !== null ? (
        <Alert>{loadError}</Alert>
      ) : pkg === null ? (
        <Loading what="the write-up" />
      ) : (
        <>
          {limits.length > 0 && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm break-words text-slate-700">
              <p className="font-medium">The couple asked for this</p>
              {limits.map((limit) => (
                <p key={limit}>{limit}</p>
              ))}
            </div>
          )}
          <div>
            <label htmlFor="writeup" className={LABEL}>
              The write-up
            </label>
            <textarea id="writeup" rows={10} className={INPUT} value={writeup} onChange={(e) => setWriteup(e.target.value)} />
          </div>
          <div>
            <label htmlFor="credits" className={LABEL}>
              The credits
            </label>
            <textarea id="credits" rows={6} className={INPUT} value={credits} onChange={(e) => setCredits(e.target.value)} />
          </div>
        </>
      )}
    </Frame>
  );
}
