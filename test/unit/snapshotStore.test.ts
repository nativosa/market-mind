import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalLevels,
  databaseFootprint,
  finalizeRun,
  insertRecomputedMetrics,
  listRuns,
  loadEvidence,
  observedCounts,
  persistObservation,
  readHistory,
  readMetricsRow,
  recordPersistenceFailure,
} from "../../src/adapters/storage/snapshotStore.js";
import { all, get, run, type Database } from "../../src/adapters/storage/sqlite.js";
import { recomputeMetrics } from "../../src/analytics/recompute.js";
import { ANALYTICS_VERSION } from "../../src/analytics/version.js";
import { decimal } from "../../src/domain/decimal.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { availabilityOf, pairingOf } from "../../src/domain/snapshot.js";
import { assetId } from "../scanFixtures.js";
import { cleanupTemp, evidence, iso, META, openMigrated, record, startRun, T0, tempDbPath } from "../storageFixtures.js";

afterEach(cleanupTemp);

function thrown(fn: () => unknown): MarketMindError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MarketMindError);
    return e as MarketMindError;
  }
  throw new Error("expected an error");
}

const count = (db: Database, table: string) => (get(db, `SELECT count(*) AS n FROM ${table}`) as { n: number }).n;
const persist = (db: Database, runId: string, rec = record()) => persistObservation(db, runId, rec, META, ANALYTICS_VERSION);

