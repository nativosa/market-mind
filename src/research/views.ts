import type { InspectResult } from "../app/inspectMarket.js";
import type { ListMarketsResult } from "../app/listMarkets.js";
import type { HistoryResult, ObservationDetailsResult, RunsResult, StoredMarketsResult } from "../app/marketHistory.js";
import type { ScanEntry, ScanResult } from "../app/scanMarkets.js";
import { countScan } from "../app/scanMarkets.js";
import { HISTORY_LIMITATIONS } from "../analytics/history.js";
import { decimalToString, type Decimal } from "../domain/decimal.js";
import type { PriceLevel, RawLevel } from "../domain/orderbook.js";
import type { Provenance } from "../domain/provenance.js";
import type { HistoryPoint, StoredMetrics } from "../domain/snapshot.js";
import type { RowAnnotation } from "../analytics/history.js";
import {
  CONTRACT,
  Cursor,
  MCP_LIMITS,
  WEB_CONTRACT,
  WEB_LIMITS,
  type DetailsOutput,
  type HistoryOutput,
  type InspectOutput,
  type MarketsOutput,
  type RunsOutput,
  type ScanOutput,
  type Source,
  type StoredMarketsOutput,
  type WebHistoryOutput,
  type WebRunsOutput,
  type WebStatusOutput,
} from "./contracts.js";
import type { CooldownGate, LiveUsage, ProcessUsage, WindowUsage } from "./liveGate.js";
import { APP_VERSION } from "../config/config.js";
import { envelopeOf, untrusted } from "./envelope.js";

const d = (v: Decimal | null): string | null => (v === null ? null : decimalToString(v));
const question = (q: string) => untrusted(q, MCP_LIMITS.questionChars);
const label = (l: string) => untrusted(l, MCP_LIMITS.labelChars);
const ms = (iso: string) => Date.parse(iso);

export const SCAN_DISCLAIMER = "Research candidates only. Quoted spreads are not profits, expected returns or recommendations to trade.";
export const LIVE_EVIDENCE_NOTE =
  "Live observation, not persisted: cite it as observed at the given timestamps. Durable, re-verifiable evidence requires `npm run cli -- collect`.";
const LIVE_LIMITATIONS = [
  "Each order book is a separate request with its own timing; the books of one market are not an atomic snapshot.",
  "A book is the aggregated resting size at one instant: it says nothing about fills, queue position, hidden liquidity or what happens next.",
  "A wide spread can reflect low interest, stale quotes or an illiquid market; on its own it is not an opportunity.",
];

interface BudgetView {
  call: LiveUsage;
  process: ProcessUsage;
}
const budgetOf = (b: BudgetView) => ({ call: { limit: b.call.limit, used: b.call.used }, process: { ...b.process } });

function levelsOf(order: "aggregated_best_first" | "wire_order", bids: readonly (PriceLevel | RawLevel)[], asks: readonly (PriceLevel | RawLevel)[], perSide: number) {
  const text = (v: Decimal | string) => (typeof v === "string" ? v : decimalToString(v));
  const take = (side: readonly (PriceLevel | RawLevel)[]) => side.slice(0, perSide).map((l) => ({ price: text(l.price), size: text(l.size) }));
  return {
    order,
    bids: take(bids),
    asks: take(asks),
    totalBids: bids.length,
    totalAsks: asks.length,
    returnedPerSide: perSide,
    truncated: bids.length > perSide || asks.length > perSide,
  };
}

const requestOf = (p: Provenance) => ({
  source: p.source,
  endpoint: p.endpoint,
  url: p.url,
  httpStatus: p.httpStatus,
  attempts: p.timing.attempts,
  firstAttemptStartedAt: p.timing.firstAttemptStartedAt,
  responseReceivedAt: p.timing.responseReceivedAt,
  durationMs: p.timing.durationMs,
});

// ---- scan_markets ----

export interface ScanCaps {
  ranked: number;
  notRanked: number;
}

