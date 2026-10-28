import type { InspectResult, OutcomeReport } from "../app/inspectMarket.js";
import type { ListMarketsResult } from "../app/listMarkets.js";
import { decimalToString, type Decimal } from "../domain/decimal.js";
import type { MarketMindError } from "../domain/errors.js";
import type { Market } from "../domain/market.js";
import type { BookMetrics, PriceLevel } from "../domain/orderbook.js";

// Plain, JSON-safe views. Every decimal becomes a fixed-notation string; numbers are used
// only for counts, durations and epoch milliseconds. No big.js objects or bigint escape.

export const MAX_ISSUES = 20;

const dec = (d: Decimal | null): string | null => (d === null ? null : decimalToString(d));
const level = (l: PriceLevel | null) => (l === null ? null : { price: decimalToString(l.price), size: decimalToString(l.size) });

function marketView(m: Market) {
  return {
    gammaId: m.gammaId,
    conditionId: m.conditionId,
    questionId: m.questionId,
    slug: m.slug,
    question: m.question,
    version: m.version,
    active: m.active,
    closed: m.closed,
    acceptingOrders: m.acceptingOrders,
    enableOrderBook: m.enableOrderBook,
    negRisk: m.negRisk,
    outcomeLabels: m.outcomeLabels,
    clobTokenIds: m.clobTokenIds,
    positionIds: m.positionIds,
    endDate: m.endDate,
  };
}

function metricsView(m: BookMetrics | null) {
  if (m === null) return null;
  return {
    state: m.state,
    bestBid: level(m.bestBid),
    bestAsk: level(m.bestAsk),
    spread: dec(m.spread),
    midpoint: dec(m.midpoint),
    bidDepth: dec(m.bidDepth),
    askDepth: dec(m.askDepth),
    depthBand: dec(m.depthBand),
    bidDepthWithinBand: dec(m.bidDepthWithinBand),
    askDepthWithinBand: dec(m.askDepthWithinBand),
    levelCounts: m.levelCounts,
    crossed: m.crossed,
    locked: m.locked,
  };
}

function outcomeView(r: OutcomeReport, maxLevels: number) {
  const { outcome, book, assessment } = r;
  return {
    index: outcome.index,
    label: outcome.label,
    role: outcome.role,
    assetId: outcome.assetId,
    assetIdKind: outcome.assetIdKind,
    raw: outcome.raw,
    quality: assessment.quality,
    issues: assessment.issues.slice(0, MAX_ISSUES),
    omittedIssues: Math.max(0, assessment.issues.length - MAX_ISSUES),
    metrics: metricsView(assessment.metrics),
    levels: {
      bids: assessment.bids.slice(0, maxLevels).map(level),
      asks: assessment.asks.slice(0, maxLevels).map(level),
      truncated: assessment.bids.length > maxLevels || assessment.asks.length > maxLevels,
    },
    book: {
      assetId: book.assetId,
      conditionId: book.conditionId,
      tickSize: book.tickSize,
      minOrderSize: book.minOrderSize,
      lastTradePrice: book.lastTradePrice,
      negRisk: book.negRisk,
      hash: book.hash,
      rawLevelCounts: { bids: book.bids.length, asks: book.asks.length },
      serverTimestamp: book.serverTimestamp,
      request: book.provenance,
    },
  };
}

export function marketsJson(result: ListMarketsResult) {
  return {
    query: result.query,
    request: result.provenance,
    nextCursor: result.nextCursor,
    markets: result.markets.map(({ market, eligibility }) => ({
      ...marketView(market),
      inspectable: eligibility.eligible,
      ineligibleReasons: eligibility.reasons,
      warnings: eligibility.warnings,
    })),
    skipped: result.skipped,
  };
}

export function inspectJson(result: InspectResult, maxLevels: number) {
  return {
    market: { ...marketView(result.market), request: result.market.provenance },
    association: result.association,
    outcomes: result.outcomes.map((o) => outcomeView(o, maxLevels)),
    requests: result.requests,
    warnings: result.warnings,
  };
}

export function errorJson(error: MarketMindError) {
  return { error: { kind: error.kind, message: error.message, ...error.details } };
}
