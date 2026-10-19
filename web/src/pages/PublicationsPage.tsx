import { useEffect, useState } from "react";

import { ApiError } from "../api/client.js";
import { useSession } from "../session-context.js";

interface Spec {
  imgMin: number | null;
  imgMax: number | null;
  size: string;
  watermarksAllowed: boolean | null;
  videoAccepted: boolean | null;
  videoNotes: string | null;
  requirements: string[];
  notes: string | null;
}

interface Publication {
  id: string;
  name: string;
  tier: string;
  method: string | null;
  submissionUrl: string | null;
  spec: Spec;
  exclusivityPolicy: string;
  typicalResponseDays: number | null;
  responseWindowNote: string | null;
  earnedOrPaid: string;
  tasteNotes: string | null;
  lastVerified: string;
  tags: string[];
}

const TIER_LABEL: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  dream: "Dream",
};

const METHOD_LABEL: Record<string, string> = {
  portal: "Portal",
  web_form: "Web form",
  email: "Email",
  aggregator: "Aggregator",
};

function imageCount(spec: Spec): string {
  if (spec.imgMin !== null && spec.imgMax !== null) return `${spec.imgMin} to ${spec.imgMax} images`;
  if (spec.imgMax !== null) return `Up to ${spec.imgMax} images`;
  if (spec.imgMin !== null) return `At least ${spec.imgMin} images`;
  return "No published image count";
}

function requirementLabel(requirement: string): string {
  const words = requirement.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function PublicationsPage() {
  const { api } = useSession();
  const [publications, setPublications] = useState<Publication[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ publications: Publication[] }>("/publications")
      .then((body) => {
        if (!cancelled) setPublications(body.publications);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : "Could not load publications.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-rose-700">
        {error}
      </p>
    );
  }

  if (publications === null) return <p className="text-sm text-slate-500">Loading publications.</p>;

  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900">Publications</h2>
      <p className="mt-1 text-sm text-slate-500">
        Specs are transcribed by hand and drift. Re-verify before first use and quarterly after.
      </p>

      <ul className="mt-6 space-y-3">
        {publications.map((publication) => (
          <li key={publication.id} className="rounded-lg border border-slate-200 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-medium text-slate-900">{publication.name}</h3>
                <p className="text-sm text-slate-500">
                  {TIER_LABEL[publication.tier] ?? publication.tier}
                  {" - "}
                  {publication.method === null
                    ? "No public submission route"
                    : (METHOD_LABEL[publication.method] ?? publication.method)}
                  {publication.earnedOrPaid !== "earned" ? " - paid placement possible" : ""}
                </p>
              </div>
              <span className="text-xs text-slate-500">Verified {publication.lastVerified}</span>
            </div>

            {publication.tasteNotes !== null && (
              <p className="mt-2 text-sm text-slate-600">{publication.tasteNotes}</p>
            )}

            {publication.tags.length > 0 && (
              <ul aria-label={`${publication.name} tags`} className="mt-2 flex flex-wrap gap-1.5">
                {publication.tags.map((tag) => (
                  <li
                    key={tag}
                    className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600"
                  >
                    {requirementLabel(tag)}
                  </li>
                ))}
              </ul>
            )}

            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-600">
              <div className="flex gap-2">
                <dt className="text-slate-500">Images</dt>
                <dd>{imageCount(publication.spec)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">Response</dt>
                <dd>
                  {publication.typicalResponseDays === null
                    ? "Unknown"
                    : `About ${publication.typicalResponseDays} days`}
                  {publication.responseWindowNote !== null && (
                    <span className="block text-xs text-slate-500">
                      {"\u201c"}
                      {publication.responseWindowNote}
                      {"\u201d"}
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">Watermarks</dt>
                <dd>
                  {publication.spec.watermarksAllowed === null
                    ? "Unknown"
                    : publication.spec.watermarksAllowed
                      ? "Allowed"
                      : "Not allowed"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">Exclusivity</dt>
                <dd>{publication.exclusivityPolicy === "unknown" ? "Unknown" : publication.exclusivityPolicy.replace(/_/g, " ")}</dd>
              </div>
            </dl>

            {publication.spec.requirements.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-slate-600">
                {publication.spec.requirements.map((requirement) => (
                  <li key={requirement}>{requirementLabel(requirement)}</li>
                ))}
              </ul>
            )}

            {publication.submissionUrl !== null && (
              <a
                href={publication.submissionUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-3 inline-block text-sm text-slate-900 underline"
              >
                Open the submission page
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
