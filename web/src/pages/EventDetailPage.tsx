import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { ApiError } from "../api/client.js";
import { API_BASE_URL } from "../config.js";
import { useSession } from "../session-context.js";
import { RightsBadge, type Gate, type GateReason } from "../components/RightsBadge.js";
import { SubmissionBadge, type SubmissionSummary } from "../components/SubmissionBadge.js";

interface EventDetail {
  id: string;
  coupleNames: string;
  eventDate: string;
  venueName: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  consentStatus: string;
  consentNotes: string | null;
  nameDisplay: string | null;
  /** The URL itself never leaves the server; only whether one is on file. */
  hasGalleryUrl: boolean;
  gate: Gate;
}

export interface PoolImage {
  key: string;
  contentType: string;
  bytes: number;
  createdAt: string;
  readUrl: string;
  expiresIn: number;
}

interface PackageSummary {
  id: string;
  publicationId: string;
  publicationName: string | null;
  version: number;
  complete: boolean;
  imageCount: number;
  createdAt: string;
  submission: SubmissionSummary | null;
}

interface PublicationOption {
  id: string;
  name: string;
}

interface UploadLine {
  name: string;
  text: string;
}

const CONSENT_LABEL: Record<string, string> = {
  unverified: "Not yet asked",
  granted: "Granted",
  granted_limited: "Granted with limits",
  declined: "Declined",
};

const ACCEPT = "image/jpeg,image/png,image/webp";

function place(event: EventDetail): string {
  return [event.venueName, [event.city, event.state, event.country].filter(Boolean).join(", ")]
    .filter((part) => part !== null && part !== "")
    .join(" - ");
}

const messageOf = (caught: unknown, fallback: string): string =>
  caught instanceof ApiError ? caught.message : fallback;

function ReasonList({ reasons }: { reasons: GateReason[] }) {
  return (
    <ul className="mt-2 space-y-1 text-sm text-slate-600">
      {reasons.map((reason) => (
        <li key={reason.code}>{reason.remedy}</li>
      ))}
    </ul>
  );
}

