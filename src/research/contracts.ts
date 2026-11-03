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

/**
 * Limits of the local web app (Stage 3.1). One browser request makes at most one bounded live call:
 * a listing is one Gamma keyset page (1 retry, so at most 2 attempts); an inspection is exactly the
 * MCP tool's (at most 8 attempts). The process ceiling and rolling window cap a browsing session.
 */
export const WEB_LIMITS = {
  list: { pageSize: 50, maxPages: 5, maxAttempts: 2, maxRetries: 1, deadlineMs: 10_000 },
  inspect: { maxAttempts: MCP_LIMITS.inspect.maxAttempts, deadlineMs: MCP_LIMITS.inspect.deadlineMs },
  /** Live HTTP attempts per web server process (MARKETMIND_WEB_MAX_REQUESTS overrides). */
  processRequests: { default: 2_000, max: 20_000 },
  /** Attempts within any trailing five minutes (MARKETMIND_WEB_WINDOW_REQUESTS overrides). */
  window: { requests: { default: 60, max: 600 }, windowMs: 300_000 },
  /** Gamma keyset cursors are opaque: bounded in length, printable, and never interpreted. */
  cursorChars: 512,
  /** After an upstream HTTP 429, live routes refuse locally (no request reaches Polymarket) for this long. */
  rateLimitCooldownMs: 60_000,
  skippedShown: 10,
  outcomeLabelsShown: 10,
  /** Stored-data routes (Stage 3.2): offline reads of the local database, never the live gate. */
  storedMarkets: { limit: { default: 50, max: 100 }, maxOffset: 1_000_000 },
  storedRuns: { limit: { default: 20, max: 100 } },
  /**
   * The newest observations of a market's analysis window returned for plotting. Statistics still use
   * the whole analysis window (up to HISTORY_MAX_OBSERVATIONS = 20,000 observations).
   */
  history: { seriesMax: 2_000 },
} as const;

