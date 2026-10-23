/**
 * The private contacts overlay (SUMMIT-334): an outlet's published submissions
 * inbox and editors' professional addresses. The files live outside the public
 * repository and reach D1 only through the import, alongside the outlet's
 * research file. Total, like the research validator: errors, never a throw.
 */

import { isRealDate, isSafeUrl } from "../event-intake.js";
import type { FieldError } from "../event-intake.js";
import type { ResearchResult } from "./schema.js";

export interface ContactSource {
  email: string;
  source: string;
  read: string;
}

export interface EditorContact extends ContactSource {
  name: string;
  role: string | null;
}

export interface Contacts {
  id: string;
  submission_inbox: ContactSource | null;
  editors: EditorContact[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PUBLICATION_ID = /^pub-[a-z0-9]+(-[a-z0-9]+)*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readSource(raw: unknown, at: string, today: string, errors: FieldError[]): ContactSource | null {
  if (!isObject(raw)) {
    errors.push({ field: at, message: "Expected a mapping with email, source and read." });
    return null;
  }
  const { email, source, read } = raw;
  const before = errors.length;
  if (typeof email !== "string" || !EMAIL.test(email)) errors.push({ field: `${at}.email`, message: "Expected an email address." });
  if (typeof source !== "string" || !isSafeUrl(source)) errors.push({ field: `${at}.source`, message: "Expected the http or https page that lists it." });
  if (typeof read !== "string" || !isRealDate(read) || read > today) {
    errors.push({ field: `${at}.read`, message: "Expected the date the page was read, YYYY-MM-DD, not after today." });
  }
  return errors.length === before ? { email: email as string, source: source as string, read: read as string } : null;
}

export function parseContacts(raw: unknown, today: string): ResearchResult<Contacts> {
  if (!isObject(raw)) return { ok: false, errors: [{ field: "contacts", message: "Expected a mapping." }] };

  const errors: FieldError[] = [];
  for (const key of Object.keys(raw)) {
    if (!["id", "submission_inbox", "editors"].includes(key)) errors.push({ field: key, message: "Unknown field." });
  }
  if (typeof raw["id"] !== "string" || !PUBLICATION_ID.test(raw["id"])) {
    errors.push({ field: "id", message: "Expected a publication id like pub-brides." });
  }

  const inbox = raw["submission_inbox"] === undefined ? null : readSource(raw["submission_inbox"], "submission_inbox", today, errors);

  const editors: EditorContact[] = [];
  const rawEditors = raw["editors"] ?? [];
  if (!Array.isArray(rawEditors)) {
    errors.push({ field: "editors", message: "Expected a list." });
  } else {
    rawEditors.forEach((entry, index) => {
      const at = `editors[${index}]`;
      const source = readSource(entry, at, today, errors);
      const name = isObject(entry) && typeof entry["name"] === "string" ? entry["name"].trim() : "";
      if (name === "") errors.push({ field: `${at}.name`, message: "Must not be blank." });
      const role = isObject(entry) && typeof entry["role"] === "string" ? entry["role"] : null;
      if (source !== null && name !== "") editors.push({ name, role, ...source });
    });
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { id: raw["id"] as string, submission_inbox: inbox, editors } };
}
