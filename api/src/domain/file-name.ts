/**
 * The photographer's own file name for an uploaded image.
 *
 * It is only ever a label: the storage key is minted by the server and never
 * derived from it. It still ends up inside a zip on her machine and in front
 * of an outlet editor, so it is reduced to a bare, visible, bounded name.
 */

export const MAX_FILE_NAME_LENGTH = 200;

const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * The last path segment, without control characters or leading dots,
 * trimmed and capped at 200 characters. Null when nothing usable is left.
 */
export function sanitizeFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // A browser sends a bare name, but some send "C:\fakepath\IMG_1.jpg" and a
  // script can send anything; only the last segment is a file name.
  const base = value.split(/[\\/]/).pop() ?? "";
  // Leading whitespace and dots go together: " .hidden.jpg" is "hidden.jpg".
  const visible = base.replace(CONTROL, "").replace(/^[.\s]+/, "");
  // Array.from counts characters, so the cap never splits a surrogate pair.
  const capped = Array.from(visible).slice(0, MAX_FILE_NAME_LENGTH).join("").trim();
  return capped === "" ? null : capped;
}

/**
 * The x-file-name header on an upload. Header values must be ISO-8859-1, so
 * the client percent-encodes the name. A header that does not decode is
 * dropped rather than refusing the upload: the name is a label, the bytes are
 * what matter.
 */
export function fileNameFromHeader(header: string | undefined): string | null {
  if (header === undefined) return null;
  try {
    return sanitizeFileName(decodeURIComponent(header));
  } catch {
    return null;
  }
}
