import { existsSync } from "node:fs";
import { APP_VERSION } from "../config/config.js";
import { GammaMarketSchema } from "../adapters/polymarket/gammaSchemas.js";
import { toMarket, toOrderBook } from "../adapters/polymarket/normalize.js";
import { migrate, SCHEMA_VERSION } from "../adapters/storage/migrations.js";
import type { Liveness } from "../adapters/storage/processLiveness.js";
import { createRun, finalizeRun, persistObservation, recoverRuns } from "../adapters/storage/snapshotStore.js";
import { openDatabase, sqliteVersion, storageError, type Database } from "../adapters/storage/sqlite.js";
import { assessBook } from "../analytics/bookQuality.js";
import { computeScanMetrics, evaluateCandidate } from "../analytics/scanMetrics.js";
import { ANALYTICS_VERSION } from "../analytics/version.js";
import { decimal, decimalToString } from "../domain/decimal.js";
import type { Outcome } from "../domain/market.js";
import type { Provenance } from "../domain/provenance.js";
import type { OutcomeObservation, ScanFilters } from "../domain/scan.js";
import type { ObservationRecord, RequestEvidence, RunStatus } from "../domain/snapshot.js";

// Synthetic demonstration database (npm run web:demo). Every row is written through the same
// storage functions collect uses (migrate, createRun, persistObservation, finalizeRun,
// recoverRuns), so the schema's constraints and the storage invariants apply unchanged. All runs
// are source_type = synthetic, every question starts with DEMO_LABEL, every URL is on the reserved
// .invalid domain, and every timestamp and value is fixed: two generations store the same records.
// Nothing here reads a configuration, opens an existing file or touches the network.

export const DEMO_LABEL = "[SYNTHETIC DEMO]";
/** 2026-01-05 09:00 UTC: the first synthetic run starts here; nothing depends on the real clock. */
export const DEMO_T0 = Date.parse("2026-01-05T09:00:00.000Z");
const MINUTE = 60_000;
const DEPTH_BAND = "0.05";
/** The pretend collector. Its host is not this computer's, so no real process is ever probed for it. */
const DEMO_OWNER = { pid: 1, host: "synthetic-demo.invalid" };
const DEMO_LIVENESS: Liveness = { hostname: () => DEMO_OWNER.host, probe: () => "gone" };
const FILTERS: ScanFilters = { minSpread: decimal("0"), minTopSize: decimal("10"), includeSuspicious: false };

type Level = [price: string, size: string];
interface Book {
  bids: Level[];
  asks: Level[];
  /** Wire fields replaced in the stored body, e.g. an asset_id that does not match the request. */
  raw?: { asset_id?: string };
}

export interface DemoMarket {
  gammaId: string;
  question: string;
}

export interface DemoSample {
  market: DemoMarket;
  /** Reference (first outcome) book; null: not received. */
  ref: Book | null;
  /** Second outcome book; default the exact complement of `ref`; null: its request failed. */
  other?: Book | null;
}

export interface DemoRun {
  runId: string;
  /** Minutes after DEMO_T0. */
  atMinute: number;
  /** "interrupted": left running, then recovered as collect would after its owner process died. */
  status: Exclude<RunStatus, "running" | "failed">;
  samples: DemoSample[];
}

export const DEMO_MARKETS = {
  steady: { gammaId: "990000000000000001", question: `${DEMO_LABEL} Will the synthetic demo index close above 100 on Friday?` },
  irregular: { gammaId: "990000000000000002", question: `${DEMO_LABEL} Will the synthetic weather station record rain this week?` },
  sparse: { gammaId: "990000000000000003", question: `${DEMO_LABEL} Will the synthetic sparse market ever trade?` },
} as const satisfies Record<string, DemoMarket>;

/** Thousandths as a price string ("0.525"). */
const price = (thousandths: number): string => `0.${String(thousandths).padStart(3, "0")}`;

