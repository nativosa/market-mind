import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertRecomputedMetrics, listStoredMarkets, loadEvidence, persistObservation } from "../../src/adapters/storage/snapshotStore.js";
import { get, openDatabase, readSnapshot, run, type Database } from "../../src/adapters/storage/sqlite.js";
import { recomputeMetrics } from "../../src/analytics/recompute.js";
import { ANALYTICS_VERSION } from "../../src/analytics/version.js";
import { collectionRuns, marketHistory, observationDetails, storedMarkets, type HistoryOptions } from "../../src/app/marketHistory.js";
import { decimal, decimalToString, type Decimal } from "../../src/domain/decimal.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { describeError } from "../../src/research/envelope.js";
import { cleanupTemp, fakeLiveness, iso, META, openMigrated, record, startRun, T0, tempDbPath, type RecordSpec } from "../storageFixtures.js";

// Stage 3.2 read-only storage foundation: depth in history, irregular-gap rows, the stored-markets
// listing, source filtering of runs, query_only connections and snapshot-consistent reads.

afterEach(cleanupTemp);

let runCounter = 0;
/** Store one observation in its own run. */
function observe(db: Database, spec: RecordSpec & { source?: "live" | "synthetic" } = {}): number {
  const runId = startRun(db, { runId: `run-${++runCounter}`, sourceType: spec.source ?? "live", startedAt: new Date(T0 + runCounter) });
  return persistObservation(db, runId, record(spec), META, ANALYTICS_VERSION).observationId;
}

/** Books received at +100 / +110 ms past `ms` (after discovery and association), so availability is ms + 110. */
const at = (ms: number): Pick<RecordSpec, "receivedAt"> => ({ receivedAt: [ms + 100, ms + 110] });
const av = (ms: number) => iso(ms + 110);
const s = (d: Decimal | null) => (d === null ? null : decimalToString(d));

function history(dbPath: string, overrides: Partial<HistoryOptions> = {}) {
  return marketHistory({ dbPath, gammaId: "1", asOf: null, limit: 100, threshold: decimal("0.02"), analyticsVersion: ANALYTICS_VERSION, includeSynthetic: false, ...overrides });
}

function thrown(fn: () => unknown): MarketMindError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MarketMindError);
    return e as MarketMindError;
  }
  throw new Error("expected an error");
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("history rows carry stored depth", () => {
  it("returns sizes, depth, band depth and levels exactly as stored for the selected version", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    const id = observe(db, {
      ref: {
        bids: [
          ["0.40", "120.5"],
          ["0.39", "30"],
          ["0.30", "1000"],
        ],
        asks: [
          ["0.45", "80.25"],
          ["0.47", "19.75"],
        ],
      },
    });
    db.close();
    const m = history(path).rows[0]!.point.metrics!;
    expect([m.bestBidSize, m.bestAskSize, m.bidDepth, m.askDepth, m.bidBandDepth, m.askBandDepth, m.depthBand].map(s)).toEqual([
      "120.5",
      "80.25",
      "1150.5",
      "100",
      "150.5",
      "100",
      "0.05",
    ]);
    expect([m.bidLevels, m.askLevels]).toEqual([3, 2]);
    // The same metrics row as the full evidence view: one stored value, two readers.
    const stored = observationDetails({ dbPath: path, observationId: id, asOf: null }).metrics.find((x) => x.analyticsVersion === ANALYTICS_VERSION)!;
    expect([stored.bestBidSize, stored.bestAskSize, stored.bidDepth, stored.askDepth, stored.bidBandDepth, stored.askBandDepth, stored.depthBand]).toEqual([
      "120.5",
      "80.25",
      "1150.5",
      "100",
      "150.5",
      "100",
      "0.05",
    ]);
  });

  it("an observation without metrics for the version has no depth (versions are never mixed)", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    const id = observe(db);
    const { metrics } = recomputeMetrics(loadEvidence(db, id));
    insertRecomputedMetrics(db, id, metrics!, { analyticsVersion: 2, computedAt: new Date(T0), appVersion: "next", buildId: null });
    observe(db, at(60_000));
    db.close();
    const v2 = history(path, { analyticsVersion: 2 });
    expect(v2.rows.map((r) => r.point.metrics?.analyticsVersion ?? null)).toEqual([null, 2]);
    expect(s(v2.rows[1]!.point.metrics!.bidDepth)).toBe("100");
  });
});

