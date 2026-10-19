import { describe, expect, it } from "vitest";

import {
  CONSENT_STATUSES,
  RIGHTS_STATUSES,
  evaluateRightsGate,
} from "../src/domain/rights-gate.js";
import type { ConsentStatus, RightsStatus } from "../src/domain/rights-gate.js";

const gate = (rights: RightsStatus, consent: ConsentStatus) =>
  evaluateRightsGate({ rightsStatus: rights, consentStatus: consent });

const reasonCodes = (rights: RightsStatus, consent: ConsentStatus) => {
  const result = gate(rights, consent);
  if (result.allowed) throw new Error("expected blocked result");
  return result.reasons.map((reason) => reason.code);
};

describe("evaluateRightsGate", () => {
  describe("allows packaging", () => {
    it("allows own_contract + granted", () => {
      expect(gate("own_contract", "granted")).toEqual({ allowed: true });
    });

    it("allows own_contract + granted_limited", () => {
      expect(gate("own_contract", "granted_limited")).toEqual({ allowed: true });
    });
  });

  describe("blocks every other combination", () => {
    const allowed = new Set(["own_contract:granted", "own_contract:granted_limited"]);

    for (const rights of RIGHTS_STATUSES) {
      for (const consent of CONSENT_STATUSES) {
        if (allowed.has(`${rights}:${consent}`)) continue;

        it(`blocks ${rights} + ${consent}`, () => {
          const result = gate(rights, consent);
          expect(result.allowed).toBe(false);
          if (result.allowed) return;
          expect(result.code).toBe("RIGHTS_BLOCKED");
          expect(result.reasons.length).toBeGreaterThan(0);
        });
      }
    }
  });

  describe("routing", () => {
    for (const consent of CONSENT_STATUSES) {
      it(`routes second_shooter + ${consent} to credit_recovery`, () => {
        const result = gate("second_shooter", consent);
        expect(result.allowed).toBe(false);
        if (result.allowed) return;
        expect(result.route).toBe("credit_recovery");
      });
    }

    it("routes a fixable event to the submission flow", () => {
      const result = gate("unverified", "unverified");
      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.route).toBe("submission");
    });

    it("routes a blocked-rights event to neither flow", () => {
      const result = gate("blocked", "granted");
      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.route).toBe("none");
    });
  });

  describe("reasons name exactly what is missing", () => {
    it("reports unverified rights", () => {
      expect(reasonCodes("unverified", "granted")).toEqual(["RIGHTS_UNVERIFIED"]);
    });

    it("reports second-shooter rights", () => {
      expect(reasonCodes("second_shooter", "granted")).toEqual(["RIGHTS_SECOND_SHOOTER"]);
    });

    it("reports explicitly blocked rights", () => {
      expect(reasonCodes("blocked", "granted")).toEqual(["RIGHTS_BLOCKED_FLAG"]);
    });

    it("reports unverified consent", () => {
      expect(reasonCodes("own_contract", "unverified")).toEqual(["CONSENT_UNVERIFIED"]);
    });

    it("reports declined consent", () => {
      expect(reasonCodes("own_contract", "declined")).toEqual(["CONSENT_DECLINED"]);
    });

    it("reports both failures when rights and consent are both missing", () => {
      expect(reasonCodes("unverified", "declined")).toEqual([
        "RIGHTS_UNVERIFIED",
        "CONSENT_DECLINED",
      ]);
    });

    it("attaches the offending field and a remedy to each reason", () => {
      const result = gate("unverified", "declined");
      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.reasons).toEqual([
        {
          code: "RIGHTS_UNVERIFIED",
          field: "rights_status",
          remedy: expect.stringMatching(/\S/),
        },
        {
          code: "CONSENT_DECLINED",
          field: "consent_status",
          remedy: expect.stringMatching(/\S/),
        },
      ]);
    });
  });

  describe("status vocabularies", () => {
    it("exports the four rights statuses from the design doc", () => {
      expect(RIGHTS_STATUSES).toEqual([
        "unverified",
        "own_contract",
        "second_shooter",
        "blocked",
      ]);
    });

    it("exports the four consent statuses from the design doc", () => {
      expect(CONSENT_STATUSES).toEqual([
        "unverified",
        "granted",
        "granted_limited",
        "declined",
      ]);
    });
  });
});
