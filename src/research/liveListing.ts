import { createGammaClient } from "../adapters/polymarket/gammaClient.js";
import { listMarkets, type ListMarketsResult } from "../app/listMarkets.js";
import { WEB_LIMITS, type MarketsInput } from "./contracts.js";
import { withCallClient, type LiveCallDeps } from "./liveCall.js";
import type { LiveUsage } from "./liveGate.js";

export type ListingDeps = LiveCallDeps;

/**
 * One Gamma keyset page as one bounded live call: a single GET with at most one retry (2 physical
 * attempts, reserved up front), a 10 s deadline that starts once the call runs, and no order-book
 * requests: listing never inspects the markets it returns.
 */
export async function listMarketPage(deps: ListingDeps, input: MarketsInput, signal: AbortSignal): Promise<{ result: ListMarketsResult; usage: LiveUsage }> {
  const L = WEB_LIMITS.list;
  return deps.gate.run(L.maxAttempts, signal, (http, usage) =>
    withCallClient(deps, http, L, signal, "Listing", async (client) => ({
      result: await listMarkets(createGammaClient(client, deps.config.gammaBaseUrl), {
        limit: L.pageSize,
        version: input.version,
        order: "volume24hr",
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }),
      usage,
    })),
  );
}
