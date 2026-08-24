import { Hono } from "hono";

import type { AppContext } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fail } from "../errors.js";
import { evaluateRightsGate } from "../domain/rights-gate.js";
import type { ConsentStatus, RightsStatus } from "../domain/rights-gate.js";
import { parsePublicationSpec } from "../domain/publication-spec.js";
import { evaluatePackage } from "../domain/package-checklist.js";
import type { PackageInput } from "../domain/package-checklist.js";
import { buildCreditsBlock, buildDescriptionDraft } from "../domain/package-draft.js";
import type { CreditRow } from "../domain/package-draft.js";

interface WeddingRow {
  id: string;
  couple_names: string;
  wedding_date: string;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  couple_story: string | null;
  unique_angle: string | null;
  name_display: string | null;
  consent_notes: string | null;
  rights_status: RightsStatus;
  consent_status: ConsentStatus;
}

interface PackageRow {
  id: string;
  wedding_id: string;
  publication_id: string;
  image_keys: string;
  description_md: string | null;
  credits_block_md: string | null;
  checklist_json: string;
  version: number;
  created_at: string;
}

function readJson<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** Only booleans survive; a stored checklist is client-influenced data. */
function readAttestations(raw: string): Record<string, boolean> {
  const parsed = readJson<Record<string, unknown>>(raw, {});
  const result: Record<string, boolean> = {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return result;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

async function viewFor(
  c: { env: AppContext["Bindings"] },
  pkg: PackageRow,
  wedding: WeddingRow,
) {
  const publication = await c.env.DB.prepare(
    "SELECT id, name, tier, method, submission_url, spec_json FROM publications WHERE id = ?",
  )
    .bind(pkg.publication_id)
    .first<{
      id: string;
      name: string;
      tier: string;
      method: string | null;
      submission_url: string | null;
      spec_json: string;
    }>();

  const spec = parsePublicationSpec(publication?.spec_json ?? "{}");

  const input: PackageInput = {
    imageKeys: readJson<string[]>(pkg.image_keys, []),
    descriptionMd: pkg.description_md,
    creditsBlockMd: pkg.credits_block_md,
    attestations: readAttestations(pkg.checklist_json),
  };

  const evaluation = evaluatePackage(spec, input, {
    nameDisplay: wedding.name_display,
    consentNotes: wedding.consent_notes,
  });

  return {
    id: pkg.id,
    weddingId: pkg.wedding_id,
    publicationId: pkg.publication_id,
    publication:
      publication === null
        ? null
        : {
            id: publication.id,
            name: publication.name,
            tier: publication.tier,
            method: publication.method,
            submissionUrl: publication.submission_url,
            spec,
          },
    imageKeys: input.imageKeys,
    descriptionMd: input.descriptionMd,
    creditsBlockMd: input.creditsBlockMd,
    version: pkg.version,
    createdAt: pkg.created_at,
    // The couple's limits travel with the package so the editor can show them
    // beside the copy being written, not buried on the wedding record.
    consent: {
      nameDisplay: wedding.name_display,
      consentNotes: wedding.consent_notes,
    },
    checklist: evaluation.items,
    complete: evaluation.complete,
    missing: evaluation.missing,
  };
}

const WEDDING_COLUMNS = `id, couple_names, wedding_date, venue_name, city, state, country,
  couple_story, unique_angle, name_display, consent_notes, rights_status, consent_status`;

export const packageRoutes = new Hono<AppContext>();

packageRoutes.use("*", requireAuth);

packageRoutes.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "VALIDATION", "Expected a JSON body.");
  }

  const source = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const weddingId = source["weddingId"];
  const publicationId = source["publicationId"];

  if (typeof weddingId !== "string" || typeof publicationId !== "string") {
    return fail(c, 400, "VALIDATION", "Both weddingId and publicationId are required.");
  }

  const wedding = await c.env.DB.prepare(`SELECT ${WEDDING_COLUMNS} FROM weddings WHERE id = ?`)
    .bind(weddingId)
    .first<WeddingRow>();
  if (wedding === null) return fail(c, 404, "NOT_FOUND", "No such wedding.");

  const publication = await c.env.DB.prepare(
    "SELECT id, active FROM publications WHERE id = ?",
  )
    .bind(publicationId)
    .first<{ id: string; active: number }>();
  if (publication === null) return fail(c, 404, "NOT_FOUND", "No such publication.");
  if (publication.active !== 1) {
    return fail(c, 400, "VALIDATION", "That publication is no longer active.");
  }

  const gate = evaluateRightsGate({
    rightsStatus: wedding.rights_status,
    consentStatus: wedding.consent_status,
  });
  if (!gate.allowed) {
    return fail(c, 403, "RIGHTS_BLOCKED", "This wedding cannot be packaged yet.", gate.reasons);
  }

  // DECISION: one package per pairing in Phase 1. Asking again returns what
  // exists rather than creating a second, because two packages for the same
  // pairing is a bug the UI would have to resolve, and the version column is
  // there for deliberate regeneration once Phase 1 has a reason to bump it.
  const existing = await c.env.DB.prepare(
    "SELECT * FROM packages WHERE wedding_id = ? AND publication_id = ? ORDER BY version DESC",
  )
    .bind(weddingId, publicationId)
    .first<PackageRow>();

  if (existing !== null) return c.json(await viewFor(c, existing, wedding), 200);

  const { results: credits } = await c.env.DB.prepare(
    "SELECT role, business_name, website, instagram FROM vendor_credits WHERE wedding_id = ? ORDER BY sort_order",
  )
    .bind(weddingId)
    .all<{ role: string; business_name: string; website: string | null; instagram: string | null }>();

  const creditRows: CreditRow[] = credits.map((row) => ({
    role: row.role,
    businessName: row.business_name,
    website: row.website,
    instagram: row.instagram,
  }));

  const id = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO packages (id, wedding_id, publication_id, image_keys, description_md, credits_block_md, checklist_json, version)
         VALUES (?, ?, ?, '[]', ?, ?, '{}', 1)`,
      )
      .bind(
        id,
        weddingId,
        publicationId,
        buildDescriptionDraft({
          coupleNames: wedding.couple_names,
          weddingDate: wedding.wedding_date,
          venueName: wedding.venue_name,
          city: wedding.city,
          state: wedding.state,
          country: wedding.country,
          coupleStory: wedding.couple_story,
          uniqueAngle: wedding.unique_angle,
        }),
        buildCreditsBlock(creditRows),
      ),
    c.env.DB
      .prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action) VALUES (?, ?, 'package', ?, 'create')",
      )
      .bind(crypto.randomUUID(), c.get("user").id, id),
  ]);

  const created = await c.env.DB.prepare("SELECT * FROM packages WHERE id = ?")
    .bind(id)
    .first<PackageRow>();
  if (created === null) return fail(c, 500, "INTERNAL", "The package could not be read back.");

  return c.json(await viewFor(c, created, wedding), 201);
});

async function loadPair(
  c: { env: AppContext["Bindings"] },
  packageId: string,
): Promise<{ pkg: PackageRow; wedding: WeddingRow } | null> {
  const pkg = await c.env.DB.prepare("SELECT * FROM packages WHERE id = ?")
    .bind(packageId)
    .first<PackageRow>();
  if (pkg === null) return null;

  const wedding = await c.env.DB.prepare(`SELECT ${WEDDING_COLUMNS} FROM weddings WHERE id = ?`)
    .bind(pkg.wedding_id)
    .first<WeddingRow>();
  if (wedding === null) return null;

  return { pkg, wedding };
}

packageRoutes.get("/:id", async (c) => {
  const found = await loadPair(c, c.req.param("id"));
  if (found === null) return fail(c, 404, "NOT_FOUND", "No such package.");
  return c.json(await viewFor(c, found.pkg, found.wedding));
});

packageRoutes.patch("/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "VALIDATION", "Expected a JSON body.");
  }

  const found = await loadPair(c, c.req.param("id"));
  if (found === null) return fail(c, 404, "NOT_FOUND", "No such package.");

  const source = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const errors: Array<{ field: string; message: string }> = [];

  let imageKeys = readJson<string[]>(found.pkg.image_keys, []);
  if (source["imageKeys"] !== undefined) {
    const value = source["imageKeys"];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      errors.push({ field: "imageKeys", message: "Expected a list of image keys." });
    } else {
      const keys = value as string[];
      // Keys are minted by the image route against this wedding. Accepting a
      // key from anywhere else would let one wedding's package reference
      // another's images.
      const foreign = keys.filter((key) => !key.startsWith(`weddings/${found.pkg.wedding_id}/`));
      if (foreign.length > 0) {
        errors.push({ field: "imageKeys", message: "Those images belong to another wedding." });
      } else if (new Set(keys).size !== keys.length) {
        errors.push({ field: "imageKeys", message: "The same image is selected twice." });
      } else {
        imageKeys = keys;
      }
    }
  }

  const readText = (field: string, current: string | null): string | null => {
    const value = source[field];
    if (value === undefined) return current;
    if (value === null) return null;
    if (typeof value !== "string") {
      errors.push({ field, message: "Expected text." });
      return current;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const descriptionMd = readText("descriptionMd", found.pkg.description_md);
  const creditsBlockMd = readText("creditsBlockMd", found.pkg.credits_block_md);

  let attestations = readAttestations(found.pkg.checklist_json);
  if (source["attestations"] !== undefined) {
    const value = source["attestations"];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push({ field: "attestations", message: "Expected an object of checklist states." });
    } else {
      const next: Record<string, boolean> = {};
      for (const [key, checked] of Object.entries(value as Record<string, unknown>)) {
        if (typeof checked !== "boolean") {
          errors.push({ field: `attestations.${key}`, message: "Expected true or false." });
        } else if (checked) {
          // Only ticked items are stored; an unticked box is the absence of an
          // attestation, not a recorded denial.
          next[key] = true;
        }
      }
      attestations = next;
    }
  }

  if (errors.length > 0) {
    return fail(c, 400, "VALIDATION", "Some fields need attention.", errors);
  }

  await c.env.DB.batch([
    c.env.DB
      .prepare(
        "UPDATE packages SET image_keys = ?, description_md = ?, credits_block_md = ?, checklist_json = ? WHERE id = ?",
      )
      .bind(
        JSON.stringify(imageKeys),
        descriptionMd,
        creditsBlockMd,
        JSON.stringify(attestations),
        found.pkg.id,
      ),
    c.env.DB
      .prepare(
        "INSERT INTO audit_log (id, user_id, entity, entity_id, action) VALUES (?, ?, 'package', ?, 'update')",
      )
      .bind(crypto.randomUUID(), c.get("user").id, found.pkg.id),
  ]);

  const updated = await c.env.DB.prepare("SELECT * FROM packages WHERE id = ?")
    .bind(found.pkg.id)
    .first<PackageRow>();
  if (updated === null) return fail(c, 500, "INTERNAL", "The package could not be read back.");

  return c.json(await viewFor(c, updated, found.wedding));
});
