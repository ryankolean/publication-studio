import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { BANNED } from "./wizard/guide.js";

/**
 * Every string she can read in the app, pulled from the source: JSX text
 * and string literals with a space in them, comments stripped first. None
 * may use a banned word, an em dash, an exclamation mark or an emoji.
 */

const ROOT = join(__dirname);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name) || name === "test-setup.ts" || name === "test-utils.tsx") return [];
    return [path];
  });
}

const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** String literals and JSX text that read as sentences: 13+ characters with a space. */
function readableStrings(code: string): string[] {
  const found: string[] = [];
  for (const match of stripComments(code).matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    // A template's ${...} parts are code, not words she reads.
    const text = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\$\{[^}]*\}/g, "X");
    if (text.length >= 13 && text.includes(" ")) found.push(text);
  }
  for (const match of stripComments(code).matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
    const text = (match[1] ?? "").trim();
    // Generics and comparisons also sit between > and <; prose has no code tokens.
    if (/[(){};=[\]]|&&|\|\||\?\?/.test(text)) continue;
    if (text.length >= 13 && text.includes(" ")) found.push(text);
  }
  return found;
}

/** Strings that carry a banned word for a reason: CSS classes, paths, API field names. */
const ALLOWED = [/^[a-z0-9:/\-_. ]+$/, /^\/[a-z]/];

describe("tone", () => {
  it("never shows her a banned word, an em dash, an exclamation mark or an emoji", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      for (const text of readableStrings(readFileSync(file, "utf8"))) {
        if (ALLOWED.some((pattern) => pattern.test(text))) continue;
        if (BANNED.test(text)) offenders.push(`${relative(ROOT, file)}: ${text}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