export function EventDetailPage() {
  const { id = "" } = useParams();
  const { api } = useSession();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [pool, setPool] = useState<PoolImage[]>([]);
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [publications, setPublications] = useState<PublicationOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [uploads, setUploads] = useState<UploadLine[]>([]);
  const [uploading, setUploading] = useState(false);
  // Set when the server refuses an upload on rights grounds after the page
  // loaded; the server is the authority, so its reasons replace the uploader.
  const [uploadBlock, setUploadBlock] = useState<GateReason[] | null>(null);

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [publicationId, setPublicationId] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const loadPool = useCallback(async () => {
    const body = await api.get<{ images: PoolImage[] }>(`/events/${id}/images`);
    setPool(body.images);
  }, [api, id]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<EventDetail>(`/events/${id}`),
      api.get<{ images: PoolImage[] }>(`/events/${id}/images`),
      api.get<{ packages: PackageSummary[] }>(`/events/${id}/packages`),
      api.get<{ publications: PublicationOption[] }>("/publications"),
    ])
      .then(([eventBody, poolBody, packageBody, publicationBody]) => {
        if (cancelled) return;
        setEvent(eventBody);
        setPool(poolBody.images);
        setPackages(packageBody.packages);
        setPublications(publicationBody.publications);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(messageOf(caught, "Could not load this event."));
      });
    return () => {
      cancelled = true;
    };
  }, [api, id]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setUploads(files.map((file) => ({ name: file.name, text: "waiting" })));
    const update = (index: number, text: string) =>
      setUploads((lines) => lines.map((line, i) => (i === index ? { ...line, text } : line)));

    // One at a time: a two-person tool gains little from parallel uploads, and
    // sequential progress is easier to read and to reason about on failure.
    for (const [index, file] of files.entries()) {
      update(index, "uploading");
      try {
        const grant = await api.post<{ uploadUrl: string }>(`/events/${id}/images`, {
          contentType: file.type,
        });
        await api.putBytes(grant.uploadUrl, file, file.type);
        update(index, "uploaded");
      } catch (caught) {
        update(index, messageOf(caught, "Upload failed."));
        if (caught instanceof ApiError && caught.code === "RIGHTS_BLOCKED") {
          setUploadBlock(caught.details as unknown as GateReason[]);
          break;
        }
      }
    }

    setUploading(false);
    if (fileInput.current !== null) fileInput.current.value = "";
    try {
      await loadPool();
    } catch (caught) {
      setDeleteError(messageOf(caught, "Could not refresh the images."));
    }
  }

  function onFiles(change: ChangeEvent<HTMLInputElement>) {
    void uploadFiles(Array.from(change.target.files ?? []));
  }

  async function confirmDelete(key: string) {
    setDeleteError(null);
    try {
      await api.delete(`/events/${id}/images/${key}`);
      setPendingDelete(null);
      await loadPool();
    } catch (caught) {
      setPendingDelete(null);
      setDeleteError(messageOf(caught, "Could not delete the image."));
    }
  }

  async function startPackage(submit: FormEvent) {
    submit.preventDefault();
    if (publicationId === "") return;
    setStarting(true);
    setStartError(null);
    try {
      // 201 for a new package, 200 for the existing one; either way, open it.
      const created = await api.post<{ id: string }>("/packages", { eventId: id, publicationId });
      navigate(`/packages/${created.id}`);
    } catch (caught) {
      setStartError(messageOf(caught, "Could not start the package."));
      setStarting(false);
    }
  }

  if (loadError !== null) {
    return (
      <p role="alert" className="text-sm text-rose-700">
        {loadError}
      </p>
    );
  }

  if (event === null) return <p className="text-sm text-slate-500">Loading event.</p>;

  const gateOpen = event.gate.allowed && uploadBlock === null;
  const limits = [
    event.nameDisplay === null ? null : `Name display: ${event.nameDisplay}`,
    event.consentNotes === null ? null : `Notes: ${event.consentNotes}`,
  ].filter((value): value is string => value !== null);

  return (
    <div className="space-y-10">
      <section>
        <Link to="/" className="text-sm text-slate-600 hover:text-slate-900">
          Back to events
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold break-words text-slate-900">{event.coupleNames}</h2>
            <p className="text-sm text-slate-500">
              {event.eventDate}
              {place(event) !== "" ? ` - ${place(event)}` : ""}
            </p>
          </div>
          <RightsBadge gate={event.gate} />
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link
            to={`/events/${event.id}/submit`}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
          >
            Submit this event
          </Link>
          <Link
            to={`/events/${event.id}/edit`}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-slate-900"
          >
            Edit event
          </Link>
        </div>
        {!event.gate.allowed && <ReasonList reasons={event.gate.reasons} />}
        <div className="mt-3 space-y-1 text-sm break-words text-slate-600">
          <p>{`Consent: ${CONSENT_LABEL[event.consentStatus] ?? event.consentStatus}`}</p>
          {limits.map((limit) => (
            <p key={limit}>{limit}</p>
          ))}
          <p>{event.hasGalleryUrl ? "Gallery link on file" : "No gallery link"}</p>
        </div>
      </section>

      <section>
        <h3 className="font-medium text-slate-900">Images</h3>

        {gateOpen ? (
          <div className="mt-3">
            <label htmlFor="add-images" className="block text-sm font-medium text-slate-700">
              Add images
            </label>
            <input
              ref={fileInput}
              id="add-images"
              type="file"
              multiple
              accept={ACCEPT}
              disabled={uploading}
              onChange={onFiles}
              className="mt-1 block w-full max-w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
            />
            <p className="mt-1 text-xs text-slate-500">
              Curated web-size JPEG, PNG or WebP, up to 12 MB each.
            </p>
          </div>
        ) : uploadBlock !== null ? (
          <div className="mt-3">
            <p className="text-sm text-slate-700">Uploads are blocked for this event.</p>
            <ReasonList reasons={uploadBlock} />
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">Uploads open once the rights gate clears.</p>
        )}

        {uploads.length > 0 && (
          <ul aria-label="Upload progress" className="mt-3 space-y-1 text-sm text-slate-600">
            {uploads.map((line, index) => (
              <li key={`${line.name}-${index}`} className="break-all">{`${line.name}: ${line.text}`}</li>
            ))}
          </ul>
        )}

        {deleteError !== null && (
          <p role="alert" className="mt-3 text-sm text-rose-700">
            {deleteError}
          </p>
        )}

        {pool.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No images uploaded yet.</p>
        ) : (
          <ul aria-label="Image pool" className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {pool.map((image, index) => {
              const n = index + 1;
              return (
                <li key={image.key} className="min-w-0">
                  <img
                    src={`${API_BASE_URL}${image.readUrl}`}
                    alt={`Image ${n}`}
                    loading="lazy"
                    className="aspect-square w-full rounded-md border border-slate-200 bg-slate-50 object-cover"
                  />
                  {pendingDelete === image.key ? (
                    <div className="mt-1 flex gap-2 text-xs">
                      <button
                        type="button"
                        aria-label={`Confirm delete of image ${n}`}
                        onClick={() => void confirmDelete(image.key)}
                        className="font-medium text-rose-700"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(null)}
                        className="text-slate-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete image ${n}`}
                      onClick={() => {
                        setDeleteError(null);
                        setPendingDelete(image.key);
                      }}
                      className="mt-1 text-xs text-slate-600 hover:text-rose-700"
                    >
                      Delete
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h3 className="font-medium text-slate-900">Packages</h3>

        {packages.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No packages yet.</p>
        ) : (
          <ul aria-label="Packages" className="mt-3 space-y-2">
            {packages.map((pkg) => (
              <li
                key={pkg.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3"
              >
                <Link to={`/packages/${pkg.id}`} className="font-medium text-slate-900 hover:underline">
                  {pkg.publicationName ?? pkg.publicationId}
                </Link>
                <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
                  <span>{`${pkg.imageCount} ${pkg.imageCount === 1 ? "image" : "images"}`}</span>
                  {pkg.submission && <SubmissionBadge status={pkg.submission.status} />}
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                      pkg.complete
                        ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                        : "border-slate-300 bg-slate-50 text-slate-700"
                    }`}
                  >
                    {pkg.complete ? "Complete" : "Incomplete"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {gateOpen ? (
          <form onSubmit={(submit) => void startPackage(submit)} className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-0 grow sm:grow-0">
              <label htmlFor="start-publication" className="block text-sm font-medium text-slate-700">
                Publication
              </label>
              <select
                id="start-publication"
                value={publicationId}
                onChange={(change) => setPublicationId(change.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm sm:w-64"
              >
                <option value="">Choose a publication</option>
                {publications.map((publication) => (
                  <option key={publication.id} value={publication.id}>
                    {publication.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={publicationId === "" || starting}
              className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Start package
            </button>
          </form>
        ) : (
          <p className="mt-4 text-sm text-slate-500">Packages can be started once the rights gate clears.</p>
        )}

        {startError !== null && (
          <p role="alert" className="mt-2 text-sm text-rose-700">
            {startError}
          </p>
        )}
      </section>
    </div>
  );
}
