import { describe, expect, it } from "vitest";

import { appUrlFor, newUserSql, PRODUCTION_APP_URL, reinviteSql } from "../scripts/invite-sql.mjs";
import { migratedDb } from "./helpers/schema-db.js";

const NOW = "2026-10-23T12:00:00.000Z";
const LATER = "2026-10-30T12:00:00.000Z";

function invitesOf(db: ReturnType<typeof migratedDb>, email: string) {
  return db
    .prepare(
      `SELECT i.token_hash AS hash, i.expires_at AS expires, i.used_at AS used
       FROM password_invites i JOIN users u ON u.id = i.user_id
       WHERE u.email = ? ORDER BY i.created_at, i.rowid`,
    )
    .all(email) as Array<{ hash: string; expires: string; used: string | null }>;
}

function seeded() {
  const db = migratedDb();
  db.exec(
    newUserSql({
      userId: "u1",
      email: " Partner@Example.com ",
      name: "Pat O'Neill",
      role: "photographer",
      inviteId: "i1",
      tokenHash: "hash-old",
      expiresAt: "2026-08-29T00:00:00.000Z",
    }),
  );
  return db;
}

describe("newUserSql", () => {
  it("creates the user, lower-cased, with a placeholder password and one invite", () => {
    const db = seeded();
    const user = db.prepare("SELECT email, name, role, pw_hash FROM users").get() as Record<string, string>;
    expect(user).toEqual({ email: "partner@example.com", name: "Pat O'Neill", role: "photographer", pw_hash: "unset" });
    expect(invitesOf(db, "partner@example.com")).toEqual([{ hash: "hash-old", expires: "2026-08-29T00:00:00.000Z", used: null }]);
  });
});

describe("reinviteSql", () => {
  it("adds a fresh invite for an existing user and expires any older unused one", () => {
    const db = seeded();
    db.exec(
      newUserSql({
        userId: "u2",
        email: "other@example.com",
        name: "Other",
        role: "admin",
        inviteId: "i2",
        tokenHash: "hash-other",
        expiresAt: LATER,
      }),
    );
    // A second unused invite that has not lapsed yet: it must stop working too.
    db.exec("INSERT INTO password_invites (id, user_id, token_hash, expires_at) VALUES ('i3', 'u1', 'hash-live', '2026-11-01T00:00:00.000Z')");

    db.exec(reinviteSql({ email: "PARTNER@example.com", inviteId: "i4", tokenHash: "hash-new", expiresAt: LATER, now: NOW }));

    expect(invitesOf(db, "partner@example.com")).toEqual([
      { hash: "hash-old", expires: "2026-08-29T00:00:00.000Z", used: null },
      { hash: "hash-live", expires: NOW, used: null },
      { hash: "hash-new", expires: LATER, used: null },
    ]);
    // Nobody else's invite moves.
    expect(invitesOf(db, "other@example.com")).toEqual([{ hash: "hash-other", expires: LATER, used: null }]);
  });

  it("leaves used invites alone", () => {
    const db = seeded();
    db.exec("UPDATE password_invites SET used_at = '2026-08-25T00:00:00.000Z', expires_at = '2026-12-01T00:00:00.000Z'");
    db.exec(reinviteSql({ email: "partner@example.com", inviteId: "i4", tokenHash: "hash-new", expiresAt: LATER, now: NOW }));
    expect(invitesOf(db, "partner@example.com")[0]).toEqual({
      hash: "hash-old",
      expires: "2026-12-01T00:00:00.000Z",
      used: "2026-08-25T00:00:00.000Z",
    });
  });

  it("creates nothing for an email with no account", () => {
    const db = seeded();
    db.exec(reinviteSql({ email: "nobody@example.com", inviteId: "i9", tokenHash: "hash-x", expiresAt: LATER, now: NOW }));
    expect((db.prepare("SELECT COUNT(*) AS n FROM password_invites").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(1);
  });
});

describe("appUrlFor", () => {
  it("points a production invite at the live app unless told otherwise", () => {
    expect(appUrlFor("--remote", undefined)).toBe(PRODUCTION_APP_URL);
    expect(PRODUCTION_APP_URL).toBe("https://ryankolean.github.io/publication-studio");
    expect(appUrlFor("--local", undefined)).toBe("http://localhost:5173");
    expect(appUrlFor("--remote", "https://staging.example.com/")).toBe("https://staging.example.com");
  });
});
