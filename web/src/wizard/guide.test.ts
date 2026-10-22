import { describe, expect, it } from "vitest";

import { BANNED, GUIDE, RULES, WELCOME } from "./guide.js";
import { STEPS } from "./model.js";

describe("the guide", () => {
  it("has a guide for every step, in the wizard's order", () => {
    expect(Object.keys(GUIDE)).toEqual([...STEPS]);
    for (const step of STEPS) {
      const guide = GUIDE[step];
      expect(guide.todo.length, step).toBeGreaterThanOrEqual(1);
      expect(guide.todo.length, step).toBeLessThanOrEqual(5);
      expect(guide.next.startsWith("Next up:"), step).toBe(true);
      expect(guide.lead.length, step).toBeGreaterThan(20);
    }
  });

  it("never uses a banned word, an em dash, an exclamation mark or an emoji", () => {
    const lines = [
      ...Object.values(GUIDE).flatMap((guide) => [guide.title, guide.lead, ...guide.todo, guide.next, guide.note ?? ""]),
      WELCOME.title,
      WELCOME.lead,
      ...WELCOME.journey,
      WELCOME.closing,
      ...RULES,
    ];
    for (const line of lines) expect(line, line).not.toMatch(BANNED);
  });

  it("names the real reorder controls on the photos step, not arrows", () => {
    const lines = GUIDE.photos.todo.join(" ");
    expect(lines).not.toMatch(/arrow/i);
    for (const control of ['"Up"', '"Down"', '"Remove"']) expect(lines).toContain(control);
  });

  it("catches each banned thing", () => {
    for (const bad of ["the package is ready", "An event", "Attestation", "well \u2014 no", "Great!", "Done \u{1F389}"]) {
      expect(bad, bad).toMatch(BANNED);
    }
    expect("The wedding is ready to send.").not.toMatch(BANNED);
  });
});
