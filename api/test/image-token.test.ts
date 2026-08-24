import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  READ_TOKEN_TTL_SECONDS,
  UPLOAD_TOKEN_TTL_SECONDS,
  mintImageToken,
  verifyImageToken,
} from "../src/domain/image-token.js";

const SECRET = "image-token-secret";
const KEY = "weddings/w1/abc.jpg";
const START = new Date("2026-08-22T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (seconds: number) =>
  vi.setSystemTime(new Date(START.getTime() + seconds * 1000));

describe("lifetimes", () => {
  it("keeps a read token short-lived", () => {
    expect(READ_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });

  it("keeps an upload token short-lived", () => {
    expect(UPLOAD_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });
});

describe("round trip", () => {
  it("verifies a freshly minted read token", async () => {
    const token = await mintImageToken(SECRET, { key: KEY, purpose: "read" });
    await expect(verifyImageToken(SECRET, token, { key: KEY, purpose: "read" })).resolves.toEqual(
      { ok: true },
    );
  });

  it("verifies a freshly minted upload token", async () => {
    const token = await mintImageToken(SECRET, { key: KEY, purpose: "write" });
    await expect(
      verifyImageToken(SECRET, token, { key: KEY, purpose: "write" }),
    ).resolves.toEqual({ ok: true });
  });

  it("produces a url-safe token", async () => {
    const token = await mintImageToken(SECRET, { key: KEY, purpose: "read" });
    expect(token).toBe(encodeURIComponent(token));
  });
});

describe("a token is bound to one object", () => {
  it("refuses a different key", async () => {
    const token = await mintImageToken(SECRET, { key: KEY, purpose: "read" });
    await expect(
      verifyImageToken(SECRET, token, { key: "weddings/w1/other.jpg", purpose: "read" }),
    ).resolves.toEqual({ ok: false, code: "TOKEN_INVALID" });
  });

  it("refuses another wedding's object", async () => {
    const token = await mintImageToken(SECRET, { key: KEY, purpose: "read" });
    await expect(
      verifyImageToken(SECRET, token, { key: "weddings/w2/abc.jpg", purpose: "read" }),
    ).resolves.toEqual({ ok: false, code: "TOKEN_INVALID" });
  });
});

describe("a token is bound to one purpose", () => {
  it("will not let a read token write", async () => {
    const token = await mintImageToken(SECRET, { key: KEY, purpose: "read" });
    await expect(
      verifyImageToken(SECRET, token, { key: KEY, purpose: "write" }),
    ).resolves.toEqual({ ok: false, code: "TOKEN_INVALID" });
  });

  it("will not let an upload token read", async () => {
    const token = await mintImageToken(SECRET, { key: KEY, purpose: "write" });
    await expect(verifyImageToken(SECRET, token, { key: KEY, purpose: "read" })).resolves.toEqual(
      { ok: false, code: "TOKEN_INVALID" },
    );
  });
});

describe("expiry", () => {
  it("is valid one second before expiry", async () => {
    const token = await mintImageToken(SECRET, { key: KEY, purpose: "read" });
    advance(READ_TOKEN_TTL_SECONDS - 1);
    await expect(verifyImageToken(SECRET, token, { key: KEY, purpose: "read" })).resolves.toEqual(
      { ok: true },
    );
  });

  it("expires after its ttl", async () => {
    const token = await mintImageToken(SECRET, { key: KEY, purpose: "read" });
    advance(READ_TOKEN_TTL_SECONDS + 1);
    await expect(verifyImageToken(SECRET, token, { key: KEY, purpose: "read" })).resolves.toEqual(
      { ok: false, code: "TOKEN_EXPIRED" },
    );
  });
});

describe("forgery", () => {
  it("refuses a token signed with another secret", async () => {
    const token = await mintImageToken("a-different-secret", { key: KEY, purpose: "read" });
    await expect(verifyImageToken(SECRET, token, { key: KEY, purpose: "read" })).resolves.toEqual(
      { ok: false, code: "TOKEN_INVALID" },
    );
  });

  it("refuses a token whose payload was edited to postpone expiry", async () => {
    const token = await mintImageToken(SECRET, { key: KEY, purpose: "read" });
    const [payload, signature] = token.split(".") as [string, string];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const forged = decoded.replace(/\|\d+$/, "|9999999999");
    const reencoded = btoa(forged).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    await expect(
      verifyImageToken(SECRET, `${reencoded}.${signature}`, { key: KEY, purpose: "read" }),
    ).resolves.toEqual({ ok: false, code: "TOKEN_INVALID" });
  });

  it("refuses malformed input without throwing", async () => {
    for (const bad of ["", "nodot", "a.b.c", ".", "....", "%%%.%%%"]) {
      await expect(
        verifyImageToken(SECRET, bad, { key: KEY, purpose: "read" }),
        bad,
      ).resolves.toMatchObject({ ok: false });
    }
  });

  it("refuses an empty secret rather than signing with nothing", async () => {
    await expect(mintImageToken("", { key: KEY, purpose: "read" })).rejects.toThrow(/secret/i);
  });
});

describe("tokens differ", () => {
  it("gives different keys different tokens", async () => {
    const a = await mintImageToken(SECRET, { key: "weddings/w1/a.jpg", purpose: "read" });
    const b = await mintImageToken(SECRET, { key: "weddings/w1/b.jpg", purpose: "read" });
    expect(a).not.toBe(b);
  });
});
