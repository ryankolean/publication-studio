import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { migratedDb } from "./helpers/schema-db.js";
import { checkResearchSet, parseResearchVocab, validatePublicationFile } from "../src/domain/research/schema.js";
import type { PublicationFile, ResearchVocab } from "../src/domain/research/schema.js";
import type { FieldError } from "../src/domain/event-intake.js";

/**
 * The research files in the repo are the source of truth for every outlet
 * (SUMMIT-333). This is the gate: CI fails if any file breaks a rule, so
 * nothing unsourced or malformed reaches the import.
 */

const RESEARCH_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../research");
const PUBLICATIONS_DIR = join(RESEARCH_DIR, "publications");

const loadYaml = (path: string): unknown => parse(readFileSync(path, "utf8"));
const today = new Date().toISOString().slice(0, 10);

function vocab(): ResearchVocab {
  const result = parseResearchVocab(
    loadYaml(join(RESEARCH_DIR, "vocab/tags.yaml")),
    loadYaml(join(RESEARCH_DIR, "vocab/geo.yaml")),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.value;
}

const publicationFiles = () => readdirSync(PUBLICATIONS_DIR).filter((name) => name.endsWith(".yaml")).sort();

describe("research vocabulary", () => {
  it("parses", () => {
    expect(() => vocab()).not.toThrow();
  });

  it("keeps every tag the database already holds, in the same category", () => {
    const db = migratedDb();
    const seeded = db.prepare("SELECT id, category FROM tags").all() as Array<{ id: string; category: string }>;
    db.close();

    const tags = vocab().tags;
    for (const tag of seeded) {
      expect(tags.get(tag.id), tag.id).toBe(tag.category);
    }
  });
});

describe("publication research files", () => {
  it("live in research/publications as .yaml files", () => {
    expect(readdirSync(PUBLICATIONS_DIR).filter((name) => !name.startsWith(".") && !name.endsWith(".yaml"))).toEqual([]);
  });

  it("each follow the schema", () => {
    const research = vocab();
    const failures: Record<string, FieldError[]> = {};
    for (const name of publicationFiles()) {
      const result = validatePublicationFile(loadYaml(join(PUBLICATIONS_DIR, name)), research, today);
      if (!result.ok) failures[name] = result.errors;
    }
    expect(failures).toEqual({});
  });

  it("agree with each other: names match ids, shared inboxes resolve", () => {
    const research = vocab();
    const files: Array<{ fileName: string; file: PublicationFile }> = [];
    for (const name of publicationFiles()) {
      const result = validatePublicationFile(loadYaml(join(PUBLICATIONS_DIR, name)), research, today);
      if (result.ok) files.push({ fileName: name, file: result.value });
    }
    expect(checkResearchSet(files)).toEqual([]);
  });
});