describe("persistObservation: exact evidence", () => {
  it("round-trips decimal strings and raw level strings byte for byte (wire order, duplicates, zero sizes)", () => {
    const db = openMigrated();
    const runId = startRun(db);
    const ref = {
      bids: [
        ["0.123456789012345678", "123456789012345678.000000001"],
        ["0.1", "0"],
      ],
      asks: [
        ["0.200000000000000001", "0.000000000000000001"],
        ["0.200000000000000001", "5"],
      ],
      raw: { tick_size: "0.000000000000000001" },
    } as const;
    const rec = record({ ref: { bids: ref.bids.map((l) => [...l]), asks: ref.asks.map((l) => [...l]), raw: ref.raw } as never });
    const r = persist(db, runId, rec);
    expect(r).toMatchObject({ booksWritten: 2, bookContentsNew: 2, bookContentsReused: 0, metricsWritten: 1 });
    const stored = loadEvidence(db, r.observationId);
    const original = rec.books[0]!.book;
    expect(stored.books[0]!.book.bids).toEqual(original.bids);
    expect(stored.books[0]!.book.asks).toEqual(original.asks);
    const m = readMetricsRow(db, r.observationId, ANALYTICS_VERSION)!;
    expect(m.best_bid).toBe("0.123456789012345678");
    expect(m.best_bid_size).toBe("123456789012345678.000000001");
    expect(m.top_size).toBe("5.000000000000000001"); // duplicate ask levels aggregated exactly
    expect(typeof m.spread).toBe("string");
  });

  it("stores both outcome books with per-book request timing, upstream timestamp and observed labels", () => {
    const db = openMigrated();
    const runId = startRun(db);
    const r = persist(db, runId, record({ labels: ["Team Alpha", "Team Beta"], receivedAt: [100, 250] }));
    const books = all(db, "SELECT outcome_index, label_observed, response_received_at, server_ts_raw, server_ts_ms, upstream_hash, quality FROM book_observation ORDER BY outcome_index");
    expect(books).toEqual([
      { outcome_index: 0, label_observed: "Team Alpha", response_received_at: iso(100), server_ts_raw: "1793221537744", server_ts_ms: 1793221537744, upstream_hash: "hash10", quality: "valid" },
      { outcome_index: 1, label_observed: "Team Beta", response_received_at: iso(250), server_ts_raw: "1793221537744", server_ts_ms: 1793221537744, upstream_hash: "hash11", quality: "valid" },
    ]);
    const obs = get(db, "SELECT pairing, association, available_at, availability_basis, outcome_labels_json FROM market_observation WHERE id = ?", r.observationId);
    expect(obs).toEqual({
      pairing: "paired",
      association: "confirmed",
      available_at: iso(250), // the later book, not the reference book
      availability_basis: "paired_books",
      outcome_labels_json: '["Team Alpha","Team Beta"]',
    });
    expect(readMetricsRow(db, r.observationId, ANALYTICS_VERSION)!.pair_skew_ms).toBe(150);
  });

  it("keeps V1 tokenId and V2 positionId identities", () => {
    const db = openMigrated();
    const runId = startRun(db);
    persist(db, runId, record({ id: "11", version: "v1" }));
    persist(db, runId, record({ id: "22", version: "v2", position: 1 }));
    expect(all(db, "SELECT gamma_id, outcome_index, asset_id_kind FROM outcome ORDER BY gamma_id, outcome_index")).toEqual([
      { gamma_id: "11", outcome_index: 0, asset_id_kind: "tokenId" },
      { gamma_id: "11", outcome_index: 1, asset_id_kind: "tokenId" },
      { gamma_id: "22", outcome_index: 0, asset_id_kind: "positionId" },
      { gamma_id: "22", outcome_index: 1, asset_id_kind: "positionId" },
    ]);
    expect(all(db, "SELECT gamma_id, protocol_version FROM market ORDER BY gamma_id")).toEqual([
      { gamma_id: "11", protocol_version: "v1" },
      { gamma_id: "22", protocol_version: "v2" },
    ]);
  });

  it("deduplicates identical book contents across runs but keeps every observation", () => {
    const db = openMigrated();
    const r1 = startRun(db, { runId: "run-a" });
    const r2 = startRun(db, { runId: "run-b" });
    const a = persist(db, r1);
    const b = persist(db, r2);
    expect(a.bookContentsNew).toBe(2);
    expect(b).toMatchObject({ bookContentsNew: 0, bookContentsReused: 2 });
    expect(count(db, "book_content")).toBe(2);
    expect(count(db, "book_observation")).toBe(4);
    expect(count(db, "market_observation")).toBe(2);
  });

  it("canonical content hashes depend on exact strings and order", () => {
    const base = record().books[0]!.book;
    const h = canonicalLevels(base).hash;
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalLevels({ ...base, bids: base.bids.map((l) => ({ ...l, price: `${l.price}0` })) }).hash).not.toBe(h);
    expect(canonicalLevels({ ...base, bids: [...base.bids, { price: "0.1", size: "1" }].reverse() }).hash).not.toBe(h);
    expect(canonicalLevels({ ...base }).hash).toBe(h);
  });

  it("detects a content-hash collision instead of silently reusing different levels", () => {
    const db = openMigrated();
    const runId = startRun(db);
    const rec = record();
    const { hash } = canonicalLevels(rec.books[0]!.book);
    run(db, "INSERT INTO book_content VALUES (?, '[]', '[]', 0, 0)", hash);
    expect(thrown(() => persist(db, runId, rec)).details.code).toBe("HASH_COLLISION");
    expect(count(db, "market_observation")).toBe(0);
  });

  it("records request evidence once per scope", () => {
    const db = openMigrated();
    const runId = startRun(db);
    persist(db, runId, record({ id: "31", position: 0 }));
    persist(db, runId, record({ id: "32", position: 1 })); // same discovery page
    const scopes = all(db, "SELECT scope FROM request_log ORDER BY id").map((r) => r.scope);
    expect(scopes).toEqual([
      "discovery page 1",
      "market 31 association",
      "market 31 book Yes",
      "market 31 book No",
      "market 32 association",
      "market 32 book Yes",
      "market 32 book No",
    ]);
  });

  it("keeps distinct requests that share a scope label (duplicate outcome labels)", () => {
    const db = openMigrated();
    const runId = startRun(db);
    persist(db, runId, record({ id: "33", labels: ["Yes", "Yes"] }));
    const rows = all(db, "SELECT scope, url FROM request_log WHERE scope LIKE '%book%' ORDER BY id");
    expect(rows.map((r) => r.scope)).toEqual(["market 33 book Yes", "market 33 book Yes"]);
    expect(new Set(rows.map((r) => r.url)).size).toBe(2);
  });
});

