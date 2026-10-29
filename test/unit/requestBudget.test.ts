import { describe, expect, it } from "vitest";
import { createHttpClient, realHttpDeps, type FetchFn } from "../../src/adapters/polymarket/httpClient.js";
import { createRequestBudget } from "../../src/adapters/polymarket/requestBudget.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { fakeFetch, json, TEST_HTTP_OPTIONS, testDeps } from "../helpers.js";

const URL_ = "https://api.example/x";

async function failure(promise: Promise<unknown>): Promise<MarketMindError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MarketMindError);
  return error as MarketMindError;
}

describe("createRequestBudget", () => {
  it("grants exactly `limit` attempts from the free pool", () => {
    const b = createRequestBudget(3);
    expect([b.tryAcquire(), b.tryAcquire(), b.tryAcquire(), b.tryAcquire()]).toEqual([true, true, true, false]);
    expect(b.used).toBe(3);
  });

  it("reservations are taken first, then the free pool; reserved units are not free", () => {
    const b = createRequestBudget(5);
    const r = b.reserve(3)!;
    expect(b.reserved).toBe(3);
    expect(b.reserve(3)).toBeNull(); // only 2 free
    expect(r.tryAcquire()).toBe(true);
    expect(r.remaining).toBe(2);
    expect(b.used).toBe(1);
    expect(b.reserved).toBe(2);
    // Free pool: 5 - 1 used - 2 reserved = 2.
    expect([b.tryAcquire(), b.tryAcquire(), b.tryAcquire()]).toEqual([true, true, false]);
    // Reservation still holds its own units, then falls back to the (empty) pool.
    expect([r.tryAcquire(), r.tryAcquire(), r.tryAcquire()]).toEqual([true, true, false]);
    expect(b.used).toBe(5);
    expect(b.reserved).toBe(0);
  });

  it("release returns unused units to the pool and is idempotent", () => {
    const b = createRequestBudget(4);
    const r = b.reserve(3)!;
    r.tryAcquire();
    r.release();
    r.release();
    expect(b.reserved).toBe(0);
    expect(r.remaining).toBe(0);
    expect(b.reserve(3)).not.toBeNull();
  });

  it("rejects empty or oversize reservations", () => {
    const b = createRequestBudget(2);
    expect(b.reserve(0)).toBeNull();
    expect(b.reserve(3)).toBeNull();
  });
});

describe("httpClient with a request budget", () => {
  it("counts every attempt, retries included", async () => {
    const { fetch, calls } = fakeFetch({ "api.example": [json({}, 503), json({}, 503), json({ ok: 1 })] });
    const budget = createRequestBudget(10);
    await createHttpClient(TEST_HTTP_OPTIONS, { ...testDeps(fetch).deps, budget }).getJson("clob", "/x", URL_);
    expect(calls).toHaveLength(3);
    expect(budget.used).toBe(3);
  });

  it("refuses a first attempt with a non-retryable BudgetExceeded error and no network call", async () => {
    const { fetch, calls } = fakeFetch({ "api.example": json({}) });
    const budget = createRequestBudget(1);
    budget.tryAcquire();
    const error = await failure(createHttpClient(TEST_HTTP_OPTIONS, { ...testDeps(fetch).deps, budget }).getJson("clob", "/x", URL_));
    expect(error.kind).toBe("BudgetExceeded");
    expect(error.details.attempts).toBe(0);
    expect(error.details.budgetExhausted).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("cancellation takes precedence over an exhausted budget (checked first)", async () => {
    const { fetch, calls } = fakeFetch({ "api.example": json({}) });
    const budget = createRequestBudget(0);
    const controller = new AbortController();
    controller.abort(new Error("user"));
    const error = await failure(
      createHttpClient(TEST_HTTP_OPTIONS, { ...testDeps(fetch).deps, budget, signal: controller.signal }).getJson("clob", "/x", URL_),
    );
    expect(error.kind).toBe("Cancelled");
    expect(calls).toHaveLength(0);
  });

  it("retries drawn by one reservation never consume units reserved by another", async () => {
    const budget = createRequestBudget(6);
    const a = budget.reserve(3)!;
    const b = budget.reserve(3)!;
    // Every attempt fails: A's 3 reserved units are spent, then its retries find an empty free pool.
    const { fetch, calls } = fakeFetch({ "api.example": json({}, 503) });
    const httpA = createHttpClient(TEST_HTTP_OPTIONS, { ...testDeps(fetch).deps, budget: a });
    const results = await Promise.allSettled([httpA.getJson("clob", "/x", URL_), httpA.getJson("clob", "/x", URL_)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(calls).toHaveLength(3);
    expect(b.remaining).toBe(3);
    expect(budget.used).toBe(3);
    expect(budget.reserved).toBe(3);
  });

  it("stops retrying when the budget refuses a retry and rethrows the last real failure", async () => {
    const { fetch, calls } = fakeFetch({ "api.example": json({ error: "down" }, 503) });
    const budget = createRequestBudget(2);
    const error = await failure(createHttpClient(TEST_HTTP_OPTIONS, { ...testDeps(fetch).deps, budget }).getJson("clob", "/x", URL_));
    expect(error.kind).toBe("Upstream5xx");
    expect(error.details.budgetExhausted).toBe(true);
    expect(error.details.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("never exceeds the limit under heavy concurrency", async () => {
    let inFlight = 0;
    let started = 0;
    const fetch: FetchFn = async () => {
      started++;
      inFlight++;
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return json({ ok: 1 });
    };
    const budget = createRequestBudget(10);
    const http = createHttpClient({ ...TEST_HTTP_OPTIONS, maxRetries: 0 }, { ...testDeps(fetch).deps, budget });
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => http.getJson("clob", "/x", URL_)));
    expect(started).toBe(10);
    expect(budget.used).toBe(10);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(inFlight).toBe(0);
  });
});

describe("httpClient with an abort signal", () => {
  it("makes no request when the signal is already aborted", async () => {
    const { fetch, calls } = fakeFetch({ "api.example": json({}) });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const error = await failure(
      createHttpClient(TEST_HTTP_OPTIONS, { ...testDeps(fetch).deps, signal: controller.signal }).getJson("gamma", "/x", URL_),
    );
    expect(error.kind).toBe("Cancelled");
    expect(error.message).toContain("stop");
    expect(calls).toHaveLength(0);
  });

  it("aborts an in-flight request and classifies it as Cancelled, not Timeout", async () => {
    const controller = new AbortController();
    const fetch: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason as Error));
        controller.abort(new DOMException("deadline", "TimeoutError"));
      });
    const { deps, sleeps } = testDeps(fetch);
    const error = await failure(createHttpClient(TEST_HTTP_OPTIONS, { ...deps, signal: controller.signal }).getJson("clob", "/x", URL_));
    expect(error.kind).toBe("Cancelled");
    expect(error.details.attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry after the signal aborts during backoff", async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch({ "api.example": json({}, 503) });
    const deps = {
      ...testDeps(fetch).deps,
      signal: controller.signal,
      sleep: () => {
        controller.abort(new Error("cancel during backoff"));
        return Promise.resolve();
      },
    };
    const error = await failure(createHttpClient(TEST_HTTP_OPTIONS, deps).getJson("clob", "/x", URL_));
    expect(error.kind).toBe("Cancelled");
    expect(calls).toHaveLength(1);
  });

  it("real sleep resolves early on abort and immediately when already aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = realHttpDeps.sleep(60_000, controller.signal);
    controller.abort();
    await pending;
    await realHttpDeps.sleep(60_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
    await realHttpDeps.sleep(1);
  });
});
