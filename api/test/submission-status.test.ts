import { describe, expect, it } from "vitest";

import {
  SUBMISSION_STATUSES,
  TERMINAL_STATUSES,
  allowedTransitions,
  canTransition,
  evaluateTransition,
  isTerminal,
  releasesEvent,
} from "../src/domain/submission-status.js";
import type { SubmissionStatus } from "../src/domain/submission-status.js";

/**
 * The design doc's lifecycle diagram (section 6.2), transcribed as data.
 * Every pair not listed here must be rejected.
 */
const EXPECTED_EDGES: ReadonlyArray<readonly [SubmissionStatus, SubmissionStatus]> = [
  ["draft", "ready"],
  ["draft", "cancelled"],
  ["ready", "queued"],
  ["ready", "cancelled"],
  ["queued", "sent"],
  ["queued", "cancelled"],
  ["sent", "accepted"],
  ["sent", "declined"],
  ["sent", "expired"],
  ["accepted", "published"],
  ["expired", "withdraw_pending"],
  ["withdraw_pending", "withdrawn"],
];

const edgeKey = (from: SubmissionStatus, to: SubmissionStatus) => `${from}->${to}`;
const expectedSet = new Set(EXPECTED_EDGES.map(([from, to]) => edgeKey(from, to)));

describe("submission status vocabulary", () => {
  it("exports the eleven statuses from the design doc", () => {
    expect(SUBMISSION_STATUSES).toEqual([
      "draft",
      "ready",
      "queued",
      "sent",
      "accepted",
      "published",
      "declined",
      "expired",
      "withdraw_pending",
      "withdrawn",
      "cancelled",
    ]);
  });
});

describe("canTransition", () => {
  for (const from of SUBMISSION_STATUSES) {
    for (const to of SUBMISSION_STATUSES) {
      const expected = expectedSet.has(edgeKey(from, to));
      it(`${expected ? "allows" : "rejects"} ${from} -> ${to}`, () => {
        expect(canTransition(from, to)).toBe(expected);
      });
    }
  }

  it("rejects every self-transition", () => {
    for (const status of SUBMISSION_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it("never allows a transition back into draft", () => {
    for (const from of SUBMISSION_STATUSES) {
      expect(canTransition(from, "draft")).toBe(false);
    }
  });

  it("never allows a send to be undone without the withdrawal path", () => {
    for (const to of ["draft", "ready", "queued", "cancelled"] as const) {
      expect(canTransition("sent", to)).toBe(false);
    }
  });

  it("never allows cancellation after send", () => {
    for (const from of ["sent", "accepted", "published", "declined", "expired"] as const) {
      expect(canTransition(from, "cancelled")).toBe(false);
    }
  });
});

describe("allowedTransitions", () => {
  it("lists the outbound edges for a mid-lifecycle status", () => {
    expect(allowedTransitions("sent")).toEqual(["accepted", "declined", "expired"]);
  });

  it("returns an empty list for terminal statuses", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(allowedTransitions(status)).toEqual([]);
    }
  });

  it("agrees with canTransition for every status", () => {
    for (const from of SUBMISSION_STATUSES) {
      for (const to of SUBMISSION_STATUSES) {
        expect(allowedTransitions(from).includes(to)).toBe(canTransition(from, to));
      }
    }
  });
});

describe("isTerminal", () => {
  it("marks published, declined, withdrawn, and cancelled as terminal", () => {
    expect(TERMINAL_STATUSES).toEqual(["published", "declined", "withdrawn", "cancelled"]);
  });

  it("agrees with the absence of outbound edges", () => {
    for (const status of SUBMISSION_STATUSES) {
      expect(isTerminal(status)).toBe(allowedTransitions(status).length === 0);
    }
  });

  it("does not treat expired as terminal, because it still owes a withdrawal", () => {
    expect(isTerminal("expired")).toBe(false);
  });

  it("does not treat accepted as terminal, because publication still follows", () => {
    expect(isTerminal("accepted")).toBe(false);
  });
});

describe("releasesEvent", () => {
  it("releases the event on declined, withdrawn, and cancelled", () => {
    expect(releasesEvent("declined")).toBe(true);
    expect(releasesEvent("withdrawn")).toBe(true);
    expect(releasesEvent("cancelled")).toBe(true);
  });

  it("does not release while the outlet still holds the submission", () => {
    for (const status of ["sent", "expired", "withdraw_pending"] as const) {
      expect(releasesEvent(status)).toBe(false);
    }
  });

  it("does not release on a win", () => {
    expect(releasesEvent("accepted")).toBe(false);
    expect(releasesEvent("published")).toBe(false);
  });
});

describe("evaluateTransition", () => {
  it("accepts a legal transition", () => {
    expect(evaluateTransition("queued", "sent")).toEqual({ ok: true });
  });

  it("rejects an illegal transition with the legal alternatives", () => {
    expect(evaluateTransition("draft", "sent")).toEqual({
      ok: false,
      code: "INVALID_TRANSITION",
      from: "draft",
      to: "sent",
      allowed: ["ready", "cancelled"],
    });
  });

  it("rejects any transition out of a terminal status", () => {
    expect(evaluateTransition("withdrawn", "ready")).toEqual({
      ok: false,
      code: "INVALID_TRANSITION",
      from: "withdrawn",
      to: "ready",
      allowed: [],
    });
  });
});