describe("persistObservation: incomplete and invalid evidence", () => {
  it("stores a single received book as incomplete, without metrics, available when that book arrived", () => {
    const db = openMigrated();
    const runId = startRun(db);
    const rec = record({ other: null, receivedAt: [100, 0], requests: [evidence("market 1 book No", "/book", 900, "Upstream5xx")] });
    const r = persist(db, runId, rec);
    expect(r).toMatchObject({ booksWritten: 1, metricsWritten: 0 });
    expect(get(db, "SELECT pairing, bucket, available_at, availability_basis FROM market_observation")).toEqual({
      pairing: "incomplete",
      bucket: "failed",
      available_at: iso(100), // the failed request's timing is not evidence
      availability_basis: "single_book",
    });
    expect(count(db, "market_metrics")).toBe(0);
    expect(all(db, "SELECT error_kind FROM request_log WHERE scope = 'market 1 book No'")).toEqual([{ error_kind: "Upstream5xx" }]);
  });

  it("stores observations without books (association mismatch, not scanned) with their basis", () => {
    const db = openMigrated();
    const runId = startRun(db);
    const mismatch = { ...record({ ref: null, other: null, association: "mismatch" }), bucket: "failed" as const, reasons: [{ code: "ASSOCIATION_MISMATCH" as const, detail: "x" }] };
    persist(db, runId, mismatch);
    const notScanned = {
      ...record({ id: "2", ref: null, other: null, association: "not_attempted", position: 1 }),
      bucket: "notScanned" as const,
      reasons: [{ code: "DEADLINE" as const, detail: "x" }],
    };
    notScanned.requests = notScanned.requests.filter((q) => q.endpoint === "/markets/keyset");
    persist(db, runId, notScanned);
    expect(all(db, "SELECT gamma_id, pairing, association, bucket, availability_basis, available_at FROM market_observation ORDER BY gamma_id")).toEqual([
      { gamma_id: "1", pairing: "none", association: "mismatch", bucket: "failed", availability_basis: "association", available_at: iso(50) },
      { gamma_id: "2", pairing: "none", association: "not_attempted", bucket: "notScanned", availability_basis: "discovery", available_at: iso(0) },
    ]);
    expect(count(db, "book_observation")).toBe(0);
    expect(count(db, "outcome")).toBe(4); // identities are still recorded
  });

  it("keeps an invalid book as audit evidence but never derives metrics from it", () => {
    const db = openMigrated();
    const runId = startRun(db);
    const rec = record({ other: { bids: [["1.5", "10"]], asks: [] } });
    expect(rec.books[1]!.assessment.quality).toBe("invalid");
    const r = persist(db, runId, rec);
    expect(r).toMatchObject({ booksWritten: 2, metricsWritten: 0 });
    expect(all(db, "SELECT outcome_index, quality FROM book_observation ORDER BY outcome_index")).toEqual([
      { outcome_index: 0, quality: "valid" },
      { outcome_index: 1, quality: "invalid" },
    ]);
    expect(loadEvidence(db, r.observationId).books[1]!.book.bids).toEqual([{ price: "1.5", size: "10" }]);
  });

  it("refuses a record without any timed evidence (never fabricates a timestamp)", () => {
    const db = openMigrated();
    const runId = startRun(db);
    const rec = { ...record({ ref: null, other: null }), requests: [] };
    expect(availabilityOf(rec)).toBeNull();
    expect(thrown(() => persist(db, runId, rec)).details.code).toBe("INVALID_VALUE");
  });

  it("pairingOf", () => {
    const r = record();
    expect([pairingOf(r.books), pairingOf(r.books.slice(0, 1)), pairingOf([])]).toEqual(["paired", "incomplete", "none"]);
  });
});

