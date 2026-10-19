import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { RAIL_LABEL, wizardPath, type StepId, type WizardState } from "./model.js";

export const BUTTON =
  "inline-flex items-center justify-center rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-900 disabled:opacity-50";
export const PRIMARY =
  "inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50";
export const INPUT =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900";
export const LABEL = "block text-sm font-medium text-slate-800";

export function Tick({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface RailProps {
  eventId: string;
  packageId: string | null;
  current: StepId;
  steps: WizardState["steps"];
}

/**
 * Step names with the server's done ticks. Done steps are links back; the
 * current one is highlighted. It scrolls inside itself on a narrow screen
 * rather than widening the page.
 */
function Rail({ eventId, packageId, current, steps }: RailProps) {
  return (
    <nav aria-label="Progress" className="-mx-1 overflow-x-auto pb-1">
      <ol className="flex min-w-max gap-1 px-1 text-xs">
        {steps.map((entry, index) => {
          const isCurrent = entry.id === current;
          const tone = isCurrent
            ? "border-slate-900 bg-slate-900 text-white"
            : entry.done
              ? "border-emerald-300 bg-emerald-50 text-emerald-900 hover:border-emerald-600"
              : "border-slate-200 text-slate-400";
          const body = (
            <>
              {entry.done ? <Tick className="h-3 w-3" /> : <span aria-hidden="true">{index + 1}</span>}
              <span>{RAIL_LABEL[entry.id]}</span>
              {entry.done && <span className="sr-only">(done)</span>}
            </>
          );
          const shape = `inline-flex items-center gap-1 rounded-full border px-2.5 py-1 ${tone}`;
          return (
            <li key={entry.id} aria-current={isCurrent ? "step" : undefined}>
              {entry.done && !isCurrent ? (
                <Link to={wizardPath(eventId, entry.id, packageId)} className={shape}>
                  {body}
                </Link>
              ) : (
                <span className={shape}>{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface PrimaryAction {
  label: string;
  onClick: () => void;
  /** One line saying why the screen is not complete; null when it is. */
  disabledReason: string | null;
  busy?: boolean;
}

interface FrameProps {
  title: string;
  lead: string;
  rail?: RailProps | null;
  back?: string | null;
  primary?: PrimaryAction | null;
  /** Lines under the bottom bar, such as an error from the save. */
  after?: ReactNode;
  children?: ReactNode;
}

/**
 * Every wizard screen: the rail, a verb-phrase heading, one line of context,
 * the task, and Back / Continue at the bottom. Continue is disabled with its
 * reason beside it whenever the screen is not complete.
 */
export function Frame({ title, lead, rail = null, back = null, primary = null, after, children }: FrameProps) {
  const reasonId = "continue-reason";
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {rail !== null && <Rail {...rail} />}
      <header>
        <h2 className="text-xl font-semibold break-words text-slate-900">{title}</h2>
        <p className="mt-1 text-sm break-words text-slate-600">{lead}</p>
      </header>
      <div className="space-y-6">{children}</div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
        {back === null ? (
          <span />
        ) : (
          <Link to={back} className={BUTTON}>
            Back
          </Link>
        )}
        {primary !== null && (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
            {primary.disabledReason !== null && (
              <p id={reasonId} className="min-w-0 text-sm break-words text-slate-600">
                {primary.disabledReason}
              </p>
            )}
            <button
              type="button"
              onClick={primary.onClick}
              disabled={primary.disabledReason !== null || primary.busy === true}
              aria-describedby={primary.disabledReason !== null ? reasonId : undefined}
              className={PRIMARY}
            >
              {primary.label}
            </button>
          </div>
        )}
      </footer>
      {after}
    </div>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm break-words text-rose-700">
      {children}
    </p>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="text-sm text-slate-500">{`Loading ${what}.`}</p>;
}
