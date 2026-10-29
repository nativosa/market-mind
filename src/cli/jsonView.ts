import type { InspectResult, OutcomeReport } from "../app/inspectMarket.js";
import type { ListMarketsResult } from "../app/listMarkets.js";
import type { CollectResult } from "../app/collectMarkets.js";
import type { HistoryResult, RunsResult } from "../app/marketHistory.js";
import { countScan, type ScanEntry, type ScanResult } from "../app/scanMarkets.js";
import { decimalToString, type Decimal } from "../domain/decimal.js";
import type { MarketMindError } from "../domain/errors.js";
import type { Market } from "../domain/market.js";
import type { BookMetrics, PriceLevel } from "../domain/orderbook.js";
import type { ScanMetrics } from "../domain/scan.js";

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

export const SCAN_DISCLAIMER =
  "Research candidates only. Quoted spreads are not profits, expected returns or recommendations to trade.";

function scanMetricsView(m: ScanMetrics) {
  return {
    reference: m.reference,
    bestBid: level(m.bestBid),
    bestAsk: level(m.bestAsk),
    spread: dec(m.spread),
    midpoint: dec(m.midpoint),
    topSize: dec(m.topSize),
    topNotional: dec(m.topNotional),
    depthBand: dec(m.depthBand),
    bidDepthWithinBand: dec(m.bidDepthWithinBand),
    askDepthWithinBand: dec(m.askDepthWithinBand),
    bidDepthTotalDisplayed: dec(m.bidDepth),
    askDepthTotalDisplayed: dec(m.askDepth),
    levelCounts: m.levelCounts,
    state: m.state,
    quality: m.quality,
    pairSkewMs: m.pairSkewMs,
  };
}

function scanEntryView(e: ScanEntry) {
  const m = e.market;
  return {
    position: e.position,
    gammaId: e.gammaId,
    question: m?.question ?? null,
    slug: m?.slug ?? null,
    conditionId: m?.conditionId ?? null,
    endDate: m?.endDate ?? null,
    gammaVolume24hr: m?.volume24hr ?? null,
    bucket: e.bucket,
    reasons: e.reasons,
    warnings: e.warnings.slice(0, MAX_ISSUES),
    omittedWarnings: Math.max(0, e.warnings.length - MAX_ISSUES),
    explanation: e.explanation,
    metrics: e.metrics ? scanMetricsView(e.metrics) : null,
    outcomes: e.outcomes.map(({ outcome, book, assessment }) => ({
      index: outcome.index,
      label: outcome.label,
      role: outcome.role,
      assetId: outcome.assetId,
      assetIdKind: outcome.assetIdKind,
      quality: assessment.quality,
      issues: assessment.issues.slice(0, MAX_ISSUES),
      metrics: metricsView(assessment.metrics),
      tickSize: book.tickSize,
      minOrderSize: book.minOrderSize,
      hash: book.hash,
      serverTimestamp: book.serverTimestamp,
      request: book.provenance,
    })),
    issues: e.issues.slice(0, MAX_ISSUES),
  };
}

export function scanJson(result: ScanResult) {
  const o = result.options;
  const byBucket = (b: ScanEntry["bucket"]) => result.entries.filter((e) => e.bucket === b).map(scanEntryView);
  return {
    disclaimer: SCAN_DISCLAIMER,
    snapshot: "not atomic: every book is a separate request with its own timing",
    scan: {
      version: o.version,
      discoverOrder: o.discoverOrder,
      filters: {
        minSpread: decimalToString(o.filters.minSpread),
        minTopSizeShares: decimalToString(o.filters.minTopSize),
        includeSuspicious: o.filters.includeSuspicious,
      },
      depthBand: dec(o.depthBand),
      limits: {
        maxMarkets: o.maxMarkets,
        top: o.top,
        pageSize: o.pageSize,
        maxPages: o.maxPages,
        maxRequests: o.maxRequests,
        concurrency: o.concurrency,
        maxDurationMs: o.maxDurationMs,
      },
    },
    status: result.status,
    stopReasons: result.stopReasons,
    window: result.window,
    budget: result.budget,
    counts: countScan(result),
    discovery: result.discovery,
    rankedTotal: result.ranked.length,
    ranked: result.ranked.slice(0, o.top).map((e, i) => ({ rank: i + 1, ...scanEntryView(e) })),
    filtered: byBucket("filtered"),
    excluded: byBucket("excluded"),
    failed: byBucket("failed"),
    notScanned: byBucket("notScanned"),
    requests: result.requests,
  };
}

