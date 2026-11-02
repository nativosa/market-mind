import { createClobClient } from "../adapters/polymarket/clobClient.js";
import { createGammaClient } from "../adapters/polymarket/gammaClient.js";
import { inspectMarket, type InspectResult } from "../app/inspectMarket.js";
import type { Decimal } from "../domain/decimal.js";
import { MCP_LIMITS } from "./contracts.js";
import { withCallClient, type LiveCallDeps } from "./liveCall.js";
import type { LiveUsage } from "./liveGate.js";

/**
 * One market inspection as one bounded live call (shared by the MCP tool and the web API): the
 * Gamma record, the CLOB market info and both books, at most 8 physical attempts and 20 s.
 */
export async function inspectLiveMarket(
  deps: LiveCallDeps,
  marketId: string,
  depthBand: Decimal | null,
  signal: AbortSignal,
): Promise<{ result: InspectResult; usage: LiveUsage }> {
  const L = MCP_LIMITS.inspect;
  return deps.gate.run(L.maxAttempts, signal, (http, usage) =>
    withCallClient(deps, http, L, signal, "Inspection", async (client) => ({
      result: await inspectMarket(
        { gamma: createGammaClient(client, deps.config.gammaBaseUrl), clob: createClobClient(client, deps.config.clobBaseUrl) },
        marketId,
        { depthBand },
      ),
      usage,
    })),
  );
}
