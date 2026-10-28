import type { ClobClient } from "../adapters/polymarket/clobClient.js";
import type { GammaClient } from "../adapters/polymarket/gammaClient.js";
import { associateOutcomes, selectOutcomes } from "../adapters/polymarket/normalize.js";
import { assessBook } from "../analytics/bookQuality.js";
import type { Decimal } from "../domain/decimal.js";
import { MarketMindError } from "../domain/errors.js";
import { inspectEligibility, type Market, type Outcome, type OutcomeAssociation } from "../domain/market.js";
import type { BookAssessment, OrderBook } from "../domain/orderbook.js";
import type { Provenance } from "../domain/provenance.js";

export interface OutcomeReport {
  outcome: Outcome;
  book: OrderBook;
  assessment: BookAssessment;
}

export interface InspectResult {
  market: Market;
  association: OutcomeAssociation;
  outcomes: OutcomeReport[];
  /** Every HTTP exchange made, in issue order, each with its own timing. */
  requests: Provenance[];
  warnings: string[];
}

export interface InspectOptions {
  depthBand: Decimal | null;
}

/**
 * Gamma market -> eligibility -> CLOB explicit association -> both books (parallel) -> quality + metrics.
 * Association failures throw (no metrics). Invalid books are returned with quality "invalid";
 * callers decide the exit status via `hasInvalidBook`.
 */
export async function inspectMarket(
  clients: { gamma: GammaClient; clob: ClobClient },
  marketId: string,
  options: InspectOptions,
): Promise<InspectResult> {
  const market = await clients.gamma.getMarket(marketId);
  const eligibility = inspectEligibility(market);
  if (!eligibility.eligible) {
    throw new MarketMindError("Ineligible", `Market ${marketId} cannot be inspected`, { issues: eligibility.reasons });
  }

  const outcomes = selectOutcomes(market);
  const { info, provenance: infoProvenance } = await clients.clob.getMarketInfo(market.conditionId);
  const association = associateOutcomes(outcomes, info);

  const books = await Promise.all(outcomes.map((o) => clients.clob.getBook(o.assetId)));
  const reports = outcomes.map((outcome, i) => {
    const book = books[i]!;
    return { outcome, book, assessment: assessBook(book, { ...options, expectedConditionId: market.conditionId }) };
  });

  return {
    market,
    association,
    outcomes: reports,
    requests: [market.provenance, infoProvenance, ...books.map((b) => b.provenance)],
    warnings: eligibility.warnings,
  };
}

export function hasInvalidBook(result: InspectResult): boolean {
  return result.outcomes.some((o) => o.assessment.quality === "invalid");
}