describe("identity versus observed metadata", () => {
  it("stores label, question, status and end-date changes per observation without conflict", () => {
    const db = openMigrated();
    const r1 = startRun(db, { runId: "run-a" });
    const r2 = startRun(db, { runId: "run-b" });
    persist(db, r1, record({ labels: ["Yes", "No"] }));
    persist(db, r2, record({ labels: ["Yes (renamed)", "No"], gamma: { question: "Edited?", acceptingOrders: false, endDate: "2027-01-01T00:00:00Z" } }));
    expect(all(db, "SELECT question, outcome_labels_json, accepting_orders, end_date FROM market_observation ORDER BY id")).toEqual([
      { question: "Synthetic market 1?", outcome_labels_json: '["Yes","No"]', accepting_orders: 1, end_date: null },
      { question: "Edited?", outcome_labels_json: '["Yes (renamed)","No"]', accepting_orders: 0, end_date: "2027-01-01T00:00:00Z" },
    ]);
    expect(all(db, "SELECT label_observed FROM book_observation WHERE outcome_index = 0 ORDER BY id")).toEqual([
      { label_observed: "Yes" },
      { label_observed: "Yes (renamed)" },
    ]);
    expect(count(db, "outcome")).toBe(2);
  });

  it("rejects a changed condition id or protocol for a known market, writing nothing", () => {
    const db = openMigrated();
    const runId = startRun(db);
    persist(db, runId, record());
    const conflict = record({ gamma: { conditionId: "0xdifferent" }, position: 1 });
    const error = thrown(() => persist(db, runId, conflict));
    expect(error.details.code).toBe("IDENTITY_CONFLICT");
    expect(error.details.issues![0]).toContain("condition_id stored");
    const v2 = record({ version: "v2", position: 2 });
    expect(thrown(() => persist(db, runId, v2)).details.issues!.some((i) => i.includes("protocol_version"))).toBe(true);
    expect(count(db, "market_observation")).toBe(1);
  });

  it("rejects an asset moving to another index or market", () => {
    const db = openMigrated();
    const runId = startRun(db);
    persist(db, runId, record());
    // Same market, outcomes swapped: asset 0 now at index 1.
    const swapped = record({ position: 1 });
    swapped.outcomes = swapped.outcomes.map((o) => ({ ...o, index: 1 - o.index }));
    swapped.books = [];
    swapped.requests = swapped.requests.filter((q) => q.endpoint !== "/book");
    expect(thrown(() => persist(db, runId, swapped)).details.code).toBe("IDENTITY_CONFLICT");
    // Another market claiming market 1's asset.
    const stolen = record({ id: "9", position: 2 });
    stolen.outcomes = [{ ...stolen.outcomes[0]!, assetId: assetId("1", 0) }, stolen.outcomes[1]!];
    stolen.books = [];
    stolen.requests = stolen.requests.filter((q) => q.endpoint !== "/book");
    expect(thrown(() => persist(db, runId, stolen)).details.issues![0]).toContain("stored under market 1");
    expect(count(db, "market_observation")).toBe(1);
  });
});