export function scanView(result: ScanResult, caps: ScanCaps, budget: BudgetView, now: Date): ScanOutput {
  const o = result.options;
  const counts = countScan(result);
  const reasonCounts: Record<string, number> = {};
  for (const e of result.entries) for (const r of e.reasons) reasonCounts[r.code] = (reasonCounts[r.code] ?? 0) + 1;
  const ranked = result.ranked.slice(0, Math.min(o.top, caps.ranked));
  const rankedTotal = result.ranked.length;
  // Sample-limit markets were never meant to be inspected: counted, not listed.
  const notRanked = result.entries.filter((e) => e.bucket !== "ranked" && !(e.bucket === "notScanned" && e.reasons[0]?.code === "SAMPLE_LIMIT"));
  const shownNotRanked = notRanked.slice(0, caps.notRanked);
  return {
    ...envelopeOf(CONTRACT.scan, "live", result.status, now, ["ranked.items[].question", "ranked.items[].reference.label", "ranked.items[].outcomes[].label", "ranked.items[].explanation[]", "notRanked.items[].question"], LIVE_LIMITATIONS),
    disclaimer: SCAN_DISCLAIMER,
    evidenceNote: LIVE_EVIDENCE_NOTE,
    stopReasons: result.stopReasons,
    appliedLimits: {
      version: o.version,
      discoverOrder: "volume24hr",
      maxMarkets: o.maxMarkets,
      top: o.top,
      pageSize: o.pageSize,
      maxPages: o.maxPages,
      minSpread: decimalToString(o.filters.minSpread),
      minTopSize: decimalToString(o.filters.minTopSize),
      includeSuspicious: o.filters.includeSuspicious,
      depthBand: d(o.depthBand),
      maxRequests: o.maxRequests,
      maxDurationMs: o.maxDurationMs,
      concurrency: o.concurrency,
    },
    counts: { ...counts, notScannedByReason: { ...counts.notScannedByReason } },
    discovery: {
      pages: result.discovery.pages,
      recordsReceived: result.discovery.recordsReceived,
      duplicates: result.discovery.duplicates.length,
      stoppedBecause: result.discovery.stoppedBecause,
    },
    window: result.window,
    budget: budgetOf(budget),
    reasonCounts,
    ranked: { returnedCount: ranked.length, totalCount: rankedTotal, truncated: ranked.length < rankedTotal, items: ranked.map((e, i) => candidateOf(e, i + 1)) },
    notRanked: {
      returnedCount: shownNotRanked.length,
      totalCount: notRanked.length,
      truncated: shownNotRanked.length < notRanked.length,
      items: shownNotRanked.map((e) => ({
        gammaId: e.gammaId,
        protocolVersion: e.market?.version ?? null,
        bucket: e.bucket as Exclude<ScanEntry["bucket"], "ranked">,
        reasonCodes: e.reasons.map((r) => r.code),
        warningCodes: e.warnings.map((w) => w.code),
        question: e.market ? question(e.market.question) : null,
      })),
    },
  };
}

function candidateOf(e: ScanEntry, rank: number): ScanOutput["ranked"]["items"][number] {
  const m = e.metrics!;
  const market = e.market!;
  return {
    rank,
    gammaId: market.gammaId,
    conditionId: market.conditionId,
    protocolVersion: market.version,
    question: question(market.question),
    endDate: market.endDate,
    reference: { index: m.reference.index, label: label(m.reference.label), assetId: m.reference.assetId },
    outcomes: e.outcomes.map(({ outcome, book, assessment }) => ({
      index: outcome.index,
      label: label(outcome.label),
      assetId: outcome.assetId,
      assetIdKind: outcome.assetIdKind,
      quality: assessment.quality,
      issueCodes: assessment.issues.map((i) => i.code),
      serverTimestamp: { raw: book.serverTimestamp.raw, iso: book.serverTimestamp.iso },
      responseReceivedAt: book.provenance.timing.responseReceivedAt,
    })),
    metrics: {
      bestBid: d(m.bestBid?.price ?? null),
      bestBidSize: d(m.bestBid?.size ?? null),
      bestAsk: d(m.bestAsk?.price ?? null),
      bestAskSize: d(m.bestAsk?.size ?? null),
      spread: d(m.spread),
      midpoint: d(m.midpoint),
      topSize: d(m.topSize),
      topNotional: d(m.topNotional),
      bidDepthWithinBand: d(m.bidDepthWithinBand),
      askDepthWithinBand: d(m.askDepthWithinBand),
      depthBand: d(m.depthBand),
      state: m.state,
      quality: m.quality,
      pairSkewMs: m.pairSkewMs,
    },
    warningCodes: e.warnings.map((w) => w.code),
    explanation: e.explanation.map((x) => untrusted(x, MCP_LIMITS.questionChars)),
  };
}

export function scanSummary(v: ScanOutput): string {
  const top = v.ranked.items
    .slice(0, 3)
    .map((c) => `#${c.rank} market ${c.gammaId} spread ${c.metrics.spread ?? "-"} top size ${c.metrics.topSize ?? "-"}`)
    .join("; ");
  return (
    `scan_markets (${v.appliedLimits.version}, live): status ${v.status}${v.stopReasons.length ? ` [${v.stopReasons.join(", ")}]` : ""}; ` +
    `${v.counts.rankedTotal} ranked of ${v.counts.discovered} discovered (${v.counts.selected} inspected); ` +
    `requests ${v.budget.call.used}/${v.budget.call.limit}.${top ? ` Top: ${top}.` : ""} ${SCAN_DISCLAIMER}`
  );
}

