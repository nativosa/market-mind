import { createClobClient } from "../adapters/polymarket/clobClient.js";
import { createGammaClient, type MarketPage, type SkippedMarket } from "../adapters/polymarket/gammaClient.js";
import { createHttpClient, type HttpClient, type HttpDeps, type HttpOptions } from "../adapters/polymarket/httpClient.js";
import { associateOutcomes, selectOutcomes } from "../adapters/polymarket/normalize.js";
import { createRequestBudget, type Reservation } from "../adapters/polymarket/requestBudget.js";
import { assessBook } from "../analytics/bookQuality.js";
import { rankCandidates } from "../analytics/ranking.js";
import { computeScanMetrics, evaluateCandidate } from "../analytics/scanMetrics.js";
import type { Decimal } from "../domain/decimal.js";
import { isMarketMindError, MarketMindError, type ErrorKind } from "../domain/errors.js";
import type { Market, ProtocolVersion } from "../domain/market.js";
import type { DataSource, RequestTiming } from "../domain/provenance.js";
import type { AssociationStatus } from "../domain/snapshot.js";
import {
  scanEligibility,
  type Bucket,
  type ExecutionStopCode,
  type FailedCode,
  type NotScannedCode,
  type OutcomeObservation,
  type Reason,
  type ScanFilters,
  type ScanMetrics,
  type ScanWarning,
} from "../domain/scan.js";
import { createLimiter, mapWithConcurrency, type Limiter } from "./concurrency.js";

export type DiscoverOrder = "volume24hr" | "none";

export interface ScanOptions {
  version: ProtocolVersion;
  discoverOrder: DiscoverOrder;
  /** Max eligible markets inspected (books fetched). */
  maxMarkets: number;
  /** Max ranked rows displayed; the full ranking is always computed. */
  top: number;
  pageSize: number;
  maxPages: number;
  filters: ScanFilters;
  depthBand: Decimal | null;
  /** Hard cap on HTTP attempts, retries included. */
  maxRequests: number;
  /** Max in-flight HTTP requests. */
  concurrency: number;
  maxDurationMs: number;
}

/** Hard upper bounds, enforced here as well as by the CLI parser. */
export const SCAN_LIMITS = {
  maxMarkets: 30,
  top: 50,
  pageSize: 100,
  maxPages: 3,
  maxRequests: 120,
  concurrency: 8,
  minDurationMs: 1_000,
  maxDurationMs: 120_000,
} as const;
export const SCAN_MAX_RETRIES = 1;
/** Association + one book per outcome. */
export const REQUESTS_PER_MARKET = 3;

export interface ScanDeps {
  http: HttpDeps;
  httpOptions: HttpOptions;
  gammaBaseUrl: string;
  clobBaseUrl: string;
  /** User cancellation (Ctrl+C). */
  signal?: AbortSignal;
  /** Deadline signal factory, injectable for tests. Defaults to AbortSignal.timeout. */
  deadline?: (ms: number) => AbortSignal;
  /**
   * Optional observer, called synchronously exactly once per selected market as soon as its final
   * bucket is known (never for unselected markets). It must not throw. Used by `collect` to persist
   * each market incrementally; the scanner itself knows nothing about storage.
   */
  onSettled?: (settled: SettledMarket) => void;
}

export interface SettledMarket {
  entry: ScanEntry;
  /** Requests made for this market plus its discovery page, in scope order. */
  requests: RequestRecord[];
}

export interface RequestRecord {
  /** What the request was for, e.g. "discovery page 1", "market 123 book Yes". */
  scope: string;
  source: DataSource;
  endpoint: string;
  url: string;
  httpStatus: number | null;
  attempts: number;
  timing: RequestTiming | null;
  error: { kind: ErrorKind; message: string } | null;
}