/** The steady market's book at sample i: a slowly moving bid, a spread between 0.006 and 0.03, two levels a side. */
function steadyBook(i: number): Book {
  const bids = [520, 525, 530, 528, 535, 540, 538, 545, 550, 548, 555, 560, 552, 545, 540, 546];
  const spreads = [30, 25, 20, 22, 15, 12, 18, 10, 8, 14, 9, 6, 16, 20, 25, 12];
  const bid = bids[i % bids.length]!;
  const ask = bid + spreads[i % spreads.length]!;
  const size = (base: number) => String(base + ((i * 37) % 180));
  return {
    bids: [
      [price(bid), `${size(120)}.5`],
      [price(bid - 10), size(300)],
    ],
    asks: [
      [price(ask), size(90)],
      [price(ask + 15), `${size(250)}.25`],
    ],
  };
}

function irregularBook(i: number): Book {
  const bid = [300, 310, 305, 320, 318, 330, 325, 335][i % 8]!;
  const spread = [40, 35, 45, 30, 50, 28, 38, 33][i % 8]!;
  return { bids: [[price(bid), String(60 + i * 15)]], asks: [[price(bid + spread), String(80 + ((i * 23) % 70))]] };
}

const { steady, irregular, sparse } = DEMO_MARKETS;

/**
 * The demonstration timeline. The steady market is collected every 15 minutes (16 observations);
 * the irregular market at uneven times, with an invalid book (the CLOB answered for another token)
 * and an incomplete observation (its second book request failed); the sparse market twice, neither
 * time with a two-sided book, so its history is insufficient evidence. The run at 2 h 15 min is interrupted.
 */
export function demoTimeline(): DemoRun[] {
  const irregularAt = new Map<number, DemoSample>([
    [0, { market: irregular, ref: irregularBook(0) }],
    [15, { market: irregular, ref: irregularBook(1) }],
    [30, { market: irregular, ref: irregularBook(2) }],
    [37, { market: irregular, ref: irregularBook(3) }],
    [105, { market: irregular, ref: { ...irregularBook(4), raw: { asset_id: "1" } } }],
    [120, { market: irregular, ref: irregularBook(5), other: null }],
    [195, { market: irregular, ref: irregularBook(6) }],
    [225, { market: irregular, ref: irregularBook(7) }],
  ]);
  const sparseAt = new Map<number, DemoSample>([
    [60, { market: sparse, ref: { bids: [["0.050", "25"]], asks: [] } }],
    [180, { market: sparse, ref: { bids: [], asks: [] } }],
  ]);
  const minutes = [...new Set([...Array.from({ length: 16 }, (_, i) => i * 15), ...irregularAt.keys(), ...sparseAt.keys()])].sort((a, b) => a - b);
  return minutes.map((atMinute, i) => {
    const samples: DemoSample[] = [];
    if (atMinute % 15 === 0) samples.push({ market: steady, ref: steadyBook(atMinute / 15) });
    const extra = [irregularAt.get(atMinute), sparseAt.get(atMinute)].filter((s) => s !== undefined);
    samples.push(...extra);
    const incomplete = samples.some((s) => s.ref === null || s.other === null);
    return {
      runId: `synthetic-demo-${String(i + 1).padStart(2, "0")}`,
      atMinute,
      status: atMinute === 135 ? "interrupted" : incomplete ? "partial" : "complete",
      samples,
    };
  });
}

// ---- record builders (the shapes collect stores; ids and URLs are synthetic) ----

const assetId = (gammaId: string, index: number) => `${gammaId}${index}`;
const conditionId = (gammaId: string) => `0x${gammaId.padStart(64, "d")}`;
const iso = (ms: number) => new Date(ms).toISOString();
const GAMMA_URL = "https://gamma-api.synthetic-demo.invalid";
const CLOB_URL = "https://clob.synthetic-demo.invalid";

function timing(receivedMs: number): Provenance["timing"] {
  return { firstAttemptStartedAt: iso(receivedMs - 40), finalAttemptStartedAt: iso(receivedMs - 40), responseReceivedAt: iso(receivedMs), durationMs: 40, attempts: 1, serverDateHeader: null };
}

function evidence(scope: string, source: "gamma" | "clob", endpoint: string, url: string, receivedMs: number, errorKind: string | null = null): RequestEvidence {
  return { scope, source, endpoint, url, httpStatus: errorKind === null ? 200 : 503, attempts: 1, timing: errorKind === null ? timing(receivedMs) : null, errorKind };
}