// ---- inspect_market ----

export function inspectView(result: InspectResult, levels: number, depthBand: Decimal | null, budget: BudgetView, now: Date): InspectOutput {
  const m = result.market;
  const invalid = result.outcomes.some((o) => o.assessment.quality === "invalid");
  const received = result.outcomes.map((o) => ms(o.book.provenance.timing.responseReceivedAt));
  return {
    ...envelopeOf(CONTRACT.inspect, "live", invalid ? "invalid_book" : "ok", now, ["market.question", "market.slug", "outcomes[].label"], LIVE_LIMITATIONS),
    evidenceNote: LIVE_EVIDENCE_NOTE,
    appliedLimits: { levels, depthBand: d(depthBand), maxAttempts: MCP_LIMITS.inspect.maxAttempts, deadlineMs: MCP_LIMITS.inspect.deadlineMs },
    market: {
      gammaId: m.gammaId,
      conditionId: m.conditionId,
      protocolVersion: m.version,
      question: question(m.question),
      slug: untrusted(m.slug, MCP_LIMITS.questionChars),
      active: m.active,
      closed: m.closed,
      acceptingOrders: m.acceptingOrders,
      enableOrderBook: m.enableOrderBook,
      negRisk: m.negRisk,
      endDate: m.endDate,
      gammaVolume24hr: m.volume24hr === null ? null : String(m.volume24hr),
    },
    association: { ...result.association },
    eligibilityWarnings: result.warnings,
    pairSkewMs: received.length === 2 ? Math.abs(received[0]! - received[1]!) : 0,
    outcomes: result.outcomes.map(({ outcome, book, assessment }) => {
      const x = assessment.metrics;
      return {
        index: outcome.index,
        label: label(outcome.label),
        role: outcome.role,
        assetId: outcome.assetId,
        assetIdKind: outcome.assetIdKind,
        quality: assessment.quality,
        issues: assessment.issues.map((i) => ({ code: i.code, severity: i.severity })),
        metrics: x && {
          bestBid: d(x.bestBid?.price ?? null),
          bestBidSize: d(x.bestBid?.size ?? null),
          bestAsk: d(x.bestAsk?.price ?? null),
          bestAskSize: d(x.bestAsk?.size ?? null),
          spread: d(x.spread),
          midpoint: d(x.midpoint),
          bidDepth: decimalToString(x.bidDepth),
          askDepth: decimalToString(x.askDepth),
          bidDepthWithinBand: d(x.bidDepthWithinBand),
          askDepthWithinBand: d(x.askDepthWithinBand),
          depthBand: d(x.depthBand),
          state: x.state,
          crossed: x.crossed,
          locked: x.locked,
        },
        levels: levelsOf("aggregated_best_first", assessment.bids, assessment.asks, levels),
        book: {
          tickSize: book.tickSize,
          minOrderSize: book.minOrderSize,
          lastTradePrice: book.lastTradePrice,
          negRisk: book.negRisk,
          upstreamHash: book.hash,
          serverTimestamp: { raw: book.serverTimestamp.raw, iso: book.serverTimestamp.iso },
        },
        request: requestOf(book.provenance),
      };
    }),
    requests: result.requests.map(requestOf),
    budget: budgetOf(budget),
  };
}

export function inspectSummary(v: InspectOutput): string {
  const books = v.outcomes
    .map((o) => `"${o.label}" ${o.quality} bid ${o.metrics?.bestBid ?? "-"} ask ${o.metrics?.bestAsk ?? "-"} spread ${o.metrics?.spread ?? "-"}`)
    .join("; ");
  return `inspect_market ${v.market.gammaId} (${v.market.protocolVersion}, live): status ${v.status}; ${books}; pair skew ${v.pairSkewMs} ms; requests ${v.budget.call.used}/${v.budget.call.limit}.`;
}

// ---- list_collection_runs ----