export interface ScanEntry {
  /** Discovery order, 0-based. */
  position: number;
  /** Discovery page (1-based) the record came from. */
  discoveryPage: number;
  /** Outcome association for inspected markets; not_attempted otherwise. */
  association: AssociationStatus;
  gammaId: string | null;
  market: Market | null;
  eligible: boolean;
  selected: boolean;
  bucket: Bucket;
  reasons: Reason[];
  warnings: ScanWarning[];
  explanation: string[];
  /** Books actually received and assessed: both when inspected, any that arrived when a sibling failed, else none. */
  outcomes: OutcomeObservation[];
  metrics: ScanMetrics | null;
  /** Validation issues or error details for failed entries. */
  issues: string[];
}

export type StopReason = ExecutionStopCode | "DISCOVERY_FAILED";
const STOP_ORDER: readonly StopReason[] = ["DISCOVERY_FAILED", "BUDGET_EXHAUSTED", "RATE_LIMITED", "DEADLINE", "CANCELLED"];

export type DiscoveryStop = "NO_MORE_PAGES" | "MAX_PAGES" | "ENOUGH_CANDIDATES" | "INTERRUPTED";

export interface ScanResult {
  options: ScanOptions;
  status: "complete" | "partial";
  stopReasons: StopReason[];
  /** Span of all requests. Observations inside it are independent, not an atomic snapshot. */
  window: { firstRequestStartedAt: string; lastResponseReceivedAt: string } | null;
  budget: { limit: number; used: number };
  discovery: {
    pages: number;
    /** Raw Gamma records received, duplicates included: recordsReceived = entries.length + duplicates.length. */
    recordsReceived: number;
    stoppedBecause: DiscoveryStop;
    /** Records repeated across pages (e.g. order shifted between requests). Counted once. */
    duplicates: { gammaId: string; page: number }[];
    warnings: string[];
  };
  /** Every unique discovered record, in discovery order. */
  entries: ScanEntry[];
  /** Full ranking (rankedTotal = ranked.length); display truncates to options.top. */
  ranked: ScanEntry[];
  /** Every request that reached the network, in deterministic (scope) order. */
  requests: RequestRecord[];
}

export interface ScanCounts {
  discovered: number;
  eligible: number;
  selected: number;
  rankedTotal: number;
  filtered: number;
  excluded: number;
  failed: number;
  notScanned: number;
  notScannedByReason: Record<NotScannedCode, number>;
}

export function countScan(result: ScanResult): ScanCounts {
  const by = (b: Bucket) => result.entries.filter((e) => e.bucket === b).length;
  const notScannedByReason: Record<NotScannedCode, number> = {
    SAMPLE_LIMIT: 0,
    BUDGET_EXHAUSTED: 0,
    DEADLINE: 0,
    CANCELLED: 0,
    RATE_LIMITED: 0,
  };
  for (const e of result.entries) if (e.bucket === "notScanned") notScannedByReason[e.reasons[0]!.code as NotScannedCode]++;
  return {
    discovered: result.entries.length,
    eligible: result.entries.filter((e) => e.eligible).length,
    selected: result.entries.filter((e) => e.selected).length,
    rankedTotal: result.ranked.length,
    filtered: by("filtered"),
    excluded: by("excluded"),
    failed: by("failed"),
    notScanned: by("notScanned"),
    notScannedByReason,
  };
}

const FAILED_CODE_BY_KIND: Partial<Record<ErrorKind, FailedCode>> = {
  Timeout: "HTTP_TIMEOUT",
  Network: "HTTP_NETWORK",
  RateLimited: "HTTP_RATE_LIMITED",
  Upstream5xx: "HTTP_UPSTREAM_5XX",
  HttpStatus: "HTTP_STATUS",
  NotFound: "HTTP_NOT_FOUND",
  AssociationMismatch: "ASSOCIATION_MISMATCH",
  InvalidBook: "INVALID_BOOK",
};

type SortKey = readonly [number, number, number];

/**
 * Bounded, read-only scan: discover -> classify -> select -> associate + books -> metrics ->
 * filter -> rank. Each candidate fails in isolation; every discovered record is accounted for.
 */
