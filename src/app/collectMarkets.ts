import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { selectOutcomes } from "../adapters/polymarket/normalize.js";
import { migrate, SCHEMA_VERSION } from "../adapters/storage/migrations.js";
import type { Liveness } from "../adapters/storage/processLiveness.js";
import {
  createRun,
  databaseFootprint,
  finalizeRun,
  persistObservation,
  recordPersistenceFailure,
  recoverRuns,
  type RecoveryReport,
} from "../adapters/storage/snapshotStore.js";
import { FATAL_STORAGE_CODES, openDatabase, sqliteVersion, storageError, toStorageError, type Database } from "../adapters/storage/sqlite.js";
import { ANALYTICS_VERSION } from "../analytics/version.js";
import { APP_VERSION } from "../config/config.js";
import { decimalToString } from "../domain/decimal.js";
import { isMarketMindError, type MarketMindError } from "../domain/errors.js";
import type { Outcome } from "../domain/market.js";
import type { AccountingStatus, ObservationRecord, RequestEvidence, RunStatus, SourceType } from "../domain/snapshot.js";
import { countScan, scanMarkets, type ScanDeps, type ScanEntry, type ScanOptions, type ScanResult, type SettledMarket } from "./scanMarkets.js";

export interface CollectOptions {
  scan: ScanOptions;
  dbPath: string;
  /** Create the parent directory if missing (only for the default path). */
  createParentDir: boolean;
  /** Soft admission limit on database + WAL + SHM size, bytes. */
  maxDbBytes: number;
  buildId: string | null;
  /** Always "live" from the CLI; "synthetic" is only reachable programmatically (tests). */
  sourceType: SourceType;
}

export interface CollectDeps extends Omit<ScanDeps, "onSettled"> {
  liveness: Liveness;
  /** Clock for storage timestamps (persisted_at, heartbeats). */
  now: () => Date;
  pid: number;
  nodeVersion: string;
  newRunId: () => string;
  /** Test hook: adjust the open connection after migration (e.g. cap its size to force SQLITE_FULL). */
  configureDatabase?: (db: Database) => void;
}

export interface PersistCounts {
  /** null when the scan never produced totals (it failed before discovery completed). */
  discovered: number | null;
  notSelected: number | null;
  selected: number | null;
  persistedObservations: number;
  persistenceFailures: number;
  /** Failures that could not even be written to persistence_failure (kept here instead). */
  persistenceFailuresUnrecorded: number;
  booksWritten: number;
  bookContentsNew: number;
  bookContentsReused: number;
  metricsWritten: number;
}

export interface PersistFailure {
  gammaId: string | null;
  discoveryPosition: number;
  code: string;
  message: string;
  recorded: boolean;
}

export interface CollectResult {
  runId: string;
  dbPath: string;
  status: Exclude<RunStatus, "running">;
  accounting: Exclude<AccountingStatus, "pending">;
  /** Whether the final run update was written. If not, the run stays "running" until safely recovered. */
  finalized: boolean;
  scan: ScanResult | null;
  scanError: MarketMindError | null;
  storageError: MarketMindError | null;
  persist: PersistCounts;
  failures: PersistFailure[];
  recovery: RecoveryReport;
  footprintBefore: { main: number; wal: number; shm: number; total: number };
  footprintAfter: { main: number; wal: number; shm: number; total: number };
  maxDbBytes: number;
  sizeLimitExceeded: boolean;
}

export const MAX_DB_MB_LIMIT = 10_240;

function evidence(requests: SettledMarket["requests"]): RequestEvidence[] {
  return requests.map((r) => ({
    scope: r.scope,
    source: r.source,
    endpoint: r.endpoint,
    url: r.url,
    httpStatus: r.httpStatus,
    attempts: r.attempts,
    timing: r.timing,
    errorKind: r.error?.kind ?? null,
  }));
}

function outcomesOf(entry: ScanEntry): Outcome[] {
  if (entry.outcomes.length === 2) return entry.outcomes.map((o) => o.outcome);
  try {
    return selectOutcomes(entry.market!);
  } catch {
    return entry.outcomes.map((o) => o.outcome);
  }
}

