/**
 * Research store vocabularies (SUMMIT-335). Mirrored by D1 CHECK constraints
 * in migration 0008; test/research-store-schema.test.ts fails on drift.
 */

/**
 * A research revision is one imported version of an outlet's file. Only an
 * approved revision reaches the publications table; a newer import of the
 * same outlet supersedes whatever was pending or approved before it.
 */
export const REVISION_STATUSES = ["pending", "approved", "rejected", "superseded"] as const;

/**
 * Where a row in publication_tags came from. Approving new research replaces
 * only the `research` rows, so the photographer's own `added` tags and the
 * research tags she `removed` survive every re-import.
 */
export const PUBLICATION_TAG_ORIGINS = ["research", "added", "removed"] as const;

/** A tag from research/vocab/tags.yaml, or one the photographer created. */
export const TAG_ORIGINS = ["seed", "custom"] as const;

/** The two vocabulary files the import loads alongside the outlets. */
export const VOCAB_KINDS = ["tags", "geo"] as const;

export type RevisionStatus = (typeof REVISION_STATUSES)[number];
export type PublicationTagOrigin = (typeof PUBLICATION_TAG_ORIGINS)[number];
export type TagOrigin = (typeof TAG_ORIGINS)[number];
export type VocabKind = (typeof VOCAB_KINDS)[number];