/** `shown` may be below the requested `limit` when the size bound cuts the list; `hasMore` then says so. */
export function runsView(result: RunsResult, shown: number, limit: number, thisHost: string, now: Date): RunsOutput {
  const items = result.runs.slice(0, Math.min(shown, limit));
  return {
    ...envelopeOf(CONTRACT.runs, "stored", items.length === 0 ? "empty" : "ok", now, [], [
      "A running run whose owner cannot be verified is shown as running; it may have crashed. Nothing here is modified.",
      "Recovered runs have accounting 'incomplete': null counts are unknown, not zero.",
    ]),
    appliedLimits: { limit },
    database: { schemaVersion: result.schemaVersion, footprintBytes: result.footprint },
    runs: {
      returnedCount: items.length,
      hasMore: result.runs.length > items.length,
      items: items.map((r) => ({
        runId: r.runId,
        sourceType: r.sourceType,
        status: r.status,
        accounting: r.accounting,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        appVersion: r.appVersion,
        buildId: r.buildId,
        schemaVersion: r.schemaVersion,
        analyticsVersion: r.analyticsVersion,
        protocolVersion: r.protocolVersion,
        stopReasons: r.stopReasons,
        scanCounts: r.scanCounts as RunsOutput["runs"]["items"][number]["scanCounts"],
        persistCounts: r.persistCounts as RunsOutput["runs"]["items"][number]["persistCounts"],
        budget: { limit: r.budgetLimit, used: r.budgetUsed },
        window: { first: r.windowFirst, last: r.windowLast },
        recoveredReason: r.recoveredReason,
        errorCode: typeof r.error?.code === "string" ? r.error.code : null,
        // Host name and process id are redacted: only whether the owner ran on this machine.
        owner: r.owner && {
          assessment: r.owner,
          onThisHost: r.ownerHost === thisHost,
          heartbeatAt: r.heartbeatAt,
          note: r.owner === "RECOVERABLE" ? "owner provably gone; the next collect marks it interrupted" : "status unverified; left unchanged",
        },
      })),
    },
  };
}

export function runsSummary(v: RunsOutput): string {
  const list = v.runs.items
    .slice(0, 5)
    .map((r) => `${r.runId} ${r.status}/${r.accounting} ${r.startedAt}`)
    .join("; ");
  return `list_collection_runs (stored): ${v.runs.returnedCount} run(s)${v.runs.hasMore ? ", more exist" : ""}${list ? `: ${list}` : ""}.`;
}

// ---- get_market_history ----

export interface HistoryQueryView {
  marketId: string;
  asOf: string | null;
  limit: number;
  spreadThreshold: Decimal;
  analyticsVersion: number;
  includeSynthetic: boolean;
}

const HISTORY_UNTRUSTED = ["rows.items[].question", "rows.items[].outcomeLabels[]", "rows.items[].books[].label"];

function appliedHistory(q: HistoryQueryView): HistoryOutput["appliedLimits"] {
  return { ...q, spreadThreshold: decimalToString(q.spreadThreshold) };
}

export function noHistoryView(q: HistoryQueryView, now: Date): HistoryOutput {
  return {
    ...envelopeOf(CONTRACT.history, "stored", "no_history", now, HISTORY_UNTRUSTED, [
      "No stored observation of this market matches the query. This is insufficient evidence, not evidence of absence.",
      ...HISTORY_LIMITATIONS,
    ]),
    evidence: "insufficient",
    appliedLimits: appliedHistory(q),
    analysisWindow: null,
    stats: null,
    rows: { returnedCount: 0, totalCount: 0, truncated: false, items: [] },
  };
}

const metricsOf = (m: StoredMetrics, asOfMs: number | null) => ({
  analyticsVersion: m.analyticsVersion,
  referenceIndex: m.referenceIndex,
  bestBid: d(m.bestBid),
  bestAsk: d(m.bestAsk),
  spread: d(m.spread),
  midpoint: d(m.midpoint),
  topSize: d(m.topSize),
  state: m.state,
  quality: m.quality,
  pairSkewMs: m.pairSkewMs,
  computedAt: m.computedAt,
  computedBy: m.computedBy,
  retrospective: asOfMs !== null && ms(m.computedAt) > asOfMs,
});

function analysisWindowOf(w: HistoryResult["analysisWindow"]): NonNullable<HistoryOutput["analysisWindow"]> {
  return { observations: w.observations, truncated: w.truncated, maxObservations: w.maxObservations, oldestAvailableAt: w.oldestAvailableAt, newestAvailableAt: w.newestAvailableAt };
}

function statsOf(s: HistoryResult["stats"]): NonNullable<HistoryOutput["stats"]> {
  return {
    eligible: s.eligible,
    usable: s.usable,
    notUsable: { ...s.notUsable },
    firstUsableAt: s.firstUsableAt,
    lastUsableAt: s.lastUsableAt,
    spread: { n: s.spread.n, min: d(s.spread.min), median: d(s.spread.median), max: d(s.spread.max), current: d(s.spread.current), previous: d(s.spread.previous), change: d(s.spread.change) },
    topSize: { n: s.topSize.n, current: d(s.topSize.current), previous: d(s.topSize.previous), change: d(s.topSize.change) },
    threshold: { n: s.threshold.n, threshold: decimalToString(s.threshold.threshold), atOrAbove: s.threshold.atOrAbove, percentOfSamples: d(s.threshold.percentOfSamples) },
    gaps: { ...s.gaps },
    states: { ...s.states },
  };
}

