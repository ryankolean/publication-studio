import { confirmationCode, confirmationExpiry, hashConfirmationCode } from "../domain/confirmation.js";
import type { D1Database } from "../env.js";

/**
 * Storing and redeeming two-step confirmation codes (migration 0011). The
 * first call of a confirmed action issues one for exactly what it would
 * record; the second call redeems it, and what gets recorded is what was
 * stored, never the second call's own arguments.
 */

export interface Pending {
  userId: string;
  action: string;
  targetId: string;
  payload: unknown;
  preview: string[];
}

export async function issueConfirmation(db: D1Database, pending: Pending): Promise<string> {
  const code = confirmationCode(crypto.getRandomValues(new Uint8Array(10)));
  await db
    .prepare(
      "INSERT INTO confirmations (id, user_id, action, target_id, payload_json, preview_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      await hashConfirmationCode(code),
      pending.userId,
      pending.action,
      pending.targetId,
      JSON.stringify(pending.payload),
      JSON.stringify(pending.preview),
      confirmationExpiry(Date.now()),
    )
    .run();
  return code;
}

/**
 * Spends the code and returns what it stands for, or null when it is unknown,
 * spent, expired, or for another person, action or target. One statement, so
 * two calls racing with the same code cannot both succeed.
 */
export async function redeemConfirmation(
  db: D1Database,
  code: string,
  expected: { userId: string; action: string; targetId: string },
): Promise<{ payload: unknown; preview: string[] } | null> {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const row = await db
    .prepare(
      `UPDATE confirmations SET used_at = ?
       WHERE id = ? AND user_id = ? AND action = ? AND target_id = ? AND used_at IS NULL AND expires_at > ?
       RETURNING payload_json, preview_json`,
    )
    .bind(now, await hashConfirmationCode(code), expected.userId, expected.action, expected.targetId, now)
    .first<{ payload_json: string; preview_json: string }>();
  return row === null ? null : { payload: JSON.parse(row.payload_json), preview: JSON.parse(row.preview_json) as string[] };
}
