/**
 * Typed error codes -- design doc section 9. The SPA renders the reason and,
 * where there is one, the unblock path.
 */

import type { Context } from "hono";

export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "INVALID_CREDENTIALS"
  | "NOT_FOUND"
  | "RIGHTS_BLOCKED"
  | "EXCLUSIVITY_LOCKED"
  | "SPEC_UNVERIFIED"
  | "IMAGE_IN_USE"
  | "PACKAGE_INCOMPLETE"
  | "SUBMISSION_EXISTS"
  | "ILLEGAL_TRANSITION"
  | "EVENT_HAS_LIVE_SUBMISSION"
  | "FORBIDDEN"
  | "RESEARCH_VOCAB_MISSING"
  | "TAG_EXISTS"
  | "PHOTO_ANALYSIS_OFF"
  | "ANALYSIS_UNAVAILABLE"
  | "NO_PHOTOS"
  | "ANALYSIS_LIMIT"
  | "ANALYSIS_FAILED"
  | "INTERNAL";

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

type StatusFor = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;

export function fail(
  c: Context,
  status: StatusFor,
  code: ErrorCode,
  message: string,
  details?: unknown,
) {
  const body: ErrorBody = details === undefined ? { code, message } : { code, message, details };
  return c.json(body, status);
}