export async function scanMarkets(options: ScanOptions, deps: ScanDeps): Promise<ScanResult> {
  assertWithinLimits(options);
  const budget = createRequestBudget(options.maxRequests);
  const limiter = createLimiter(options.concurrency);
  const circuit = new AbortController();
  const deadline = (deps.deadline ?? ((ms: number) => AbortSignal.timeout(ms)))(options.maxDurationMs);
  const scanSignal = AbortSignal.any([deadline, circuit.signal, ...(deps.signal ? [deps.signal] : [])]);
  const httpOptions: HttpOptions = { ...deps.httpOptions, maxRetries: Math.min(deps.httpOptions.maxRetries, SCAN_MAX_RETRIES) };
  const stopReasons = new Set<StopReason>();
  const records: { key: SortKey; record: RequestRecord }[] = [];

  /** Why the scan signal fired. Only meaningful once it has. */
  const stopCode = (): ExecutionStopCode =>
    deps.signal?.aborted ? "CANCELLED" : circuit.signal.aborted ? "RATE_LIMITED" : "DEADLINE";

  const clientFor = (reservation: Reservation, key: SortKey, scope: string): HttpClient =>
    recorded(limited(createHttpClient(httpOptions, { ...deps.http, budget: reservation, signal: scanSignal }), limiter), records, key, scope);

  // 1. Discovery (sequential: each page needs the previous cursor).
  const discovered: { page: number; item: Market | SkippedMarket }[] = [];
  const seen = new Set<string>();
  const duplicates: { gammaId: string; page: number }[] = [];
  let eligibleSoFar = 0;
  let recordsReceived = 0;
  let pages = 0;
  let cursor: string | undefined;
  let stoppedBecause: DiscoveryStop;
  for (;;) {
    if (pages >= options.maxPages) {
      stoppedBecause = "MAX_PAGES";
      break;
    }
    if (eligibleSoFar >= options.maxMarkets) {
      stoppedBecause = "ENOUGH_CANDIDATES";
      break;
    }
    if (scanSignal.aborted) {
      stopReasons.add(stopCode());
      stoppedBecause = "INTERRUPTED";
      break;
    }
    const reservation = budget.reserve(1);
    if (!reservation) {
      stopReasons.add("BUDGET_EXHAUSTED");
      stoppedBecause = "INTERRUPTED";
      break;
    }
    const pageNo = pages + 1;
    let page: MarketPage;
    try {
      const gamma = createGammaClient(clientFor(reservation, [0, pageNo, 0], `discovery page ${pageNo}`), deps.gammaBaseUrl);
      page = await gamma.listOpenMarkets({
        limit: options.pageSize,
        version: options.version,
        ...(cursor ? { cursor } : {}),
        ...(options.discoverOrder === "none" ? {} : { order: options.discoverOrder }),
      });
    } catch (error) {
      if (!isMarketMindError(error)) throw error;
      if (error.kind === "Cancelled" || error.kind === "BudgetExceeded") {
        stopReasons.add(error.kind === "BudgetExceeded" ? "BUDGET_EXHAUSTED" : stopCode());
        stoppedBecause = "INTERRUPTED";
        break;
      }
      if (error.details.budgetExhausted) stopReasons.add("BUDGET_EXHAUSTED");
      if (error.kind === "RateLimited") stopReasons.add("RATE_LIMITED");
      if (pages === 0) throw orderRejection(error, options) ?? error;
      stopReasons.add("DISCOVERY_FAILED");
      stoppedBecause = "INTERRUPTED";
      break;
    } finally {
      reservation.release();
    }
    pages = pageNo;
    recordsReceived += page.markets.length + page.skipped.length;
    for (const item of [...page.markets, ...page.skipped]) {
      const id = "gammaId" in item ? item.gammaId : item.id;
      if (id !== null && seen.has(id)) {
        duplicates.push({ gammaId: id, page: pageNo });
        continue;
      }
      if (id !== null) seen.add(id);
      discovered.push({ page: pageNo, item });
      if ("gammaId" in item && scanEligibility(item).bucket === "eligible") eligibleSoFar++;
    }
    if (!page.nextCursor) {
      stoppedBecause = "NO_MORE_PAGES";
      break;
    }
    cursor = page.nextCursor;
  }

  // 2-3. Metadata classification and selection, in discovery order.
  const entries: ScanEntry[] = discovered.map(({ item, page }, position) => classifyRecord(item, position, page));
  const selected: ScanEntry[] = [];
  for (const entry of entries) {
    if (!entry.eligible) continue;
    if (selected.length < options.maxMarkets) {
      entry.selected = true;
      selected.push(entry);
    } else {
      notScanned(entry, "SAMPLE_LIMIT", `beyond --max-markets ${options.maxMarkets}`);
    }
  }

  // 4. Reserve each market's first attempts up front, in selection order, so which markets get
  // inspected does not depend on timing. Once one reservation fails, no later market gets one.
  let budgetShort = false;
  const reservations = selected.map((): Reservation | null => {
    const reservation = budgetShort ? null : budget.reserve(REQUESTS_PER_MARKET);
    if (!reservation) budgetShort = true;
    return reservation;
  });

  const settle = (entry: ScanEntry) => {
    if (!deps.onSettled) return;
    const own = records
      .filter(({ key }) => (key[0] === 1 && key[1] === entry.position) || (key[0] === 0 && key[1] === entry.discoveryPage))
      .sort((a, b) => compareKeys(a.key, b.key))
      .map((r) => r.record);
    deps.onSettled({ entry, requests: own });
  };

  await mapWithConcurrency(selected, options.concurrency, async (entry, i) => {
    const reservation = reservations[i] ?? null;
    if (reservation === null) {
      stopReasons.add("BUDGET_EXHAUSTED");
      notScanned(entry, "BUDGET_EXHAUSTED", `budget of ${options.maxRequests} requests cannot cover this market`);
      settle(entry);
      return;
    }
    try {
      await inspect(entry, reservation);
    } finally {
      reservation.release();
    }
    settle(entry);
  });

  async function inspect(entry: ScanEntry, reservation: Reservation): Promise<void> {
    const market = entry.market!;
    if (scanSignal.aborted) {
      const code = stopCode();
      stopReasons.add(code);
      notScanned(entry, code, "scan stopped before this market started");
      return;
    }
    const scope = `market ${market.gammaId}`;
    try {
      const outcomes = selectOutcomes(market);
      const clob = (step: number, what: string) =>
        createClobClient(clientFor(reservation, [1, entry.position, step], `${scope} ${what}`), deps.clobBaseUrl);
      entry.association = "failed"; // until the association response arrives and matches
      const { info } = await clob(0, "association").getMarketInfo(market.conditionId);
      try {
        associateOutcomes(outcomes, info);
      } catch (error) {
        entry.association = "mismatch";
        throw error;
      }
      entry.association = "confirmed";
      const settled = await Promise.allSettled(outcomes.map((o, i) => clob(1 + i, `book ${o.label}`).getBook(o.assetId)));
      // Keep every book that did arrive, even if its sibling failed: it is still evidence.
      entry.outcomes = settled.flatMap((s, i): OutcomeObservation[] =>
        s.status === "fulfilled"
          ? [
              {
                outcome: outcomes[i]!,
                book: s.value,
                assessment: assessBook(s.value, { depthBand: options.depthBand, expectedConditionId: market.conditionId }),
              },
            ]
          : [],
      );
      const rejected = settled.filter((s) => s.status === "rejected").map((s) => s.reason as unknown);
      if (rejected.length > 0) {
        // Prefer the root cause over requests the scan cancelled because of it.
        throw rejected.find((e) => !(isMarketMindError(e) && (e.kind === "Cancelled" || e.kind === "BudgetExceeded"))) ?? rejected[0];
      }
      const observations = entry.outcomes;
      const [ref, other] = observations as [OutcomeObservation, OutcomeObservation];
      const metrics = computeScanMetrics(ref, other);
      const evaluation = evaluateCandidate(ref, other, metrics, options.filters, market.endDate);
      Object.assign(entry, {
        bucket: evaluation.bucket,
        reasons: evaluation.reasons,
        warnings: evaluation.warnings,
        explanation: evaluation.explanation,
        outcomes: observations,
        metrics,
      });
    } catch (error) {
      if (!isMarketMindError(error)) throw error;
      if (error.kind === "Cancelled" || error.kind === "BudgetExceeded") {
        const code = error.kind === "BudgetExceeded" ? "BUDGET_EXHAUSTED" : stopCode();
        stopReasons.add(code);
        // A cancelled association request never answered: it was not attempted to completion.
        if (entry.association === "failed") entry.association = "not_attempted";
        notScanned(entry, code, "stopped while this market was being inspected; books received so far are kept, metrics are not computed");
        return;
      }
      if (error.kind === "RateLimited") {
        // Throttling should delay, not reject; a surviving 429 means stop adding load.
        stopReasons.add("RATE_LIMITED");
        circuit.abort(new Error("rate limited (HTTP 429 after retry)"));
      }
      if (error.details.budgetExhausted) stopReasons.add("BUDGET_EXHAUSTED");
      const code: FailedCode = FAILED_CODE_BY_KIND[error.kind] ?? "VALIDATION";
      Object.assign(entry, {
        bucket: "failed",
        reasons: [{ code, detail: error.message + (error.details.budgetExhausted ? " (retry refused: request budget exhausted)" : "") }],
        issues: [...(error.details.url ? [`url: ${error.details.url}`] : []), ...(error.details.issues ?? [])],
      });
    }
  }

  // 5. Ranking over the full passing set.
  const ranked = rankCandidates(
    entries.filter((e) => e.bucket === "ranked"),
    (e) => ({ gammaId: e.gammaId!, spread: e.metrics!.spread, topSize: e.metrics!.topSize }),
  );

  const requests = records.sort((a, b) => compareKeys(a.key, b.key)).map((r) => r.record);
  const stops = STOP_ORDER.filter((s) => stopReasons.has(s));
  const incomplete = entries.some((e) => e.bucket === "failed" || (e.bucket === "notScanned" && e.reasons[0]!.code !== "SAMPLE_LIMIT"));
  return {
    options,
    status: stops.length > 0 || incomplete ? "partial" : "complete",
    stopReasons: stops,
    window: windowOf(requests),
    budget: { limit: budget.limit, used: budget.used },
    discovery: { pages, recordsReceived, stoppedBecause, duplicates, warnings: orderWarnings(entries, options) },
    entries,
    ranked,
    requests,
  };
}

