import type { D1Database } from "./env.js";

/**
 * The Claude connector's own audit_log rows (entity `connector`): sign-in
 * outcomes, registrations, sign-in pages opened. The caps and the sign-in
 * pause count these rows, so writing and counting live together.
 */

export async function logConnector(
  db: D1Database,
  entityId: string,
  action: string,
  options: { userId?: string | null; detail?: Record<string, unknown> } = {},
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (id, user_id, entity, entity_id, action, detail_json) VALUES (?, ?, 'connector', ?, ?, ?)")
    .bind(crypto.randomUUID(), options.userId ?? null, entityId, action, JSON.stringify(options.detail ?? {}))
    .run();
}

/** Rows for one entity id and action written at or after `since` (audit_log's `at` format). */
export async function countConnector(db: D1Database, entityId: string, action: string, since: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'connector' AND entity_id = ? AND action = ? AND at >= ?")
    .bind(entityId, action, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