function outcomeOf(market: DemoMarket, index: number): Outcome {
  const id = assetId(market.gammaId, index);
  return { index, label: index === 0 ? "Yes" : "No", role: null, assetId: id, assetIdKind: "tokenId", raw: { clobTokenId: id, positionId: null } };
}

const complement = (p: string) => decimalToString(decimal("1").minus(decimal(p)));
const mirror = (book: Book): Book => ({ bids: book.asks.map(([p, s]) => [complement(p), s]), asks: book.bids.map(([p, s]) => [complement(p), s]) });

function bookObservation(market: DemoMarket, index: number, book: Book, receivedMs: number): OutcomeObservation {
  const requested = assetId(market.gammaId, index);
  // Wire order as documented for the CLOB: bids ascending, asks descending.
  const bids = [...book.bids].sort((a, b) => decimal(a[0]).cmp(decimal(b[0])));
  const asks = [...book.asks].sort((a, b) => decimal(b[0]).cmp(decimal(a[0])));
  const ob = toOrderBook(
    {
      market: conditionId(market.gammaId),
      asset_id: book.raw?.asset_id ?? requested,
      timestamp: String(receivedMs - 25),
      hash: `synthetic-demo-${market.gammaId}-${index}-${receivedMs}`,
      bids: bids.map(([p, size]) => ({ price: p, size })),
      asks: asks.map(([p, size]) => ({ price: p, size })),
      min_order_size: "5",
      tick_size: "0.001",
      neg_risk: false,
      last_trade_price: null,
    },
    requested,
    { source: "clob", endpoint: "/book", url: `${CLOB_URL}/book?token_id=${requested}`, httpStatus: 200, timing: timing(receivedMs) },
  );
  return { outcome: outcomeOf(market, index), book: ob, assessment: assessBook(ob, { depthBand: decimal(DEPTH_BAND), expectedConditionId: conditionId(market.gammaId) }) };
}

/** One market's observation in a run started at `startMs`, discovered at `position`. */
export function demoRecord(sample: DemoSample, startMs: number, position: number): ObservationRecord {
  const { market } = sample;
  const t = startMs + position * 1_000;
  const gamma = GammaMarketSchema.parse({
    id: market.gammaId,
    question: market.question,
    conditionId: conditionId(market.gammaId),
    slug: `synthetic-demo-${market.gammaId}`,
    version: "v1",
    outcomes: JSON.stringify(["Yes", "No"]),
    clobTokenIds: JSON.stringify([assetId(market.gammaId, 0), assetId(market.gammaId, 1)]),
    positionIds: null,
    active: true,
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true,
    negRisk: false,
    endDate: null,
    volume24hr: null,
  });
  const discovered = startMs + 200;
  const parsedMarket = toMarket(gamma, { source: "gamma", endpoint: "/markets/keyset", url: `${GAMMA_URL}/markets/keyset`, httpStatus: 200, timing: timing(discovered) });
  const otherSpec = sample.other === undefined ? (sample.ref === null ? null : mirror(sample.ref)) : sample.other;
  const ref = sample.ref === null ? null : bookObservation(market, 0, sample.ref, t + 400);
  const other = otherSpec === null ? null : bookObservation(market, 1, otherSpec, t + 430);
  const books = [ref, other].filter((b) => b !== null);
  const requests: RequestEvidence[] = [
    evidence("discovery page 1", "gamma", "/markets/keyset", `${GAMMA_URL}/markets/keyset`, discovered),
    evidence(`market ${market.gammaId} association`, "clob", "/clob-markets/{condition_id}", `${CLOB_URL}/clob-markets/${conditionId(market.gammaId)}`, t + 300),
    ...[0, 1].map((index) => {
      const book = books.find((b) => b.outcome.index === index);
      const url = `${CLOB_URL}/book?token_id=${assetId(market.gammaId, index)}`;
      const scope = `market ${market.gammaId} book ${index === 0 ? "Yes" : "No"}`;
      return book ? evidence(scope, "clob", "/book", url, Date.parse(book.book.provenance.timing.responseReceivedAt)) : evidence(scope, "clob", "/book", url, t + 430, "HTTP_UPSTREAM_5XX");
    }),
  ];
  let metrics = null;
  let bucket: ObservationRecord["bucket"] = "failed";
  let reasons: ObservationRecord["reasons"] = [{ code: "HTTP_UPSTREAM_5XX", detail: "synthetic: the second book request failed" }];
  let warnings: ObservationRecord["warnings"] = [];
  if (ref && other) {
    metrics = computeScanMetrics(ref, other);
    ({ bucket, reasons, warnings } = evaluateCandidate(ref, other, metrics, FILTERS, parsedMarket.endDate));
  }
  return {
    market: parsedMarket,
    outcomes: [outcomeOf(market, 0), outcomeOf(market, 1)],
    discoveryPosition: position,
    bucket,
    reasons,
    warnings,
    association: "confirmed",
    books,
    metrics,
    depthBand: decimal(DEPTH_BAND),
    requests,
  };
}

