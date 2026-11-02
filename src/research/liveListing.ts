import { createGammaClient } from "../adapters/polymarket/gammaClient.js";
import { createHttpClient } from "../adapters/polymarket/httpClient.js";
import { createRequestBudget } from "../adapters/polymarket/requestBudget.js";
import { listMarkets, type ListMarketsResult } from "../app/listMarkets.js";
import type { AppConfig } from "../config/config.js";
import { isMarketMindError, MarketMindError } from "../domain/errors.js";
import { WEB_LIMITS, type MarketsInput } from "./contracts.js";
import type { LiveGate, LiveUsage } from "./liveGate.js";

export interface ListingDeps {
  gate: LiveGate;
  config: AppConfig;
  /** Deadline signal factory, injectable for tests. Defaults to AbortSignal.timeout. */
  deadline?: (ms: number) => AbortSignal;
}

/**
 * One Gamma keyset page as one bounded live call: a single GET with at most one retry (2 physical
 * attempts, reserved up front), a 10 s deadline that starts once the call runs, and no order-book
 * requests: listing never inspects the markets it returns.
 */
export async function listMarketPage(deps: ListingDeps, input: MarketsInput, signal: AbortSignal): Promise<{ result: ListMarketsResult; usage: LiveUsage }> {
  const L = WEB_LIMITS.list;
  return deps.gate.run(L.maxAttempts, signal, async (http, usage) => {
    const deadline = deps.deadline ? deps.deadline(L.deadlineMs) : AbortSignal.timeout(L.deadlineMs);
    const client = createHttpClient(
      { ...deps.config, maxRetries: Math.min(deps.config.maxRetries, L.maxRetries) },
      { ...http, budget: createRequestBudget(L.maxAttempts), signal: AbortSignal.any([signal, deadline]) },
    );
    try {
      const result = await listMarkets(createGammaClient(client, deps.config.gammaBaseUrl), {
        limit: L.pageSize,
        version: input.version,
        order: "volume24hr",
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return { result, usage };
    } catch (error) {
      if (isMarketMindError(error) && error.kind === "Cancelled" && deadline.aborted && !signal.aborted) {
        throw new MarketMindError("Cancelled", `Listing exceeded its ${L.deadlineMs} ms deadline`, { ...error.details, code: "DEADLINE" });
      }
      throw error;
    }
  });
}
