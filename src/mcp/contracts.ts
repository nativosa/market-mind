import { z } from "zod";
import { ANALYTICS_VERSION } from "../analytics/version.js";

/** Conservative MCP limits: stricter than the CLI's, because an agent may call tools repeatedly. */
export const MCP_LIMITS = {
  scan: {
    maxMarkets: { default: 5, max: 10 },
    top: { default: 5, max: 10 },
    pageSize: { default: 20, max: 50 },
    maxPages: { default: 1, max: 2 },
    maxRequests: { default: 16, max: 32 },
    maxDurationMs: { default: 30_000, min: 1_000, max: 60_000 },
    concurrency: 2,
  },
  inspect: { levels: { default: 5, max: 20 }, maxAttempts: 8, maxRetries: 1, deadlineMs: 20_000 },
  runs: { limit: { default: 10, max: 50 } },
  history: { limit: { default: 10, max: 25 } },
  details: { levels: { default: 10, max: 50 } },
  /** Live HTTP attempts per server process (MARKETMIND_MCP_MAX_REQUESTS overrides, 1..1000). */
  processRequests: { default: 200, max: 1_000 },
  /** Hard bound on the serialized CallToolResult (structured content and text together). */
  maxResultChars: 32_000,
  /** Untrusted upstream text is truncated to these lengths. */
  questionChars: 300,
  labelChars: 100,
} as const;

export const CONTRACT = {
  scan: "marketmind.scan_markets/1",
  inspect: "marketmind.inspect_market/1",
  runs: "marketmind.list_collection_runs/1",
  history: "marketmind.get_market_history/1",
  details: "marketmind.get_observation_details/1",
  error: "marketmind.error/1",
} as const;

// ---- shared field schemas ----

const obj = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** A decimal in [0, 1], as a string (e.g. "0.02"). */
const unitDecimal = z.string().regex(/^(0(\.\d{1,18})?|1(\.0{1,18})?)$/, "a decimal string between 0 and 1, e.g. \"0.02\"");
const sharesDecimal = z.string().regex(/^\d{1,12}(\.\d{1,18})?$/, "a non-negative decimal string, e.g. \"10\"");
const gammaId = z.string().regex(/^[0-9]{1,20}$/, "a numeric Gamma market id");
const asOf = z.iso
  .datetime({ offset: true })
  .describe("Evidence-availability boundary (inclusive), ISO-8601 with a time zone, e.g. 2026-10-29T08:00:00Z. Nothing that became available later is used.");

const Dec = z.string().regex(/^-?\d+(\.\d+)?$/);
const Iso = z.string();
const Count = z.number().int().min(0);

// ---- inputs ----

const L = MCP_LIMITS;

export const ScanInput = obj({
  version: z.enum(["v1", "v2"]).default("v1").describe("Protocol version of the markets to discover."),
  maxMarkets: int(1, L.scan.maxMarkets.max).default(L.scan.maxMarkets.default).describe("Eligible markets to inspect (3 requests each)."),
  top: int(1, L.scan.top.max).default(L.scan.top.default).describe("Ranked candidates to return."),
  pageSize: int(1, L.scan.pageSize.max).default(L.scan.pageSize.default).describe("Gamma records per discovery page."),
  maxPages: int(1, L.scan.maxPages.max).default(L.scan.maxPages.default).describe("Discovery pages to fetch at most."),
  minSpread: unitDecimal.default("0").describe("Minimum reference spread for ranking."),
  minTopSize: sharesDecimal.default("10").describe("Minimum of best bid size and best ask size, in shares."),
  includeSuspicious: z.boolean().default(false).describe("Rank books with nonfatal quality issues too."),
  depthBand: unitDecimal.nullable().default("0.05").describe("Price band for depth near the best price, or null."),
  maxRequests: int(1, L.scan.maxRequests.max).default(L.scan.maxRequests.default).describe("Hard cap on HTTP attempts for this call, retries included."),
  maxDurationMs: int(L.scan.maxDurationMs.min, L.scan.maxDurationMs.max).default(L.scan.maxDurationMs.default).describe("Deadline for this call."),
});

export const InspectInput = obj({
  marketId: gammaId.describe("Gamma market id, e.g. from scan_markets."),
  levels: int(0, L.inspect.levels.max).default(L.inspect.levels.default).describe("Aggregated price levels per side to return, best first."),
  depthBand: unitDecimal.nullable().default("0.05").describe("Price band for depth near the best price, or null."),
});

export const RunsInput = obj({
  limit: int(1, L.runs.limit.max).default(L.runs.limit.default).describe("Most recent collection runs to return."),
});