/**
 * One stored observation as a history row (shared by get_market_history and the web series).
 * Without `asOf` the run's current status is included; with it, that later knowledge is withheld.
 */
export function historyRowView(p: HistoryPoint, flags: RowAnnotation, asOf: string | null): HistoryOutput["rows"]["items"][number] {
  const asOfMs = asOf === null ? null : ms(asOf);
  return {
    observationId: p.observationId,
    runId: p.runId,
    sourceType: p.sourceType,
    ...(asOf === null ? { runStatus: p.runStatus } : {}),
    availableAt: p.availableAt,
    availabilityBasis: p.availabilityBasis,
    pairing: p.pairing,
    association: p.association,
    bucket: p.bucket,
    reasonCodes: p.reasonCodes,
    question: question(p.question),
    outcomeLabels: p.outcomeLabels.map(label),
    active: p.active,
    closed: p.closed,
    acceptingOrders: p.acceptingOrders,
    endDate: p.endDate,
    books: p.books.map((b) => ({ ...b, label: label(b.label) })),
    metrics: p.metrics && metricsOf(p.metrics, asOfMs),
    flags: { notUsable: flags.notUsable, unchanged: flags.unchanged, gapMs: flags.gapMs, changes: flags.changes },
  };
}

export function historyView(result: HistoryResult, q: HistoryQueryView, rows: number, now: Date): HistoryOutput {
  const shown = result.rows.slice(0, rows);
  return {
    ...envelopeOf(CONTRACT.history, "stored", "ok", now, HISTORY_UNTRUSTED, HISTORY_LIMITATIONS),
    evidence: result.stats.usable > 0 ? "available" : "insufficient",
    appliedLimits: appliedHistory(q),
    analysisWindow: analysisWindowOf(result.analysisWindow),
    stats: statsOf(result.stats),
    rows: {
      returnedCount: shown.length,
      totalCount: result.analysisWindow.observations,
      truncated: shown.length < result.analysisWindow.observations,
      items: shown.map(({ point, flags }) => historyRowView(point, flags, q.asOf)),
    },
  };
}

export function historySummary(v: HistoryOutput): string {
  const base = `get_market_history ${v.appliedLimits.marketId} (stored${v.appliedLimits.asOf ? `, as of ${v.appliedLimits.asOf}` : ""}): `;
  if (v.stats === null) return `${base}no stored observations; evidence insufficient.`;
  const sp = v.stats.spread;
  return (
    `${base}${v.stats.usable} usable of ${v.stats.eligible} observations; spread n=${sp.n} min ${sp.min ?? "-"} median ${sp.median ?? "-"} max ${sp.max ?? "-"} current ${sp.current ?? "-"}; ` +
    `newest observation ids: ${v.rows.items.slice(0, 5).map((r) => r.observationId).join(", ") || "-"}.`
  );
}

// ---- get_observation_details ----

