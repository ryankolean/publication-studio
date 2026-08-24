import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { hashPassword, parsePasswordHash } from "../src/domain/password.js";
import { signAccessToken, signRefreshToken } from "../src/domain/tokens.js";
import { createTestD1, type TestD1 } from "./helpers/d1.js";
import { createTestR2 } from "./helpers/r2.js";

const JWT_SECRET = "test-signing-secret";
const ALLOWED_ORIGIN = "https://studio.example.com";
const PASSWORD = "a-strong-partner-password";

let db: TestD1;
let env: Env;
const app = createApp();

async function seedUser(
  overrides: { id?: string; email?: string; role?: string; iterations?: number } = {},
) {
  const id = overrides.id ?? "user-1";
  const email = overrides.email ?? "partner@example.com";
  const role = overrides.role ?? "photographer";
  const hash = await hashPassword(PASSWORD, { iterations: overrides.iterations ?? 1000 });
  await db
    .prepare("INSERT INTO users (id, email, name, role, pw_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, "Partner", role, hash)
    .run();
  return { id, email, role };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers }, env);

beforeEach(() => {
  db = createTestD1();
  env = {
    DB: db,
    IMAGES: createTestR2(),
    JWT_SECRET,
    ALLOWED_ORIGIN,
  };
});

afterEach(() => {
  db.close();
});

describe("GET /health", () => {
  it("is reachable without a token", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok" });
  });
});

describe("POST /auth/login", () => {
  it("returns an access token, a refresh token, and the user", async () => {
    const user = await seedUser();
    const res = await post("/auth/login", { email: user.email, password: PASSWORD });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["access_token"]).toBe("string");
    expect(typeof body["refresh_token"]).toBe("string");
    expect(body["user"]).toMatchObject({ id: user.id, email: user.email, role: user.role });
  });

  it("never returns the password hash", async () => {
    const user = await seedUser();
    const res = await post("/auth/login", { email: user.email, password: PASSWORD });
    expect(JSON.stringify(await res.json())).not.toMatch(/pbkdf2|pw_hash/);
  });

  it("matches the email case-insensitively", async () => {
    await seedUser({ email: "partner@example.com" });
    const res = await post("/auth/login", {
      email: "Partner@Example.COM",
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong password", async () => {
    const user = await seedUser();
    const res = await post("/auth/login", { email: user.email, password: "wrong" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("gives an unknown email the identical response to a wrong password", async () => {
    const user = await seedUser();
    const wrongPassword = await post("/auth/login", { email: user.email, password: "wrong" });
    const unknownEmail = await post("/auth/login", {
      email: "nobody@example.com",
      password: PASSWORD,
    });

    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(await unknownEmail.json()).toEqual(await wrongPassword.json());
  });

  it("rejects a malformed body", async () => {
    for (const body of [{}, { email: "partner@example.com" }, { password: PASSWORD }]) {
      const res = await post("/auth/login", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("upgrades a stored hash whose work factor is below the current default", async () => {
    const user = await seedUser({ iterations: 1000 });
    const before = await db
      .prepare("SELECT pw_hash FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ pw_hash: string }>();
    expect(parsePasswordHash(before?.pw_hash ?? "").iterations).toBe(1000);

    await post("/auth/login", { email: user.email, password: PASSWORD });

    const after = await db
      .prepare("SELECT pw_hash FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ pw_hash: string }>();
    expect(parsePasswordHash(after?.pw_hash ?? "").iterations).toBeGreaterThan(1000);
  });

  it("still authenticates with the same password after the upgrade", async () => {
    const user = await seedUser({ iterations: 1000 });
    await post("/auth/login", { email: user.email, password: PASSWORD });
    const second = await post("/auth/login", { email: user.email, password: PASSWORD });
    expect(second.status).toBe(200);
  });

  it("writes a login to the audit log", async () => {
    const user = await seedUser();
    await post("/auth/login", { email: user.email, password: PASSWORD });
    const row = await db
      .prepare("SELECT user_id, entity, action FROM audit_log WHERE action = 'login'")
      .first<{ user_id: string; entity: string }>();
    expect(row).toMatchObject({ user_id: user.id, entity: "user" });
  });

  it("does not audit-log a failed login attempt against an unknown email", async () => {
    await post("/auth/login", { email: "nobody@example.com", password: PASSWORD });
    const row = await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe("no signup endpoint exists", () => {
  it("does not route POST /auth/signup", async () => {
    const res = await post("/auth/signup", { email: "x@example.com", password: "x" });
    expect(res.status).toBe(404);
  });

  it("does not route POST /users", async () => {
    const res = await post("/users", { email: "x@example.com" });
    expect(res.status).toBe(404);
  });
});

describe("auth middleware", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await get("/auth/me");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a malformed Authorization header", async () => {
    for (const header of ["", "Bearer", "Basic abc", "Bearer  ", "token abc"]) {
      const res = await get("/auth/me", { authorization: header });
      expect(res.status, header).toBe(401);
    }
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signAccessToken("some-other-secret", {
      userId: "user-1",
      role: "admin",
    });
    const res = await get("/auth/me", { authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  it("rejects a refresh token used as an access token", async () => {
    const user = await seedUser();
    const refresh = await signRefreshToken(JWT_SECRET, { userId: user.id });
    const res = await get("/auth/me", { authorization: `Bearer ${refresh}` });
    expect(res.status).toBe(401);
  });

  it("rejects a token whose user no longer exists", async () => {
    const token = await signAccessToken(JWT_SECRET, { userId: "ghost", role: "admin" });
    const res = await get("/auth/me", { authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  it("accepts a valid access token and returns the caller", async () => {
    const user = await seedUser();
    const login = await post("/auth/login", { email: user.email, password: PASSWORD });
    const { access_token } = (await login.json()) as { access_token: string };

    const res = await get("/auth/me", { authorization: `Bearer ${access_token}` });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: user.id, email: user.email });
  });
});

describe("POST /auth/refresh", () => {
  it("exchanges a refresh token for a new access token", async () => {
    const user = await seedUser();
    const login = await post("/auth/login", { email: user.email, password: PASSWORD });
    const { refresh_token } = (await login.json()) as { refresh_token: string };

    const res = await post("/auth/refresh", { refresh_token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["access_token"]).toBe("string");
  });

  it("refuses an access token in place of a refresh token", async () => {
    const user = await seedUser();
    const login = await post("/auth/login", { email: user.email, password: PASSWORD });
    const { access_token } = (await login.json()) as { access_token: string };

    const res = await post("/auth/refresh", { refresh_token: access_token });
    expect(res.status).toBe(401);
  });

  it("refuses a refresh token for a deleted user", async () => {
    const refresh = await signRefreshToken(JWT_SECRET, { userId: "ghost" });
    const res = await post("/auth/refresh", { refresh_token: refresh });
    expect(res.status).toBe(401);
  });

  it("rejects a missing refresh_token field", async () => {
    const res = await post("/auth/refresh", {});
    expect(res.status).toBe(400);
  });
});

describe("CORS", () => {
  it("allows the configured SPA origin", async () => {
    const res = await app.request(
      "/health",
      { method: "OPTIONS", headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "GET" } },
      env,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  it("does not echo an unapproved origin", async () => {
    const res = await app.request(
      "/health",
      { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } },
      env,
    );
    expect(res.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });
});
