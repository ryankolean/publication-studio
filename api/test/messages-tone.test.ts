import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every message the server can hand the photographer, read from the source:
 * error messages passed to fail(), `message:` fields, and the `text:` of
 * outlet warnings. The wizard prints them as written, so none may say event,
 * package or image (she reads wedding, submission and photo).
 */

const SRC = join(__dirname, "..", "src");
const BANNED = /\b(event|package|image)s?\b/i;

function sources(): Array<{ file: string; code: string }> {
  return ["routes", "domain"].flatMap((dir) =>
    readdirSync(join(SRC, dir))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ file: `${dir}/${name}`, code: readFileSync(join(SRC, dir, name), "utf8") })),
  );
}

function readableMessages(code: string): string[] {
  const found: string[] = [];
  const patterns = [
    /fail\(\s*c,\s*\d+,\s*"[A-Z_]+",\s*"([^"]+)"/g,
    /\bmessage:\s*"([^"]+)"/g,
    /\btext:\s*"([^"]+)"/g,
    /\btext:\s*`([^`]+)`/g,
    /\btext:\s*\n\s*"([^"]+)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push((match[1] ?? "").replace(/\$\{[^}]*\}/g, "X"));
  }
  // A message passed to fail() on its own line, after the code.
  for (const match of code.matchAll(/fail\(\s*c,\s*\d+,\s*"[A-Z_]+",\s*\n\s*"([^"]+)"/g)) found.push(match[1] ?? "");
  return found;
}

describe("server messages she can read", () => {
  it("never say event, package or image", () => {
    const offenders = sources().flatMap(({ file, code }) =>
      readableMessages(code)
        .filter((message) => BANNED.test(message))
        .map((message) => `${file}: ${message}`),
    );
    expect(offenders).toEqual([]);
  });

  it("finds the messages it is meant to check", () => {
    const all = sources().flatMap(({ code }) => readableMessages(code));
    expect(all).toContain("This wedding cannot go to an outlet yet.");
    expect(all.some((message) => message.startsWith("Exclusive: sending here blocks"))).toBe(true);
  });
});