export const WEB_CONTRACT = {
  markets: "marketmind.web.list_markets/1",
  storedMarkets: "marketmind.web.stored_markets/1",
  storedRuns: "marketmind.web.collection_runs/1",
  history: "marketmind.web.market_history/1",
  status: "marketmind.web.status/1",
  error: "marketmind.web.error/1",
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
/** A median of whole milliseconds: with an even number of gaps it is the mean of the middle two, so it can end in .5. */
const MedianMs = z.number().min(0);

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

/**
 * Opaque keyset cursor: any printable text up to the length bound (no control, bidi-control or lone
 * surrogate characters). It is only ever sent as the value of Gamma's after_cursor query parameter,
 * encoded by URLSearchParams, so it cannot change the upstream host or path.
 */
export const Cursor = z
  .string()
  .min(1)
  .max(WEB_LIMITS.cursorChars)
  .regex(/^[^\p{Cc}\p{Cs}\p{Bidi_Control}]+$/u, "an opaque keyset cursor from a previous page");

export const MarketsInput = obj({
  version: z.enum(["v1", "v2"]).default("v1").describe("Protocol version to list."),
  cursor: Cursor.optional().describe("nextCursor from the previous page; omit for the first page."),
});

/**
 * Provenance filter of the stored-data routes: "live" excludes synthetic (test or demonstration)
 * runs and observations; "all" includes them, each marked by sourceType. Omitted, the server's
 * default applies (live, except in a synthetic demonstration server).
 */
export const Source = z.enum(["live", "all"]);
export type Source = z.infer<typeof Source>;

const W = WEB_LIMITS;

export const StoredMarketsInput = obj({
  source: Source.optional(),
  limit: int(1, W.storedMarkets.limit.max).default(W.storedMarkets.limit.default),
  offset: int(0, W.storedMarkets.maxOffset).default(0),
});

export const WebRunsInput = obj({
  source: Source.optional(),
  limit: int(1, W.storedRuns.limit.max).default(W.storedRuns.limit.default),
});

export const WebHistoryInput = obj({
  marketId: gammaId,
  source: Source.optional(),
  asOf: asOf.optional(),
  spreadThreshold: unitDecimal.default("0.02"),
  analyticsVersion: int(1, 1_000_000).default(ANALYTICS_VERSION),
});

export const WebDetailsInput = obj({
  observationId: int(1, Number.MAX_SAFE_INTEGER),
  source: Source.optional(),
  asOf: asOf.optional(),
  levels: int(0, L.details.levels.max).default(L.details.levels.default),
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

const WindowBudget = obj({ limit: Count, windowMs: Count, used: Count, remaining: Count });
const WebBudget = obj({ ...Budget.shape, window: WindowBudget.nullable() });

/**
 * One Gamma keyset page for the web Market Explorer. Metadata only: listing never fetches order
 * books, so nothing here describes prices, spreads or depth. A null field means Gamma did not report it.
 */
export const MarketsOutput = envelope(WEB_CONTRACT.markets, ["ok", "empty"], {
  volumeNote: z.string(),
  appliedLimits: obj({ version: Protocol, order: z.literal("volume24hr"), pageSize: Count, maxAttempts: Count, deadlineMs: Count }),
  query: obj({ cursor: Cursor.nullable() }),
  markets: obj({
    returnedCount: Count,
    items: z
      .array(
        obj({
          gammaId: z.string(),
          conditionId: z.string(),
          protocolVersion: Protocol,
          question: z.string(),
          slug: z.string(),
          outcomeLabels: z.array(z.string()).max(WEB_LIMITS.outcomeLabelsShown),
          outcomeCount: Count,
          active: z.boolean(),
          closed: z.boolean(),
          acceptingOrders: z.boolean().nullable(),
          enableOrderBook: z.boolean().nullable(),
          negRisk: z.boolean().nullable(),
          endDate: z.string().nullable(),
          /** Gamma-reported 24h traded volume: ordering only, never liquidity or depth. */
          gammaVolume24hr: z.string().nullable(),
          eligibility: obj({ inspectable: z.boolean(), reasons: z.array(z.string()), warnings: z.array(z.string()) }),
        }),
      )
      .max(WEB_LIMITS.list.pageSize),
  }),
  skipped: obj({ ...Truncation, items: z.array(obj({ id: z.string().nullable(), issues: z.array(z.string()) })).max(WEB_LIMITS.skippedShown) }),
  pagination: obj({
    nextCursor: Cursor.nullable(),
    /** CURSOR_UNSUPPORTED: Gamma returned a cursor that is too long or not printable text, so paging stops here. */
    stoppedReason: z.enum(["LAST_PAGE", "CURSOR_UNSUPPORTED"]).nullable(),
  }),
  request: Request,
  budget: WebBudget,
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
const SourceType = z.enum(["live", "synthetic"]);

const HistoryAppliedLimits = obj({
  marketId: z.string(),
  asOf: Iso.nullable(),
  limit: Count,
  spreadThreshold: Dec,
  analyticsVersion: Count,
  includeSynthetic: z.boolean(),
});

/** The observations statistics are computed from: the newest up to maxObservations available by asOf. */
const AnalysisWindow = obj({ observations: Count, truncated: z.boolean(), maxObservations: Count, oldestAvailableAt: Iso, newestAvailableAt: Iso });

/** Sample-count statistics over every usable observation of the analysis window (never time-weighted). */
const HistoryStats = obj({
  eligible: Count,
  usable: Count,
  notUsable: z.record(z.string(), Count),
  firstUsableAt: Iso.nullable(),
  lastUsableAt: Iso.nullable(),
  spread: obj({ n: Count, min: Stat, median: Stat, max: Stat, current: Stat, previous: Stat, change: Stat }),
  topSize: obj({ n: Count, current: Stat, previous: Stat, change: Stat }),
  threshold: obj({ n: Count, threshold: Dec, atOrAbove: Count, percentOfSamples: Stat }),
  gaps: obj({ n: Count, minMs: Count.nullable(), medianMs: MedianMs.nullable(), maxMs: Count.nullable(), irregular: Count }),
  states: obj({ n: Count, distinct: Count }),
});

const HistoryFlags = obj({
  notUsable: z.string().nullable(),
  unchanged: z.boolean().nullable(),
  gapMs: Count.nullable(),
  changes: z.array(z.string()),
});

/** Fields of one stored observation shared by get_market_history rows and the web history series. */
const historyRowShape = {
  observationId: Count,
  runId: z.string(),
  sourceType: SourceType,
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
  books: z.array(obj({ outcomeIndex: Count, label: z.string(), quality: Quality, contentHash: z.string(), responseReceivedAt: Iso, serverTimestampIso: Iso.nullable() })),
};

export const HistoryOutput = envelope(CONTRACT.history, ["ok", "no_history"], {
  evidence: z.enum(["available", "insufficient"]),
  appliedLimits: HistoryAppliedLimits,
  analysisWindow: AnalysisWindow.nullable(),
  stats: HistoryStats.nullable(),
  rows: obj({
    ...Truncation,
    items: z.array(obj({ ...historyRowShape, metrics: StoredMetrics.nullable(), flags: HistoryFlags })),
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

// ---- web stored-data outputs (Stage 3.2) ----

/** Stored metrics of one analytics version, with the reference book's sizes and displayed depth. */
const WebStoredMetrics = obj({
  ...StoredMetrics.shape,
  bestBidSize: Dec.nullable(),
  bestAskSize: Dec.nullable(),
  bidDepth: Dec.nullable(),
  askDepth: Dec.nullable(),
  bidBandDepth: Dec.nullable(),
  askBandDepth: Dec.nullable(),
  /** A per-run setting: band depths of observations with different bands are not comparable. */
  depthBand: Dec.nullable(),
  bidLevels: Count.nullable(),
  askLevels: Count.nullable(),
});

/**
 * One market's stored history for the browser: the same statistics and analysis window as
 * get_market_history, plus a series of the newest observations of that window for plotting.
 */
export const WebHistoryOutput = envelope(WEB_CONTRACT.history, ["ok", "no_history"], {
  evidence: z.enum(["available", "insufficient"]),
  appliedLimits: obj({
    marketId: z.string(),
    source: Source,
    asOf: Iso.nullable(),
    spreadThreshold: Dec,
    analyticsVersion: Count,
    seriesMax: Count,
  }),
  analysisWindow: AnalysisWindow.nullable(),
  stats: HistoryStats.nullable(),
  series: obj({
    /** Observations returned (newest first): the newest `returnedCount` of the analysis window's `windowObservations`. */
    returnedCount: Count,
    windowObservations: Count,
    /** True when the series holds fewer observations than the analysis window the statistics use. */
    truncated: z.boolean(),
    oldestAvailableAt: Iso.nullable(),
    newestAvailableAt: Iso.nullable(),
    sourceCounts: obj({ live: Count, synthetic: Count }),
    items: z
      .array(
        obj({
          ...historyRowShape,
          metrics: WebStoredMetrics.nullable(),
          /** irregularGap: the gap since the previous usable observation exceeds twice the window's median gap. */
          flags: obj({ ...HistoryFlags.shape, irregularGap: z.boolean() }),
        }),
      )
      .max(WEB_LIMITS.history.seriesMax),
  }),
});

/** Markets with stored observations, most recently observed first. Nothing here is fetched live. */
export const StoredMarketsOutput = envelope(WEB_CONTRACT.storedMarkets, ["ok", "empty"], {
  appliedLimits: obj({ source: Source, limit: Count, offset: Count }),
  markets: obj({
    returnedCount: Count,
    hasMore: z.boolean(),
    nextOffset: Count.nullable(),
    items: z
      .array(
        obj({
          gammaId: z.string(),
          conditionId: z.string(),
          protocolVersion: Protocol,
          /** Stored observations within the source filter; liveObservations + syntheticObservations = observations. */
          observations: Count,
          liveObservations: Count,
          syntheticObservations: Count,
          firstAvailableAt: Iso,
          lastAvailableAt: Iso,
          /** The newest stored observation (within the source filter) describes the market. */
          latest: obj({
            observationId: Count,
            runId: z.string(),
            sourceType: SourceType,
            runStatus: RunStatus,
            question: z.string(),
            outcomeLabels: z.array(z.string()).max(WEB_LIMITS.outcomeLabelsShown),
            outcomeCount: Count,
            active: z.boolean(),
            closed: z.boolean(),
          }),
        }),
      )
      .max(WEB_LIMITS.storedMarkets.limit.max),
  }),
});

/** list_collection_runs for the browser: the same runs view, naming the source filter that produced it. */
export const WebRunsOutput = obj({
  ...RunsOutput.shape,
  contract: z.literal(WEB_CONTRACT.storedRuns),
  appliedLimits: obj({ limit: Count, source: Source }),
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

/** Web API errors: the shared categories plus request-level refusals that never reach a live call. */
export const WebErrorCategory = z.enum([...ErrorCategory.options, "forbidden", "route_not_found", "method_not_allowed"]);
export type WebErrorCategory = z.infer<typeof WebErrorCategory>;

export const WebErrorOutput = obj({
  contract: z.literal(WEB_CONTRACT.error),
  error: obj({
    category: WebErrorCategory,
    code: z.string().nullable(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()),
  }),
});
export type WebErrorOutput = z.infer<typeof WebErrorOutput>;

/** GET /api/status: version, limits and remaining live capacity. No paths, environment values or secrets. */
export const WebStatusOutput = obj({
  contract: z.literal(WEB_CONTRACT.status),
  appVersion: z.string(),
  generatedAt: Iso,
  readOnly: z.literal(true),
  limits: obj({
    list: obj({ pageSize: Count, maxAttempts: Count, deadlineMs: Count }),
    inspect: obj({ maxAttempts: Count, deadlineMs: Count, levels: obj({ default: Count, max: Count }) }),
    rateLimitCooldownMs: Count,
  }),
  budget: obj({ process: obj({ limit: Count, used: Count, remaining: Count }), window: WindowBudget.nullable() }),
  rateLimit: obj({ coolingDown: z.boolean(), retryAfterMs: Count }),
  /** False on a server that must never call Polymarket (e.g. a synthetic demonstration): live routes are refused. */
  live: obj({ enabled: z.boolean() }),
  /**
   * Stored-data routes: the source filter applied when a request names none, and whether the local
   * database file exists (its schema and contents are checked by the stored routes themselves).
   */
  stored: obj({ defaultSource: Source, database: z.enum(["present", "missing"]) }),
});
export type WebStatusOutput = z.infer<typeof WebStatusOutput>;

export type ScanOutput = z.infer<typeof ScanOutput>;
export type InspectOutput = z.infer<typeof InspectOutput>;
export type RunsOutput = z.infer<typeof RunsOutput>;
export type HistoryOutput = z.infer<typeof HistoryOutput>;
export type DetailsOutput = z.infer<typeof DetailsOutput>;
export type MarketsInput = z.infer<typeof MarketsInput>;
export type MarketsOutput = z.infer<typeof MarketsOutput>;
export type StoredMarketsInput = z.infer<typeof StoredMarketsInput>;
export type StoredMarketsOutput = z.infer<typeof StoredMarketsOutput>;
export type WebRunsInput = z.infer<typeof WebRunsInput>;
export type WebRunsOutput = z.infer<typeof WebRunsOutput>;
export type WebHistoryInput = z.infer<typeof WebHistoryInput>;
export type WebHistoryOutput = z.infer<typeof WebHistoryOutput>;
export type WebDetailsInput = z.infer<typeof WebDetailsInput>;