export const HistoryInput = obj({
  marketId: gammaId.describe("Gamma market id."),
  asOf: asOf.optional(),
  limit: int(1, L.history.limit.max).default(L.history.limit.default).describe("Most recent observations to list. Statistics always use the whole analysis window."),
  spreadThreshold: unitDecimal.default("0.02").describe("Spread threshold for the share-of-samples statistic."),
  analyticsVersion: int(1, 1_000_000).default(ANALYTICS_VERSION).describe("Metrics version to use; versions are never mixed."),
  includeSynthetic: z.boolean().default(false).describe("Include synthetic (test) runs."),
});

export const DetailsInput = obj({
  observationId: int(1, Number.MAX_SAFE_INTEGER).describe("observationId from get_market_history."),
  asOf: asOf.optional(),
  levels: int(0, L.details.levels.max).default(L.details.levels.default).describe("Captured price levels per side to return, in wire order."),
});

// ---- outputs ----

const Truncation = { returnedCount: Count, totalCount: Count, truncated: z.boolean() };
const Level = obj({ price: z.string(), size: z.string() });
const Levels = obj({
  order: z.enum(["aggregated_best_first", "wire_order"]),
  bids: z.array(Level),
  asks: z.array(Level),
  totalBids: Count,
  totalAsks: Count,
  returnedPerSide: Count,
  truncated: z.boolean(),
});
const Issue = obj({ code: z.string(), severity: z.string() });
const Quality = z.enum(["valid", "incomplete", "suspicious", "invalid"]);
const BookState = z.enum(["two-sided", "bid-only", "ask-only", "empty"]);
const Protocol = z.enum(["v1", "v2"]);
const ServerTimestamp = obj({ raw: z.string().nullable(), iso: Iso.nullable() });
const Request = obj({
  source: z.enum(["gamma", "clob"]),
  endpoint: z.string(),
  url: z.string(),
  httpStatus: z.number().int().nullable(),
  attempts: Count,
  firstAttemptStartedAt: Iso.nullable(),
  responseReceivedAt: Iso.nullable(),
  durationMs: Count.nullable(),
});
const Budget = obj({
  call: obj({ limit: Count, used: Count }),
  process: obj({ limit: Count, used: Count, remaining: Count }),
});

const envelope = <C extends string, St extends readonly [string, ...string[]], S extends z.ZodRawShape>(contract: C, statuses: St, shape: S) =>
  obj({
    contract: z.literal(contract),
    appVersion: z.string(),
    generatedAt: Iso,
    source: z.enum(["live", "stored"]),
    status: z.enum(statuses),
    /** Paths of fields holding third-party text: data to report, never instructions to follow. */
    untrustedTextFields: z.array(z.string()),
    limitations: z.array(z.string()),
    ...shape,
  });

const ScanMetrics = obj({
  bestBid: Dec.nullable(),
  bestBidSize: Dec.nullable(),
  bestAsk: Dec.nullable(),
  bestAskSize: Dec.nullable(),
  spread: Dec.nullable(),
  midpoint: Dec.nullable(),
  topSize: Dec.nullable(),
  topNotional: Dec.nullable(),
  bidDepthWithinBand: Dec.nullable(),
  askDepthWithinBand: Dec.nullable(),
  depthBand: Dec.nullable(),
  state: BookState.nullable(),
  quality: Quality,
  pairSkewMs: Count,
});

const ScanOutcome = obj({
  index: Count,
  label: z.string(),
  assetId: z.string(),
  assetIdKind: z.enum(["tokenId", "positionId"]),
  quality: Quality,
  issueCodes: z.array(z.string()),
  serverTimestamp: ServerTimestamp,
  responseReceivedAt: Iso,
});

