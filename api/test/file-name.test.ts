import { describe, expect, it } from "vitest";

import { MAX_FILE_NAME_LENGTH, fileNameFromHeader, sanitizeFileName } from "../src/domain/file-name.js";

describe("sanitizeFileName", () => {
  it("keeps an ordinary name as it was", () => {
    expect(sanitizeFileName("IMG_2041.jpg")).toBe("IMG_2041.jpg");
    expect(sanitizeFileName("Ceremony - first kiss (2).JPG")).toBe("Ceremony - first kiss (2).JPG");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeFileName("  portrait.jpg \n")).toBe("portrait.jpg");
  });

  it("strips any path, forward or backward", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\fakepath\\IMG_1.jpg")).toBe("IMG_1.jpg");
    expect(sanitizeFileName("galleries/june/IMG_1.jpg")).toBe("IMG_1.jpg");
    expect(sanitizeFileName("a/b\\c.png")).toBe("c.png");
  });

  it("removes leading dots, so nothing becomes hidden or climbs a directory", () => {
    expect(sanitizeFileName(".htaccess")).toBe("htaccess");
    expect(sanitizeFileName("...jpg")).toBe("jpg");
    expect(sanitizeFileName(" . hidden.jpg")).toBe("hidden.jpg");
  });

  it("keeps dots inside the name", () => {
    expect(sanitizeFileName("first.look.v2.jpg")).toBe("first.look.v2.jpg");
  });

  it("removes control characters", () => {
    expect(sanitizeFileName("a\u0000b\u001fc\u007f.jpg")).toBe("abc.jpg");
  });

  it("caps the length at 200 characters", () => {
    expect(MAX_FILE_NAME_LENGTH).toBe(200);
    const long = `${"a".repeat(250)}.jpg`;
    const result = sanitizeFileName(long);
    expect(result).toHaveLength(200);
    expect(result).toBe("a".repeat(200));
  });

  it("counts characters, not code units, so a cap never splits one", () => {
    const result = sanitizeFileName(`${"\u{1F4F7}".repeat(201)}`);
    expect(Array.from(result ?? "")).toHaveLength(200);
  });

  it("trims again after capping", () => {
    expect(sanitizeFileName(`${"a".repeat(199)}  b.jpg`)).toBe("a".repeat(199));
  });

  it("returns null for nothing usable", () => {
    expect(sanitizeFileName("")).toBeNull();
    expect(sanitizeFileName("   ")).toBeNull();
    expect(sanitizeFileName("..")).toBeNull();
    expect(sanitizeFileName("photos/")).toBeNull();
    expect(sanitizeFileName(undefined)).toBeNull();
    expect(sanitizeFileName(null)).toBeNull();
    expect(sanitizeFileName(42)).toBeNull();
  });
});

describe("fileNameFromHeader", () => {
  it("decodes the percent-encoded header and sanitizes it the same way", () => {
    expect(fileNameFromHeader(encodeURIComponent("Café première.jpg"))).toBe("Café première.jpg");
    expect(fileNameFromHeader(encodeURIComponent("../x/IMG_9.jpg"))).toBe("IMG_9.jpg");
  });

  it("ignores a missing or broken header rather than refusing the upload", () => {
    expect(fileNameFromHeader(undefined)).toBeNull();
    expect(fileNameFromHeader("%E0%A4%A")).toBeNull();
    expect(fileNameFromHeader("")).toBeNull();
  });
});
