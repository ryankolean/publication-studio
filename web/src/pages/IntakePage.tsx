import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { ApiError } from "../api/client.js";
import { useSession } from "../session-context.js";

interface VendorRow {
  role: string;
  businessName: string;
  website: string;
  instagram: string;
}

const EMPTY_VENDOR: VendorRow = { role: "", businessName: "", website: "", instagram: "" };

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

export function IntakePage() {
  const { api } = useSession();
  const navigate = useNavigate();

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

  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const splitList = (raw: string) =>
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

  function payload() {
    const optional = (value: string) => (value.trim() === "" ? undefined : value.trim());
    return {
      coupleNames: values.coupleNames,
      eventDate: values.eventDate,
      venueName: optional(values.venueName),
      city: optional(values.city),
      state: optional(values.state),
      country: optional(values.country),
      galleryUrl: optional(values.galleryUrl),
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
      await api.post("/events", payload());
      navigate("/");
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

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-8" noValidate>
      <h2 className="text-lg font-semibold text-slate-900">Add an event</h2>

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
        {busy ? "Saving" : "Save event"}
      </button>
    </form>
  );
}