function assertWithinLimits(o: ScanOptions): void {
  const checks: [string, number, number, number][] = [
    ["maxMarkets", o.maxMarkets, 1, SCAN_LIMITS.maxMarkets],
    ["top", o.top, 1, SCAN_LIMITS.top],
    ["pageSize", o.pageSize, 1, SCAN_LIMITS.pageSize],
    ["maxPages", o.maxPages, 1, SCAN_LIMITS.maxPages],
    ["maxRequests", o.maxRequests, 1, SCAN_LIMITS.maxRequests],
    ["concurrency", o.concurrency, 1, SCAN_LIMITS.concurrency],
    ["maxDurationMs", o.maxDurationMs, SCAN_LIMITS.minDurationMs, SCAN_LIMITS.maxDurationMs],
  ];
  const bad = checks.filter(([, v, min, max]) => !Number.isInteger(v) || v < min || v > max);
  if (bad.length > 0) {
    throw new MarketMindError("Usage", "Scan options outside hard limits", {
      issues: bad.map(([name, v, min, max]) => `${name}=${v} not in ${min}..${max}`),
    });
  }
}

function classifyRecord(item: Market | SkippedMarket, position: number, discoveryPage: number): ScanEntry {
  const base = {
    position,
    discoveryPage,
    association: "not_attempted" as const,
    eligible: false,
    selected: false,
    warnings: [],
    explanation: [],
    outcomes: [],
    metrics: null,
  };
  if (!("gammaId" in item)) {
    return {
      ...base,
      gammaId: item.id,
      market: null,
      bucket: "failed",
      reasons: [{ code: "MALFORMED_RECORD", detail: item.issues[0] ?? "malformed Gamma market record" }],
      issues: item.issues,
    };
  }
  const eligibility = scanEligibility(item);
  return {
    ...base,
    gammaId: item.gammaId,
    market: item,
    eligible: eligibility.bucket === "eligible",
    // Eligible markets are provisionally notScanned until selection and inspection decide.
    bucket: eligibility.bucket === "eligible" ? "notScanned" : eligibility.bucket,
    reasons: eligibility.reasons,
    issues: [],
  };
}