export function detailsView(result: ObservationDetailsResult, levels: number, now: Date): DetailsOutput {
  const o = result.observation;
  const metric = result.metrics.find((m) => m.analyticsVersion === result.run.analyticsVersion) ?? result.metrics.at(-1);
  return {
    ...envelopeOf(CONTRACT.details, "stored", "ok", now, ["observation.question", "observation.slug", "observation.outcomeLabels[]", "books[].labelObserved"], [
      "Captured levels are exactly as received, in wire order; aggregation and metrics are separate, versioned derivations.",
      ...(result.query.asOf ? ["Facts that became known after asOf (later requests, the run's final status, persistence time) are withheld."] : []),
      ...HISTORY_LIMITATIONS,
    ]),
    appliedLimits: { observationId: result.query.observationId, asOf: result.query.asOf, levels },
    observation: {
      observationId: o.observationId,
      gammaId: o.gammaId,
      conditionId: o.conditionId,
      protocolVersion: o.protocolVersion,
      discoveryPosition: o.discoveryPosition,
      availableAt: o.availableAt,
      availabilityBasis: o.availabilityBasis,
      persistedAt: result.persistedAt,
      pairing: o.pairing,
      association: o.association,
      bucket: o.bucket,
      reasonCodes: o.reasons.map((r) => r.code),
      warningCodes: o.warnings.map((w) => w.code),
      question: question(o.question),
      slug: untrusted(o.slug, MCP_LIMITS.questionChars),
      outcomeLabels: o.outcomeLabels.map(label),
      active: o.active,
      closed: o.closed,
      acceptingOrders: o.acceptingOrders,
      enableOrderBook: o.enableOrderBook,
      negRisk: o.negRisk,
      endDate: o.endDate,
      gammaVolume24hr: o.gammaVolume24hr,
      pairSkewMs: metric?.pairSkewMs ?? (o.books.length === 2 ? Math.abs(ms(o.books[0]!.book.provenance.timing.responseReceivedAt) - ms(o.books[1]!.book.provenance.timing.responseReceivedAt)) : null),
    },
    run: result.run,
    runOutcome: result.runOutcome,
    books: o.books.map(({ outcome, labelObserved, contentHash, book, quality, issues }) => ({
      outcomeIndex: outcome.index,
      assetId: outcome.assetId,
      assetIdKind: outcome.assetIdKind,
      labelObserved: label(labelObserved),
      contentHash,
      quality,
      issues,
      reportedAssetId: book.assetId,
      reportedConditionId: book.conditionId,
      upstreamHash: book.hash,
      serverTimestamp: { raw: book.serverTimestamp.raw, iso: book.serverTimestamp.iso },
      tickSize: book.tickSize,
      minOrderSize: book.minOrderSize,
      lastTradePrice: book.lastTradePrice,
      negRisk: book.negRisk,
      levels: levelsOf("wire_order", book.bids, book.asks, levels),
      request: {
        url: book.provenance.url,
        httpStatus: book.provenance.httpStatus,
        attempts: book.provenance.timing.attempts,
        firstAttemptStartedAt: book.provenance.timing.firstAttemptStartedAt,
        finalAttemptStartedAt: book.provenance.timing.finalAttemptStartedAt,
        responseReceivedAt: book.provenance.timing.responseReceivedAt,
        durationMs: book.provenance.timing.durationMs,
        serverDateHeader: book.provenance.timing.serverDateHeader,
      },
    })),
    metrics: result.metrics,
    requests: { withheldAfterAsOf: result.requestsWithheld, items: result.requests },
  };
}

export function detailsSummary(v: DetailsOutput): string {
  const o = v.observation;
  const m = v.metrics.find((x) => x.analyticsVersion === v.run.analyticsVersion);
  return (
    `get_observation_details ${o.observationId} (stored): market ${o.gammaId} (${o.protocolVersion}), run ${v.run.runId}, available ${o.availableAt} (${o.availabilityBasis}), ` +
    `pairing ${o.pairing}, books ${v.books.map((b) => `${b.outcomeIndex}:${b.quality}`).join(" ") || "none"}; spread ${m?.spread ?? "-"}.`
  );
}

// ---- web: list_markets ----

export const VOLUME_NOTE =
  "gammaVolume24hr is Gamma's reported 24h traded volume, used only to order the list. It is not liquidity or order-book depth; inspect a market to see its books.";
const LISTING_LIMITATIONS = [
  "Listing reads Gamma metadata only: no order book was fetched, so nothing here describes prices, spreads or depth.",
  "Eligibility is computed from Gamma metadata; an inspectable market can still turn out to have an empty or invalid book.",
  "A null field means Gamma did not report it, not that the value is false or zero.",
];

export interface WebBudgetView extends BudgetView {
  window: WindowUsage | null;
}

