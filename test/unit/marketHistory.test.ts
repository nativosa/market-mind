import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { insertRecomputedMetrics, persistObservation } from "../../src/adapters/storage/snapshotStore.js";
import { openDatabase, type Database } from "../../src/adapters/storage/sqlite.js";
import { recomputeMetrics } from "../../src/analytics/recompute.js";
import { ANALYTICS_VERSION } from "../../src/analytics/version.js";
import { collectionRuns, marketHistory, type HistoryOptions } from "../../src/app/marketHistory.js";
import { historyJson } from "../../src/cli/jsonView.js";
import { decimal, decimalToString } from "../../src/domain/decimal.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { loadEvidence } from "../../src/adapters/storage/snapshotStore.js";
import { cleanupTemp, fakeLiveness, iso, META, openMigrated, record, startRun, T0, tempDbPath, type RecordSpec } from "../storageFixtures.js";

afterEach(cleanupTemp);

let runCounter = 0;
/** Store one observation in its own (live) run. */
function observe(db: Database, spec: RecordSpec & { source?: "live" | "synthetic" } = {}): number {
  const runId = startRun(db, { runId: `run-${++runCounter}`, sourceType: spec.source ?? "live" });
  return persistObservation(db, runId, record(spec), META, ANALYTICS_VERSION).observationId;
}

function history(dbPath: string, overrides: Partial<HistoryOptions> = {}) {
  return marketHistory({
    dbPath,
    gammaId: "1",
    asOf: null,
    limit: 20,
    threshold: decimal("0.02"),
    analyticsVersion: ANALYTICS_VERSION,
    includeSynthetic: false,
    ...overrides,
  });
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

/** Five observations of market 1, one minute apart, spreads 0.01..0.05. */
function seed(path: string): Database {
  const db = openMigrated(path);
  ["0.01", "0.02", "0.03", "0.04", "0.05"].forEach((spread, i) => {
    const bid = "0.40";
    const ask = decimalToString(decimal(bid).plus(decimal(spread)));
    observe(db, { ref: { bids: [[bid, "100"]], asks: [[ask, "100"]] }, receivedAt: [i * 60_000 + 100, i * 60_000 + 110] });
  });
  return db;
}

describe("marketHistory: scope", () => {
  it("statistics use every usable sample; --limit only trims the displayed rows", () => {
    const path = tempDbPath();
    seed(path).close();
    const r = history(path, { limit: 2 });
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x) => x.point.availableAt)).toEqual([iso(240_110), iso(180_110)]); // newest first
    expect(r.analysisWindow).toMatchObject({ observations: 5, truncated: false, oldestAvailableAt: iso(110), newestAvailableAt: iso(240_110) });
    expect(r.stats.usable).toBe(5);
    expect(r.stats.spread.n).toBe(5);
    expect([r.stats.spread.min, r.stats.spread.median, r.stats.spread.max].map((d) => decimalToString(d!))).toEqual(["0.01", "0.03", "0.05"]);
    expect(r.stats.threshold).toMatchObject({ n: 5, atOrAbove: 4 });
    expect(r.stats.gaps).toMatchObject({ n: 4, medianMs: 60_000 });
    expect(r.limitations.length).toBeGreaterThan(3);
  });

  it("caps the analysis window explicitly", () => {
    const path = tempDbPath();
    seed(path).close();
    const r = history(path, { maxObservations: 3 });
    expect(r.analysisWindow).toMatchObject({ observations: 3, truncated: true, maxObservations: 3, oldestAvailableAt: iso(120_110) });
    expect(r.stats.spread.n).toBe(3);
  });

  it("excludes synthetic runs unless asked", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    observe(db, { source: "synthetic" });
    db.close();
    expect(thrown(() => history(path)).details.code).toBe("NO_OBSERVATIONS");
    const r = history(path, { includeSynthetic: true });
    expect(r.rows[0]!.point.sourceType).toBe("synthetic");
  });

  it("counts incomplete and invalid observations but never uses them", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    observe(db, { receivedAt: [100, 110] });
    observe(db, { other: null, receivedAt: [200, 0] });
    observe(db, { other: { bids: [["2", "1"]], asks: [] }, receivedAt: [300, 310] });
    db.close();
    const r = history(path);
    expect(r.stats).toMatchObject({ eligible: 3, usable: 1, notUsable: { NOT_PAIRED: 1, INVALID_BOOK: 1, NO_METRICS_FOR_VERSION: 0, NOT_TWO_SIDED: 0 } });
    expect(r.rows.map((x) => x.flags.notUsable)).toEqual(["INVALID_BOOK", "NOT_PAIRED", null]);
  });
});

