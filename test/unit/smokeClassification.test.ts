import { describe, expect, it } from "vitest";
import { MarketMindError, type ErrorKind } from "../../src/domain/errors.js";
import { classifySmokeError, isCandidateUnavailable } from "../../test-live/classification.js";

// Offline guard for the live smoke test's PASS/SKIP/FAIL rules: our own bad requests
// (400, 422, other 4xx) must never be reported as "upstream unavailable".

const err = (kind: ErrorKind, status?: number) =>
  new MarketMindError(kind, `synthetic ${kind}`, status !== undefined ? { status } : {});

describe("classifySmokeError", () => {
  it.each<[string, MarketMindError]>([
    ["timeout", err("Timeout")],
    ["network error", err("Network")],
    ["HTTP 429", err("RateLimited", 429)],
    ["HTTP 500", err("Upstream5xx", 500)],
    ["HTTP 503", err("Upstream5xx", 503)],
  ])("%s -> SKIP UPSTREAM_UNAVAILABLE", (_name, error) => {
    expect(classifySmokeError(error, "step", false)).toMatchObject({ status: "SKIP", reason: "UPSTREAM_UNAVAILABLE" });
  });

  it.each<[string, MarketMindError]>([
    ["HTTP 400", err("HttpStatus", 400)],
    ["HTTP 422", err("HttpStatus", 422)],
    ["HTTP 403", err("HttpStatus", 403)],
    ["HTTP 404 outside candidate inspection", err("NotFound", 404)],
    ["schema validation", err("Validation")],
    ["outcome association mismatch", err("AssociationMismatch")],
    ["invalid book", err("InvalidBook")],
  ])("%s -> FAIL", (_name, error) => {
    const outcome = classifySmokeError(error, "step", false);
    expect(outcome.status).toBe("FAIL");
  });

  it("HTTP 400/422 FAIL details name the status", () => {
    expect(classifySmokeError(err("HttpStatus", 400), "discovery page 1", false)).toEqual({
      status: "FAIL",
      detail: "discovery page 1: [HttpStatus] synthetic HttpStatus (HTTP 400) []",
    });
    expect(classifySmokeError(err("HttpStatus", 422), "inspect 1", false).status).toBe("FAIL");
  });

  it("budget exhaustion FAILs even though it surfaces as a network error", () => {
    expect(classifySmokeError(err("Network"), "inspect 1", true)).toEqual({
      status: "FAIL",
      detail: "request budget exceeded during inspect 1",
    });
  });

  it("non-domain errors FAIL", () => {
    expect(classifySmokeError(new Error("bug"), "step", false)).toEqual({ status: "FAIL", detail: "step: Error: bug" });
  });
});

describe("isCandidateUnavailable", () => {
  it("only NotFound (book-level 404) and Ineligible move on to the next candidate", () => {
    expect(isCandidateUnavailable(err("NotFound", 404))).toBe(true);
    expect(isCandidateUnavailable(err("Ineligible"))).toBe(true);
    for (const kind of ["HttpStatus", "Validation", "AssociationMismatch", "Timeout", "Upstream5xx"] as const) {
      expect(isCandidateUnavailable(err(kind, 422))).toBe(false);
    }
    expect(isCandidateUnavailable(new Error("x"))).toBe(false);
  });
});
