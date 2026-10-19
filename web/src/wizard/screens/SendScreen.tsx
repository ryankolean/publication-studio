import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "../../api/client.js";
import { API_BASE_URL } from "../../config.js";
import { useSession } from "../../session-context.js";
import type { StepContext } from "../context.js";
import { Alert, BUTTON, Frame, Loading, PRIMARY } from "../Frame.js";
import { errorText, friendlyDate, isWebUrl, wizardPath } from "../model.js";
import { outletNameOf, type PackageView } from "../package.js";
import { buildPackageZip, saveFile, zipFileName, type PackageImage } from "../zip.js";
import { NO_OUTLET, NeedsEarlier } from "./shared.js";

const LEAD = "You send it; the tool gets everything ready.";
const COPY_FALLBACK = "Copying is not available here. Select the text on the write-up screen and copy it from there.";

/** How the outlet takes submissions, in a sentence. */
export function routeSentence(outlet: string, method: string | null): string {
  switch (method) {
    case "web_form":
      return `${outlet} takes submissions through a web form.`;
    case "portal":
      return `${outlet} takes submissions through a portal. You need an account there.`;
    case "email":
      return `${outlet} takes submissions by email. Use a clear subject line.`;
    case "aggregator":
      return `${outlet} takes submissions through a submission service.`;
    default:
      return `${outlet} has no public form. Reaching it is a pitch to an editor.`;
  }
}

function Item({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="rounded-lg border border-slate-200 p-4">
      <h3 className="flex items-center gap-2 font-medium text-slate-900">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-300 text-xs">
          {n}
        </span>
        {title}
      </h3>
      <div className="mt-3 space-y-2">{children}</div>
    </li>
  );
}

/**
 * [send] Everything she needs to send it herself, in order. The tool never
 * sends anything to an outlet: "I sent it" only records that she did.
 */
export function SendScreen({ ctx }: { ctx: StepContext }) {
  if (ctx.packageId === null) {
    return <NeedsEarlier ctx={ctx} title="Send it" lead={LEAD} {...NO_OUTLET} />;
  }
  return <Send ctx={ctx} packageId={ctx.packageId} />;
}