export function toObservationRecord(entry: ScanEntry, requests: SettledMarket["requests"], options: ScanOptions): ObservationRecord {
  return {
    market: entry.market!,
    outcomes: outcomesOf(entry),
    discoveryPosition: entry.position,
    bucket: entry.bucket,
    reasons: entry.reasons,
    warnings: entry.warnings,
    association: entry.association,
    books: entry.outcomes,
    metrics: entry.metrics,
    depthBand: options.depthBand,
    requests: evidence(requests),
  };
}

function scanConfig(o: ScanOptions, deps: CollectDeps) {
  return {
    version: o.version,
    discoverOrder: o.discoverOrder,
    maxMarkets: o.maxMarkets,
    top: o.top,
    pageSize: o.pageSize,
    maxPages: o.maxPages,
    filters: {
      minSpread: decimalToString(o.filters.minSpread),
      minTopSize: decimalToString(o.filters.minTopSize),
      includeSuspicious: o.filters.includeSuspicious,
    },
    depthBand: o.depthBand === null ? null : decimalToString(o.depthBand),
    maxRequests: o.maxRequests,
    concurrency: o.concurrency,
    maxDurationMs: o.maxDurationMs,
    gammaBaseUrl: deps.gammaBaseUrl,
    clobBaseUrl: deps.clobBaseUrl,
  };
}

/**
 * One-shot collection: admission (size, schema, safe recovery), run creation, a normal bounded
 * scan whose markets are persisted one atomic transaction each as they settle, then finalization.
 * Polymarket access is exactly the scanner's read-only GETs.
 */
