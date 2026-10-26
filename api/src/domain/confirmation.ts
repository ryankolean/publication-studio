/**
 * Confirmation codes for the Claude connector's two-step actions (spec
 * docs/specs/claude-native.md section 6): single-use, fifteen minutes.
 *
 * Codes are short enough to read aloud, in Crockford's base32, which has no
 * I, L, O or U to misread. Ten characters is fifty bits, plenty for a code
 * that works once, for one person, for a quarter of an hour.
 */

import { hashInviteToken } from "./invite.js";

export const CONFIRMATION_TTL_MS = 15 * 60 * 1000;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;

/** One character per byte; 256 is a multiple of 32, so no character is favoured. */
export function confirmationCode(bytes: Uint8Array): string {
  if (bytes.length !== CODE_LENGTH) throw new Error(`a confirmation code needs ${CODE_LENGTH} random bytes`);
  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

export function normalizeConfirmationCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

/** What is stored in place of the code. */
export function hashConfirmationCode(code: string): Promise<string> {
  return hashInviteToken(normalizeConfirmationCode(code));
}

export function confirmationExpiry(nowMs: number): string {
  return new Date(nowMs + CONFIRMATION_TTL_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}