describe("marketHistory: as-of (evidence availability)", () => {
  it("excludes a paired observation whose second book arrived after the boundary, even though the first arrived before", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    observe(db, { receivedAt: [100, 110] }); // complete well before
    observe(db, { receivedAt: [1_000, 9_000] }); // YES at +1s (before), NO at +9s (after the boundary)
    db.close();
    const before = history(path, { asOf: iso(5_000) });
    expect(before.analysisWindow.observations).toBe(1);
    expect(before.rows[0]!.point.availableAt).toBe(iso(110));
    const after = history(path, { asOf: iso(9_000) }); // inclusive
    expect(after.analysisWindow.observations).toBe(2);
    expect(after.rows[0]!.point.availableAt).toBe(iso(9_000));
  });

  it("observations made after the boundary change no output byte", () => {
    const path = tempDbPath();
    const db = seed(path);
    const asOf = iso(130_000);
    const first = JSON.stringify(historyJson(history(path, { asOf })));
    observe(db, { receivedAt: [130_001, 130_002], ref: { bids: [["0.1", "999"]], asks: [["0.9", "999"]] } });
    observe(db, { receivedAt: [100_000, 500_000] }); // first book before, completion after
    db.close();
    expect(JSON.stringify(historyJson(history(path, { asOf })))).toBe(first);
    expect(history(path).analysisWindow.observations).toBe(7);
  });

  it("reports no observations when everything is after the boundary", () => {
    const path = tempDbPath();
    seed(path).close();
    const e = thrown(() => history(path, { asOf: iso(0) }));
    expect(e.kind).toBe("NotFound");
    expect(e.message).toContain(`available by ${iso(0)}`);
  });
});

describe("marketHistory: analytics versions", () => {
  it("uses exactly one analytics version and never mixes them", () => {
    const path = tempDbPath();
    const db = seed(path);
    // Recompute only the two newest observations under a hypothetical version 2.
    const ids = (db.prepare("SELECT id FROM market_observation ORDER BY available_at_ms DESC LIMIT 2").all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) {
      const { metrics } = recomputeMetrics(loadEvidence(db, id));
      insertRecomputedMetrics(db, id, metrics!, { analyticsVersion: 2, computedAt: new Date(T0), appVersion: "next", buildId: null });
    }
    db.close();
    const v1 = history(path);
    expect(v1.stats.usable).toBe(5);
    const v2 = history(path, { analyticsVersion: 2 });
    expect(v2.stats).toMatchObject({ eligible: 5, usable: 2, notUsable: { NO_METRICS_FOR_VERSION: 3 } });
    expect(v2.rows.filter((r) => r.point.metrics).every((r) => r.point.metrics!.analyticsVersion === 2)).toBe(true);
  });
});

describe("marketHistory and runs: database access", () => {
  it("a missing database is NotFound and is never created", () => {
    const path = tempDbPath("never.sqlite");
    const e = thrown(() => history(path));
    expect(e).toMatchObject({ kind: "NotFound", details: { code: "DATABASE_MISSING" } });
    expect(existsSync(path)).toBe(false);
    expect(thrown(() => collectionRuns({ dbPath: path, limit: 5, liveness: fakeLiveness(), now: () => new Date(T0) })).details.code).toBe("DATABASE_MISSING");
    expect(existsSync(path)).toBe(false);
  });

  it("an unmigrated database is reported as outdated to read-only commands", () => {
    const path = tempDbPath();
    openDatabase({ path, readOnly: false }).close();
    expect(thrown(() => history(path)).details.code).toBe("SCHEMA_OUTDATED");
  });

  it("runs lists newest first and annotates running runs without modifying them", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    startRun(db, { runId: "a", startedAt: new Date(T0), owner: { pid: 1, host: "test-host" } });
    startRun(db, { runId: "b", startedAt: new Date(T0 + 1000), owner: { pid: 2, host: "test-host" } });
    db.close();
    const r = collectionRuns({ dbPath: path, limit: 10, liveness: fakeLiveness({ 2: "alive" }), now: () => new Date(T0 + 10 * 60_000) });
    expect(r.runs.map((x) => [x.runId, x.status, x.owner])).toEqual([
      ["b", "running", "OWNER_ALIVE"],
      ["a", "running", "RECOVERABLE"],
    ]);
    expect(r.schemaVersion).toBe(1);
    expect(r.footprint.total).toBeGreaterThan(0);
    const again = collectionRuns({ dbPath: path, limit: 10, liveness: fakeLiveness(), now: () => new Date(T0) });
    expect(again.runs.every((x) => x.status === "running")).toBe(true); // reads never recover
  });
});