describe("history rows mark irregular gaps with the analytics rule", () => {
  it("flags only gaps above twice the median, matching stats.gaps.irregular, and never unusable rows", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    [0, 60_000, 120_000, 180_000].forEach((ms) => observe(db, at(ms)));
    observe(db, { ...at(200_000), other: null }); // unpaired: not usable, no gap of its own
    observe(db, at(1_980_000)); // 30 minutes after the last usable sample
    db.close();
    const r = history(path);
    expect(r.stats.gaps).toMatchObject({ n: 4, medianMs: 60_000, irregular: 1 });
    expect(r.rows.map((x) => [x.flags.notUsable, x.flags.gapMs, x.irregularGap])).toEqual([
      [null, 1_800_000, true],
      ["NOT_PAIRED", null, false],
      [null, 60_000, false],
      [null, 60_000, false],
      [null, 60_000, false],
      [null, null, false],
    ]);
    expect(r.rows.filter((x) => x.irregularGap)).toHaveLength(r.stats.gaps.irregular);
  });
});

describe("listStoredMarkets / storedMarkets", () => {
  /** Market 1: three live observations (question changes); 2: one live + one synthetic; 3: synthetic only. */
  function seedMarkets(path: string): Database {
    const db = openMigrated(path);
    observe(db, { id: "1", ...at(0), gamma: { question: "Old question?" } });
    observe(db, { id: "1", ...at(60_000), other: null, gamma: { question: "Old question?" } });
    observe(db, { id: "1", ...at(120_000), gamma: { question: "New question?" } });
    observe(db, { id: "2", ...at(30_000) });
    observe(db, { id: "2", ...at(300_000), source: "synthetic" });
    observe(db, { id: "3", ...at(400_000), source: "synthetic" });
    return db;
  }

  it("live only: synthetic observations are neither counted nor used to describe or order a market", () => {
    const path = tempDbPath();
    seedMarkets(path).close();
    const r = storedMarkets({ dbPath: path, includeSynthetic: false, limit: 10, offset: 0 });
    expect(r.hasMore).toBe(false);
    expect(r.markets.map((m) => [m.gammaId, m.observations, m.liveObservations, m.syntheticObservations, m.firstAvailableAt, m.lastAvailableAt])).toEqual([
      ["1", 3, 3, 0, av(0), av(120_000)],
      ["2", 1, 1, 0, av(30_000), av(30_000)],
    ]);
    expect(r.markets[0]!.latest).toMatchObject({ question: "New question?", sourceType: "live", runStatus: "running", outcomeLabels: ["Yes", "No"], active: true, closed: false });
    expect(r.markets[0]!).toMatchObject({ protocolVersion: "v1" });
    expect(r.markets[0]!.conditionId).toMatch(/^0x/);
  });

  it("all sources: counts split by provenance and the newest observation describes the market", () => {
    const path = tempDbPath();
    seedMarkets(path).close();
    const r = storedMarkets({ dbPath: path, includeSynthetic: true, limit: 10, offset: 0 });
    expect(r.markets.map((m) => [m.gammaId, m.observations, m.liveObservations, m.syntheticObservations, m.latest.sourceType])).toEqual([
      ["3", 1, 0, 1, "synthetic"],
      ["2", 2, 1, 1, "synthetic"],
      ["1", 3, 3, 0, "live"],
    ]);
  });

  it("counts observations, not metrics rows, when several analytics versions are stored", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    const id = observe(db);
    const { metrics } = recomputeMetrics(loadEvidence(db, id));
    insertRecomputedMetrics(db, id, metrics!, { analyticsVersion: 2, computedAt: new Date(T0), appVersion: "next", buildId: null });
    db.close();
    expect(storedMarkets({ dbPath: path, includeSynthetic: false, limit: 10, offset: 0 }).markets[0]!.observations).toBe(1);
  });

  it("pages are bounded and stable, with hasMore", () => {
    const path = tempDbPath();
    seedMarkets(path).close();
    const page = (offset: number) => storedMarkets({ dbPath: path, includeSynthetic: true, limit: 1, offset });
    expect([0, 1, 2, 3].map((o) => [page(o).markets.map((m) => m.gammaId), page(o).hasMore])).toEqual([
      [["3"], true],
      [["2"], true],
      [["1"], false],
      [[], false],
    ]);
    expect(storedMarkets({ dbPath: path, includeSynthetic: true, limit: 10_000, offset: 0 }).markets).toHaveLength(3); // clamped, not refused
  });

  it("reads a page of many markets with one statement (no query per market)", () => {
    const db = openMigrated();
    for (let i = 1; i <= 30; i++) observe(db, { id: String(i), ...at(i * 1_000) });
    const prepare = vi.spyOn(db, "prepare");
    const markets = listStoredMarkets(db, { includeSynthetic: false, limit: 25, offset: 0 });
    expect(markets).toHaveLength(25);
    expect(markets[0]!.gammaId).toBe("30");
    expect(prepare).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("an empty database lists nothing", () => {
    const path = tempDbPath();
    openMigrated(path).close();
    expect(storedMarkets({ dbPath: path, includeSynthetic: true, limit: 10, offset: 0 })).toEqual({ markets: [], hasMore: false });
  });
});

describe("collectionRuns source filter", () => {
  it("filters synthetic runs in SQL so the limit counts live runs; the default still lists both", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    startRun(db, { runId: "live-old", sourceType: "live", startedAt: new Date(T0) });
    startRun(db, { runId: "synth-1", sourceType: "synthetic", startedAt: new Date(T0 + 1) });
    startRun(db, { runId: "synth-2", sourceType: "synthetic", startedAt: new Date(T0 + 2) });
    db.close();
    const runs = (includeSynthetic?: boolean) =>
      collectionRuns({ dbPath: path, limit: 1, liveness: fakeLiveness(), now: () => new Date(T0), ...(includeSynthetic === undefined ? {} : { includeSynthetic }) }).runs.map((r) => r.runId);
    expect(runs(false)).toEqual(["live-old"]);
    expect(runs()).toEqual(["synth-2"]);
    expect(runs(true)).toEqual(["synth-2"]);
  });
});

