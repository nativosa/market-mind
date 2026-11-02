import { describe, expect, it } from "vitest";
import type { FetchFn } from "../../src/adapters/polymarket/httpClient.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { WEB_LIMITS } from "../../src/research/contracts.js";
import { describeError } from "../../src/research/envelope.js";
import { createLiveGate, webGateSettings, type LiveGate } from "../../src/research/liveGate.js";
import { json, testDeps } from "../helpers.js";

// Stage 3.1: the web server's rolling window on top of the lifetime ceiling. Every test drives the
// window with an injected clock, so nothing here depends on real time.

const WINDOW = { limit: 20, windowMs: 300_000 };

function setup(processLimit = 100, window = WINDOW) {
  let t = 1_000_000;
  const urls: string[] = [];
  const fetch: FetchFn = (url) => {
    urls.push(url);
    return Promise.resolve(json({}));
  };
  const gate = createLiveGate(testDeps(fetch).deps, processLimit, { window, now: () => t });
  return { gate, urls, advance: (ms: number) => (t += ms) };
}

/** A call that makes `n` physical attempts through the gate. */
const attempts = (gate: LiveGate, reserve: number, n: number, signal = new AbortController().signal) =>
  gate.run(reserve, signal, async (http, usage) => {
    for (let i = 0; i < n; i++) await http.fetch(`https://gamma.example/${i}`, {});
    return usage.used;
  });

const never: FetchFn = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new MarketMindError("Cancelled", "aborted")));
  });

describe("rolling window", () => {
  it("is off unless configured: window is null and only the lifetime ceiling applies", async () => {
    const gate = createLiveGate(testDeps(() => Promise.resolve(json({}))).deps, 50);
    expect(gate.window).toBeNull();
    for (let i = 0; i < 6; i++) await attempts(gate, 8, 8);
    expect(gate.process).toEqual({ limit: 50, used: 48, remaining: 2 });
  });

  it("charges actual attempts and returns the unused reservation to both limits", async () => {
    const { gate } = setup();
    expect(await attempts(gate, 8, 3)).toBe(3);
    expect(gate.window).toEqual({ limit: 20, windowMs: 300_000, used: 3, remaining: 17 });
    expect(gate.process).toEqual({ limit: 100, used: 3, remaining: 97 });
  });

  it("holds the whole reservation while a call runs", async () => {
    const { gate } = setup();
    let seen = null as ReturnType<() => LiveGate["window"]>;
    await gate.run(8, new AbortController().signal, async (http) => {
      await http.fetch("https://gamma.example/a", {});
      seen = gate.window;
    });
    expect(seen).toEqual({ limit: 20, windowMs: 300_000, used: 1, remaining: 12 });
    expect(gate.window!.remaining).toBe(19);
  });

  it("counts failed attempts and retries", async () => {
    const { gate } = setup();
    await expect(
      gate.run(8, new AbortController().signal, async (http) => {
        await http.fetch("https://gamma.example/a", {});
        await http.fetch("https://gamma.example/a", {});
        throw new MarketMindError("Upstream5xx", "down", { attempts: 2 });
      }),
    ).rejects.toMatchObject({ kind: "Upstream5xx" });
    expect(gate.window).toMatchObject({ used: 2, remaining: 18 });
    expect(gate.process.used).toBe(2);
  });

  it("refuses a call that does not fit before any request, with an exact retry time, and releases the ceiling reservation", async () => {
    const { gate, urls, advance } = setup();
    await attempts(gate, 8, 8); // charged at t0
    advance(60_000);
    await attempts(gate, 8, 8); // charged at t0 + 60 s
    advance(30_000);
    const before = urls.length;
    const refused = attempts(gate, 8, 8);
    await expect(refused).rejects.toMatchObject({
      kind: "BudgetExceeded",
      details: { code: "WINDOW_BUDGET_EXHAUSTED", attempts: 0, retryAfterMs: 210_000 },
    });
    expect(urls.length).toBe(before);
    expect(gate.process).toEqual({ limit: 100, used: 16, remaining: 84 });
    expect(gate.window).toMatchObject({ used: 16, remaining: 4 });
    // Exactly when the first eight charges expire, the call fits again.
    advance(209_999);
    await expect(attempts(gate, 8, 0)).rejects.toMatchObject({ details: { retryAfterMs: 1 } });
    advance(1);
    expect(await attempts(gate, 8, 8)).toBe(8);
    expect(gate.window).toMatchObject({ used: 16, remaining: 4 });
  });

  it("reports budget_exhausted as retryable with retryAfterMs; the lifetime ceiling stays non-retryable", async () => {
    const { gate } = setup(100, { limit: 10, windowMs: 300_000 });
    await attempts(gate, 8, 8);
    const windowError = await attempts(gate, 8, 0).catch((e: unknown) => e);
    expect(describeError(windowError)).toMatchObject({ category: "budget_exhausted", code: "WINDOW_BUDGET_EXHAUSTED", retryable: true, details: { attempts: 0, retryAfterMs: 300_000 } });

    const lifetime = setup(10);
    await attempts(lifetime.gate, 8, 8);
    const ceilingError = await attempts(lifetime.gate, 8, 0).catch((e: unknown) => e);
    expect(describeError(ceilingError)).toMatchObject({ category: "budget_exhausted", code: "PROCESS_BUDGET_EXHAUSTED", retryable: false, details: { attempts: 0 } });
  });

  it("a call larger than the whole window is refused without a retry time", async () => {
    const { gate } = setup(100, { limit: 4, windowMs: 1_000 });
    const error = await attempts(gate, 8, 0).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "BudgetExceeded", details: { code: "WINDOW_BUDGET_EXHAUSTED" } });
    expect((error as MarketMindError).details).not.toHaveProperty("retryAfterMs");
    expect(describeError(error).retryable).toBe(false);
  });

  it("concurrent calls never overspend: refused calls send nothing", async () => {
    const { gate, urls } = setup(1_000, { limit: 20, windowMs: 300_000 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => attempts(gate, 8, 8)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r.reason as MarketMindError).details.code === "WINDOW_BUDGET_EXHAUSTED")).toBe(true);
    expect(urls).toHaveLength(16);
    expect(gate.window).toMatchObject({ used: 16, remaining: 4 });
  });

  it("cancellation in flight charges the attempts made and releases the rest", async () => {
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const fetch: FetchFn = (url, init) => {
      started();
      return never(url, init);
    };
    const gate = createLiveGate(testDeps(fetch).deps, 100, { window: WINDOW, now: () => 0 });
    const user = new AbortController();
    const pending = gate.run(8, user.signal, (http) => http.fetch("https://gamma.example/a", { signal: user.signal }));
    await inFlight;
    expect(gate.window).toMatchObject({ used: 1, remaining: 12 });
    user.abort(new Error("user"));
    await expect(pending).rejects.toMatchObject({ kind: "Cancelled" });
    expect(gate.window).toMatchObject({ used: 1, remaining: 19 });
    expect(gate.process).toEqual({ limit: 100, used: 1, remaining: 99 });
  });

  it("a call cancelled while queued holds nothing in the window", async () => {
    const { gate } = setup();
    let finish!: () => void;
    const first = gate.run(8, new AbortController().signal, () => new Promise<void>((r) => (finish = r)));
    const queued = new AbortController();
    const second = attempts(gate, 8, 8, queued.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.window!.remaining).toBe(12);
    queued.abort(new Error("changed my mind"));
    await expect(second).rejects.toMatchObject({ details: { code: "CANCELLED_WHILE_QUEUED" } });
    finish();
    await first;
    expect(gate.window).toMatchObject({ used: 0, remaining: 20 });
  });

  it("an unexpected failure charges the whole reservation to the window too", async () => {
    const { gate } = setup();
    await expect(gate.run(8, new AbortController().signal, () => Promise.reject(new TypeError("bug")))).rejects.toThrow("bug");
    expect(gate.window).toMatchObject({ used: 8, remaining: 12 });
    expect(gate.process.used).toBe(8);
  });

  it("an attempt beyond the reservation fails closed and charges nothing", async () => {
    const { gate } = setup();
    await expect(attempts(gate, 1, 2)).rejects.toMatchObject({ details: { code: "RESERVATION_EXHAUSTED" } });
    expect(gate.window).toMatchObject({ used: 1, remaining: 19 });
  });

  it("the lifetime ceiling still refuses first when it is the tighter limit", async () => {
    const { gate, urls } = setup(10);
    await attempts(gate, 8, 8);
    await expect(attempts(gate, 8, 0)).rejects.toMatchObject({ details: { code: "PROCESS_BUDGET_EXHAUSTED" } });
    expect(urls).toHaveLength(8);
    expect(gate.window).toMatchObject({ used: 8, remaining: 12 });
  });
});