export function errorJson(error: MarketMindError) {
  return { error: { kind: error.kind, message: error.message, ...error.details } };
}

// ---- Stage 2.2: collect / history / runs ----

export function collectJson(result: CollectResult) {
  const err = (e: MarketMindError | null) => (e === null ? null : errorJson(e).error);
  return {
    run: { runId: result.runId, status: result.status, accounting: result.accounting, finalized: result.finalized, dbPath: result.dbPath },
    persistence: {
      counts: result.persist,
      invariant: "selected = persistedObservations + persistenceFailures + persistenceFailuresUnrecorded",
      failures: result.failures,
    },
    recovery: result.recovery,
    storage: {
      footprintBefore: result.footprintBefore,
      footprintAfter: result.footprintAfter,
      softLimitBytes: result.maxDbBytes,
      sizeLimitExceeded: result.sizeLimitExceeded,
    },
    errors: { scan: err(result.scanError), storage: err(result.storageError) },
    scan: result.scan ? scanJson(result.scan) : null,
  };
}

export function historyJson(result: HistoryResult) {
  const s = result.stats;
  return {
    query: { ...result.query, threshold: decimalToString(result.query.threshold) },
    analysisWindow: result.analysisWindow,
    stats: {
      eligible: s.eligible,
      usable: s.usable,
      notUsable: s.notUsable,
      firstUsableAt: s.firstUsableAt,
      lastUsableAt: s.lastUsableAt,
      spread: {
        n: s.spread.n,
        min: dec(s.spread.min),
        median: dec(s.spread.median),
        max: dec(s.spread.max),
        current: dec(s.spread.current),
        previous: dec(s.spread.previous),
        change: dec(s.spread.change),
      },
      topSize: { n: s.topSize.n, current: dec(s.topSize.current), previous: dec(s.topSize.previous), change: dec(s.topSize.change) },
      threshold: {
        n: s.threshold.n,
        threshold: decimalToString(s.threshold.threshold),
        atOrAbove: s.threshold.atOrAbove,
        percentOfSamples: dec(s.threshold.percentOfSamples),
      },
      gaps: s.gaps,
      states: s.states,
    },
    rows: result.rows.map(({ point: p, flags }) => ({
      observationId: p.observationId,
      runId: p.runId,
      runStatus: p.runStatus,
      sourceType: p.sourceType,
      availableAt: p.availableAt,
      availabilityBasis: p.availabilityBasis,
      pairing: p.pairing,
      association: p.association,
      bucket: p.bucket,
      reasonCodes: p.reasonCodes,
      question: p.question,
      outcomeLabels: p.outcomeLabels,
      books: p.books,
      metrics: p.metrics && {
        analyticsVersion: p.metrics.analyticsVersion,
        referenceIndex: p.metrics.referenceIndex,
        bestBid: dec(p.metrics.bestBid),
        bestAsk: dec(p.metrics.bestAsk),
        spread: dec(p.metrics.spread),
        midpoint: dec(p.metrics.midpoint),
        topSize: dec(p.metrics.topSize),
        state: p.metrics.state,
        quality: p.metrics.quality,
        pairSkewMs: p.metrics.pairSkewMs,
      },
      flags,
    })),
    limitations: result.limitations,
  };
}

export function runsJson(result: RunsResult) {
  return result;
}
