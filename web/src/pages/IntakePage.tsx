import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { ApiError } from "../api/client.js";
import { useSession } from "../session-context.js";

interface VendorRow {
  role: string;
  businessName: string;
  website: string;
  instagram: string;
}

const EMPTY_VENDOR: VendorRow = { role: "", businessName: "", website: "", instagram: "" };

/** GET /events/:id. The gallery link itself is never part of it. */
interface StoredEvent {
  coupleNames: string;
  eventDate: string;
  venueName: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  styleTags: string[];
  uniqueAngle: string | null;
  rightsStatus: string;
  consentStatus: string;
  consentNotes: string | null;
  nameDisplay: string | null;
  coupleStory: string | null;
  isDestination: boolean;
  heroPicks: string | null;
  videoUrl: string | null;
  targetOutletNotes: string | null;
  priorExposure: { ownBlog: boolean; igPosted: boolean; priorPubs: string[] };
  hasGalleryUrl: boolean;
  vendorCredits: Array<{
    role: string;
    businessName: string;
    website: string | null;
    instagram: string | null;
  }>;
}

/** Where to go after an edit: an in-app path handed over in router state, if any. */
function returnPathOf(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const value = (state as Record<string, unknown>)["returnTo"];
  return typeof value === "string" && value.startsWith("/") ? value : null;
}

const RIGHTS_OPTIONS = [
  { value: "unverified", label: "Not yet verified" },
  { value: "own_contract", label: "I was the contracted lead" },
  { value: "second_shooter", label: "I second shot this" },
  { value: "blocked", label: "Blocked" },
];

const CONSENT_OPTIONS = [
  { value: "unverified", label: "Not yet asked" },
  { value: "granted", label: "Granted" },
  { value: "granted_limited", label: "Granted with limits" },
  { value: "declined", label: "Declined" },
];

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {error !== undefined && (
        <p className="mt-1 text-sm text-rose-700" data-testid={`error-${id}`}>
          {error}
        </p>
      )}
    </div>
  );
}

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900";

/**
 * The intake form, for a new event at /events/new and for an existing one at
 * /events/:id/edit. Editing sends the whole form again with PATCH; the server
 * validates it with the same rules as a new event.
 */