function Send({ ctx, packageId }: { ctx: StepContext; packageId: string }) {
  const { api } = useSession();
  const { wizard, event } = ctx.walkthrough;

  const [pkg, setPkg] = useState<PackageView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);
  const [zipNote, setZipNote] = useState<string | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"writeup" | "credits" | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<PackageView>(`/packages/${packageId}`)
      .then((view) => {
        if (!cancelled) setPkg(view);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorText(caught, "Could not load the submission."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, packageId]);

  const outlet = pkg === null ? (wizard.outlet?.name ?? "the outlet") : outletNameOf(pkg);
  const title = `Send it to ${outlet}`;

  if (loadError !== null || pkg === null) {
    return (
      <Frame title={title} lead={LEAD} rail={ctx.rail} back={ctx.back}>
        {loadError !== null ? <Alert>{loadError}</Alert> : <Loading what="the submission" />}
      </Frame>
    );
  }

  if (pkg.submission === null) {
    return (
      <NeedsEarlier
        ctx={ctx}
        title={title}
        lead={LEAD}
        message="Add it to your queue first."
        step="review"
        linkLabel="Go to the review"
      />
    );
  }

  // The server's verdict on this step, not a reading of the status here.
  const sent = wizard.steps.find((entry) => entry.id === "send")?.done === true;
  const held = wizard.blocked?.step === "send" ? wizard.blocked.reasons : [];
  const warnings = wizard.outlet?.warnings ?? [];

  async function download() {
    setZipping(true);
    setZipError(null);
    setZipNote(null);
    try {
      const body = await api.get<{ images: PackageImage[] }>(`/packages/${packageId}/images`);
      const bytes = await buildPackageZip(body.images, {
        baseUrl: API_BASE_URL,
        fetch: (url) => globalThis.fetch(url),
      });
      saveFile(zipFileName(event.coupleNames, outlet), bytes);
      setZipNote(`${body.images.length} ${body.images.length === 1 ? "photo" : "photos"}, numbered in your order.`);
    } catch (caught) {
      // The zip builder's own error already names the photo; the API's is worded by the server.
      setZipError(
        caught instanceof ApiError
          ? errorText(caught, "Could not get the photos.")
          : caught instanceof Error
            ? caught.message
            : "Could not get the photos.",
      );
    } finally {
      setZipping(false);
    }
  }

  async function copy(kind: "writeup" | "credits", text: string) {
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

  async function markSent() {
    if (pkg === null || pkg.submission === null) return;
    setMarking(true);
    setMarkError(null);
    const id = pkg.submission.id;
    try {
      // The lifecycle has no ready -> sent edge; walk through queued first,
      // each its own PATCH, exactly as the queue page does.
      if (pkg.submission.status === "ready") await api.patch(`/submissions/${id}`, { status: "queued" });
      await api.patch(`/submissions/${id}`, { status: "sent" });
      ctx.go("track");
    } catch (caught) {
      setMarkError(errorText(caught, "Could not mark it sent."));
      setConfirming(false);
      setMarking(false);
      try {
        // The first PATCH may have landed: read the status again.
        setPkg(await api.get<PackageView>(`/packages/${packageId}`));
      } catch {
        // The error above already says what went wrong.
      }
    }
  }

  const writeup = pkg.descriptionMd ?? "";
  const credits = pkg.creditsBlockMd ?? "";
  const submissionUrl = pkg.publication?.submissionUrl ?? null;

  return (
    <Frame
      title={title}
      lead={LEAD}
      rail={ctx.rail}
      back={ctx.back}
      primary={{
        label: "Continue",
        onClick: () => ctx.go("track"),
        disabledReason: sent ? null : "Mark it as sent to continue.",
      }}
    >
      {warnings.length > 0 && (
        <section aria-label={`Before you send to ${outlet}`} className="rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900">Before you send</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm break-words text-amber-900">
            {warnings.map((warning) => (
              <li key={warning.code}>{warning.text}</li>
            ))}
          </ul>
        </section>
      )}

      <ol className="space-y-4">
        <Item n={1} title="The photos">
          <button type="button" onClick={() => void download()} disabled={zipping} className={BUTTON}>
            {zipping ? "Getting the photos ready" : "Download the photos"}
          </button>
          {zipNote !== null && <p className="text-sm text-slate-600">{zipNote}</p>}
          {zipError !== null && <Alert>{zipError}</Alert>}
        </Item>

        <Item n={2} title="The write-up and credits">
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={writeup.trim() === ""} onClick={() => void copy("writeup", writeup)} className={BUTTON}>
              {copied === "writeup" ? "Copied" : "Copy the write-up"}
            </button>
            <button type="button" disabled={credits.trim() === ""} onClick={() => void copy("credits", credits)} className={BUTTON}>
              {copied === "credits" ? "Copied" : "Copy the credits"}
            </button>
          </div>
          {copyNote !== null && <p className="text-sm text-slate-600">{copyNote}</p>}
        </Item>

        <Item n={3} title={`${outlet}'s page`}>
          <p className="text-sm text-slate-700">{routeSentence(outlet, pkg.publication?.method ?? null)}</p>
          {isWebUrl(submissionUrl) && (
            <a href={submissionUrl} target="_blank" rel="noreferrer" className={`${BUTTON} w-fit`}>
              {`Open ${outlet}'s submission page`}
            </a>
          )}
        </Item>

        <Item n={4} title="Mark it sent">
          {held.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-rose-800">
              {held.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {sent ? (
            <p className="text-sm text-slate-700">
              {`Marked sent${pkg.submission.sentAt === null ? "" : ` on ${friendlyDate(pkg.submission.sentAt.slice(0, 10))}`}. `}
              <Link to={wizardPath(ctx.eventId, "track", packageId)} className="underline">
                Track the reply
              </Link>
            </p>
          ) : confirming ? (
            <div className="space-y-2">
              <p className="text-sm text-slate-800">Mark this as sent today? The reply window starts now.</p>
              <div className="flex flex-wrap gap-3">
                <button type="button" disabled={marking} onClick={() => void markSent()} className={PRIMARY}>
                  Yes, mark it sent
                </button>
                <button type="button" disabled={marking} onClick={() => setConfirming(false)} className={BUTTON}>
                  Not yet
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={held.length > 0}
              onClick={() => {
                setMarkError(null);
                setConfirming(true);
              }}
              className={BUTTON}
            >
              I sent it
            </button>
          )}
          {markError !== null && <Alert>{markError}</Alert>}
        </Item>
      </ol>
    </Frame>
  );
}
