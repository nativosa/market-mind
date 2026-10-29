import { existsSync } from "node:fs";
import { assertSchemaCurrent, userVersion } from "../adapters/storage/migrations.js";
import type { Liveness } from "../adapters/storage/processLiveness.js";
import { assessRunOwner, databaseFootprint, listRuns, readHistory, type OwnerAssessment } from "../adapters/storage/snapshotStore.js";
import { openDatabase, type Database } from "../adapters/storage/sqlite.js";
import { annotateRows, computeHistoryStats, HISTORY_LIMITATIONS, type HistoryStats, type RowAnnotation } from "../analytics/history.js";
import type { Decimal } from "../domain/decimal.js";
import { MarketMindError } from "../domain/errors.js";
import type { HistoryPoint, RunRecord } from "../domain/snapshot.js";

/** Most recent observations analysed per history query (bounded memory: metrics only, no levels). */
export const HISTORY_MAX_OBSERVATIONS = 20_000;

/** Read-only open of an existing, current-schema database. Never creates a file. */
function openExisting(dbPath: string): Database {
  if (!existsSync(dbPath)) {
    throw new MarketMindError("NotFound", `No database at ${dbPath}; run \`collect\` first`, { code: "DATABASE_MISSING" });
  }
  const db = openDatabase({ path: dbPath, readOnly: true });
  try {
    assertSchemaCurrent(db, dbPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface HistoryOptions {
  dbPath: string;
  gammaId: string;
  /** Evidence-availability boundary (inclusive), ISO-8601. */
  asOf: string | null;
  /** Rows displayed; statistics always use the whole analysis window. */
  limit: number;
  threshold: Decimal;
  analyticsVersion: number;
  includeSynthetic: boolean;
  maxObservations?: number;
}

export interface HistoryResult {
  query: Omit<HistoryOptions, "maxObservations" | "threshold"> & { threshold: Decimal };
  analysisWindow: { observations: number; truncated: boolean; oldestAvailableAt: string; newestAvailableAt: string; maxObservations: number };
  stats: HistoryStats;
  /** Newest first, at most `limit`. */
  rows: { point: HistoryPoint; flags: RowAnnotation }[];
  limitations: readonly string[];
}

/**
 * Offline history of one market: as-of filtering happens in SQL before anything else, statistics
 * use every usable sample in the bounded window, and `limit` only trims the displayed rows.
 */
export function marketHistory(options: HistoryOptions): HistoryResult {
  const max = options.maxObservations ?? HISTORY_MAX_OBSERVATIONS;
  const db = openExisting(options.dbPath);
  try {
    const newestFirst = readHistory(db, {
      gammaId: options.gammaId,
      analyticsVersion: options.analyticsVersion,
      includeSynthetic: options.includeSynthetic,
      asOfMs: options.asOf === null ? null : Date.parse(options.asOf),
      limit: max + 1,
    });
    const truncated = newestFirst.length > max;
    const window = newestFirst.slice(0, max);
    if (window.length === 0) {
      throw new MarketMindError(
        "NotFound",
        `No ${options.includeSynthetic ? "" : "live "}observations for market ${options.gammaId}${options.asOf ? ` available by ${options.asOf}` : ""} in ${options.dbPath}`,
        { code: "NO_OBSERVATIONS" },
      );
    }
    const ascending = [...window].reverse();
    const flags = annotateRows(ascending);
    const { maxObservations: _, ...query } = options;
    return {
      query,
      analysisWindow: {
        observations: window.length,
        truncated,
        oldestAvailableAt: ascending[0]!.availableAt,
        newestAvailableAt: window[0]!.availableAt,
        maxObservations: max,
      },
      stats: computeHistoryStats(ascending, options.threshold),
      rows: window.slice(0, options.limit).map((point) => ({ point, flags: flags.get(point.observationId)! })),
      limitations: HISTORY_LIMITATIONS,
    };
  } finally {
    db.close();
  }
}

export interface RunsResult {
  dbPath: string;
  schemaVersion: number;
  footprint: { main: number; wal: number; shm: number; total: number };
  runs: (RunRecord & { owner: OwnerAssessment | null })[];
}

/** Recent runs, newest first. Running runs are annotated with an owner check but never modified. */
export function collectionRuns(options: { dbPath: string; limit: number; liveness: Liveness; now: () => Date }): RunsResult {
  const db = openExisting(options.dbPath);
  try {
    const nowMs = options.now().getTime();
    return {
      dbPath: options.dbPath,
      schemaVersion: userVersion(db),
      footprint: databaseFootprint(options.dbPath),
      runs: listRuns(db, options.limit).map((r) => ({ ...r, owner: r.status === "running" ? assessRunOwner(r, options.liveness, nowMs) : null })),
    };
  } finally {
    db.close();
  }
}