export function IntakePage() {
  const { api } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams();
  const editing = id !== undefined;

  const [loaded, setLoaded] = useState(!editing);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [galleryOnFile, setGalleryOnFile] = useState(false);

  const [values, setValues] = useState({
    coupleNames: "",
    eventDate: "",
    venueName: "",
    city: "",
    state: "",
    country: "",
    galleryUrl: "",
    rightsStatus: "unverified",
    consentStatus: "unverified",
    consentNotes: "",
    nameDisplay: "",
    coupleStory: "",
    uniqueAngle: "",
    heroPicks: "",
    videoUrl: "",
    targetOutletNotes: "",
    styleTags: "",
  });
  const [isDestination, setIsDestination] = useState(false);
  const [ownBlog, setOwnBlog] = useState(false);
  const [igPosted, setIgPosted] = useState(false);
  const [priorPubs, setPriorPubs] = useState("");
  const [vendors, setVendors] = useState<VendorRow[]>([{ ...EMPTY_VENDOR }]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    api
      .get<StoredEvent>(`/events/${id}`)
      .then((stored) => {
        if (cancelled) return;
        const text = (value: string | null) => value ?? "";
        setValues({
          coupleNames: stored.coupleNames,
          eventDate: stored.eventDate,
          venueName: text(stored.venueName),
          city: text(stored.city),
          state: text(stored.state),
          country: text(stored.country),
          // Never prefilled: the server does not hand the link back.
          galleryUrl: "",
          rightsStatus: stored.rightsStatus,
          consentStatus: stored.consentStatus,
          consentNotes: text(stored.consentNotes),
          nameDisplay: text(stored.nameDisplay),
          coupleStory: text(stored.coupleStory),
          uniqueAngle: text(stored.uniqueAngle),
          heroPicks: text(stored.heroPicks),
          videoUrl: text(stored.videoUrl),
          targetOutletNotes: text(stored.targetOutletNotes),
          styleTags: stored.styleTags.join(", "),
        });
        setIsDestination(stored.isDestination);
        setOwnBlog(stored.priorExposure.ownBlog);
        setIgPosted(stored.priorExposure.igPosted);
        setPriorPubs(stored.priorExposure.priorPubs.join(", "));
        setVendors(
          stored.vendorCredits.length === 0
            ? [{ ...EMPTY_VENDOR }]
            : stored.vendorCredits.map((credit) => ({
                role: credit.role,
                businessName: credit.businessName,
                website: text(credit.website),
                instagram: text(credit.instagram),
              })),
        );
        setGalleryOnFile(stored.hasGalleryUrl);
        setLoaded(true);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setLoadError(caught instanceof ApiError ? caught.message : "Could not load this event.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, editing, id]);

  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const splitList = (raw: string) =>
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

  function payload() {
    const optional = (value: string) => (value.trim() === "" ? undefined : value.trim());
    const gallery = optional(values.galleryUrl);
    return {
      coupleNames: values.coupleNames,
      eventDate: values.eventDate,
      venueName: optional(values.venueName),
      city: optional(values.city),
      state: optional(values.state),
      country: optional(values.country),
      // Only when typed. On an edit, an absent link keeps the stored one.
      ...(gallery === undefined ? {} : { galleryUrl: gallery }),
      rightsStatus: values.rightsStatus,
      consentStatus: values.consentStatus,
      consentNotes: optional(values.consentNotes),
      nameDisplay: optional(values.nameDisplay),
      coupleStory: optional(values.coupleStory),
      uniqueAngle: optional(values.uniqueAngle),
      heroPicks: optional(values.heroPicks),
      videoUrl: optional(values.videoUrl),
      targetOutletNotes: optional(values.targetOutletNotes),
      isDestination,
      styleTags: splitList(values.styleTags),
      priorExposure: { ownBlog, igPosted, priorPubs: splitList(priorPubs) },
      // Rows the user started and abandoned are dropped rather than sent as
      // half-filled vendor credits.
      vendorCredits: vendors
        .filter((row) => row.role.trim() !== "" || row.businessName.trim() !== "")
        .map((row) => ({
          role: row.role,
          businessName: row.businessName,
          website: optional(row.website),
          instagram: optional(row.instagram),
        })),
    };
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);
    setBusy(true);
    try {
      if (editing) {
        await api.patch(`/events/${id}`, payload());
        navigate(returnPathOf(location.state) ?? `/events/${id}`);
      } else {
        await api.post("/events", payload());
        navigate("/");
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        // The server validates; the form renders what it says rather than
        // keeping a second copy of the rules.
        setFieldErrors(caught.fieldErrors());
        setFormError(caught.message);
      } else {
        setFormError("Something went wrong. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const updateVendor = (index: number, key: keyof VendorRow, value: string) =>
    setVendors((rows) => rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));

  if (loadError !== null) {
    return (
      <p role="alert" className="text-sm text-rose-700">
        {loadError}
      </p>
    );
  }

  if (!loaded) return <p className="text-sm text-slate-500">Loading event.</p>;

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-8" noValidate>
      <h2 className="text-lg font-semibold text-slate-900">{editing ? "Edit event" : "Add an event"}</h2>

      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold text-slate-900">The event</legend>
        <Field id="coupleNames" label="Couple names" error={fieldErrors["coupleNames"]}>
          <input
            id="coupleNames"
            className={inputClass}
            value={values.coupleNames}
            onChange={(e) => set("coupleNames")(e.target.value)}
          />
        </Field>
        <Field id="eventDate" label="Event date" error={fieldErrors["eventDate"]}>
          <input
            id="eventDate"
            type="date"
            className={inputClass}
            value={values.eventDate}
            onChange={(e) => set("eventDate")(e.target.value)}
          />
        </Field>
        <Field id="venueName" label="Venue" error={fieldErrors["venueName"]}>
          <input id="venueName" className={inputClass} value={values.venueName} onChange={(e) => set("venueName")(e.target.value)} />
        </Field>
        <Field id="city" label="City" error={fieldErrors["city"]}>
          <input id="city" className={inputClass} value={values.city} onChange={(e) => set("city")(e.target.value)} />
        </Field>
        <Field id="state" label="State" error={fieldErrors["state"]}>
          <input id="state" className={inputClass} value={values.state} onChange={(e) => set("state")(e.target.value)} />
        </Field>
        <Field id="country" label="Country" error={fieldErrors["country"]}>
          <input id="country" className={inputClass} value={values.country} onChange={(e) => set("country")(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={isDestination} onChange={(e) => setIsDestination(e.target.checked)} />
          This reads as a destination wedding
        </label>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold text-slate-900">Gallery</legend>
        <Field id="galleryUrl" label="Gallery link" error={fieldErrors["galleryUrl"]}>
          <input id="galleryUrl" className={inputClass} value={values.galleryUrl} onChange={(e) => set("galleryUrl")(e.target.value)} />
          {editing && galleryOnFile && (
            <p className="mt-1 text-sm text-slate-700">
              A gallery link is on file; paste a new one only to replace it.
            </p>
          )}
          <p className="mt-1 text-xs text-slate-500">
            Stored on the server only. It is treated as a credential and is never sent back to
            this page.
          </p>
        </Field>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold text-slate-900">Rights and consent</legend>
        <Field id="rightsStatus" label="Rights" error={fieldErrors["rightsStatus"]}>
          <select id="rightsStatus" className={inputClass} value={values.rightsStatus} onChange={(e) => set("rightsStatus")(e.target.value)}>
            {RIGHTS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="consentStatus" label="Couple consent" error={fieldErrors["consentStatus"]}>
          <select id="consentStatus" className={inputClass} value={values.consentStatus} onChange={(e) => set("consentStatus")(e.target.value)}>
            {CONSENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="nameDisplay" label="Name display preference" error={fieldErrors["nameDisplay"]}>
          <input id="nameDisplay" className={inputClass} value={values.nameDisplay} onChange={(e) => set("nameDisplay")(e.target.value)} />
        </Field>
        <Field id="consentNotes" label="Consent notes" error={fieldErrors["consentNotes"]}>
          <textarea id="consentNotes" rows={2} className={inputClass} value={values.consentNotes} onChange={(e) => set("consentNotes")(e.target.value)} />
        </Field>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold text-slate-900">The story</legend>
        <Field id="coupleStory" label="Couple story" error={fieldErrors["coupleStory"]}>
          <textarea id="coupleStory" rows={4} className={inputClass} value={values.coupleStory} onChange={(e) => set("coupleStory")(e.target.value)} />
        </Field>
        <Field id="uniqueAngle" label="What made this event unique" error={fieldErrors["uniqueAngle"]}>
          <textarea id="uniqueAngle" rows={2} className={inputClass} value={values.uniqueAngle} onChange={(e) => set("uniqueAngle")(e.target.value)} />
        </Field>
        <Field id="styleTags" label="Style tags, comma separated" error={fieldErrors["styleTags"]}>
          <input id="styleTags" className={inputClass} value={values.styleTags} onChange={(e) => set("styleTags")(e.target.value)} />
        </Field>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold text-slate-900">Vendors</legend>
        {vendors.map((row, index) => (
          <div key={index} className="grid grid-cols-2 gap-3 rounded-md border border-slate-200 p-3">
            <Field id={`vendor-role-${index}`} label="Role" error={fieldErrors[`vendorCredits.${index}.role`]}>
              <input id={`vendor-role-${index}`} className={inputClass} value={row.role} onChange={(e) => updateVendor(index, "role", e.target.value)} />
            </Field>
            <Field id={`vendor-name-${index}`} label="Business name" error={fieldErrors[`vendorCredits.${index}.businessName`]}>
              <input id={`vendor-name-${index}`} className={inputClass} value={row.businessName} onChange={(e) => updateVendor(index, "businessName", e.target.value)} />
            </Field>
            <Field id={`vendor-site-${index}`} label="Website" error={fieldErrors[`vendorCredits.${index}.website`]}>
              <input id={`vendor-site-${index}`} className={inputClass} value={row.website} onChange={(e) => updateVendor(index, "website", e.target.value)} />
            </Field>
            <Field id={`vendor-ig-${index}`} label="Instagram" error={fieldErrors[`vendorCredits.${index}.instagram`]}>
              <input id={`vendor-ig-${index}`} className={inputClass} value={row.instagram} onChange={(e) => updateVendor(index, "instagram", e.target.value)} />
            </Field>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setVendors((rows) => [...rows, { ...EMPTY_VENDOR }])}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700"
        >
          Add another vendor
        </button>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold text-slate-900">Prior exposure</legend>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={ownBlog} onChange={(e) => setOwnBlog(e.target.checked)} />
          Posted on my own blog
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={igPosted} onChange={(e) => setIgPosted(e.target.checked)} />
          Posted to Instagram
        </label>
        <Field id="priorPubs" label="Previously submitted or published, comma separated" error={fieldErrors["priorExposure.priorPubs"]}>
          <input id="priorPubs" className={inputClass} value={priorPubs} onChange={(e) => setPriorPubs(e.target.value)} />
        </Field>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold text-slate-900">Assets and targets</legend>
        <Field id="heroPicks" label="Hero image picks" error={fieldErrors["heroPicks"]}>
          <input id="heroPicks" className={inputClass} value={values.heroPicks} onChange={(e) => set("heroPicks")(e.target.value)} />
        </Field>
        <Field id="videoUrl" label="Video link" error={fieldErrors["videoUrl"]}>
          <input id="videoUrl" className={inputClass} value={values.videoUrl} onChange={(e) => set("videoUrl")(e.target.value)} />
        </Field>
        <Field id="targetOutletNotes" label="Dream outlet and alternates" error={fieldErrors["targetOutletNotes"]}>
          <textarea id="targetOutletNotes" rows={2} className={inputClass} value={values.targetOutletNotes} onChange={(e) => set("targetOutletNotes")(e.target.value)} />
        </Field>
      </fieldset>

      {formError !== null && (
        <p role="alert" className="text-sm text-rose-700">
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Saving" : editing ? "Save changes" : "Save event"}
      </button>
    </form>
  );
}
