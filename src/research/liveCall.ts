import { createHttpClient, type HttpClient, type HttpDeps } from "../adapters/polymarket/httpClient.js";
import { createRequestBudget } from "../adapters/polymarket/requestBudget.js";
import type { AppConfig } from "../config/config.js";
import { isMarketMindError, MarketMindError } from "../domain/errors.js";
import type { LiveGate } from "./liveGate.js";

export interface LiveCallDeps {
  gate: LiveGate;
  config: AppConfig;
  /** Deadline signal factory, injectable for tests. Defaults to AbortSignal.timeout. */
  deadline?: (ms: number) => AbortSignal;
}

export interface CallLimits {
  maxAttempts: number;
  maxRetries: number;
  deadlineMs: number;
}

/**
 * HTTP client for one bounded live call, built inside `gate.run`: its own attempt budget, retries
 * capped by `limits`, and a deadline that starts once the call runs (not while it queues). A deadline
 * abort is reported as Cancelled/DEADLINE with `what` in the message; a caller's abort stays Cancelled.
 */
export async function withCallClient<T>(
  deps: LiveCallDeps,
  http: HttpDeps,
  limits: CallLimits,
  signal: AbortSignal,
  what: string,
  fn: (client: HttpClient) => Promise<T>,
): Promise<T> {
  const deadline = deps.deadline ? deps.deadline(limits.deadlineMs) : AbortSignal.timeout(limits.deadlineMs);
  const client = createHttpClient(
    { ...deps.config, maxRetries: Math.min(deps.config.maxRetries, limits.maxRetries) },
    { ...http, budget: createRequestBudget(limits.maxAttempts), signal: AbortSignal.any([signal, deadline]) },
  );
  try {
    return await fn(client);
  } catch (error) {
    if (isMarketMindError(error) && error.kind === "Cancelled" && deadline.aborted && !signal.aborted) {
      throw new MarketMindError("Cancelled", `${what} exceeded its ${limits.deadlineMs} ms deadline`, { ...error.details, code: "DEADLINE" });
    }
    throw error;
  }
}