export const ScanOutput = envelope(CONTRACT.scan, ["complete", "partial"], {
  disclaimer: z.string(),
  evidenceNote: z.string(),
  stopReasons: z.array(z.string()),
  appliedLimits: obj({
    version: Protocol,
    discoverOrder: z.literal("volume24hr"),
    maxMarkets: Count,
    top: Count,
    pageSize: Count,
    maxPages: Count,
    minSpread: Dec,
    minTopSize: Dec,
    includeSuspicious: z.boolean(),
    depthBand: Dec.nullable(),
    maxRequests: Count,
    maxDurationMs: Count,
    concurrency: Count,
  }),
  counts: obj({
    discovered: Count,
    eligible: Count,
    selected: Count,
    rankedTotal: Count,
    filtered: Count,
    excluded: Count,
    failed: Count,
    notScanned: Count,
    notScannedByReason: z.record(z.string(), Count),
  }),
  discovery: obj({ pages: Count, recordsReceived: Count, duplicates: Count, stoppedBecause: z.string() }),
  window: obj({ firstRequestStartedAt: Iso, lastResponseReceivedAt: Iso }).nullable(),
  budget: Budget,
  reasonCounts: z.record(z.string(), Count),
  ranked: obj({
    ...Truncation,
    items: z.array(
      obj({
        rank: Count,
        gammaId: z.string(),
        conditionId: z.string(),
        protocolVersion: Protocol,
        question: z.string(),
        endDate: z.string().nullable(),
        reference: obj({ index: Count, label: z.string(), assetId: z.string() }),
        outcomes: z.array(ScanOutcome),
        metrics: ScanMetrics,
        warningCodes: z.array(z.string()),
        explanation: z.array(z.string()),
      }),
    ),
  }),
  notRanked: obj({
    ...Truncation,
    items: z.array(
      obj({
        gammaId: z.string().nullable(),
        protocolVersion: Protocol.nullable(),
        bucket: z.enum(["filtered", "excluded", "failed", "notScanned"]),
        reasonCodes: z.array(z.string()),
        warningCodes: z.array(z.string()),
        question: z.string().nullable(),
      }),
    ),
  }),
});

const InspectMetrics = obj({
  bestBid: Dec.nullable(),
  bestBidSize: Dec.nullable(),
  bestAsk: Dec.nullable(),
  bestAskSize: Dec.nullable(),
  spread: Dec.nullable(),
  midpoint: Dec.nullable(),
  bidDepth: Dec,
  askDepth: Dec,
  bidDepthWithinBand: Dec.nullable(),
  askDepthWithinBand: Dec.nullable(),
  depthBand: Dec.nullable(),
  state: BookState,
  crossed: z.boolean(),
  locked: z.boolean(),
});

export const InspectOutput = envelope(CONTRACT.inspect, ["ok", "invalid_book"], {
  evidenceNote: z.string(),
  appliedLimits: obj({ levels: Count, depthBand: Dec.nullable(), maxAttempts: Count, deadlineMs: Count }),
  market: obj({
    gammaId: z.string(),
    conditionId: z.string(),
    protocolVersion: Protocol,
    question: z.string(),
    slug: z.string(),
    active: z.boolean(),
    closed: z.boolean(),
    acceptingOrders: z.boolean().nullable(),
    enableOrderBook: z.boolean().nullable(),
    negRisk: z.boolean().nullable(),
    endDate: z.string().nullable(),
    gammaVolume24hr: z.string().nullable(),
  }),
  association: obj({ method: z.string(), gammaIndexCrossCheck: z.string() }),
  eligibilityWarnings: z.array(z.string()),
  pairSkewMs: Count,
  outcomes: z.array(
    obj({
      index: Count,
      label: z.string(),
      role: z.enum(["YES", "NO"]).nullable(),
      assetId: z.string(),
      assetIdKind: z.enum(["tokenId", "positionId"]),
      quality: Quality,
      issues: z.array(Issue),
      metrics: InspectMetrics.nullable(),
      levels: Levels,
      book: obj({
        tickSize: z.string().nullable(),
        minOrderSize: z.string().nullable(),
        lastTradePrice: z.string().nullable(),
        negRisk: z.boolean().nullable(),
        upstreamHash: z.string().nullable(),
        serverTimestamp: ServerTimestamp,
      }),
      request: Request,
    }),
  ),
  requests: z.array(Request),
  budget: Budget,
});

const OwnerAssessment = z.enum(["RECOVERABLE", "OTHER_HOST", "OWNER_ALIVE", "OWNER_UNKNOWN", "HEARTBEAT_FRESH"]);
const RunStatus = z.enum(["running", "complete", "partial", "interrupted", "failed"]);
const Accounting = z.enum(["pending", "verified", "incomplete"]);
const CountMap = z.record(z.string(), z.union([Count, z.null(), z.record(z.string(), Count)]));

export const RunsOutput = envelope(CONTRACT.runs, ["ok", "empty"], {
  appliedLimits: obj({ limit: Count }),
  database: obj({ schemaVersion: Count, footprintBytes: obj({ main: Count, wal: Count, shm: Count, total: Count }) }),
  runs: obj({
    returnedCount: Count,
    hasMore: z.boolean(),
    items: z.array(
      obj({
        runId: z.string(),
        sourceType: z.enum(["live", "synthetic"]),
        status: RunStatus,
        accounting: Accounting,
        startedAt: Iso,
        finishedAt: Iso.nullable(),
        appVersion: z.string(),
        buildId: z.string().nullable(),
        schemaVersion: Count,
        analyticsVersion: Count,
        protocolVersion: Protocol,
        stopReasons: z.array(z.string()).nullable(),
        scanCounts: CountMap.nullable(),
        persistCounts: CountMap.nullable(),
        budget: obj({ limit: Count, used: Count.nullable() }),
        window: obj({ first: Iso.nullable(), last: Iso.nullable() }),
        recoveredReason: z.string().nullable(),
        errorCode: z.string().nullable(),
        owner: obj({ assessment: OwnerAssessment, onThisHost: z.boolean(), heartbeatAt: Iso, note: z.string() }).nullable(),
      }),
    ),
  }),
});

