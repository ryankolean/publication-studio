import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { ApiError } from "../api/client.js";
import { useSession } from "../session-context.js";
import { SubmissionBadge, type SubmissionStatus, type SubmissionSummary } from "../components/SubmissionBadge.js";

type StepStatus = "done" | "current" | "todo" | "blocked";

interface Step {
  id: string;
  title: string;
  status: StepStatus;
  summary: string;
  detail: string[];
  action: { label: string; href: string } | null;
}

interface Outlet {
  id: string;
  name: string;
  tier: string;
  method: string | null;
  imgMin: number | null;
  imgMax: number | null;
  typicalResponseDays: number | null;
  warnings: Array<{ code: string; text: string }>;
}

interface EventPackage {
  id: string;
  publicationId: string;
  publicationName: string | null;
  submission: SubmissionSummary | null;
}

interface ChosenPackage {
  id: string;
  publicationId: string;
  publicationName: string;
  submissionUrl: string | null;
  descriptionMd: string | null;
  creditsBlockMd: string | null;
  imageCount: number;
  complete: boolean;
  submission: {
    id: string;
    status: SubmissionStatus;
    responseDueAt: string | null;
    daysRemaining: number | null;
    publishedUrl: string | null;
  } | null;
}

/** GET /events/:id/walkthrough. Every verdict in it is the server's. */
interface Walkthrough {
  event: { id: string; coupleNames: string };
  packages: EventPackage[];
  package: ChosenPackage | null;
  outlets: Outlet[];
  steps: Step[];
}

const STATUS_LABEL: Record<StepStatus, string> = {
  done: "Done",
  current: "Current",
  todo: "To do",
  blocked: "Blocked",
};

const STATUS_TONE: Record<StepStatus, string> = {
  done: "border-emerald-300 bg-emerald-50 text-emerald-800",
  current: "border-sky-300 bg-sky-50 text-sky-900",
  todo: "border-slate-300 bg-slate-50 text-slate-700",
  blocked: "border-rose-300 bg-rose-50 text-rose-900",
};

const METHOD_LABEL: Record<string, string> = {
  portal: "portal",
  web_form: "web form",
  email: "email",
  aggregator: "aggregator",
};

const COPY_FALLBACK = "Copying is not available here. Open the package and copy the text from there.";

const BUTTON = "rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-slate-900 disabled:opacity-50";
const PRIMARY = "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";

function errorText(caught: unknown, fallback: string): string {
  if (!(caught instanceof ApiError)) return fallback;
  const details = caught.details.map((detail) => detail.message).filter(Boolean);
  return details.length > 0 ? `${caught.message} ${details.join(" ")}` : caught.message;
}

function outletFacts(outlet: Outlet): string {
  const method = outlet.method === null ? "no public route" : (METHOD_LABEL[outlet.method] ?? outlet.method);
  const { imgMin, imgMax } = outlet;
  const bounds =
    imgMin !== null && imgMax !== null
      ? `${imgMin} to ${imgMax} images`
      : imgMin !== null
        ? `at least ${imgMin} images`
        : imgMax !== null
          ? `at most ${imgMax} images`
          : "no stated image count";
  const window =
    outlet.typicalResponseDays === null
      ? "response window unknown"
      : `replies in about ${outlet.typicalResponseDays} days`;
  return [outlet.tier, method, bounds, window].join(" - ");
}

/** Only a web address becomes a link; anything else stays text. */
const isWebUrl = (value: string | null): value is string =>
  value !== null && /^https?:\/\//i.test(value);