describe("read-only access", () => {
  it("missing database: every reader refuses with DATABASE_MISSING and creates nothing", () => {
    const path = tempDbPath("never.sqlite");
    const codes = [
      () => storedMarkets({ dbPath: path, includeSynthetic: true, limit: 10, offset: 0 }),
      () => history(path),
      () => observationDetails({ dbPath: path, observationId: 1, asOf: null }),
      () => collectionRuns({ dbPath: path, limit: 5, liveness: fakeLiveness(), now: () => new Date(T0) }),
    ].map((fn) => thrown(fn).details.code);
    expect(codes).toEqual(["DATABASE_MISSING", "DATABASE_MISSING", "DATABASE_MISSING", "DATABASE_MISSING"]);
    expect(readdirSync(dirname(path))).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("incompatible schemas are refused by the listing too", () => {
    const outdated = tempDbPath();
    openDatabase({ path: outdated, readOnly: false }).close();
    expect(thrown(() => storedMarkets({ dbPath: outdated, includeSynthetic: true, limit: 1, offset: 0 })).details.code).toBe("SCHEMA_OUTDATED");
    const newer = tempDbPath();
    const db = openMigrated(newer);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(thrown(() => storedMarkets({ dbPath: newer, includeSynthetic: true, limit: 1, offset: 0 })).details.code).toBe("SCHEMA_TOO_NEW");
    expect(thrown(() => history(newer)).details.code).toBe("SCHEMA_TOO_NEW");
  });

  it("read-only connections are query_only: even a plain write statement is refused", () => {
    const path = tempDbPath();
    openMigrated(path).close();
    const ro = openDatabase({ path, readOnly: true });
    expect(get(ro, "PRAGMA query_only")).toEqual({ query_only: 1 });
    expect(thrown(() => run(ro, "DELETE FROM schema_migrations")).details.code).toBe("READONLY");
    ro.close();
  });

  it("all stored reads leave the database file byte-for-byte unchanged and write no WAL frames", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    const id = observe(db);
    observe(db, { ...at(60_000), source: "synthetic" });
    db.close();
    const before = sha(path);
    storedMarkets({ dbPath: path, includeSynthetic: true, limit: 10, offset: 0 });
    history(path, { includeSynthetic: true });
    observationDetails({ dbPath: path, observationId: id, asOf: null });
    collectionRuns({ dbPath: path, limit: 10, liveness: fakeLiveness(), now: () => new Date(T0) });
    expect(sha(path)).toBe(before);
    // SQLite may create the WAL index side files a WAL reader needs, but no transaction is ever written.
    expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);
  });
});