export interface DemoSummary {
  runs: number;
  observations: number;
  markets: number;
}

/**
 * Write the demonstration database at `path`, which must not exist yet (nor its -wal/-shm files):
 * an existing database is never opened, let alone changed. The file is created, migrated and
 * filled through the storage layer, then closed. On any failure the handle is closed before the
 * error propagates, so the caller can delete the (temporary) directory, Windows included.
 */
export function writeDemoDatabase(path: string, timeline: readonly DemoRun[] = demoTimeline()): DemoSummary {
  if ([path, `${path}-wal`, `${path}-shm`, `${path}-journal`].some((p) => existsSync(p))) {
    throw storageError("CANNOT_OPEN", "The demonstration database must be a new file; an existing database is never used");
  }
  const db = openDatabase({ path, readOnly: false });
  try {
    migrate(db, () => new Date(DEMO_T0 - MINUTE));
    let observations = 0;
    for (const run of timeline) observations += writeRun(db, run);
    return { runs: timeline.length, observations, markets: new Set(timeline.flatMap((r) => r.samples.map((s) => s.market.gammaId))).size };
  } finally {
    db.close();
  }
}

function writeRun(db: Database, run: DemoRun): number {
  const startMs = DEMO_T0 + run.atMinute * MINUTE;
  createRun(db, {
    runId: run.runId,
    sourceType: "synthetic",
    startedAt: new Date(startMs),
    owner: DEMO_OWNER,
    appVersion: APP_VERSION,
    buildId: "synthetic-demo",
    schemaVersion: SCHEMA_VERSION,
    analyticsVersion: ANALYTICS_VERSION,
    nodeVersion: process.version,
    sqliteVersion: sqliteVersion(db),
    protocolVersion: "v1",
    config: { synthetic: true, generator: "npm run web:demo", depthBand: DEPTH_BAND },
    budgetLimit: 48,
  });
  let books = 0;
  run.samples.forEach((sample, position) => {
    const record = demoRecord(sample, startMs, position);
    const now = new Date(startMs + position * 1_000 + 500);
    books += persistObservation(db, run.runId, record, { now, appVersion: APP_VERSION, buildId: "synthetic-demo" }, ANALYTICS_VERSION).booksWritten;
  });
  const lastMs = startMs + run.samples.length * 1_000;
  if (run.status === "interrupted") {
    // Left running, then recovered exactly as collect recovers a run whose owner process is gone.
    const report = recoverRuns(db, DEMO_LIVENESS, new Date(startMs + 10 * MINUTE));
    if (!report.recovered.includes(run.runId)) throw storageError("INVALID_VALUE", `Synthetic run ${run.runId} could not be marked interrupted`);
    return run.samples.length;
  }
  const n = run.samples.length;
  finalizeRun(db, run.runId, {
    status: run.status,
    accounting: "verified",
    finishedAt: new Date(lastMs),
    stopReasons: run.status === "complete" ? [] : ["SYNTHETIC_INCOMPLETE_OBSERVATION"],
    scanCounts: null,
    persistCounts: { discovered: n, notSelected: 0, selected: n, persistedObservations: n, booksWritten: books, persistenceFailures: 0 },
    budgetUsed: n * 4,
    window: { first: new Date(startMs).toISOString(), last: new Date(lastMs).toISOString() },
    error: null,
  });
  return n;
}