describe("webGateSettings", () => {
  it("defaults to 2,000 lifetime attempts and 60 attempts per five minutes", () => {
    expect(webGateSettings({})).toEqual({ processLimit: 2_000, window: { limit: 60, windowMs: 300_000 } });
    expect(WEB_LIMITS.list.maxAttempts).toBe(2);
    expect(WEB_LIMITS.inspect.maxAttempts).toBe(8);
  });

  it("accepts overrides and rejects invalid values", () => {
    expect(webGateSettings({ MARKETMIND_WEB_MAX_REQUESTS: "500", MARKETMIND_WEB_WINDOW_REQUESTS: "30" })).toEqual({ processLimit: 500, window: { limit: 30, windowMs: 300_000 } });
    for (const bad of ["0", "20001", "abc", "1.5"]) expect(() => webGateSettings({ MARKETMIND_WEB_MAX_REQUESTS: bad })).toThrow(/MARKETMIND_WEB_MAX_REQUESTS/);
    for (const bad of ["0", "601", "x"]) expect(() => webGateSettings({ MARKETMIND_WEB_WINDOW_REQUESTS: bad })).toThrow(/MARKETMIND_WEB_WINDOW_REQUESTS/);
  });

  it("refuses a window too small for one inspection", () => {
    expect(() => webGateSettings({ MARKETMIND_WEB_WINDOW_REQUESTS: "7" })).toThrow(/WINDOW_REQUESTS/);
    expect(webGateSettings({ MARKETMIND_WEB_WINDOW_REQUESTS: "8" }).window.limit).toBe(8);
  });
});
