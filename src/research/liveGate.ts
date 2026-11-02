import { z } from "zod";
import type { FetchFn, HttpDeps } from "../adapters/polymarket/httpClient.js";
import { createRequestBudget, type RequestBudget } from "../adapters/polymarket/requestBudget.js";
import { MarketMindError, isMarketMindError } from "../domain/errors.js";
import { WEB_LIMITS } from "./contracts.js";

export interface LiveUsage {
  /** Physical HTTP attempts made by this call (retries and failures included). */
  used: number;
  limit: number;
}

export interface ProcessUsage {
  limit: number;
  used: number;
  remaining: number;
}

/** Attempts made within the trailing window, plus those reserved by the running call. */
export interface WindowUsage {
  limit: number;
  windowMs: number;
  used: number;
  remaining: number;
}

export interface RollingWindowLimit {
  /** Most physical HTTP attempts allowed within any trailing `windowMs`. */
  limit: number;
  windowMs: number;
}

export interface LiveGateOptions {
  /** Optional rolling limit on top of the lifetime ceiling. Off unless given (the MCP server never sets it). */
  window?: RollingWindowLimit;
  /** Milliseconds clock for the rolling window; injectable for tests. */
  now?: () => number;
}

export interface LiveGate {
  /**
   * Run one live call: wait for exclusive access (abortable, holding no budget while queued), reserve
   * `maxAttempts` from the process ceiling, and hand `fn` HTTP deps whose fetch counts and charges
   * every physical attempt. Unused units return to the ceiling in `finally`; after an unexpected
   * (non-MarketMind) failure the whole reservation is charged, because usage may be unknown.
   */
  run<T>(maxAttempts: number, signal: AbortSignal, fn: (http: HttpDeps, usage: LiveUsage) => Promise<T>): Promise<T>;
  readonly process: ProcessUsage;
  /** Null when no rolling window is configured. */
  readonly window: WindowUsage | null;
}

const cancelled = (signal: AbortSignal) =>
  new MarketMindError("Cancelled", "Cancelled before any request was sent", { code: "CANCELLED_WHILE_QUEUED", attempts: 0, issues: [String(signal.reason)] });