describe("market-level atomicity", () => {
  it.each(["market_observation", "book_content", "book_observation", "market_metrics", "request_log", "outcome"])(
    "a failure while inserting into %s leaves zero rows for the market and no heartbeat change",
    (table) => {
      const db = openMigrated();
      const runId = startRun(db);
      const heartbeat = get(db, "SELECT heartbeat_ms FROM collection_run")!.heartbeat_ms;
      db.exec(`CREATE TRIGGER inject BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
      expect(thrown(() => persist(db, runId)).message).toContain("injected failure");
      for (const t of ["market", "outcome", "market_observation", "book_content", "book_observation", "market_metrics", "request_log"]) {
        expect(count(db, t), t).toBe(0);
      }
      expect(get(db, "SELECT heartbeat_ms FROM collection_run")!.heartbeat_ms).toBe(heartbeat);
      expect(db.isTransaction).toBe(false);
    },
  );

  it("a constraint violation (duplicate market in one run) rolls back the second write only", () => {
    const db = openMigrated();
    const runId = startRun(db);
    persist(db, runId);
    expect(thrown(() => persist(db, runId, record({ position: 5 }))).details.code).toBe("CONSTRAINT");
    expect(count(db, "market_observation")).toBe(1);
    expect(count(db, "book_observation")).toBe(2);
  });

  it("refuses observations for a run that is no longer running", () => {
    const db = openMigrated();
    const runId = startRun(db);
    finalizeRun(db, runId, {
      status: "complete",
      accounting: "verified",
      finishedAt: new Date(T0 + 5),
      stopReasons: [],
      scanCounts: null,
      persistCounts: {},
      budgetUsed: 0,
      window: null,
      error: null,
    });
    expect(thrown(() => persist(db, runId)).details.code).toBe("RUN_NOT_RUNNING");
  });

  it("market writes are visible to other connections as soon as they commit", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    const other = openMigrated(path);
    const runId = startRun(db);
    persist(db, runId);
    expect(count(other, "market_observation")).toBe(1);
    db.close();
    other.close();
  });
});

describe("runs, failures and reads", () => {
  it("finalize is compare-and-set and listRuns returns parsed records", () => {
    const db = openMigrated();
    const runId = startRun(db);
    recordPersistenceFailure(db, runId, { gammaId: "7", discoveryPosition: 3, code: "DATABASE_BUSY", message: "busy", occurredAt: new Date(T0) });
    const final = {
      status: "partial" as const,
      accounting: "verified" as const,
      finishedAt: new Date(T0 + 99),
      stopReasons: ["BUDGET_EXHAUSTED"],
      scanCounts: { discovered: 5 },
      persistCounts: { selected: 1, persistedObservations: 0, persistenceFailures: 1 },
      budgetUsed: 7,
      window: { first: iso(0), last: iso(50) },
      error: null,
    };
    expect(finalizeRun(db, runId, final)).toBe(true);
    expect(finalizeRun(db, runId, { ...final, status: "complete" })).toBe(false);
    const [r] = listRuns(db, 10);
    expect(r).toMatchObject({
      runId,
      status: "partial",
      accounting: "verified",
      stopReasons: ["BUDGET_EXHAUSTED"],
      scanCounts: { discovered: 5 },
      budgetUsed: 7,
      windowFirst: iso(0),
      sourceType: "synthetic",
    });
    expect(observedCounts(db, runId)).toEqual({ persistedObservations: 0, persistenceFailures: 1, booksWritten: 0, metricsWritten: 0 });
  });

  it("readHistory filters by market, source type and evidence availability, newest first", () => {
    const db = openMigrated();
    const live = startRun(db, { runId: "live-1", sourceType: "live" });
    const synth = startRun(db, { runId: "synth-1", sourceType: "synthetic" });
    persist(db, live, record({ receivedAt: [100, 110] }));
    persist(db, synth, record({ receivedAt: [200, 210] }));
    persist(db, live, record({ id: "2", position: 1 }));
    const q = { gammaId: "1", analyticsVersion: ANALYTICS_VERSION, includeSynthetic: false, asOfMs: null, limit: 10 };
    expect(readHistory(db, q).map((p) => p.runId)).toEqual(["live-1"]);
    expect(readHistory(db, { ...q, includeSynthetic: true }).map((p) => p.runId)).toEqual(["synth-1", "live-1"]);
    expect(readHistory(db, { ...q, includeSynthetic: true, asOfMs: T0 + 209 }).map((p) => p.runId)).toEqual(["live-1"]);
    expect(readHistory(db, { ...q, includeSynthetic: true, asOfMs: T0 + 210 }).map((p) => p.runId)).toEqual(["synth-1", "live-1"]);
    const [p] = readHistory(db, q);
    expect(p!.metrics!.spread!.toFixed()).toBe("0.05");
    expect(p!.books.map((b) => b.label)).toEqual(["Yes", "No"]);
    expect(readHistory(db, { ...q, analyticsVersion: 99 })[0]!.metrics).toBeNull();
  });

  it("databaseFootprint counts main, WAL and SHM files; missing files are 0", () => {
    const path = tempDbPath();
    expect(databaseFootprint(path)).toEqual({ main: 0, wal: 0, shm: 0, total: 0 });
    const db = openMigrated(path);
    const f = databaseFootprint(path);
    expect(f.wal).toBeGreaterThan(0);
    expect(f.shm).toBeGreaterThan(0);
    expect(f.total).toBe(f.main + f.wal + f.shm);
    db.close();
  });
});

describe("reconstruction and recomputation", () => {
  it("reconstructs the exact captured books and recomputes identical metrics", () => {
    const db = openMigrated();
    const runId = startRun(db);
    const rec = record({ ref: { bids: [["0.40", "120"], ["0.39", "50"]], asks: [["0.46", "80"]] }, receivedAt: [100, 140] });
    const { observationId } = persist(db, runId, rec);
    const ev = loadEvidence(db, observationId);
    expect(ev.depthBand!.toFixed()).toBe("0.05");
    expect(ev.books.map((b) => b.book)).toEqual(rec.books.map((b) => b.book));
    const { metrics } = recomputeMetrics(ev);
    insertRecomputedMetrics(db, observationId, metrics!, { analyticsVersion: ANALYTICS_VERSION + 1, computedAt: new Date(T0 + 5_000), appVersion: "next", buildId: null });
    const original = readMetricsRow(db, observationId, ANALYTICS_VERSION)!;
    const again = readMetricsRow(db, observationId, ANALYTICS_VERSION + 1)!;
    const strip = (r: Record<string, unknown>) => {
      const { analytics_version: _a, computed_at: _b, computed_by: _c, app_version: _d, build_id: _e, ...rest } = r;
      return rest;
    };
    expect(strip(again)).toEqual(strip(original));
    expect([original.computed_by, again.computed_by]).toEqual(["collect", "recompute"]);
  });

  it("recompute yields no metrics for incomplete or invalid evidence", () => {
    const one = record({ other: null });
    expect(recomputeMetrics({ conditionId: one.market.conditionId, depthBand: decimal("0.05"), books: one.books }).metrics).toBeNull();
    const bad = record({ other: { bids: [["abc", "1"]], asks: [] } });
    expect(recomputeMetrics({ conditionId: bad.market.conditionId, depthBand: null, books: bad.books }).metrics).toBeNull();
  });
});
