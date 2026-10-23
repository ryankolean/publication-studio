import { useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { ApiError } from "../../api/client.js";
import { useSession } from "../../session-context.js";
import { PRIMARY } from "../Frame.js";
import { errorText } from "../model.js";

const ACCEPT = "image/jpeg,image/png,image/webp";

interface UploadLine {
  name: string;
  text: string;
}

function uploadSummary(lines: Array<{ name: string; text: string }>): string {
  const done = lines.filter((line) => line.text === "uploaded").length;
  const failed = lines.length - done;
  if (failed === 0) return done === 1 ? "1 photo added." : `${done} photos added.`;
  return `${done} added, ${failed} failed.`;
}

/**
 * "Add photos": uploads files into the wedding's photos one at a time, with
 * a line per file while it runs and a summary after. Shared by the Look and
 * Photos screens, so a photo added on one is there on the other.
 */
export function AddPhotos({
  eventId,
  onAdded,
  onUploading,
}: {
  eventId: string;
  /** Runs once every file has been tried, so the screen can list the photos again. */
  onAdded: () => Promise<void>;
  onUploading?: (uploading: boolean) => void;
}) {
  const { api } = useSession();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadLine[]>([]);
  const [uploading, setUploading] = useState(false);

  const busy = (value: boolean) => {
    setUploading(value);
    onUploading?.(value);
  };

  async function upload(files: File[]) {
    if (files.length === 0) return;
    busy(true);
    setUploads(files.map((file) => ({ name: file.name, text: "waiting" })));
    const update = (index: number, text: string) =>
      setUploads((lines) => lines.map((line, i) => (i === index ? { ...line, text } : line)));

    for (const [index, file] of files.entries()) {
      update(index, "uploading");
      try {
        const grant = await api.post<{ uploadUrl: string; fileName: string | null }>(`/events/${eventId}/images`, {
          contentType: file.type,
          fileName: file.name,
        });
        await api.putBytes(grant.uploadUrl, file, file.type, grant.fileName);
        update(index, "uploaded");
      } catch (caught) {
        update(index, errorText(caught, "Upload failed."));
        if (caught instanceof ApiError && caught.code === "RIGHTS_BLOCKED") break;
      }
    }

    busy(false);
    if (fileInput.current !== null) fileInput.current.value = "";
    await onAdded();
  }

  return (
    <div>
      {/* The native picker is hidden; the button carries the name the guide uses. */}
      <input
        ref={fileInput}
        id="add-photos"
        aria-label="Add photos"
        type="file"
        multiple
        accept={ACCEPT}
        disabled={uploading}
        onChange={(change: ChangeEvent<HTMLInputElement>) => void upload(Array.from(change.target.files ?? []))}
        className="sr-only"
      />
      <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()} className={PRIMARY}>
        {uploading ? "Adding photos" : "Add photos"}
      </button>
      <p className="mt-1 text-xs text-slate-500">JPEG, PNG or WebP, up to 12 MB each.</p>
      {uploads.length > 0 && uploading && (
        <ul aria-label="Upload progress" className="mt-2 space-y-1 text-sm text-slate-600">
          {uploads.map((line, index) => (
            <li key={`${line.name}-${index}`} className="break-all">{`${line.name}: ${line.text}`}</li>
          ))}
        </ul>
      )}
      {uploads.length > 0 && !uploading && (
        <div role="status" className="mt-2 text-sm text-slate-600">
          <p>{uploadSummary(uploads)}</p>
          {uploads
            .filter((line) => line.text !== "uploaded")
            .map((line, index) => (
              <p key={`${line.name}-${index}`} className="break-all text-rose-700">{`${line.name}: ${line.text}`}</p>
            ))}
        </div>
      )}
    </div>
  );
}
