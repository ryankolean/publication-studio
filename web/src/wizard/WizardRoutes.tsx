import { useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { useSession } from "../session-context.js";
import type { StepContext } from "./context.js";
import { Alert, Frame, Loading } from "./Frame.js";
import { errorText, isStep, stepBefore, wizardPath, type StepId, type Walkthrough } from "./model.js";
import { ConfirmScreen } from "./screens/ConfirmScreen.js";
import { OutletScreen } from "./screens/OutletScreen.js";
import { PermissionsScreen } from "./screens/PermissionsScreen.js";
import { PhotosScreen } from "./screens/PhotosScreen.js";
import { ReviewScreen } from "./screens/ReviewScreen.js";
import { SendScreen } from "./screens/SendScreen.js";
import { StoryScreen } from "./screens/StoryScreen.js";
import { TrackScreen } from "./screens/TrackScreen.js";
import { WeddingScreen } from "./screens/WeddingScreen.js";
import { WriteupScreen } from "./screens/WriteupScreen.js";

const SCREENS: Record<StepId, ComponentType<{ ctx: StepContext }>> = {
  wedding: WeddingScreen,
  permissions: PermissionsScreen,
  story: StoryScreen,
  outlet: OutletScreen,
  photos: PhotosScreen,
  writeup: WriteupScreen,
  confirm: ConfirmScreen,
  review: ReviewScreen,
  send: SendScreen,
  track: TrackScreen,
};

/** Steps a closed rights gate holds: everything between the outlet and the reply. */
const HELD_BY_GATE: ReadonlySet<StepId> = new Set(["photos", "writeup", "confirm", "review", "send"]);

function walkthroughPath(eventId: string, packageId: string | null): string {
  return `/events/${eventId}/walkthrough${packageId === null ? "" : `?package=${encodeURIComponent(packageId)}`}`;
}

/** /wizard/new/wedding: a blank wedding form; nothing exists until Continue. */
export function WizardNewWedding() {
  return <WeddingScreen ctx={null} />;
}

/**
 * /wizard/:eventId lands on the first unfinished step. The server decides
 * which that is (the walkthrough's wizard.step); this only follows it.
 */
export function WizardResume() {
  const { eventId = "" } = useParams();
  const [params] = useSearchParams();
  const named = params.get("package");
  const { api } = useSession();
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Walkthrough>(walkthroughPath(eventId, named))
      .then((body) => {
        if (!cancelled) setTarget(wizardPath(eventId, body.wizard.step, body.wizard.packageId));
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught, "Could not open this wedding."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, eventId, named]);

  if (target !== null) return <Navigate to={target} replace />;
  if (error !== null) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <Alert>{error}</Alert>
        <Link to="/wizard" className="text-sm underline">
          Choose a wedding
        </Link>
      </div>
    );
  }
  return <Loading what="the wedding" />;
}

/** The old step-list address now opens the wizard where it left off. */
export function SubmitRedirect() {
  const { id = "" } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/wizard/${id}${search}`} replace />;
}

/**
 * /wizard/:eventId/:step. Reads the walkthrough on every screen change, so a
 * refresh or a step taken elsewhere never leaves the rail stale, then hands
 * the screen its context. Each screen reads its own data on mount.
 */
export function WizardStep() {
  const { eventId = "", step = "" } = useParams();
  const [params] = useSearchParams();
  const named = params.get("package");
  const navigate = useNavigate();
  const { api } = useSession();

  const key = `${eventId}|${step}|${named ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; body: Walkthrough } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .get<Walkthrough>(walkthroughPath(eventId, named))
      .then((body) => {
        if (!cancelled) setLoaded({ key, body });
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught, "Could not load this wedding."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, eventId, named, key, version]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);

  if (!isStep(step)) return <Navigate to={`/wizard/${eventId}`} replace />;

  if (error !== null) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <Alert>{error}</Alert>
        <Link to="/wizard" className="text-sm underline">
          Choose a wedding
        </Link>
      </div>
    );
  }
  // A walkthrough read for another screen is not shown: its rail would lie.
  if (loaded === null || loaded.key !== key) return <Loading what="the wedding" />;

  const walkthrough = loaded.body;
  const packageId = named ?? walkthrough.wizard.packageId;
  const previous = stepBefore(step);
  const ctx: StepContext = {
    eventId,
    step,
    walkthrough,
    packageId,
    rail: { eventId, packageId, current: step, steps: walkthrough.wizard.steps },
    back: previous === null ? "/wizard" : wizardPath(eventId, previous, packageId),
    go: (next, nextPackage = packageId) => navigate(wizardPath(eventId, next, nextPackage)),
    reload,
  };

  const gate = walkthrough.wizard.blocked;
  if (gate?.step === "outlet" && HELD_BY_GATE.has(step)) {
    return (
      <Frame
        title="Sort out the permissions first"
        lead="This wedding cannot go to an outlet until they are clear."
        rail={ctx.rail}
        back={wizardPath(eventId, "outlet", packageId)}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-800">
          {gate.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <Link to={wizardPath(eventId, "permissions", packageId)} className="text-sm font-medium underline">
          Edit permissions
        </Link>
      </Frame>
    );
  }

  const Screen = SCREENS[step];
  return <Screen key={`${step}|${packageId ?? ""}`} ctx={ctx} />;
}
