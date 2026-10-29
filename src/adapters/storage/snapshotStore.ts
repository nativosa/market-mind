import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { z } from "zod";
import { decimal, decimalToString, isStrictDecimalString, type Decimal } from "../../domain/decimal.js";
import { roleForLabel, type Market, type Outcome } from "../../domain/market.js";
import type { OrderBook } from "../../domain/orderbook.js";
import type { ScanMetrics } from "../../domain/scan.js";
import {
  availabilityOf,
  pairingOf,
  type AccountingStatus,
  type HistoryPoint,
  type ObservationRecord,
  type RunRecord,
  type RunStatus,
  type SourceType,
} from "../../domain/snapshot.js";
import type { ProtocolVersion } from "../../domain/market.js";
import type { Liveness } from "./processLiveness.js";
import { all, get, immediate, run, storageError, type Database, type SqlValue } from "./sqlite.js";

/** A run whose owner is provably gone is recoverable only after its heartbeat is older than this (2 x 120 s scan cap). */
export const RUN_LEASE_MS = 240_000;

// ---------------------------------------------------------------- helpers

const json = (value: unknown) => JSON.stringify(value);
const bit = (b: boolean | null) => (b === null ? null : b ? 1 : 0);

/** Exact decimal text for an unsigned column; anything else is a programming error, never stored. */
function dec(value: Decimal | null, column: string): string | null {
  if (value === null) return null;
  const s = decimalToString(value);
  if (!isStrictDecimalString(s)) throw storageError("INVALID_VALUE", `${column} is not a non-negative decimal: ${decimalToString(value)}`);
  return s;
}

function signedDec(value: Decimal | null, column: string): string | null {
  if (value === null) return null;
  const s = decimalToString(value);
  if (!isStrictDecimalString(s.replace(/^-/, ""))) throw storageError("INVALID_VALUE", `${column} is not a decimal: ${s}`);
  return s;
}

function readDec(value: string | null): Decimal | null {
  if (value === null) return null;
  return value.startsWith("-") ? decimal(value.slice(1)).neg() : decimal(value);
}

/** Canonical, exact captured levels: wire order and original strings. */
export function canonicalLevels(book: OrderBook): { hash: string; bidsJson: string; asksJson: string } {
  const bidsJson = json(book.bids.map((l) => [l.price, l.size]));
  const asksJson = json(book.asks.map((l) => [l.price, l.size]));
  const hash = createHash("sha256").update(`{"bids":${bidsJson},"asks":${asksJson}}`).digest("hex");
  return { hash, bidsJson, asksJson };
}

/** Sizes of the database and its WAL/SHM side files; missing files count as 0. */
export function databaseFootprint(path: string): { main: number; wal: number; shm: number; total: number } {
  const size = (p: string) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  };
  const main = size(path);
  const wal = size(`${path}-wal`);
  const shm = size(`${path}-shm`);
  return { main, wal, shm, total: main + wal + shm };
}

// ---------------------------------------------------------------- runs

export interface NewRun {
  runId: string;
  sourceType: SourceType;
  startedAt: Date;
  owner: { pid: number; host: string };
  appVersion: string;
  buildId: string | null;
  schemaVersion: number;
  analyticsVersion: number;
  nodeVersion: string;
  sqliteVersion: string;
  protocolVersion: ProtocolVersion;
  config: unknown;
  budgetLimit: number;
}

