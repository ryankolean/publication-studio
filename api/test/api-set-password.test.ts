import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { createInviteToken, inviteExpiry } from "../src/domain/invite.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2 } from "./helpers/r2.js";

const PASSWORD = "correct horse battery staple";
const UNUSABLE = "unset";

let db: TestD1;
let env: Env;
const app = createApp();

async function seedInvite(
  options: { used?: boolean; expiresAt?: string; userId?: string } = {},
) {
  const userId = options.userId ?? "user-1";
  await db
    .prepare("INSERT OR IGNORE INTO users (id, email, name, role, pw_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, `${userId}@example.com`, "Partner", "photographer", UNUSABLE)
    .run();

  const { token, tokenHash } = await createInviteToken();
  await db
    .prepare(
      "INSERT INTO password_invites (id, user_id, token_hash, expires_at, used_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      userId,
      tokenHash,
      options.expiresAt ?? inviteExpiry(),
      options.used === true ? new Date().toISOString() : null,
    )
    .run();

  return { token, userId, email: `${userId}@example.com` };
}

const setPassword = (body: unknown) =>
  app.request(
    "/auth/set-password",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );

const login = (email: string, password: string) =>
  app.request(
    "/auth/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
    env,
  );

beforeEach(() => {
  db = createTestD1();
  env = {
    DB: db,
    IMAGES: createTestR2(),
    JWT_SECRET: "test-signing-secret",
    ALLOWED_ORIGIN: "https://studio.example.com",
  };
});

afterEach(() => {
  db.close();
});

describe("a seeded user cannot log in until they set a password", () => {
  it("refuses the placeholder hash", async () => {
    const { email } = await seedInvite();
    expect((await login(email, UNUSABLE)).status).toBe(401);
  });

  it("refuses an empty password against the placeholder", async () => {
    const { email } = await seedInvite();
    expect((await login(email, "")).status).toBe(400);
  });
});

describe("POST /auth/set-password", () => {
  it("needs no authentication, since the token is the credential", async () => {
    const { token } = await seedInvite();
    expect((await setPassword({ token, password: PASSWORD })).status).toBe(204);
  });

  it("lets the user log in afterwards", async () => {
    const { token, email } = await seedInvite();
    await setPassword({ token, password: PASSWORD });
    expect((await login(email, PASSWORD)).status).toBe(200);
  });

  it("stores a real hash rather than the placeholder", async () => {
    const { token, userId } = await seedInvite();
    await setPassword({ token, password: PASSWORD });
    const row = await db
      .prepare("SELECT pw_hash FROM users WHERE id = ?")
      .bind(userId)
      .first<{ pw_hash: string }>();
    expect(row?.pw_hash).toMatch(/^pbkdf2-sha256\$/);
  });

  it("spends the invite", async () => {
    const { token, userId } = await seedInvite();
    await setPassword({ token, password: PASSWORD });
    const row = await db
      .prepare("SELECT used_at FROM password_invites WHERE user_id = ?")
      .bind(userId)
      .first<{ used_at: string | null }>();
    expect(row?.used_at).not.toBeNull();
  });

  it("refuses to reuse a spent invite", async () => {
    const { token } = await seedInvite();
    expect((await setPassword({ token, password: PASSWORD })).status).toBe(204);
    expect((await setPassword({ token, password: "another good passphrase" })).status).toBe(400);
  });

  it("refuses an invite that was already marked used", async () => {
    const { token } = await seedInvite({ used: true });
    expect((await setPassword({ token, password: PASSWORD })).status).toBe(400);
  });

  it("refuses an expired invite", async () => {
    const { token } = await seedInvite({ expiresAt: "2020-01-01T00:00:00.000Z" });
    expect((await setPassword({ token, password: PASSWORD })).status).toBe(400);
  });

  it("refuses an unknown token", async () => {
    await seedInvite();
    const res = await setPassword({ token: "not-a-real-token", password: PASSWORD });
    expect(res.status).toBe(400);
  });

  it("gives an unknown token and a spent one the same answer", async () => {
    const { token } = await seedInvite({ used: true });
    const spent = await setPassword({ token, password: PASSWORD });
    const unknown = await setPassword({ token: "nope", password: PASSWORD });
    expect(await unknown.json()).toEqual(await spent.json());
  });

  it("enforces the password policy", async () => {
    const { token } = await seedInvite();
    const res = await setPassword({ token, password: "short" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "VALIDATION" });
  });

  it("leaves the invite usable when the password was rejected", async () => {
    const { token } = await seedInvite();
    await setPassword({ token, password: "short" });
    expect((await setPassword({ token, password: PASSWORD })).status).toBe(204);
  });

  it("requires both fields", async () => {
    const { token } = await seedInvite();
    expect((await setPassword({ token })).status).toBe(400);
    expect((await setPassword({ password: PASSWORD })).status).toBe(400);
  });

  it("audit-logs the password being set", async () => {
    const { token, userId } = await seedInvite();
    await setPassword({ token, password: PASSWORD });
    const row = await db
      .prepare("SELECT user_id, action FROM audit_log WHERE action = 'set_password'")
      .first<{ user_id: string }>();
    expect(row?.user_id).toBe(userId);
  });

  it("never echoes the token back", async () => {
    const { token } = await seedInvite({ used: true });
    const text = await (await setPassword({ token, password: PASSWORD })).text();
    expect(text).not.toContain(token);
  });
});

describe("there is still no signup", () => {
  it("does not let set-password create a user", async () => {
    const res = await setPassword({ token: "anything", password: PASSWORD });
    expect(res.status).toBe(400);
    const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