function notScanned(entry: ScanEntry, code: NotScannedCode, detail: string): void {
  entry.bucket = "notScanned";
  entry.reasons = [{ code, detail }];
}

function orderRejection(error: MarketMindError, options: ScanOptions): MarketMindError | null {
  if (options.discoverOrder === "none" || error.kind !== "HttpStatus" || error.details.status !== 422) return null;
  return new MarketMindError(
    "Validation",
    `Gamma rejected discovery order "${options.discoverOrder}" (${error.message}); rerun with --discover-order none to sample in Gamma's default order`,
    error.details,
  );
}

/** Advisory: report the first place where Gamma's volume24hr order was not non-increasing. */
function orderWarnings(entries: readonly ScanEntry[], options: ScanOptions): string[] {
  if (options.discoverOrder !== "volume24hr") return [];
  let previous: { id: string; v: number } | null = null;
  for (const e of entries) {
    const v = e.market?.volume24hr;
    if (v === null || v === undefined) continue;
    if (previous && v > previous.v) {
      return [`DISCOVERY_ORDER_NOT_MONOTONIC: market ${e.gammaId} volume24hr ${v} > ${previous.v} of market ${previous.id}`];
    }
    previous = { id: e.gammaId!, v };
  }
  return [];
}

function limited(inner: HttpClient, limiter: Limiter): HttpClient {
  return { getJson: (source, endpoint, url) => limiter.run(() => inner.getJson(source, endpoint, url)) };
}