export function createRun(db: Database, r: NewRun): void {
  const at = r.startedAt.toISOString();
  immediate(db, () =>
    run(
      db,
      `INSERT INTO collection_run (run_id, source_type, status, accounting, started_at, owner_pid, owner_host, heartbeat_at, heartbeat_ms,
         app_version, build_id, schema_version, analytics_version, node_version, sqlite_version, protocol_version, config_json, budget_limit)
       VALUES (?, ?, 'running', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.runId,
      r.sourceType,
      at,
      r.owner.pid,
      r.owner.host,
      at,
      r.startedAt.getTime(),
      r.appVersion,
      r.buildId,
      r.schemaVersion,
      r.analyticsVersion,
      r.nodeVersion,
      r.sqliteVersion,
      r.protocolVersion,
      json(r.config),
      r.budgetLimit,
    ),
  );
}

export interface FinalRun {
  status: Exclude<RunStatus, "running">;
  accounting: Exclude<AccountingStatus, "pending">;
  finishedAt: Date;
  stopReasons: string[];
  scanCounts: unknown;
  persistCounts: unknown;
  budgetUsed: number | null;
  window: { first: string; last: string } | null;
  error: unknown;
}

/** Compare-and-set: only a run that is still running can be finalized. Returns whether it was. */
export function finalizeRun(db: Database, runId: string, f: FinalRun): boolean {
  return immediate(db, () => {
    const at = f.finishedAt.toISOString();
    const r = run(
      db,
      `UPDATE collection_run SET status = ?, accounting = ?, finished_at = ?, heartbeat_at = ?, heartbeat_ms = ?,
         stop_reasons_json = ?, scan_counts_json = ?, persist_counts_json = ?, budget_used = ?, window_first = ?, window_last = ?, error_json = ?
       WHERE run_id = ? AND status = 'running'`,
      f.status,
      f.accounting,
      at,
      at,
      f.finishedAt.getTime(),
      json(f.stopReasons),
      f.scanCounts === null ? null : json(f.scanCounts),
      json(f.persistCounts),
      f.budgetUsed,
      f.window?.first ?? null,
      f.window?.last ?? null,
      f.error === null ? null : json(f.error),
      runId,
    );
    return r.changes === 1;
  });
}

export interface ObservedCounts {
  persistedObservations: number;
  persistenceFailures: number;
  booksWritten: number;
  metricsWritten: number;
}

export function observedCounts(db: Database, runId: string): ObservedCounts {
  const n = (sql: string) => (get(db, sql, runId) as { n: number }).n;
  return {
    persistedObservations: n("SELECT count(*) AS n FROM market_observation WHERE run_id = ?"),
    persistenceFailures: n("SELECT count(*) AS n FROM persistence_failure WHERE run_id = ?"),
    booksWritten: n(
      "SELECT count(*) AS n FROM book_observation b JOIN market_observation m ON m.id = b.market_observation_id WHERE m.run_id = ?",
    ),
    metricsWritten: n(
      "SELECT count(*) AS n FROM market_metrics x JOIN market_observation m ON m.id = x.market_observation_id WHERE m.run_id = ? AND x.computed_by = 'collect'",
    ),
  };
}

export type OwnerAssessment = "RECOVERABLE" | "OTHER_HOST" | "OWNER_ALIVE" | "OWNER_UNKNOWN" | "HEARTBEAT_FRESH";

/** Whether a running run's owner is provably gone. Anything uncertain is reported, never recovered. */
export function assessRunOwner(r: { ownerPid: number; ownerHost: string; heartbeatMs: number }, liveness: Liveness, nowMs: number): OwnerAssessment {
  if (r.ownerHost !== liveness.hostname()) return "OTHER_HOST";
  const state = liveness.probe(r.ownerPid);
  if (state === "alive") return "OWNER_ALIVE";
  if (state === "unknown") return "OWNER_UNKNOWN";
  if (nowMs - r.heartbeatMs <= RUN_LEASE_MS) return "HEARTBEAT_FRESH";
  return "RECOVERABLE";
}

export interface RecoveryReport {
  recovered: string[];
  unverified: { runId: string; reason: Exclude<OwnerAssessment, "RECOVERABLE"> }[];
}

/**
 * Mark runs interrupted only when their owner process is provably gone on this host and the
 * heartbeat is stale. The update is a compare-and-set on (status, heartbeat), so concurrent
 * recoverers and a late owner can never both win. Recovered accounting is "incomplete": only
 * what was actually stored is counted; scan totals stay unknown (null).
 */
export function recoverRuns(db: Database, liveness: Liveness, now: Date, excludeRunId: string | null = null): RecoveryReport {
  const report: RecoveryReport = { recovered: [], unverified: [] };
  const rows = all(db, "SELECT run_id, owner_pid, owner_host, heartbeat_ms FROM collection_run WHERE status = 'running' ORDER BY started_at, run_id");
  for (const row of rows) {
    const r = { runId: String(row.run_id), ownerPid: Number(row.owner_pid), ownerHost: String(row.owner_host), heartbeatMs: Number(row.heartbeat_ms) };
    if (r.runId === excludeRunId) continue;
    const verdict = assessRunOwner(r, liveness, now.getTime());
    if (verdict !== "RECOVERABLE") {
      report.unverified.push({ runId: r.runId, reason: verdict });
      continue;
    }
    const won = immediate(db, () => {
      const counts = { selected: null, discovered: null, ...observedCounts(db, r.runId), bookContentsNew: null, bookContentsReused: null };
      return (
        run(
          db,
          `UPDATE collection_run SET status = 'interrupted', accounting = 'incomplete', finished_at = ?, recovered_reason = 'OWNER_PROCESS_GONE',
             persist_counts_json = ?, error_json = ?
           WHERE run_id = ? AND status = 'running' AND heartbeat_ms = ?`,
          now.toISOString(),
          json(counts),
          json({ kind: "Interrupted", code: "OWNER_PROCESS_GONE", message: `owner pid ${r.ownerPid} on ${r.ownerHost} no longer exists` }),
          r.runId,
          r.heartbeatMs,
        ).changes === 1
      );
    });
    if (won) report.recovered.push(r.runId);
  }
  return report;
}

// ---------------------------------------------------------------- observations

export interface PersistMeta {
  now: Date;
  appVersion: string;
  buildId: string | null;
}

export interface PersistResult {
  observationId: number;
  booksWritten: number;
  bookContentsNew: number;
  bookContentsReused: number;
  metricsWritten: number;
}

function verifyMarketIdentity(db: Database, market: Market, runId: string): void {
  const existing = get(db, "SELECT condition_id, protocol_version FROM market WHERE gamma_id = ?", market.gammaId);
  if (!existing) {
    run(db, "INSERT INTO market (gamma_id, condition_id, protocol_version, first_seen_run) VALUES (?, ?, ?, ?)", market.gammaId, market.conditionId, market.version, runId);
    return;
  }
  const problems: string[] = [];
  if (String(existing.condition_id).toLowerCase() !== market.conditionId.toLowerCase()) {
    problems.push(`condition_id stored ${String(existing.condition_id)} vs observed ${market.conditionId}`);
  }
  if (existing.protocol_version !== market.version) problems.push(`protocol_version stored ${String(existing.protocol_version)} vs observed ${market.version}`);
  if (problems.length > 0) throw storageError("IDENTITY_CONFLICT", `Market ${market.gammaId} identity conflicts with stored identity`, problems);
}

function verifyOutcomeIdentity(db: Database, gammaId: string, o: Outcome): void {
  const byAsset = get(db, "SELECT gamma_id, outcome_index, asset_id_kind FROM outcome WHERE asset_id = ?", o.assetId);
  const byIndex = get(db, "SELECT asset_id FROM outcome WHERE gamma_id = ? AND outcome_index = ?", gammaId, o.index);
  const problems: string[] = [];
  if (byAsset) {
    if (byAsset.gamma_id !== gammaId) problems.push(`asset ${o.assetId} stored under market ${String(byAsset.gamma_id)}`);
    if (byAsset.outcome_index !== o.index) problems.push(`asset ${o.assetId} stored at index ${String(byAsset.outcome_index)}, observed ${o.index}`);
    if (byAsset.asset_id_kind !== o.assetIdKind) problems.push(`asset ${o.assetId} stored as ${String(byAsset.asset_id_kind)}, observed ${o.assetIdKind}`);
  }
  if (byIndex && byIndex.asset_id !== o.assetId) problems.push(`market ${gammaId} index ${o.index} stored as asset ${String(byIndex.asset_id)}, observed ${o.assetId}`);
  if (problems.length > 0) throw storageError("IDENTITY_CONFLICT", `Outcome identity conflict for market ${gammaId}`, problems);
  if (!byAsset) {
    run(db, "INSERT INTO outcome (asset_id, gamma_id, outcome_index, asset_id_kind) VALUES (?, ?, ?, ?)", o.assetId, gammaId, o.index, o.assetIdKind);
  }
}

function insertMetricsRow(
  db: Database,
  observationId: number,
  m: ScanMetrics,
  meta: { analyticsVersion: number; computedBy: "collect" | "recompute"; computedAt: Date; appVersion: string; buildId: string | null },
): void {
  run(
    db,
    `INSERT INTO market_metrics (market_observation_id, analytics_version, computed_at, computed_by, app_version, build_id, depth_band,
       reference_index, reference_asset_id, best_bid, best_bid_size, best_ask, best_ask_size, spread, midpoint, top_size, top_notional,
       bid_depth, ask_depth, bid_band_depth, ask_band_depth, bid_levels, ask_levels, book_state, quality, pair_skew_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    observationId,
    meta.analyticsVersion,
    meta.computedAt.toISOString(),
    meta.computedBy,
    meta.appVersion,
    meta.buildId,
    dec(m.depthBand, "depth_band"),
    m.reference.index,
    m.reference.assetId,
    dec(m.bestBid?.price ?? null, "best_bid"),
    dec(m.bestBid?.size ?? null, "best_bid_size"),
    dec(m.bestAsk?.price ?? null, "best_ask"),
    dec(m.bestAsk?.size ?? null, "best_ask_size"),
    signedDec(m.spread, "spread"),
    dec(m.midpoint, "midpoint"),
    dec(m.topSize, "top_size"),
    dec(m.topNotional, "top_notional"),
    dec(m.bidDepth, "bid_depth"),
    dec(m.askDepth, "ask_depth"),
    dec(m.bidDepthWithinBand, "bid_band_depth"),
    dec(m.askDepthWithinBand, "ask_band_depth"),
    m.levelCounts?.bids ?? null,
    m.levelCounts?.asks ?? null,
    m.state,
    m.quality,
    m.pairSkewMs,
  );
}

/**
 * Persist one selected market atomically: identity checks, observation, captured books (content
 * deduplicated), metrics, request evidence and the run heartbeat. Any failure rolls back
 * everything for this market. Metrics are written only for paired observations without an
 * invalid book: incomplete or invalid evidence never yields analytical metrics.
 */
export function persistObservation(db: Database, runId: string, rec: ObservationRecord, meta: PersistMeta, analyticsVersion: number): PersistResult {
  const availability = availabilityOf(rec);
  if (availability === null) throw storageError("INVALID_VALUE", `Market ${rec.market.gammaId} has no timed evidence to store`);
  const pairing = pairingOf(rec.books);
  const at = meta.now.toISOString();

  return immediate(db, () => {
    const hb = run(db, "UPDATE collection_run SET heartbeat_at = ?, heartbeat_ms = ? WHERE run_id = ? AND status = 'running'", at, meta.now.getTime(), runId);
    if (hb.changes !== 1) throw storageError("RUN_NOT_RUNNING", `Run ${runId} is not running; refusing to add observations`);

    const m = rec.market;
    verifyMarketIdentity(db, m, runId);
    const outcomes = new Map<number, Outcome>();
    for (const o of rec.outcomes) outcomes.set(o.index, o);
    for (const b of rec.books) outcomes.set(b.outcome.index, b.outcome);
    for (const o of outcomes.values()) verifyOutcomeIdentity(db, m.gammaId, o);

    const observationId = run(
      db,
      `INSERT INTO market_observation (run_id, gamma_id, discovery_position, available_at, available_at_ms, availability_basis, persisted_at,
         pairing, association, bucket, reasons_json, warnings_json, question, slug, outcome_labels_json,
         active, closed, accepting_orders, enable_order_book, neg_risk, end_date, gamma_volume24hr)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      m.gammaId,
      rec.discoveryPosition,
      availability.availableAt,
      availability.availableAtMs,
      availability.basis,
      at,
      pairing,
      rec.association,
      rec.bucket,
      json(rec.reasons),
      json(rec.warnings),
      m.question,
      m.slug,
      json(m.outcomeLabels),
      bit(m.active),
      bit(m.closed),
      bit(m.acceptingOrders),
      bit(m.enableOrderBook),
      bit(m.negRisk),
      m.endDate,
      m.volume24hr === null ? null : String(m.volume24hr),
    ).lastInsertRowid;

    let bookContentsNew = 0;
    let bookContentsReused = 0;
    for (const { outcome, book, assessment } of rec.books) {
      const c = canonicalLevels(book);
      const inserted = run(
        db,
        "INSERT OR IGNORE INTO book_content (content_hash, bids_json, asks_json, bid_levels, ask_levels) VALUES (?, ?, ?, ?, ?)",
        c.hash,
        c.bidsJson,
        c.asksJson,
        book.bids.length,
        book.asks.length,
      ).changes;
      if (inserted === 1) bookContentsNew++;
      else {
        const stored = get(db, "SELECT bids_json, asks_json FROM book_content WHERE content_hash = ?", c.hash)!;
        if (stored.bids_json !== c.bidsJson || stored.asks_json !== c.asksJson) {
          throw storageError("HASH_COLLISION", `Stored book content ${c.hash} differs from new content with the same hash`);
        }
        bookContentsReused++;
      }
      const t = book.provenance.timing;
      run(
        db,
        `INSERT INTO book_observation (market_observation_id, asset_id, outcome_index, label_observed, content_hash, reported_asset_id, reported_condition_id,
           upstream_hash, server_ts_raw, server_ts_ms, tick_size, min_order_size, last_trade_price, neg_risk,
           request_url, http_status, first_attempt_started_at, final_attempt_started_at, response_received_at, response_received_ms,
           duration_ms, attempts, server_date_header, quality, issues_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        observationId,
        outcome.assetId,
        outcome.index,
        outcome.label,
        c.hash,
        book.assetId,
        book.conditionId,
        book.hash,
        book.serverTimestamp.raw,
        book.serverTimestamp.epochMs,
        book.tickSize,
        book.minOrderSize,
        book.lastTradePrice,
        bit(book.negRisk),
        book.provenance.url,
        book.provenance.httpStatus,
        t.firstAttemptStartedAt,
        t.finalAttemptStartedAt,
        t.responseReceivedAt,
        Date.parse(t.responseReceivedAt),
        t.durationMs,
        t.attempts,
        t.serverDateHeader,
        assessment.quality,
        json(assessment.issues),
      );
    }

    let metricsWritten = 0;
    const usableForMetrics = pairing === "paired" && rec.books.every((b) => b.assessment.quality !== "invalid");
    if (usableForMetrics && rec.metrics) {
      insertMetricsRow(db, observationId, rec.metrics, {
        analyticsVersion,
        computedBy: "collect",
        computedAt: meta.now,
        appVersion: meta.appVersion,
        buildId: meta.buildId,
      });
      metricsWritten = 1;
    }

    for (const q of rec.requests) {
      run(
        db,
        `INSERT OR IGNORE INTO request_log (run_id, scope, source, endpoint, url, http_status, attempts, started_at, received_at, error_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        runId,
        q.scope,
        q.source,
        q.endpoint,
        q.url,
        q.httpStatus,
        q.attempts,
        q.timing?.firstAttemptStartedAt ?? null,
        q.timing?.responseReceivedAt ?? null,
        q.errorKind,
      );
    }
    return { observationId, booksWritten: rec.books.length, bookContentsNew, bookContentsReused, metricsWritten };
  });
}

export interface FailureInput {
  gammaId: string | null;
  discoveryPosition: number;
  code: string;
  message: string;
  occurredAt: Date;
}

export function recordPersistenceFailure(db: Database, runId: string, f: FailureInput): void {
  immediate(db, () =>
    run(
      db,
      "INSERT INTO persistence_failure (run_id, gamma_id, discovery_position, code, message, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
      runId,
      f.gammaId,
      f.discoveryPosition,
      f.code,
      f.message,
      f.occurredAt.toISOString(),
    ),
  );
}

/** Add metrics computed by a newer (or re-run) analytics version; existing rows are never touched. */
export function insertRecomputedMetrics(
  db: Database,
  observationId: number,
  metrics: ScanMetrics,
  meta: { analyticsVersion: number; computedAt: Date; appVersion: string; buildId: string | null },
): void {
  immediate(db, () => insertMetricsRow(db, observationId, metrics, { ...meta, computedBy: "recompute" }));
}

// ---------------------------------------------------------------- reads (the database is treated as untrusted input)

const nullableString = z.string().nullable();
const flag = z.union([z.literal(0), z.literal(1)]);

const RunRow = z.object({
  run_id: z.string(),
  source_type: z.enum(["live", "synthetic"]),
  status: z.enum(["running", "complete", "partial", "interrupted", "failed"]),
  accounting: z.enum(["pending", "verified", "incomplete"]),
  started_at: z.string(),
  finished_at: nullableString,
  owner_pid: z.number(),
  owner_host: z.string(),
  heartbeat_at: z.string(),
  heartbeat_ms: z.number(),
  app_version: z.string(),
  build_id: nullableString,
  schema_version: z.number(),
  analytics_version: z.number(),
  node_version: z.string(),
  sqlite_version: z.string(),
  protocol_version: z.enum(["v1", "v2"]),
  stop_reasons_json: nullableString,
  scan_counts_json: nullableString,
  persist_counts_json: nullableString,
  budget_limit: z.number(),
  budget_used: z.number().nullable(),
  window_first: nullableString,
  window_last: nullableString,
  error_json: nullableString,
  recovered_reason: nullableString,
});

const parseJson = <T>(value: string | null): T | null => (value === null ? null : (JSON.parse(value) as T));

export function listRuns(db: Database, limit: number): RunRecord[] {
  return all(db, "SELECT * FROM collection_run ORDER BY started_at DESC, rowid DESC LIMIT ?", limit).map((raw) => {
    const r = RunRow.parse(raw);
    return {
      runId: r.run_id,
      sourceType: r.source_type,
      status: r.status,
      accounting: r.accounting,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      ownerPid: r.owner_pid,
      ownerHost: r.owner_host,
      heartbeatAt: r.heartbeat_at,
      heartbeatMs: r.heartbeat_ms,
      appVersion: r.app_version,
      buildId: r.build_id,
      schemaVersion: r.schema_version,
      analyticsVersion: r.analytics_version,
      nodeVersion: r.node_version,
      sqliteVersion: r.sqlite_version,
      protocolVersion: r.protocol_version,
      stopReasons: parseJson<string[]>(r.stop_reasons_json),
      scanCounts: parseJson<Record<string, unknown>>(r.scan_counts_json),
      persistCounts: parseJson<Record<string, unknown>>(r.persist_counts_json),
      budgetLimit: r.budget_limit,
      budgetUsed: r.budget_used,
      windowFirst: r.window_first,
      windowLast: r.window_last,
      error: parseJson<Record<string, unknown>>(r.error_json),
      recoveredReason: r.recovered_reason,
    };
  });
}

const HistoryRow = z.object({
  id: z.number(),
  run_id: z.string(),
  run_status: z.enum(["running", "complete", "partial", "interrupted", "failed"]),
  source_type: z.enum(["live", "synthetic"]),
  available_at: z.string(),
  available_at_ms: z.number(),
  availability_basis: z.enum(["paired_books", "single_book", "association", "discovery"]),
  pairing: z.enum(["paired", "incomplete", "none"]),
  association: z.enum(["confirmed", "mismatch", "failed", "not_attempted"]),
  bucket: z.enum(["ranked", "filtered", "excluded", "failed", "notScanned"]),
  reasons_json: z.string(),
  question: z.string(),
  outcome_labels_json: z.string(),
  active: flag,
  closed: flag,
  accepting_orders: flag.nullable(),
  end_date: nullableString,
  analytics_version: z.number().nullable(),
  reference_index: z.number().nullable(),
  best_bid: nullableString,
  best_ask: nullableString,
  spread: nullableString,
  midpoint: nullableString,
  top_size: nullableString,
  book_state: z.enum(["two-sided", "bid-only", "ask-only", "empty"]).nullable(),
  m_quality: z.enum(["valid", "incomplete", "suspicious", "invalid"]).nullable(),
  pair_skew_ms: z.number().nullable(),
});

const BookRow = z.object({
  market_observation_id: z.number(),
  outcome_index: z.number(),
  label_observed: z.string(),
  quality: z.enum(["valid", "incomplete", "suspicious", "invalid"]),
  content_hash: z.string(),
  response_received_at: z.string(),
  server_ts_ms: z.number().nullable(),
});

export interface HistoryQuery {
  gammaId: string;
  analyticsVersion: number;
  includeSynthetic: boolean;
  /** Evidence-availability boundary (inclusive), epoch ms. */
  asOfMs: number | null;
  /** Rows to read, newest first. */
  limit: number;
}

/**
 * Most recent observations of one market whose evidence was fully available at or before `asOfMs`.
 * The as-of filter is applied in SQL, so nothing later is ever read. Newest first.
 */
export function readHistory(db: Database, q: HistoryQuery): HistoryPoint[] {
  const params: SqlValue[] = [q.analyticsVersion, q.gammaId, q.includeSynthetic ? 1 : 0, q.asOfMs, q.asOfMs, q.limit];
  const rows = all(
    db,
    `SELECT mo.id, mo.run_id, r.status AS run_status, r.source_type, mo.available_at, mo.available_at_ms, mo.availability_basis,
            mo.pairing, mo.association, mo.bucket, mo.reasons_json, mo.question, mo.outcome_labels_json, mo.active, mo.closed,
            mo.accepting_orders, mo.end_date,
            mm.analytics_version, mm.reference_index, mm.best_bid, mm.best_ask, mm.spread, mm.midpoint, mm.top_size, mm.book_state,
            mm.quality AS m_quality, mm.pair_skew_ms
     FROM market_observation mo
     JOIN collection_run r ON r.run_id = mo.run_id
     LEFT JOIN market_metrics mm ON mm.market_observation_id = mo.id AND mm.analytics_version = ?
     WHERE mo.gamma_id = ? AND (? = 1 OR r.source_type = 'live') AND (? IS NULL OR mo.available_at_ms <= ?)
     ORDER BY mo.available_at_ms DESC, mo.id DESC
     LIMIT ?`,
    ...params,
  ).map((raw) => HistoryRow.parse(raw));

  const books = new Map<number, z.infer<typeof BookRow>[]>();
  if (rows.length > 0) {
    const bookRows = all(
      db,
      `SELECT market_observation_id, outcome_index, label_observed, quality, content_hash, response_received_at, server_ts_ms
       FROM book_observation WHERE market_observation_id IN (SELECT value FROM json_each(?)) ORDER BY market_observation_id, outcome_index`,
      json(rows.map((r) => r.id)),
    ).map((raw) => BookRow.parse(raw));
    for (const b of bookRows) books.set(b.market_observation_id, [...(books.get(b.market_observation_id) ?? []), b]);
  }

  return rows.map((r) => ({
    observationId: r.id,
    runId: r.run_id,
    runStatus: r.run_status,
    sourceType: r.source_type,
    availableAt: r.available_at,
    availableAtMs: r.available_at_ms,
    availabilityBasis: r.availability_basis,
    pairing: r.pairing,
    association: r.association,
    bucket: r.bucket,
    reasonCodes: (JSON.parse(r.reasons_json) as { code: string }[]).map((x) => x.code),
    question: r.question,
    outcomeLabels: JSON.parse(r.outcome_labels_json) as string[],
    active: r.active === 1,
    closed: r.closed === 1,
    acceptingOrders: r.accepting_orders === null ? null : r.accepting_orders === 1,
    endDate: r.end_date,
    books: (books.get(r.id) ?? []).map((b) => ({
      outcomeIndex: b.outcome_index,
      label: b.label_observed,
      quality: b.quality,
      contentHash: b.content_hash,
      responseReceivedAt: b.response_received_at,
      serverTimestampIso: b.server_ts_ms === null ? null : new Date(b.server_ts_ms).toISOString(),
    })),
    metrics:
      r.analytics_version === null
        ? null
        : {
            analyticsVersion: r.analytics_version,
            referenceIndex: r.reference_index!,
            bestBid: readDec(r.best_bid),
            bestAsk: readDec(r.best_ask),
            spread: readDec(r.spread),
            midpoint: readDec(r.midpoint),
            topSize: readDec(r.top_size),
            state: r.book_state,
            quality: r.m_quality!,
            pairSkewMs: r.pair_skew_ms!,
          },
  }));
}

// ---------------------------------------------------------------- reconstruction for recomputation

export interface StoredEvidence {
  observationId: number;
  conditionId: string;
  depthBand: Decimal | null;
  books: { outcome: Outcome; book: OrderBook }[];
}

/** Rebuild the exact captured books of one observation (raw levels, scalars, provenance). */
export function loadEvidence(db: Database, observationId: number): StoredEvidence {
  const head = get(
    db,
    `SELECT m.condition_id, r.config_json FROM market_observation mo
     JOIN market m ON m.gamma_id = mo.gamma_id JOIN collection_run r ON r.run_id = mo.run_id WHERE mo.id = ?`,
    observationId,
  );
  if (!head) throw storageError("INVALID_VALUE", `No observation ${observationId}`);
  const config = JSON.parse(String(head.config_json)) as { depthBand?: string | null };
  const rows = all(
    db,
    `SELECT b.*, c.bids_json, c.asks_json, o.asset_id_kind FROM book_observation b
     JOIN book_content c ON c.content_hash = b.content_hash JOIN outcome o ON o.asset_id = b.asset_id
     WHERE b.market_observation_id = ? ORDER BY b.outcome_index`,
    observationId,
  );
  const levels = (s: unknown) => (JSON.parse(String(s)) as [string, string][]).map(([price, size]) => ({ price, size }));
  const text = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
  return {
    observationId,
    conditionId: String(head.condition_id),
    depthBand: config.depthBand ? decimal(config.depthBand) : null,
    books: rows.map((b) => {
      const assetId = String(b.asset_id);
      const kind = b.asset_id_kind === "positionId" ? "positionId" : "tokenId";
      const label = String(b.label_observed);
      const serverMs = b.server_ts_ms === null ? null : Number(b.server_ts_ms);
      return {
        outcome: {
          index: Number(b.outcome_index),
          label,
          role: roleForLabel(label),
          assetId,
          assetIdKind: kind,
          raw: { clobTokenId: kind === "tokenId" ? assetId : null, positionId: kind === "positionId" ? assetId : null },
        },
        book: {
          requestedAssetId: assetId,
          assetId: String(b.reported_asset_id),
          conditionId: String(b.reported_condition_id),
          bids: levels(b.bids_json),
          asks: levels(b.asks_json),
          tickSize: text(b.tick_size),
          minOrderSize: text(b.min_order_size),
          lastTradePrice: text(b.last_trade_price),
          negRisk: b.neg_risk === null ? null : b.neg_risk === 1,
          hash: text(b.upstream_hash),
          serverTimestamp: { raw: text(b.server_ts_raw), epochMs: serverMs, iso: serverMs === null ? null : new Date(serverMs).toISOString() },
          provenance: {
            source: "clob",
            endpoint: "/book",
            url: String(b.request_url),
            httpStatus: Number(b.http_status),
            timing: {
              firstAttemptStartedAt: String(b.first_attempt_started_at),
              finalAttemptStartedAt: String(b.final_attempt_started_at),
              responseReceivedAt: String(b.response_received_at),
              durationMs: Number(b.duration_ms),
              attempts: Number(b.attempts),
              serverDateHeader: text(b.server_date_header),
            },
          },
        },
      };
    }),
  };
}

/** Stored metric columns of one observation for one analytics version (decimal strings as stored). */
export function readMetricsRow(db: Database, observationId: number, analyticsVersion: number): Record<string, unknown> | undefined {
  return get(db, "SELECT * FROM market_metrics WHERE market_observation_id = ? AND analytics_version = ?", observationId, analyticsVersion);
}
