import { describe, expect, it } from "vitest";

import {
  CONFIRMATION_TTL_MS,
  confirmationCode,
  confirmationExpiry,
  hashConfirmationCode,
  normalizeConfirmationCode,
} from "../src/domain/confirmation.js";

describe("confirmationCode", () => {
  it("is ten characters from an alphabet with no look-alikes", () => {
    const code = confirmationCode(new Uint8Array([0, 1, 2, 31, 32, 63, 64, 200, 254, 255]));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(code).not.toMatch(/[ILOU]/);
  });

  it("uses every byte, so different bytes give different codes", () => {
    expect(confirmationCode(new Uint8Array(10).fill(0))).not.toBe(confirmationCode(new Uint8Array(10).fill(1)));
  });

  it("needs exactly ten bytes", () => {
    expect(() => confirmationCode(new Uint8Array(9))).toThrow();
  });
});

describe("normalizeConfirmationCode", () => {
  it("forgives case, spaces and dashes, as someone reading it aloud would", () => {
    expect(normalizeConfirmationCode(" ab12-cd34 ef ")).toBe("AB12CD34EF");
  });
});

describe("hashConfirmationCode", () => {
  it("hashes the normalized code, so a retyped code still matches", async () => {
    expect(await hashConfirmationCode("ab12-cd34ef")).toBe(await hashConfirmationCode("AB12CD34EF"));
    expect(await hashConfirmationCode("AB12CD34EF")).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashConfirmationCode("AB12CD34EF")).not.toBe(await hashConfirmationCode("AB12CD34EG"));
  });
});

describe("confirmationExpiry", () => {
  it("is fifteen minutes on, in the audit log's timestamp format", () => {
    expect(CONFIRMATION_TTL_MS).toBe(15 * 60 * 1000);
    expect(confirmationExpiry(Date.parse("2026-10-26T12:00:00.700Z"))).toBe("2026-10-26T12:15:00Z");
  });
});
