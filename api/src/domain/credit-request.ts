/** Credit recovery vocabulary - design doc sections 5 and 7.5. */

export const CREDIT_REQUEST_STATUSES = [
  "draft",
  "sent",
  "granted",
  "declined",
  "no_response",
] as const;

export type CreditRequestStatus = (typeof CREDIT_REQUEST_STATUSES)[number];