export function marketsView(result: ListMarketsResult, budget: WebBudgetView, now: Date): MarketsOutput {
  const L = WEB_LIMITS;
  const next = result.nextCursor;
  const cursorOk = next !== null && Cursor.safeParse(next).success;
  const skipped = result.skipped.slice(0, L.skippedShown);
  return {
    ...envelopeOf(
      WEB_CONTRACT.markets,
      "live",
      result.markets.length === 0 ? "empty" : "ok",
      now,
      ["markets.items[].question", "markets.items[].slug", "markets.items[].outcomeLabels[]", "skipped.items[].id", "skipped.items[].issues[]"],
      LISTING_LIMITATIONS,
    ),
    volumeNote: VOLUME_NOTE,
    appliedLimits: { version: result.query.version, order: "volume24hr", pageSize: result.query.limit, maxAttempts: L.list.maxAttempts, deadlineMs: L.list.deadlineMs },
    query: { cursor: result.query.cursor ?? null },
    markets: {
      returnedCount: result.markets.length,
      items: result.markets.map(({ market: m, eligibility }) => ({
        gammaId: m.gammaId,
        conditionId: m.conditionId,
        protocolVersion: m.version,
        question: question(m.question),
        slug: untrusted(m.slug, MCP_LIMITS.questionChars),
        outcomeLabels: m.outcomeLabels.slice(0, L.outcomeLabelsShown).map(label),
        outcomeCount: m.outcomeLabels.length,
        active: m.active,
        closed: m.closed,
        acceptingOrders: m.acceptingOrders,
        enableOrderBook: m.enableOrderBook,
        negRisk: m.negRisk,
        endDate: m.endDate,
        gammaVolume24hr: m.volume24hr === null ? null : String(m.volume24hr),
        eligibility: { inspectable: eligibility.eligible, reasons: [...eligibility.reasons], warnings: [...eligibility.warnings] },
      })),
    },
    skipped: {
      returnedCount: skipped.length,
      totalCount: result.skipped.length,
      truncated: result.skipped.length > skipped.length,
      items: skipped.map((x) => ({ id: x.id === null ? null : untrusted(x.id, 40), issues: x.issues.slice(0, 5).map((i) => untrusted(i, 300)) })),
    },
    pagination: { nextCursor: cursorOk ? next : null, stoppedReason: next === null ? "LAST_PAGE" : cursorOk ? null : "CURSOR_UNSUPPORTED" },
    request: requestOf(result.provenance),
    budget: { ...budgetOf(budget), window: budget.window && { ...budget.window } },
  };
}

// ---- web: stored data (Stage 3.2) ----

export const includesSynthetic = (source: Source): boolean => source === "all";

const SYNTHETIC_NOTE =
  "source 'all' includes synthetic (test or demonstration) observations, marked sourceType 'synthetic'. They are not market evidence, and the statistics then mix them with live observations.";
const sourceLimitations = (source: Source) => (includesSynthetic(source) ? [SYNTHETIC_NOTE] : []);

export interface WebHistoryQuery {
  marketId: string;
  source: Source;
  asOf: string | null;
  spreadThreshold: Decimal;
  analyticsVersion: number;
}

const WEB_HISTORY_UNTRUSTED = ["series.items[].question", "series.items[].outcomeLabels[]", "series.items[].books[].label"];

function webHistoryLimitations(q: WebHistoryQuery): string[] {
  return [
    `The series lists at most the newest ${WEB_LIMITS.history.seriesMax} observations of the analysis window; statistics use every observation in the window.`,
    "Points are observations at their availableAt times. Nothing is known between them: do not connect, interpolate or time-weight them.",
    ...sourceLimitations(q.source),
    ...HISTORY_LIMITATIONS,
  ];
}

function appliedWebHistory(q: WebHistoryQuery): WebHistoryOutput["appliedLimits"] {
  return {
    marketId: q.marketId,
    source: q.source,
    asOf: q.asOf,
    spreadThreshold: decimalToString(q.spreadThreshold),
    analyticsVersion: q.analyticsVersion,
    seriesMax: WEB_LIMITS.history.seriesMax,
  };
}

export function webNoHistoryView(q: WebHistoryQuery, now: Date): WebHistoryOutput {
  return {
    ...envelopeOf(WEB_CONTRACT.history, "stored", "no_history", now, WEB_HISTORY_UNTRUSTED, [
      "No stored observation of this market matches the query. This is insufficient evidence, not evidence of absence.",
      ...webHistoryLimitations(q),
    ]),
    evidence: "insufficient",
    appliedLimits: appliedWebHistory(q),
    analysisWindow: null,
    stats: null,
    series: { returnedCount: 0, windowObservations: 0, truncated: false, oldestAvailableAt: null, newestAvailableAt: null, sourceCounts: { live: 0, synthetic: 0 }, items: [] },
  };
}

/** `result` must come from marketHistory with limit <= WEB_LIMITS.history.seriesMax. */
export function webHistoryView(result: HistoryResult, q: WebHistoryQuery, now: Date): WebHistoryOutput {
  const series = result.rows.slice(0, WEB_LIMITS.history.seriesMax);
  return {
    ...envelopeOf(WEB_CONTRACT.history, "stored", "ok", now, WEB_HISTORY_UNTRUSTED, webHistoryLimitations(q)),
    evidence: result.stats.usable > 0 ? "available" : "insufficient",
    appliedLimits: appliedWebHistory(q),
    analysisWindow: analysisWindowOf(result.analysisWindow),
    stats: statsOf(result.stats),
    series: {
      returnedCount: series.length,
      windowObservations: result.analysisWindow.observations,
      truncated: series.length < result.analysisWindow.observations,
      oldestAvailableAt: series.at(-1)?.point.availableAt ?? null,
      newestAvailableAt: series[0]?.point.availableAt ?? null,
      sourceCounts: {
        live: series.filter((r) => r.point.sourceType === "live").length,
        synthetic: series.filter((r) => r.point.sourceType === "synthetic").length,
      },
      items: series.map(({ point, flags, irregularGap }) => {
        const row = historyRowView(point, flags, q.asOf);
        const m = point.metrics;
        return {
          ...row,
          metrics: row.metrics && m && {
            ...row.metrics,
            bestBidSize: d(m.bestBidSize),
            bestAskSize: d(m.bestAskSize),
            bidDepth: d(m.bidDepth),
            askDepth: d(m.askDepth),
            bidBandDepth: d(m.bidBandDepth),
            askBandDepth: d(m.askBandDepth),
            depthBand: d(m.depthBand),
            bidLevels: m.bidLevels,
            askLevels: m.askLevels,
          },
          flags: { ...row.flags, irregularGap },
        };
      }),
    },
  };
}

