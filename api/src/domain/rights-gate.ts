/**
 * Rights gate — design doc section 6.1.
 *
 * Packaging is blocked unless the photographer held the contract AND the couple
 * consented. Second-shooter weddings never enter the submission flow at all;
 * they are routed to credit recovery (design doc section 7.5).
 *
 * This module is pure. The API layer is the only enforcement point that matters
 * (the SPA is untrusted), but the rules live here so they are testable without
 * a database.
 */

export const RIGHTS_STATUSES = [
  "unverified",
  "own_contract",
  "second_shooter",
  "blocked",
] as const;

export const CONSENT_STATUSES = [
  "unverified",
  "granted",
  "granted_limited",
  "declined",
] as const;

export type RightsStatus = (typeof RIGHTS_STATUSES)[number];
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export type RightsGateReasonCode =
  | "RIGHTS_UNVERIFIED"
  | "RIGHTS_SECOND_SHOOTER"
  | "RIGHTS_BLOCKED_FLAG"
  | "CONSENT_UNVERIFIED"
  | "CONSENT_DECLINED";

/** Where a blocked wedding can still go, if anywhere. */
export type RightsGateRoute = "submission" | "credit_recovery" | "none";

export interface RightsGateReason {
  code: RightsGateReasonCode;
  field: "rights_status" | "consent_status";
  /** Plain-language unblock path, rendered verbatim by the SPA. */
  remedy: string;
}

export interface RightsGateInput {
  rightsStatus: RightsStatus;
  consentStatus: ConsentStatus;
}

export type RightsGateResult =
  | { allowed: true }
  | {
      allowed: false;
      code: "RIGHTS_BLOCKED";
      route: RightsGateRoute;
      reasons: RightsGateReason[];
    };

const RIGHTS_REASONS: Partial<Record<RightsStatus, RightsGateReason>> = {
  unverified: {
    code: "RIGHTS_UNVERIFIED",
    field: "rights_status",
    remedy:
      "Confirm the photographer was the contracted lead and that the client contract permits editorial submission.",
  },
  second_shooter: {
    code: "RIGHTS_SECOND_SHOOTER",
    field: "rights_status",
    remedy:
      "Second-shooter work cannot be submitted. Log the published feature as a credit request instead.",
  },
  blocked: {
    code: "RIGHTS_BLOCKED_FLAG",
    field: "rights_status",
    remedy:
      "This event is marked blocked. Resolve the underlying rights conflict before changing the status.",
  },
};

const CONSENT_REASONS: Partial<Record<ConsentStatus, RightsGateReason>> = {
  unverified: {
    code: "CONSENT_UNVERIFIED",
    field: "consent_status",
    remedy:
      "Record the couple's written consent to submit, including name display preference and off-limits images.",
  },
  declined: {
    code: "CONSENT_DECLINED",
    field: "consent_status",
    remedy:
      "The couple declined. This event cannot be submitted unless they change their answer in writing.",
  },
};

function routeFor(rightsStatus: RightsStatus): RightsGateRoute {
  switch (rightsStatus) {
    case "second_shooter":
      return "credit_recovery";
    case "blocked":
      return "none";
    case "unverified":
    case "own_contract":
      return "submission";
  }
}

export function evaluateRightsGate(input: RightsGateInput): RightsGateResult {
  const reasons: RightsGateReason[] = [];

  const rightsReason = RIGHTS_REASONS[input.rightsStatus];
  if (rightsReason) reasons.push(rightsReason);

  const consentReason = CONSENT_REASONS[input.consentStatus];
  if (consentReason) reasons.push(consentReason);

  if (reasons.length === 0) return { allowed: true };

  return {
    allowed: false,
    code: "RIGHTS_BLOCKED",
    route: routeFor(input.rightsStatus),
    reasons,
  };
}
