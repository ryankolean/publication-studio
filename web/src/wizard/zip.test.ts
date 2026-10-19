import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { buildPackageZip, zipEntryName, zipFileName, type PackageImage } from "./zip.js";

const image = (key: string, originalName: string | null): PackageImage => ({
  key,
  originalName,
  contentType: "image/jpeg",
  bytes: 3,
  readUrl: `/images/${key}?token=t-${key.split("/").pop() ?? ""}`,
  expiresIn: 900,
});

/** Answers each read url with bytes that name it, so order is checkable. */
function fakeFetch(fail: string | null = null) {
  return vi.fn(async (url: string) => {
    if (fail !== null && url.includes(fail)) return new Response("gone", { status: 404 });
    return new Response(new TextEncoder().encode(`bytes of ${url}`));
  });
}

describe("zipEntryName", () => {
  it("prefixes the photographer's own name with a two-digit order number", () => {
    expect(zipEntryName(image("events/w1/a.jpg", "IMG_2041.jpg"), 0)).toBe("01-IMG_2041.jpg");
    expect(zipEntryName(image("events/w1/a.jpg", "first look.jpg"), 11)).toBe("12-first look.jpg");
  });

  it("names an image with no recorded name by its order and type", () => {
    expect(zipEntryName(image("events/w1/9f2c.png", null), 2)).toBe("03-photo.png");
    expect(zipEntryName(image("events/w1/noext", null), 0)).toBe("01-photo.jpg");
  });

  it("keeps counting past 99", () => {
    expect(zipEntryName(image("events/w1/a.jpg", "a.jpg"), 99)).toBe("100-a.jpg");
  });
});

describe("zipFileName", () => {
  it("names the zip after the couple and the outlet, without characters a file system refuses", () => {
    expect(zipFileName("Sarah and James", "Outlet A")).toBe("Sarah and James - Outlet A.zip");
    expect(zipFileName("Ana / Bo: the sequel?", "Out*let")).toBe("Ana - Bo- the sequel- - Out-let.zip");
  });
});

describe("buildPackageZip", () => {
  it("puts every image in selection order, named, with its own bytes", async () => {
    const images = [
      image("events/w1/c.jpg", "ceremony.jpg"),
      image("events/w1/a.jpg", "arrival.jpg"),
      image("events/w1/b.jpg", null),
    ];
    const fetch = fakeFetch();
    const zipped = await buildPackageZip(images, { baseUrl: "https://api.example.com", fetch });

    const files = unzipSync(zipped);
    expect(Object.keys(files)).toEqual(["01-ceremony.jpg", "02-arrival.jpg", "03-photo.jpg"]);
    expect(new TextDecoder().decode(files["02-arrival.jpg"])).toBe(
      "bytes of https://api.example.com/images/events/w1/a.jpg?token=t-a.jpg",
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("makes an empty zip for an empty selection", async () => {
    const zipped = await buildPackageZip([], { baseUrl: "", fetch: fakeFetch() });
    expect(Object.keys(unzipSync(zipped))).toEqual([]);
  });

  it("says which photo could not be downloaded", async () => {
    const images = [image("events/w1/a.jpg", "a.jpg"), image("events/w1/b.jpg", "b.jpg")];
    await expect(
      buildPackageZip(images, { baseUrl: "", fetch: fakeFetch("b.jpg") }),
    ).rejects.toThrow("Photo 2 could not be downloaded. Try again.");
  });

  it("says so when the network fails", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(buildPackageZip([image("events/w1/a.jpg", "a.jpg")], { baseUrl: "", fetch })).rejects.toThrow(
      "Photo 1 could not be downloaded. Try again.",
    );
  });
});
