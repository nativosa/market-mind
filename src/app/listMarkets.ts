import type { GammaClient, ListMarketsQuery, MarketPage } from "../adapters/polymarket/gammaClient.js";
import { inspectEligibility, type Eligibility, type Market } from "../domain/market.js";

export interface ListedMarket {
  market: Market;
  eligibility: Eligibility;
}

export interface ListMarketsResult extends Omit<MarketPage, "markets"> {
  query: ListMarketsQuery;
  markets: ListedMarket[];
}

export async function listMarkets(gamma: GammaClient, query: ListMarketsQuery): Promise<ListMarketsResult> {
  const page = await gamma.listOpenMarkets(query);
  return {
    ...page,
    query,
    markets: page.markets.map((market) => ({ market, eligibility: inspectEligibility(market) })),
  };
}
