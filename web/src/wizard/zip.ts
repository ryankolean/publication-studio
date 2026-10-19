import { zipSync } from "fflate";

/** One entry of GET /packages/:id/images, in the package's selection order. */
export interface PackageImage {
  key: string;
  originalName: string | null;
  contentType: string | null;
  bytes: number | null;
  readUrl: string;
  expiresIn: number;
}

/**
 * "07-IMG_2041.jpg": the position in the selection, then her own file name,
 * so the outlet's upload form receives the photos in the order she chose.
 * The server already reduced the name to a bare, bounded file name. An image
 * uploaded before names were kept is "07-photo.jpg".
 */
export function zipEntryName(image: PackageImage, index: number): string {
  const order = String(index + 1).padStart(2, "0");
  if (image.originalName !== null) return `${order}-${image.originalName}`;
  const extension = /\.([a-z0-9]+)$/i.exec(image.key)?.[1] ?? "jpg";
  return `${order}-photo.${extension}`;
}

/** "Sarah and James - Outlet A.zip", minus characters a file system refuses. */
export function zipFileName(coupleNames: string, outletName: string): string {
  return `${coupleNames} - ${outletName}.zip`.replace(/[\\/:*?"<>|]/g, "-");
}

interface Fetcher {
  baseUrl: string;
  fetch: (url: string) => Promise<Response>;
}

/**
 * Downloads each image through its read url and zips them in selection
 * order. Stored, not compressed: the photos are JPEG, PNG or WebP already, so
 * compressing again costs time and saves nothing.
 */
export async function buildPackageZip(images: PackageImage[], source: Fetcher): Promise<Uint8Array> {
  const contents = await Promise.all(
    images.map(async (image, index) => {
      const failed = new Error(`Photo ${index + 1} could not be downloaded. Try again.`);
      let response: Response;
      try {
        response = await source.fetch(`${source.baseUrl}${image.readUrl}`);
      } catch {
        throw failed;
      }
      if (!response.ok) throw failed;
      return new Uint8Array(await response.arrayBuffer());
    }),
  );

  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  images.forEach((image, index) => {
    files[zipEntryName(image, index)] = [contents[index] as Uint8Array, { level: 0 }];
  });
  return zipSync(files);
}

/** Hands the bytes to the browser as a download. */
export function saveFile(name: string, bytes: Uint8Array, type = "application/zip"): void {
  // A copy typed to a plain ArrayBuffer, which is what a Blob part accepts.
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next turn: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