export async function collectMarkets(options: CollectOptions, deps: CollectDeps): Promise<CollectResult> {
  // 1. Admission, before any HTTP request.
  const footprintBefore = databaseFootprint(options.dbPath);
  if (footprintBefore.total >= options.maxDbBytes) {
    throw storageError(
      "DB_SIZE_LIMIT",
      `Database ${options.dbPath} uses ${footprintBefore.total} bytes (incl. WAL/SHM), at or above the soft limit of ${options.maxDbBytes}; no collection started`,
    );
  }
  const parent = dirname(options.dbPath);
  if (!existsSync(parent)) {
    if (!options.createParentDir) throw storageError("CANNOT_OPEN", `Directory ${parent} does not exist`);
    mkdirSync(parent, { recursive: true });
  }

  const db = openDatabase({ path: options.dbPath, readOnly: false });
  try {
    migrate(db, deps.now);
    const recovery = recoverRuns(db, deps.liveness, deps.now());
    deps.configureDatabase?.(db);

    const runId = deps.newRunId();
    createRun(db, {
      runId,
      sourceType: options.sourceType,
      startedAt: deps.now(),
      owner: { pid: deps.pid, host: deps.liveness.hostname() },
      appVersion: APP_VERSION,
      buildId: options.buildId,
      schemaVersion: SCHEMA_VERSION,
      analyticsVersion: ANALYTICS_VERSION,
      nodeVersion: deps.nodeVersion,
      sqliteVersion: sqliteVersion(db),
      protocolVersion: options.scan.version,
      config: scanConfig(options.scan, deps),
      budgetLimit: options.scan.maxRequests,
    });

    // 2. Incremental persistence.
    const counts = { persistedObservations: 0, booksWritten: 0, bookContentsNew: 0, bookContentsReused: 0, metricsWritten: 0 };
    const failures: PersistFailure[] = [];
    const storageAbort = new AbortController();
    let fatal: MarketMindError | null = null;

    const fail = (entry: ScanEntry, error: MarketMindError) => {
      const f = {
        gammaId: entry.gammaId,
        discoveryPosition: entry.position,
        code: error.details.code ?? error.kind,
        message: error.message,
        recorded: false,
      };
      if (fatal === null) {
        try {
          recordPersistenceFailure(db, runId, { ...f, occurredAt: deps.now() });
          f.recorded = true;
        } catch (e) {
          const err = toStorageError(e, "Cannot record persistence failure");
          if (FATAL_STORAGE_CODES.has(err.details.code ?? "")) declareFatal(err);
        }
      }
      failures.push(f);
    };
    const declareFatal = (error: MarketMindError) => {
      if (fatal !== null) return;
      fatal = error;
      storageAbort.abort(error);
    };

    const onSettled = ({ entry, requests }: SettledMarket) => {
      if (fatal !== null) {
        fail(entry, storageError("STORAGE_UNAVAILABLE", `Not written: storage failed earlier (${fatal.message})`));
        return;
      }
      try {
        const r = persistObservation(db, runId, toObservationRecord(entry, requests, options.scan), {
          now: deps.now(),
          appVersion: APP_VERSION,
          buildId: options.buildId,
        }, ANALYTICS_VERSION);
        counts.persistedObservations++;
        counts.booksWritten += r.booksWritten;
        counts.bookContentsNew += r.bookContentsNew;
        counts.bookContentsReused += r.bookContentsReused;
        counts.metricsWritten += r.metricsWritten;
      } catch (e) {
        const err = toStorageError(e, `Cannot persist market ${entry.gammaId ?? "(no id)"}`);
        if (FATAL_STORAGE_CODES.has(err.details.code ?? "")) declareFatal(err);
        fail(entry, err);
      }
    };

    let scan: ScanResult | null = null;
    let scanError: MarketMindError | null = null;
    try {
      scan = await scanMarkets(options.scan, {
        ...deps,
        signal: deps.signal ? AbortSignal.any([deps.signal, storageAbort.signal]) : storageAbort.signal,
        onSettled,
      });
    } catch (error) {
      if (!isMarketMindError(error)) throw error;
      scanError = error;
    }

    // 3. Finalization.
    const persistenceFailures = failures.filter((f) => f.recorded).length;
    const unrecorded = failures.length - persistenceFailures;
    const sc = scan ? countScan(scan) : null;
    const selected = sc ? sc.selected : scanError ? 0 : null;
    const persist: PersistCounts = {
      discovered: sc ? sc.discovered : null,
      notSelected: sc ? sc.discovered - sc.selected : null,
      selected,
      ...counts,
      persistenceFailures,
      persistenceFailuresUnrecorded: unrecorded,
    };
    const accounted = selected !== null && selected === counts.persistedObservations + failures.length;
    const accounting: "verified" | "incomplete" = accounted ? "verified" : "incomplete";
    const stops = scan?.stopReasons ?? [];
    const status: Exclude<RunStatus, "running"> =
      fatal !== null || scanError !== null
        ? "failed"
        : stops.includes("DEADLINE") || stops.includes("CANCELLED")
          ? "interrupted"
          : scan!.status === "partial" || failures.length > 0 || !accounted
            ? "partial"
            : "complete";
    const fatalError = fatal as MarketMindError | null;
    const errorInfo = fatalError ?? scanError;

    let finalized = false;
    try {
      finalized = finalizeRun(db, runId, {
        status,
        accounting,
        finishedAt: deps.now(),
        stopReasons: stops,
        scanCounts: sc ? { ...sc, recordsReceived: scan!.discovery.recordsReceived, duplicates: scan!.discovery.duplicates.length } : null,
        persistCounts: persist,
        budgetUsed: scan?.budget.used ?? null,
        window: scan?.window ? { first: scan.window.firstRequestStartedAt, last: scan.window.lastResponseReceivedAt } : null,
        error: errorInfo ? { kind: errorInfo.kind, code: errorInfo.details.code ?? null, message: errorInfo.message } : null,
      });
    } catch (e) {
      // Left "running": a later collect recovers it once this process is provably gone.
      if (fatal === null) fatal = toStorageError(e, "Cannot finalize run");
    }

    const footprintAfter = databaseFootprint(options.dbPath);
    return {
      runId,
      dbPath: options.dbPath,
      status,
      accounting,
      finalized,
      scan,
      scanError,
      storageError: fatal,
      persist,
      failures,
      recovery,
      footprintBefore,
      footprintAfter,
      maxDbBytes: options.maxDbBytes,
      sizeLimitExceeded: footprintAfter.total >= options.maxDbBytes,
    };
  } finally {
    db.close();
  }
}
