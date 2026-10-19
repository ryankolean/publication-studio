import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { API_BASE_URL } from "../../config.js";
import { useSession } from "../../session-context.js";
import type { StepContext } from "../context.js";
import { Alert, Frame, Loading } from "../Frame.js";
import { errorText, friendlyDate, type StoredEvent } from "../model.js";
import { limitsOf, outletNameOf, type PackageView } from "../package.js";
import type { PackageImage } from "../zip.js";
import { NO_OUTLET, NeedsEarlier } from "./shared.js";

const TITLE = "Review";
const LEAD = "Check it over once before it goes in your queue.";

/** "June 14, 2026 at The Barn, Detroit, MI" */
function weddingLine(event: StoredEvent): string {
  const place = [event.venueName, [event.city, event.state, event.country].filter(Boolean).join(", ")]
    .filter((part) => part !== null && part !== "")
    .join(", ");
  return `${event.coupleNames}, ${friendlyDate(event.eventDate)}${place === "" ? "" : ` at ${place}`}`;
}

/** The first 280 characters of the write-up, cut at a word. */
function excerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 280) return trimmed;
  const cut = trimmed.slice(0, 280);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 200 ? cut.lastIndexOf(" ") : 280)}...`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-slate-100 py-3 sm:grid sm:grid-cols-4 sm:gap-4">
      <dt className="text-sm font-medium text-slate-600">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm break-words text-slate-900 sm:col-span-3 sm:mt-0">{children}</dd>
    </div>
  );
}

/** [review] A compact summary, then "Add to the queue". Nothing is sent. */
export function ReviewScreen({ ctx }: { ctx: StepContext }) {
  if (ctx.packageId === null) return <NeedsEarlier ctx={ctx} title={TITLE} lead={LEAD} {...NO_OUTLET} />;
  return <Review ctx={ctx} packageId={ctx.packageId} />;
}

function Review({ ctx, packageId }: { ctx: StepContext; packageId: string }) {
  const { api } = useSession();
  const [event, setEvent] = useState<StoredEvent | null>(null);
  const [pkg, setPkg] = useState<PackageView | null>(null);
  const [images, setImages] = useState<PackageImage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<StoredEvent>(`/events/${ctx.eventId}`),
      api.get<PackageView>(`/packages/${packageId}`),
      api.get<{ images: PackageImage[] }>(`/packages/${packageId}/images`),
    ])
      .then(([eventBody, view, imageBody]) => {
        if (cancelled) return;
        setEvent(eventBody);
        setPkg(view);
        setImages(imageBody.images);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorText(caught, "Could not load the summary."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, ctx.eventId, packageId]);

  async function addToQueue() {
    setAdding(true);
    setAddError(null);
    try {
      await api.post("/submissions", { packageId });
      ctx.go("send");
    } catch (caught) {
      // A 422 (checklist not complete) or 409 (already queued) is shown as the server words it.
      setAddError(errorText(caught, "Could not add it to the queue."));
      setAdding(false);
    }
  }

  // The server's verdict on this step: a submission exists for the package.
  const queued = ctx.walkthrough.wizard.steps.find((entry) => entry.id === "review")?.done === true;
  const ready = event !== null && pkg !== null;
  const limits = pkg === null ? [] : limitsOf(pkg.consent);

  return (
    <Frame
      title={TITLE}
      lead={LEAD}
      rail={ctx.rail}
      back={ctx.back}
      primary={
        !ready
          ? null
          : queued
            ? { label: "Continue", onClick: () => ctx.go("send"), disabledReason: null }
            : { label: "Add to the queue", onClick: () => void addToQueue(), disabledReason: null, busy: adding }
      }
      after={
        ready && (
          <>
            <p className="text-right text-sm text-slate-600">
              {queued ? "It is in your queue. Nothing has been sent." : "This only puts it in your queue. Nothing is sent."}
            </p>
            {addError !== null && <Alert>{addError}</Alert>}
          </>
        )
      }
    >
      {loadError !== null ? (
        <Alert>{loadError}</Alert>
      ) : !ready ? (
        <Loading what="the summary" />
      ) : (
        <dl>
          <Row label="Wedding">{weddingLine(event)}</Row>
          <Row label="Outlet">{outletNameOf(pkg)}</Row>
          <Row label="Photos">
            <p>{`${pkg.imageKeys.length} ${pkg.imageKeys.length === 1 ? "photo" : "photos"}`}</p>
            {images.length > 0 && (
              <ul aria-label="First photos" className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                {images.slice(0, 6).map((image, index) => (
                  <li key={image.key}>
                    <img
                      src={`${API_BASE_URL}${image.readUrl}`}
                      alt={image.originalName ?? `Photo ${index + 1}`}
                      className="aspect-square w-full rounded object-cover"
                    />
                  </li>
                ))}
              </ul>
            )}
          </Row>
          <Row label="Write-up">
            <p className="whitespace-pre-line">{excerpt(pkg.descriptionMd ?? "")}</p>
          </Row>
          <Row label="Credits">
            <p className="whitespace-pre-line">{pkg.creditsBlockMd ?? ""}</p>
          </Row>
          {limits.length > 0 && (
            <Row label="The couple's limits">
              {limits.map((limit) => (
                <p key={limit}>{limit}</p>
              ))}
            </Row>
          )}
        </dl>
      )}
    </Frame>
  );
}
