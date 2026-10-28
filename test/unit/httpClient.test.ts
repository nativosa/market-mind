import { describe, expect, it } from "vitest";
import { createHttpClient, parseRetryAfter } from "../../src/adapters/polymarket/httpClient.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { fakeFetch, json, TEST_HTTP_OPTIONS, testDeps, timeoutError } from "../helpers.js";

const URL_ = "https://api.example/markets/keyset?limit=1";

async function failure(promise: Promise<unknown>): Promise<MarketMindError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MarketMindError);
  return error as MarketMindError;
}

describe("httpClient", () => {
  it("returns parsed JSON with full provenance and per-request timing", async () => {
    const { fetch, calls } = fakeFetch({ "api.example": json({ ok: 1 }) });
    const { deps } = testDeps(fetch);
    const res = await createHttpClient(TEST_HTTP_OPTIONS, deps).getJson("gamma", "/markets/keyset", URL_);

    expect(res.body).toEqual({ ok: 1 });
    expect(res.provenance).toEqual({
      source: "gamma",
      endpoint: "/markets/keyset",
      url: URL_,
      httpStatus: 200,
      timing: {
        firstAttemptStartedAt: "2026-10-28T21:05:12.000Z",
        finalAttemptStartedAt: "2026-10-28T21:05:12.000Z",
        responseReceivedAt: "2026-10-28T21:05:12.010Z",
        durationMs: 10,
        attempts: 1,
        serverDateHeader: "Wed, 28 Oct 2026 21:05:12 GMT",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
  });

  it("records a null Date header when the server sends none", async () => {
    const { fetch } = fakeFetch({ "api.example": new Response("{}", { status: 200 }) });
    const res = await createHttpClient(TEST_HTTP_OPTIONS, testDeps(fetch).deps).getJson("clob", "/x", URL_);
    expect(res.provenance.timing.serverDateHeader).toBeNull();
  });

  it("retries timeouts a bounded number of times, then fails with Timeout", async () => {
    const { fetch, calls } = fakeFetch({ "api.example": timeoutError() });
    const { deps, sleeps } = testDeps(fetch);
    const error = await failure(createHttpClient(TEST_HTTP_OPTIONS, deps).getJson("gamma", "/x", URL_));
    expect(error.kind).toBe("Timeout");
    expect(calls).toHaveLength(1 + TEST_HTTP_OPTIONS.maxRetries);
    expect(error.details.attempts).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("treats other fetch failures as Network errors", async () => {
    const { fetch, calls } = fakeFetch({ "api.example": new TypeError("fetch failed") });
    const error = await failure(createHttpClient({ ...TEST_HTTP_OPTIONS, maxRetries: 0 }, testDeps(fetch).deps).getJson("gamma", "/x", URL_));
    expect(error.kind).toBe("Network");
    expect(error.message).toContain("fetch failed");
    expect(calls).toHaveLength(1);
  });

  it("recovers when a retry succeeds and records attempts and both start times", async () => {
    const { fetch, calls } = fakeFetch({ "api.example": [json({ e: 1 }, 503), json({ ok: true })] });
    const { deps, sleeps } = testDeps(fetch);
    const res = await createHttpClient(TEST_HTTP_OPTIONS, deps).getJson("clob", "/book", URL_);
    expect(res.body).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([100]);
    const t = res.provenance.timing;
    expect(t.attempts).toBe(2);
    expect(t.firstAttemptStartedAt).toBe("2026-10-28T21:05:12.000Z");
    expect(t.finalAttemptStartedAt).toBe("2026-10-28T21:05:12.020Z");
    expect(t.responseReceivedAt).toBe("2026-10-28T21:05:12.030Z");
    expect(t.durationMs).toBe(10);
  });

  it.each([500, 502, 503])("retries HTTP %i and fails with Upstream5xx", async (status) => {
    const { fetch, calls } = fakeFetch({ "api.example": json({ error: "boom" }, status) });
    const error = await failure(createHttpClient(TEST_HTTP_OPTIONS, testDeps(fetch).deps).getJson("clob", "/x", URL_));
    expect(error.kind).toBe("Upstream5xx");
    expect(error.details.status).toBe(status);
    expect(error.message).toContain("boom");
    expect(calls).toHaveLength(3);
  });

  it("honours Retry-After on 429 (capped)", async () => {
    const { fetch, calls } = fakeFetch({ "api.example": json({}, 429, { "retry-after": "60" }) });
    const { deps, sleeps } = testDeps(fetch);
    const error = await failure(createHttpClient(TEST_HTTP_OPTIONS, deps).getJson("clob", "/x", URL_));
    expect(error.kind).toBe("RateLimited");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("falls back to exponential backoff on 429 without Retry-After", async () => {
    const { fetch } = fakeFetch({ "api.example": [json({}, 429), json({}, 429), json({ ok: 1 })] });
    const { deps, sleeps } = testDeps(fetch);
    await createHttpClient(TEST_HTTP_OPTIONS, deps).getJson("clob", "/x", URL_);
    expect(sleeps).toEqual([100, 200]);
  });

  it.each([
    [400, "HttpStatus"],
    [404, "NotFound"],
    [422, "HttpStatus"],
  ] as const)("does not retry HTTP %i", async (status, kind) => {
    const { fetch, calls } = fakeFetch({ "api.example": json({ error: "nope" }, status) });
    const { deps, sleeps } = testDeps(fetch);
    const error = await failure(createHttpClient(TEST_HTTP_OPTIONS, deps).getJson("clob", "/x", URL_));
    expect(error.kind).toBe(kind);
    expect(error.details.status).toBe(status);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("reports a non-JSON success body as a Validation error without retrying", async () => {
    const { fetch, calls } = fakeFetch({ "api.example": new Response("<html>oops</html>", { status: 200 }) });
    const error = await failure(createHttpClient(TEST_HTTP_OPTIONS, testDeps(fetch).deps).getJson("gamma", "/x", URL_));
    expect(error.kind).toBe("Validation");
    expect(calls).toHaveLength(1);
  });

  it("includes non-JSON error bodies in the message, truncated", async () => {
    const { fetch } = fakeFetch({ "api.example": new Response("x".repeat(500), { status: 400 }) });
    const error = await failure(createHttpClient(TEST_HTTP_OPTIONS, testDeps(fetch).deps).getJson("gamma", "/x", URL_));
    expect(error.message.length).toBeLessThan(260);
  });
});

describe("parseRetryAfter", () => {
  it.each([
    [null, null],
    ["", null],
    ["abc", null],
    ["Wed, 21 Oct 2015 07:28:00 GMT", null],
    ["1", 1000],
    [" 3 ", 3000],
    ["999", 5000],
  ] as const)("%j -> %j", (header, expected) => {
    expect(parseRetryAfter(header, 5000)).toBe(expected);
  });
});
