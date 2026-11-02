import type { FetchFn, HttpDeps } from "../adapters/polymarket/httpClient.js";
import { createRequestBudget, type RequestBudget } from "../adapters/polymarket/requestBudget.js";
import { MarketMindError, isMarketMindError } from "../domain/errors.js";

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

export interface LiveGate {
  /**
   * Run one live call: wait for exclusive access (abortable, holding no budget while queued), reserve
   * `maxAttempts` from the process ceiling, and hand `fn` HTTP deps whose fetch counts and charges
   * every physical attempt. Unused units return to the ceiling in `finally`; after an unexpected
   * (non-MarketMind) failure the whole reservation is charged, because usage may be unknown.
   */
  run<T>(maxAttempts: number, signal: AbortSignal, fn: (http: HttpDeps, usage: LiveUsage) => Promise<T>): Promise<T>;
  readonly process: ProcessUsage;
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

export function createLiveGate(http: HttpDeps, processLimit: number): LiveGate {
  const ceiling: RequestBudget = createRequestBudget(processLimit);
  // Each caller's gate is "everyone before me has finished": a cancelled waiter releases its own
  // slot at once, but the next waiter still waits for the call that is actually running.
  let tail: Promise<void> = Promise.resolve();

  return {
    get process() {
      return { limit: ceiling.limit, used: ceiling.used, remaining: ceiling.limit - ceiling.used - ceiling.reserved };
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
        const usage: LiveUsage = { used: 0, limit: maxAttempts };
        // A Reservation falls back to the shared pool once empty; a live call must never do that,
        // so every grant is taken strictly from this call's own reserved units.
        const take = () => reservation.remaining > 0 && reservation.tryAcquire();
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
        }
      } finally {
        release();
      }
    },
  };
}