function StatusBadge({ status }: { status: StepStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function StepCard({
  step,
  number,
  returnTo,
  showDetail,
  children,
}: {
  step: Step;
  number: number;
  returnTo: string;
  showDetail: boolean;
  children?: ReactNode;
}) {
  const current = step.status === "current";
  return (
    <li
      aria-current={current ? "step" : undefined}
      className={`rounded-lg border p-4 ${current ? "border-slate-900" : "border-slate-200"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="flex min-w-0 items-start gap-3 font-medium text-slate-900">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-300 text-xs">
            {number}
          </span>
          <span className="min-w-0 break-words">{step.title}</span>
        </h3>
        <StatusBadge status={step.status} />
      </div>
      <p className="mt-2 text-sm break-words text-slate-700">{step.summary}</p>
      {showDetail && step.detail.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm break-words text-slate-600">
          {step.detail.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {children}
      {step.action !== null && (
        <Link
          to={step.action.href}
          state={{ returnTo }}
          className="mt-3 inline-block rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-slate-900"
        >
          {step.action.label}
        </Link>
      )}
    </li>
  );
}

/**
 * The per-event submission walkthrough. The steps, their order and every done
 * or blocked verdict come from the API; this page renders them, links each one
 * to the page where the work happens, and handles the three things that are
 * done right here: choosing the outlet, copying the text to paste, and
 * recording the live link.
 */
export function SubmitWalkthroughPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const packageId = params.get("package");
  const { api } = useSession();

  const path = `/events/${id}/walkthrough${packageId === null ? "" : `?package=${encodeURIComponent(packageId)}`}`;
  const here = `/events/${id}/submit${packageId === null ? "" : `?package=${encodeURIComponent(packageId)}`}`;

  const [data, setData] = useState<Walkthrough | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const [chosen, setChosen] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [copied, setCopied] = useState<"description" | "credits" | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  const [liveUrl, setLiveUrl] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Walkthrough>(path)
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setLoadError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorText(caught, "Could not load the walkthrough."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, path, version]);

  /** After every change the walkthrough is read again; the server's state is the truth. */
  const reload = () => setVersion((current) => current + 1);

  const openPackage = (next: string) => {
    if (next === packageId) reload();
    else setParams({ package: next });
  };

  async function startPackage() {
    const publicationId = chosen ?? data?.package?.publicationId ?? "";
    if (publicationId === "") return;
    setStarting(true);
    setStartError(null);
    try {
      // 201 for a new package, 200 for the one that already exists.
      const created = await api.post<{ id: string }>("/packages", { eventId: id, publicationId });
      openPackage(created.id);
    } catch (caught) {
      setStartError(errorText(caught, "Could not start the package."));
    } finally {
      setStarting(false);
    }
  }

  async function copy(kind: "description" | "credits", text: string) {
    setCopyNote(null);
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      setCopied(null);
      setCopyNote(COPY_FALLBACK);
      return;
    }
    try {
      await clipboard.writeText(text);
      setCopied(kind);
    } catch {
      setCopied(null);
      setCopyNote(COPY_FALLBACK);
    }
  }

  async function recordPublished(submit: FormEvent) {
    submit.preventDefault();
    const submissionId = data?.package?.submission?.id;
    if (submissionId === undefined) return;
    setPublishing(true);
    setPublishError(null);
    try {
      await api.patch(`/submissions/${submissionId}`, { status: "published", publishedUrl: liveUrl.trim() });
      setLiveUrl("");
      reload();
    } catch (caught) {
      setPublishError(errorText(caught, "Could not record the link."));
    } finally {
      setPublishing(false);
    }
  }

  if (data === null) {
    if (loadError !== null) {
      return (
        <p role="alert" className="text-sm text-rose-700">
          {loadError}
        </p>
      );
    }
    return <p className="text-sm text-slate-500">Loading the walkthrough.</p>;
  }

  const selectedOutlet = chosen ?? data.package?.publicationId ?? "";
  const pkg = data.package;

  function extrasFor(step: Step): ReactNode {
    if (step.id === "outlet") {
      return (
        <div className="mt-3 space-y-4">
          {data !== null && data.packages.length > 0 && (
            <div>
              <p className="text-sm font-medium text-slate-700">Packages already started</p>
              <ul className="mt-2 space-y-2">
                {data.packages.map((existing) => {
                  const name = existing.publicationName ?? existing.publicationId;
                  return (
                    <li key={existing.id} className="flex flex-wrap items-center gap-2 text-sm">
                      {existing.id === packageId ? (
                        <span className="text-slate-700">{`${name} (open now)`}</span>
                      ) : (
                        <button type="button" onClick={() => openPackage(existing.id)} className={BUTTON}>
                          {`Continue with ${name}`}
                        </button>
                      )}
                      {existing.submission !== null && <SubmissionBadge status={existing.submission.status} />}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">Outlets</legend>
            <ul className="mt-2 space-y-3">
              {data?.outlets.map((outlet) => (
                <li key={outlet.id} className="min-w-0 text-sm">
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="outlet"
                      value={outlet.id}
                      checked={selectedOutlet === outlet.id}
                      onChange={() => setChosen(outlet.id)}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="font-medium break-words text-slate-900">{outlet.name}</span>
                      <span className="block break-words text-slate-500">{outletFacts(outlet)}</span>
                    </span>
                  </label>
                  {outlet.warnings.length > 0 && (
                    <ul className="mt-1 ml-6 space-y-1 text-xs break-words text-amber-900">
                      {outlet.warnings.map((warning) => (
                        <li key={warning.code}>{warning.text}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </fieldset>
          <button
            type="button"
            disabled={selectedOutlet === "" || starting}
            onClick={() => void startPackage()}
            className={PRIMARY}
          >
            Start package for this outlet
          </button>
          {startError !== null && (
            <p role="alert" className="text-sm break-words text-rose-700">
              {startError}
            </p>
          )}
        </div>
      );
    }

    if (step.id === "send" && pkg !== null) {
      const description = pkg.descriptionMd ?? "";
      const credits = pkg.creditsBlockMd ?? "";
      return (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={description.trim() === ""}
              onClick={() => void copy("description", description)}
              className={BUTTON}
            >
              {copied === "description" ? "Copied" : "Copy description"}
            </button>
            <button
              type="button"
              disabled={credits.trim() === ""}
              onClick={() => void copy("credits", credits)}
              className={BUTTON}
            >
              {copied === "credits" ? "Copied" : "Copy credits"}
            </button>
            {isWebUrl(pkg.submissionUrl) && (
              <a
                href={pkg.submissionUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-slate-900"
              >
                Open the outlet's submission page
              </a>
            )}
          </div>
          {copyNote !== null && <p className="text-sm text-slate-600">{copyNote}</p>}
        </div>
      );
    }

    if (step.id === "published" && step.status !== "done" && pkg?.submission) {
      return (
        <form onSubmit={(submit) => void recordPublished(submit)} className="mt-3 space-y-2" noValidate>
          <label htmlFor="live-url" className="block text-sm font-medium text-slate-700">
            Live feature address
          </label>
          <input
            id="live-url"
            type="url"
            value={liveUrl}
            onChange={(change) => setLiveUrl(change.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button type="submit" disabled={publishing || liveUrl.trim() === ""} className={PRIMARY}>
            Record published link
          </button>
          {publishError !== null && (
            <p role="alert" className="text-sm break-words text-rose-700">
              {publishError}
            </p>
          )}
        </form>
      );
    }

    return null;
  }

  return (
    <div className="space-y-8">
      <header>
        <Link to={`/events/${id}`} className="text-sm text-slate-600 hover:text-slate-900">
          Back to event
        </Link>
        <h2 className="mt-2 text-lg font-semibold break-words text-slate-900">{`Submit ${data.event.coupleNames}`}</h2>
        {pkg !== null && <p className="text-sm text-slate-500">{`Outlet: ${pkg.publicationName}`}</p>}
        {loadError !== null && (
          <p role="alert" className="mt-2 text-sm text-rose-700">
            {loadError}
          </p>
        )}
      </header>

      <section aria-labelledby="how-this-works" className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <h3 id="how-this-works" className="text-sm font-semibold text-slate-900">
          How this works
        </h3>
        <p className="mt-2 text-sm text-slate-700">
          This tool prepares the package and tracks the reply; you do the sending yourself, through the outlet's own
          form, portal or inbox. Each event goes to one outlet at a time, so start with the one you want most. The
          checklist is the outlet's own rules, taken from its published guidelines. Mark things done here as you go,
          and the steps below update to show what is next.
        </p>
      </section>

      <ol aria-label="Submission steps" className="space-y-4">
        {data.steps.map((step, index) => (
          <StepCard
            key={step.id}
            step={step}
            number={index + 1}
            returnTo={here}
            showDetail={step.id !== "outlet"}
          >
            {extrasFor(step)}
          </StepCard>
        ))}
      </ol>
    </div>
  );
}
