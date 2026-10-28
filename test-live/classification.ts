import { isMarketMindError, type ErrorKind, type MarketMindError } from "../src/domain/errors.js";

export type SkipReason = "LIVE_DATA_UNAVAILABLE" | "UPSTREAM_UNAVAILABLE";

export type FailureOutcome =
  | { status: "SKIP"; reason: SkipReason; detail: string }
  | { status: "FAIL"; detail: string };

/**
 * Only transient upstream conditions may SKIP: network errors, timeouts, HTTP 429 and 5xx.
 * Generic HTTP statuses (400, 422, other 4xx) usually mean we sent a bad request, so they FAIL,
 * as do validation, association and invalid-book errors.
 */
export const UPSTREAM_UNAVAILABLE_KINDS: readonly ErrorKind[] = ["Timeout", "Network", "RateLimited", "Upstream5xx"];

/** Classify an error raised during a live smoke step. Budget exhaustion always FAILs first. */
export function classifySmokeError(error: unknown, step: string, budgetExceeded: boolean): FailureOutcome {
  if (budgetExceeded) return { status: "FAIL", detail: `request budget exceeded during ${step}` };
  if (isMarketMindError(error) && UPSTREAM_UNAVAILABLE_KINDS.includes(error.kind)) {
    return { status: "SKIP", reason: "UPSTREAM_UNAVAILABLE", detail: `${step}: [${error.kind}] ${error.message}` };
  }
  const detail = isMarketMindError(error)
    ? `${step}: [${error.kind}] ${error.message}${error.details.status !== undefined ? ` (HTTP ${error.details.status})` : ""} ${JSON.stringify(error.details.issues ?? [])}`
    : `${step}: ${String(error)}`;
  return { status: "FAIL", detail };
}

/**
 * During candidate inspection, a missing book (404 NotFound) or a market that turned out to be
 * ineligible is a data-availability problem: move on to the next candidate instead of failing.
 */
export function isCandidateUnavailable(error: unknown): error is MarketMindError {
  return isMarketMindError(error) && (error.kind === "NotFound" || error.kind === "Ineligible");
}