const StoredMetrics = obj({
  analyticsVersion: Count,
  referenceIndex: Count,
  bestBid: Dec.nullable(),
  bestAsk: Dec.nullable(),
  spread: Dec.nullable(),
  midpoint: Dec.nullable(),
  topSize: Dec.nullable(),
  state: BookState.nullable(),
  quality: Quality,
  pairSkewMs: Count,
  computedAt: Iso,
  computedBy: z.enum(["collect", "recompute"]),
  /** Computed after `asOf` from evidence available before it. */
  retrospective: z.boolean(),
});

const Stat = Dec.nullable();

export const HistoryOutput = envelope(CONTRACT.history, ["ok", "no_history"], {
  evidence: z.enum(["available", "insufficient"]),
  appliedLimits: obj({
    marketId: z.string(),
    asOf: Iso.nullable(),
    limit: Count,
    spreadThreshold: Dec,
    analyticsVersion: Count,
    includeSynthetic: z.boolean(),
  }),
  analysisWindow: obj({ observations: Count, truncated: z.boolean(), maxObservations: Count, oldestAvailableAt: Iso, newestAvailableAt: Iso }).nullable(),
  stats: obj({
    eligible: Count,
    usable: Count,
    notUsable: z.record(z.string(), Count),
    firstUsableAt: Iso.nullable(),
    lastUsableAt: Iso.nullable(),
    spread: obj({ n: Count, min: Stat, median: Stat, max: Stat, current: Stat, previous: Stat, change: Stat }),
    topSize: obj({ n: Count, current: Stat, previous: Stat, change: Stat }),
    threshold: obj({ n: Count, threshold: Dec, atOrAbove: Count, percentOfSamples: Stat }),
    gaps: obj({ n: Count, minMs: Count.nullable(), medianMs: Count.nullable(), maxMs: Count.nullable(), irregular: Count }),
    states: obj({ n: Count, distinct: Count }),
  }).nullable(),
  rows: obj({
    ...Truncation,
    items: z.array(
      obj({
        observationId: Count,
        runId: z.string(),
        sourceType: z.enum(["live", "synthetic"]),
        /** Present only without `asOf`: a run's final status is later knowledge. */
        runStatus: RunStatus.optional(),
        availableAt: Iso,
        availabilityBasis: z.enum(["paired_books", "single_book", "association", "discovery"]),
        pairing: z.enum(["paired", "incomplete", "none"]),
        association: z.enum(["confirmed", "mismatch", "failed", "not_attempted"]),
        bucket: z.enum(["ranked", "filtered", "excluded", "failed", "notScanned"]),
        reasonCodes: z.array(z.string()),
        question: z.string(),
        outcomeLabels: z.array(z.string()),
        active: z.boolean(),
        closed: z.boolean(),
        acceptingOrders: z.boolean().nullable(),
        endDate: z.string().nullable(),
        books: z.array(
          obj({ outcomeIndex: Count, label: z.string(), quality: Quality, contentHash: z.string(), responseReceivedAt: Iso, serverTimestampIso: Iso.nullable() }),
        ),
        metrics: StoredMetrics.nullable(),
        flags: obj({
          notUsable: z.string().nullable(),
          unchanged: z.boolean().nullable(),
          gapMs: Count.nullable(),
          changes: z.array(z.string()),
        }),
      }),
    ),
  }),
});