/** Resolves when `gate` settles, or rejects as soon as `signal` aborts. */
function waitFor(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void gate.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * Rolling-window accounting. A call reserves its whole `maxAttempts` before its first request; each
 * physical attempt then turns one reserved unit into a timestamped charge, and the call's unused units
 * are released when it settles. Invariant: charges within the window + reserved <= limit.
 */
function createRollingWindow({ limit, windowMs }: RollingWindowLimit, now: () => number) {
  const charged: number[] = []; // attempt instants, oldest first
  let reserved = 0;
  const prune = (t: number) => {
    while (charged.length > 0 && charged[0]! + windowMs <= t) charged.shift();
  };
  return {
    usage(): WindowUsage {
      prune(now());
      return { limit, windowMs, used: charged.length, remaining: limit - charged.length - reserved };
    },
    /** Reserve `n` units, or return how long until they could fit (null: never, `n` exceeds the limit). */
    reserve(n: number): { ok: true } | { ok: false; retryAfterMs: number | null } {
      const t = now();
      prune(t);
      const free = limit - charged.length - reserved;
      if (n <= free) {
        reserved += n;
        return { ok: true };
      }
      if (n > limit - reserved) return { ok: false, retryAfterMs: null };
      // The (n - free) oldest charges must expire first.
      return { ok: false, retryAfterMs: charged[n - free - 1]! + windowMs - t };
    },
    charge() {
      reserved--;
      charged.push(now());
    },
    release(n: number) {
      reserved -= n;
    },
  };
}

export function createLiveGate(http: HttpDeps, processLimit: number, options: LiveGateOptions = {}): LiveGate {
  const ceiling: RequestBudget = createRequestBudget(processLimit);
  const window = options.window ? createRollingWindow(options.window, options.now ?? Date.now) : null;
  // Each caller's gate is "everyone before me has finished": a cancelled waiter releases its own
  // slot at once, but the next waiter still waits for the call that is actually running.
  let tail: Promise<void> = Promise.resolve();

  return {
    get process() {
      return { limit: ceiling.limit, used: ceiling.used, remaining: ceiling.limit - ceiling.used - ceiling.reserved };
    },
    get window() {
      return window ? window.usage() : null;
    },
    async run(maxAttempts, signal, fn) {
      const before = tail;
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      tail = before.then(() => mine);
      try {
        await waitFor(before, signal);
        const reservation = ceiling.reserve(maxAttempts);
        if (reservation === null) {
          const remaining = ceiling.limit - ceiling.used - ceiling.reserved;
          throw new MarketMindError("BudgetExceeded", `The server's live request ceiling cannot cover this call (${maxAttempts} needed, ${remaining} left)`, {
            code: "PROCESS_BUDGET_EXHAUSTED",
            attempts: 0,
          });
        }
        const admitted = window ? window.reserve(maxAttempts) : { ok: true as const };
        if (!admitted.ok) {
          reservation.release();
          const wait = admitted.retryAfterMs === null ? "" : `; retry in ${Math.ceil(admitted.retryAfterMs / 1000)} s`;
          throw new MarketMindError("BudgetExceeded", `The rolling live request limit cannot cover this call (${maxAttempts} needed)${wait}`, {
            code: "WINDOW_BUDGET_EXHAUSTED",
            attempts: 0,
            ...(admitted.retryAfterMs === null ? {} : { retryAfterMs: admitted.retryAfterMs }),
          });
        }
        const usage: LiveUsage = { used: 0, limit: maxAttempts };
        // A Reservation falls back to the shared pool once empty; a live call must never do that,
        // so every grant is taken strictly from this call's own reserved units.
        const take = () => {
          if (reservation.remaining <= 0 || !reservation.tryAcquire()) return false;
          window?.charge();
          return true;
        };
        const fetch: FetchFn = (url, init) => {
          // Unreachable by construction (per-call budgets never exceed the reservation); fail closed.
          if (!take()) return Promise.reject(new MarketMindError("BudgetExceeded", "Live request reservation exhausted", { code: "RESERVATION_EXHAUSTED" }));
          usage.used++;
          return http.fetch(url, init);
        };
        try {
          return await fn({ ...http, fetch }, usage);
        } catch (error) {
          if (!isMarketMindError(error)) while (take()) usage.used++;
          throw error;
        } finally {
          reservation.release();
          window?.release(maxAttempts - usage.used);
        }
      } finally {
        release();
      }
    },
  };
}

/** Web server budget from the environment: lifetime ceiling and rolling window, each overridable. */
export function webGateSettings(env: Record<string, string | undefined>): { processLimit: number; window: RollingWindowLimit } {
  const L = WEB_LIMITS;
  const read = (name: string, fallback: number, max: number) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const parsed = z.coerce.number().int().min(1).max(max).safeParse(raw);
    if (!parsed.success) throw new MarketMindError("Usage", `Invalid ${name}`, { issues: [`must be an integer from 1 to ${max}`] });
    return parsed.data;
  };
  const processLimit = read("MARKETMIND_WEB_MAX_REQUESTS", L.processRequests.default, L.processRequests.max);
  const limit = read("MARKETMIND_WEB_WINDOW_REQUESTS", L.window.requests.default, L.window.requests.max);
  // A window smaller than the largest call would refuse every inspection forever.
  if (limit < L.inspect.maxAttempts) {
    throw new MarketMindError("Usage", "Invalid MARKETMIND_WEB_WINDOW_REQUESTS", { issues: [`must be at least ${L.inspect.maxAttempts}, the attempts one inspection may need`] });
  }
  return { processLimit, window: { limit, windowMs: L.window.windowMs } };
}

export interface CooldownGate extends LiveGate {
  /** Milliseconds until live calls are allowed again after an upstream 429; 0 when not cooling down. */
  readonly cooldownRemainingMs: number;
}

/**
 * Wrap a gate so that an upstream rate limit (HTTP 429) starts a local cooldown: until it ends, every
 * live call is refused with RateLimited/LOCAL_COOLDOWN before any request is sent, including calls
 * that were already queued when the 429 arrived. Refusals charge nothing. Used by the web server only.
 */
export function withRateLimitCooldown(gate: LiveGate, cooldownMs: number, now: () => number = Date.now): CooldownGate {
  let until = 0;
  const remaining = () => Math.max(0, until - now());
  const refuseIfCooling = () => {
    const left = remaining();
    if (left > 0) {
      throw new MarketMindError("RateLimited", `Polymarket rate-limited an earlier request; live requests pause for ${Math.ceil(left / 1000)} s`, {
        code: "LOCAL_COOLDOWN",
        attempts: 0,
        retryAfterMs: left,
      });
    }
  };
  return {
    get process() {
      return gate.process;
    },
    get window() {
      return gate.window;
    },
    get cooldownRemainingMs() {
      return remaining();
    },
    async run(maxAttempts, signal, fn) {
      refuseIfCooling();
      return gate.run(maxAttempts, signal, async (http, usage) => {
        refuseIfCooling(); // a 429 may have arrived while this call was queued
        try {
          return await fn(http, usage);
        } catch (error) {
          if (isMarketMindError(error) && error.kind === "RateLimited") {
            until = now() + cooldownMs;
            throw new MarketMindError("RateLimited", error.message, { ...error.details, retryAfterMs: cooldownMs });
          }
          throw error;
        }
      });
    },
  };
}
