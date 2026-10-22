import { Link } from "react-router-dom";

import type { StepContext } from "../context.js";
import { Frame } from "../Frame.js";
import type { StepGuide } from "../guide.js";
import { wizardPath, type StepId } from "../model.js";

/**
 * A screen opened before the one it depends on is finished: a package before
 * an outlet is chosen, a send before it is queued. Says what comes first and
 * links there, rather than rendering a task that cannot be done.
 */
export function NeedsEarlier({
  ctx,
  guide,
  title,
  message,
  step,
  linkLabel,
}: {
  ctx: StepContext;
  guide: StepGuide;
  title?: string;
  message: string;
  step: StepId;
  linkLabel: string;
}) {
  return (
    <Frame guide={guide} title={title} rail={ctx.rail} back={ctx.back}>
      <p className="text-sm text-slate-700">{message}</p>
      <Link to={wizardPath(ctx.eventId, step, ctx.packageId)} className="text-sm font-medium text-slate-900 underline">
        {linkLabel}
      </Link>
    </Frame>
  );
}

export const NO_OUTLET = {
  message: "Choose an outlet first.",
  step: "outlet" as const,
  linkLabel: "Choose an outlet",
};