describe("snapshot-consistent reads during a concurrent collection", () => {
  it("statements inside readSnapshot see one state even when a writer commits between them", () => {
    const path = tempDbPath();
    const writer = openMigrated(path);
    observe(writer);
    const reader = openDatabase({ path, readOnly: true });
    const count = () => (get(reader, "SELECT count(*) AS n FROM market_observation") as { n: number }).n;
    const [first, second] = readSnapshot(reader, () => {
      const a = count();
      observe(writer, { id: "2" });
      return [a, count()];
    });
    expect([first, second]).toEqual([1, 1]);
    expect(count()).toBe(2); // the next snapshot sees the commit
    expect(reader.isTransaction).toBe(false);
    reader.close();
    writer.close();
  });

  it("an uncommitted collection write is invisible to the listing and history", () => {
    const path = tempDbPath();
    const writer = openMigrated(path);
    observe(writer);
    writer.exec("BEGIN IMMEDIATE");
    persistObservationUncommitted(writer);
    expect(storedMarkets({ dbPath: path, includeSynthetic: true, limit: 10, offset: 0 }).markets.map((m) => m.gammaId)).toEqual(["1"]);
    expect(history(path).analysisWindow.observations).toBe(1);
    writer.exec("ROLLBACK");
    writer.close();
  });

  it("a reader blocked by an exclusive lock fails as retryable DATABASE_BUSY and ends its transaction", () => {
    const path = tempDbPath();
    const writer = openMigrated(path);
    observe(writer);
    writer.exec("PRAGMA journal_mode = DELETE"); // rollback journal: an exclusive lock blocks readers
    writer.exec("BEGIN EXCLUSIVE");
    const reader = openDatabase({ path, readOnly: true, busyTimeoutMs: 20 });
    const error = thrown(() => readSnapshot(reader, () => listStoredMarkets(reader, { includeSynthetic: true, limit: 10, offset: 0 })));
    expect(error.details.code).toBe("DATABASE_BUSY");
    expect(describeError(error)).toMatchObject({ category: "storage_error", retryable: true });
    expect(reader.isTransaction).toBe(false);
    writer.exec("COMMIT");
    expect(readSnapshot(reader, () => listStoredMarkets(reader, { includeSynthetic: true, limit: 10, offset: 0 }))).toHaveLength(1);
    reader.close();
    writer.close();
  });
});

/** Insert a run and a bare observation row inside the caller's open transaction. */
function persistObservationUncommitted(db: Database): void {
  run(
    db,
    `INSERT INTO collection_run (run_id, source_type, status, accounting, started_at, owner_pid, owner_host, heartbeat_at, heartbeat_ms, app_version,
       schema_version, analytics_version, node_version, sqlite_version, protocol_version, config_json, budget_limit)
     VALUES ('pending-run', 'live', 'running', 'pending', ?, 1, 'h', ?, ?, 'x', 1, 1, 'v', 's', 'v1', '{}', 1)`,
    iso(0),
    iso(0),
    T0,
  );
  run(db, "INSERT INTO market (gamma_id, condition_id, protocol_version, first_seen_run) VALUES ('2', '0x2', 'v1', 'pending-run')");
  run(
    db,
    `INSERT INTO market_observation (run_id, gamma_id, discovery_position, available_at, available_at_ms, availability_basis, persisted_at, pairing,
       association, bucket, reasons_json, warnings_json, question, slug, outcome_labels_json, active, closed)
     VALUES ('pending-run', '2', 0, ?, ?, 'discovery', ?, 'none', 'not_attempted', 'failed', '[]', '[]', 'Q', 's', '[]', 1, 0)`,
    iso(500_000),
    T0 + 500_000,
    iso(500_000),
  );
  run(db, "INSERT INTO market_observation (run_id, gamma_id, discovery_position, available_at, available_at_ms, availability_basis, persisted_at, pairing, association, bucket, reasons_json, warnings_json, question, slug, outcome_labels_json, active, closed) SELECT 'pending-run', '1', 1, available_at, available_at_ms + 1, availability_basis, persisted_at, pairing, association, bucket, reasons_json, warnings_json, question, slug, outcome_labels_json, active, closed FROM market_observation WHERE gamma_id = '1' LIMIT 1");
}
