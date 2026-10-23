/**
 * The SQL behind scripts/seed-user.mjs, kept apart so it can be tested against
 * the real migrations. `wrangler d1 execute` takes no bind parameters, so
 * every value is quoted here.
 */

export const PRODUCTION_APP_URL = "https://ryankolean.github.io/publication-studio";
const LOCAL_APP_URL = "http://localhost:5173";

/** Single-quoted SQL literal. */
export const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

const normalEmail = (email) => String(email).trim().toLowerCase();

/**
 * Where the invite link points: the address given, else the live app for the
 * production database and the dev server for the local one. A production
 * invite that pointed at localhost would be a dead link.
 */
export function appUrlFor(target, given) {
  const url = given ?? (target === "--remote" ? PRODUCTION_APP_URL : LOCAL_APP_URL);
  return url.replace(/\/+$/, "");
}

/**
 * A new user and their first invite. pw_hash is a placeholder that cannot
 * parse as a real hash, so it never verifies against any password; the
 * invite is the only way in.
 */
export function newUserSql({ userId, email, name, role, inviteId, tokenHash, expiresAt }) {
  return [
    `INSERT INTO users (id, email, name, role, pw_hash) VALUES (${q(userId)}, ${q(normalEmail(email))}, ${q(name)}, ${q(role)}, 'unset');`,
    `INSERT INTO password_invites (id, user_id, token_hash, expires_at) VALUES (${q(inviteId)}, ${q(userId)}, ${q(tokenHash)}, ${q(expiresAt)});`,
  ].join(" ");
}

/**
 * A fresh invite for a user who already exists, for when the first link
 * lapsed or was lost. Any older unused invite stops working at `now`, so only
 * the newest link is live. Used invites are history and stay as they are.
 * For an email with no account it changes nothing; the script checks first
 * and says so.
 */
export function reinviteSql({ email, inviteId, tokenHash, expiresAt, now }) {
  const user = `(SELECT id FROM users WHERE email = ${q(normalEmail(email))})`;
  return [
    `UPDATE password_invites SET expires_at = ${q(now)} WHERE used_at IS NULL AND expires_at > ${q(now)} AND user_id = ${user};`,
    `INSERT INTO password_invites (id, user_id, token_hash, expires_at) SELECT ${q(inviteId)}, id, ${q(tokenHash)}, ${q(expiresAt)} FROM users WHERE email = ${q(normalEmail(email))};`,
  ].join(" ");
}
