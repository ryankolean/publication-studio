import { describe, expect, it } from "vitest";

import {
  CLAUDE_CALLBACKS,
  SIGNIN_FAILURE_LIMIT,
  SIGNIN_WINDOW_MS,
  claudeHost,
  isClaudeCallback,
  isClaudeHost,
  registrationRefusal,
  signinLocked,
  signinWindowStart,
  CAP_WINDOW_MS,
  REGISTRATION_LIMIT,
  SIGNIN_PAGE_LIMIT,
  capWindowStart,
  registrationLocked,
  signinPageLocked,
} from "../src/domain/connector.js";

describe("isClaudeCallback", () => {
  it("accepts exactly Claude's two callback addresses", () => {
    for (const uri of CLAUDE_CALLBACKS) expect(isClaudeCallback(uri)).toBe(true);
  });

  it.each([
    "https://claude.ai/api/mcp/auth_callback/",
    "https://claude.ai/api/mcp/auth_callback?x=1",
    "http://claude.ai/api/mcp/auth_callback",
    "https://evil.claude.ai/api/mcp/auth_callback",
    "https://claude.ai.evil.example/api/mcp/auth_callback",
    "https://evil.example/cb",
    "",
  ])("refuses %s", (uri) => {
    expect(isClaudeCallback(uri)).toBe(false);
  });

  it("refuses anything that is not a string", () => {
    expect(isClaudeCallback(undefined)).toBe(false);
    expect(isClaudeCallback(["https://claude.ai/api/mcp/auth_callback"])).toBe(false);
  });
});

describe("claudeHost", () => {
  it("names the host of a Claude callback, for the sign-in page", () => {
    expect(claudeHost("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
    expect(claudeHost("https://claude.com/api/mcp/auth_callback")).toBe("claude.com");
  });

  it("is null for anything else, so a posted value cannot choose what the page shows", () => {
    expect(claudeHost("https://evil.example/cb")).toBeNull();
    expect(claudeHost("claude.ai")).toBeNull();
    expect(claudeHost(null)).toBeNull();
  });
});

describe("isClaudeHost", () => {
  it("accepts only the hosts of Claude's callbacks", () => {
    expect(isClaudeHost("claude.ai")).toBe(true);
    expect(isClaudeHost("claude.com")).toBe(true);
    expect(isClaudeHost("evil.example")).toBe(false);
    expect(isClaudeHost("CLAUDE.AI")).toBe(false);
    expect(isClaudeHost(null)).toBe(false);
  });
});

describe("registrationRefusal", () => {
  it("allows a registration whose every redirect is Claude's", () => {
    expect(registrationRefusal({ redirect_uris: [...CLAUDE_CALLBACKS] })).toBeNull();
  });

  it.each([
    [{}],
    [{ redirect_uris: [] }],
    [{ redirect_uris: "https://claude.ai/api/mcp/auth_callback" }],
    [{ redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"] }],
  ])("refuses %j", (metadata) => {
    expect(registrationRefusal(metadata)).toBe("Only Claude can connect to this studio.");
  });
});

describe("sign-in throttle", () => {
  it("locks once the failures in the window reach the limit", () => {
    expect(signinLocked(SIGNIN_FAILURE_LIMIT - 1)).toBe(false);
    expect(signinLocked(SIGNIN_FAILURE_LIMIT)).toBe(true);
  });

  it("starts the window fifteen minutes back, in the audit log's timestamp format", () => {
    expect(SIGNIN_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(signinWindowStart(Date.parse("2026-10-26T12:30:00.500Z"))).toBe("2026-10-26T12:15:00Z");
  });
});

describe("KV write caps", () => {
  it("caps new registrations and sign-in pages each hour", () => {
    expect(registrationLocked(REGISTRATION_LIMIT - 1)).toBe(false);
    expect(registrationLocked(REGISTRATION_LIMIT)).toBe(true);
    expect(signinPageLocked(SIGNIN_PAGE_LIMIT - 1)).toBe(false);
    expect(signinPageLocked(SIGNIN_PAGE_LIMIT)).toBe(true);
  });

  it("keeps a full day at both caps well inside KV's 1,000 free writes", () => {
    const hoursPerDay = 24 * 60 * 60 * 1000 / CAP_WINDOW_MS;
    expect((REGISTRATION_LIMIT + SIGNIN_PAGE_LIMIT) * hoursPerDay).toBeLessThanOrEqual(600);
  });

  it("starts the cap window an hour back", () => {
    expect(CAP_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(capWindowStart(Date.parse("2026-10-26T12:30:00.500Z"))).toBe("2026-10-26T11:30:00Z");
  });
});
