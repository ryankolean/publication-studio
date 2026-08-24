import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The timing defense against user enumeration cannot be observed through the
 * response body -- it is about work done, not output. So this file spies on the
 * KDF and asserts it ran even when no user matched. Isolated in its own file
 * because the module mock would otherwise apply to the whole auth suite.
 */
vi.mock("../src/domain/password.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/domain/password.js")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

import { createApp } from "../src/app.js";
import {
  DEFAULT_PBKDF2_ITERATIONS,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from "../src/domain/password.js";
import { createTestD1 } from "./helpers/d1.js";
import { createTestR2 } from "./helpers/r2.js";
import type { TestD1 } from "./helpers/d1.js";
import type { Env } from "../src/env.js";

let db: TestD1;
let env: Env;
const app = createApp();

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

beforeEach(async () => {
  vi.mocked(verifyPassword).mockClear();
  db = createTestD1();
  env = {
    DB: db,
    IMAGES: createTestR2(),
    JWT_SECRET: "test-signing-secret",
    ALLOWED_ORIGIN: "https://studio.example.com",
  };
  const hash = await hashPassword("a-strong-partner-password", { iterations: 1000 });
  await db
    .prepare("INSERT INTO users (id, email, name, role, pw_hash) VALUES (?, ?, ?, ?, ?)")
    .bind("user-1", "partner@example.com", "Partner", "photographer", hash)
    .run();
  vi.mocked(verifyPassword).mockClear();
});

afterEach(() => {
  db.close();
});

describe("user enumeration defense", () => {
  it("still runs the key derivation when no user matched", async () => {
    await login("nobody@example.com", "any-password");
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  it("derives against a hash with the current default work factor", async () => {
    await login("nobody@example.com", "any-password");

    const call = vi.mocked(verifyPassword).mock.calls[0];
    const encoded = call?.[1] ?? "";
    expect(parsePasswordHash(encoded).iterations).toBe(DEFAULT_PBKDF2_ITERATIONS);
  });

  it("runs the derivation exactly once for a wrong password too", async () => {
    await login("partner@example.com", "wrong-password");
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });
});