export const DetailsOutput = envelope(CONTRACT.details, ["ok"], {
  appliedLimits: obj({ observationId: Count, asOf: Iso.nullable(), levels: Count }),
  observation: obj({
    observationId: Count,
    gammaId: z.string(),
    conditionId: z.string(),
    protocolVersion: Protocol,
    discoveryPosition: Count,
    availableAt: Iso,
    availabilityBasis: z.enum(["paired_books", "single_book", "association", "discovery"]),
    persistedAt: Iso.nullable(),
    pairing: z.enum(["paired", "incomplete", "none"]),
    association: z.enum(["confirmed", "mismatch", "failed", "not_attempted"]),
    bucket: z.enum(["ranked", "filtered", "excluded", "failed", "notScanned"]),
    reasonCodes: z.array(z.string()),
    warningCodes: z.array(z.string()),
    question: z.string(),
    slug: z.string(),
    outcomeLabels: z.array(z.string()),
    active: z.boolean(),
    closed: z.boolean(),
    acceptingOrders: z.boolean().nullable(),
    enableOrderBook: z.boolean().nullable(),
    negRisk: z.boolean().nullable(),
    endDate: z.string().nullable(),
    gammaVolume24hr: Dec.nullable(),
    pairSkewMs: Count.nullable(),
  }),
  run: obj({
    runId: z.string(),
    sourceType: z.enum(["live", "synthetic"]),
    startedAt: Iso,
    appVersion: z.string(),
    buildId: z.string().nullable(),
    schemaVersion: Count,
    analyticsVersion: Count,
    protocolVersion: Protocol,
  }),
  runOutcome: obj({ status: RunStatus, accounting: Accounting, finishedAt: Iso.nullable(), recoveredReason: z.string().nullable() }).nullable(),
  books: z.array(
    obj({
      outcomeIndex: Count,
      assetId: z.string(),
      assetIdKind: z.enum(["tokenId", "positionId"]),
      labelObserved: z.string(),
      contentHash: z.string(),
      quality: Quality,
      issues: z.array(Issue),
      reportedAssetId: z.string(),
      reportedConditionId: z.string(),
      upstreamHash: z.string().nullable(),
      serverTimestamp: ServerTimestamp,
      tickSize: z.string().nullable(),
      minOrderSize: z.string().nullable(),
      lastTradePrice: z.string().nullable(),
      negRisk: z.boolean().nullable(),
      levels: Levels,
      request: obj({
        url: z.string(),
        httpStatus: z.number().int(),
        attempts: Count,
        firstAttemptStartedAt: Iso,
        finalAttemptStartedAt: Iso,
        responseReceivedAt: Iso,
        durationMs: Count,
        serverDateHeader: z.string().nullable(),
      }),
    }),
  ),
  metrics: z.array(
    obj({
      analyticsVersion: Count,
      computedAt: Iso,
      computedBy: z.enum(["collect", "recompute"]),
      retrospective: z.boolean(),
      appVersion: z.string(),
      depthBand: Dec.nullable(),
      referenceIndex: Count,
      referenceAssetId: z.string(),
      bestBid: Dec.nullable(),
      bestBidSize: Dec.nullable(),
      bestAsk: Dec.nullable(),
      bestAskSize: Dec.nullable(),
      spread: Dec.nullable(),
      midpoint: Dec.nullable(),
      topSize: Dec.nullable(),
      topNotional: Dec.nullable(),
      bidDepth: Dec.nullable(),
      askDepth: Dec.nullable(),
      bidBandDepth: Dec.nullable(),
      askBandDepth: Dec.nullable(),
      bidLevels: Count.nullable(),
      askLevels: Count.nullable(),
      state: BookState.nullable(),
      quality: Quality,
      pairSkewMs: Count,
    }),
  ),
  requests: obj({
    withheldAfterAsOf: Count,
    items: z.array(
      obj({
        scope: z.string(),
        source: z.enum(["gamma", "clob"]),
        endpoint: z.string(),
        url: z.string(),
        httpStatus: z.number().int().nullable(),
        attempts: Count,
        startedAt: Iso.nullable(),
        receivedAt: Iso.nullable(),
        errorKind: z.string().nullable(),
      }),
    ),
  }),
});

export const ErrorCategory = z.enum([
  "invalid_arguments",
  "market_not_found",
  "market_ineligible",
  "observation_not_found",
  "observation_not_available_as_of",
  "database_missing",
  "upstream_unavailable",
  "rate_limited",
  "upstream_invalid_data",
  "budget_exhausted",
  "deadline_exceeded",
  "cancelled",
  "storage_error",
  "internal_error",
]);
export type ErrorCategory = z.infer<typeof ErrorCategory>;

export const ErrorOutput = obj({
  contract: z.literal(CONTRACT.error),
  error: obj({
    category: ErrorCategory,
    code: z.string().nullable(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()),
  }),
});
export type ErrorOutput = z.infer<typeof ErrorOutput>;

export type ScanOutput = z.infer<typeof ScanOutput>;
export type InspectOutput = z.infer<typeof InspectOutput>;
export type RunsOutput = z.infer<typeof RunsOutput>;
export type HistoryOutput = z.infer<typeof HistoryOutput>;
export type DetailsOutput = z.infer<typeof DetailsOutput>;