function recorded(inner: HttpClient, log: { key: SortKey; record: RequestRecord }[], key: SortKey, scope: string): HttpClient {
  return {
    async getJson(source, endpoint, url) {
      try {
        const response = await inner.getJson(source, endpoint, url);
        const p = response.provenance;
        log.push({ key, record: { scope, source, endpoint, url, httpStatus: p.httpStatus, attempts: p.timing.attempts, timing: p.timing, error: null } });
        return response;
      } catch (error) {
        // A request refused before its first attempt never reached the network: nothing to record.
        if (isMarketMindError(error) && (error.details.attempts ?? 0) > 0) {
          log.push({
            key,
            record: {
              scope,
              source,
              endpoint,
              url,
              httpStatus: error.details.status ?? null,
              attempts: error.details.attempts ?? 0,
              timing: error.details.timing ?? null,
              error: { kind: error.kind, message: error.message },
            },
          });
        }
        throw error;
      }
    },
  };
}

function compareKeys(a: SortKey, b: SortKey): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function windowOf(requests: readonly RequestRecord[]): ScanResult["window"] {
  const timings = requests.map((r) => r.timing).filter((t): t is RequestTiming => t !== null);
  if (timings.length === 0) return null;
  const starts = timings.map((t) => t.firstAttemptStartedAt).sort();
  const ends = timings.map((t) => t.responseReceivedAt).sort();
  return { firstRequestStartedAt: starts[0]!, lastResponseReceivedAt: ends.at(-1)! };
}