export function storedMarketsView(result: StoredMarketsResult, q: { source: Source; limit: number; offset: number }, now: Date): StoredMarketsOutput {
  const items = result.markets.slice(0, q.limit);
  return {
    ...envelopeOf(
      WEB_CONTRACT.storedMarkets,
      "stored",
      items.length === 0 ? "empty" : "ok",
      now,
      ["markets.items[].latest.question", "markets.items[].latest.outcomeLabels[]"],
      [
        "Markets with locally stored observations, most recently observed first. Counts are stored observations, not market activity.",
        "The newest stored observation describes each market; its question and labels may have changed since.",
        "Offset paging: a collection that runs between pages can shift markets from one page to the next.",
        ...sourceLimitations(q.source),
      ],
    ),
    appliedLimits: { source: q.source, limit: q.limit, offset: q.offset },
    markets: {
      returnedCount: items.length,
      hasMore: result.hasMore,
      nextOffset: result.hasMore ? q.offset + items.length : null,
      items: items.map((m) => ({
        gammaId: m.gammaId,
        conditionId: m.conditionId,
        protocolVersion: m.protocolVersion,
        observations: m.observations,
        liveObservations: m.liveObservations,
        syntheticObservations: m.syntheticObservations,
        firstAvailableAt: m.firstAvailableAt,
        lastAvailableAt: m.lastAvailableAt,
        latest: {
          observationId: m.latest.observationId,
          runId: m.latest.runId,
          sourceType: m.latest.sourceType,
          runStatus: m.latest.runStatus,
          question: question(m.latest.question),
          outcomeLabels: m.latest.outcomeLabels.slice(0, WEB_LIMITS.outcomeLabelsShown).map(label),
          outcomeCount: m.latest.outcomeLabels.length,
          active: m.latest.active,
          closed: m.latest.closed,
        },
      })),
    },
  };
}

/** `result` holds up to limit + 1 runs (one extra to learn whether more exist), already source-filtered. */
export function webRunsView(result: RunsResult, q: { source: Source; limit: number }, thisHost: string, now: Date): WebRunsOutput {
  const view = runsView(result, q.limit, q.limit, thisHost, now);
  return {
    ...view,
    contract: WEB_CONTRACT.storedRuns,
    limitations: [...view.limitations, ...sourceLimitations(q.source)],
    appliedLimits: { limit: q.limit, source: q.source },
  };
}

// ---- web: status ----

export interface WebStatusFacts {
  liveEnabled: boolean;
  mode: "normal" | "demo";
  defaultSource: Source;
  databasePresent: boolean;
}

export function webStatusView(gate: CooldownGate, facts: WebStatusFacts, now: Date): WebStatusOutput {
  const L = WEB_LIMITS;
  const cooldown = gate.cooldownRemainingMs;
  const window = gate.window;
  return {
    contract: WEB_CONTRACT.status,
    appVersion: APP_VERSION,
    generatedAt: now.toISOString(),
    readOnly: true,
    limits: {
      list: { pageSize: L.list.pageSize, maxAttempts: L.list.maxAttempts, deadlineMs: L.list.deadlineMs },
      inspect: { maxAttempts: L.inspect.maxAttempts, deadlineMs: L.inspect.deadlineMs, levels: { ...MCP_LIMITS.inspect.levels } },
      rateLimitCooldownMs: L.rateLimitCooldownMs,
    },
    budget: { process: { ...gate.process }, window: window && { ...window } },
    rateLimit: { coolingDown: cooldown > 0, retryAfterMs: cooldown },
    live: { enabled: facts.liveEnabled },
    stored: { mode: facts.mode, defaultSource: facts.defaultSource, database: facts.databasePresent ? "present" : "missing" },
  };
}
