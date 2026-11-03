import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistObservation } from "../../src/adapters/storage/snapshotStore.js";
import { openDatabase, type Database } from "../../src/adapters/storage/sqlite.js";
import { ANALYTICS_VERSION } from "../../src/analytics/version.js";
import {
  DetailsOutput,
  StoredMarketsOutput,
  WEB_CONTRACT,
  WebErrorOutput,
  WebHistoryOutput,
  WebRunsOutput,
  WebStatusOutput,
  type WebErrorOutput as WebError,
} from "../../src/research/contracts.js";
import { httpStatusOf } from "../../src/web/server.js";
import { fixture, json } from "../helpers.js";
import { cleanupTemp, iso, META, openMigrated, record, startRun, T0, tempDbPath, type RecordSpec } from "../storageFixtures.js";
import { closeAllWeb, startWeb, type HttpReply } from "../webFixtures.js";

// Stage 3.2 read-only stored-data API: real node:http server on 127.0.0.1, isolated temporary
// databases, and an upstream fetch that records every URL (none may ever be requested here).

afterEach(async () => {
  await closeAllWeb();
  cleanupTemp();
});

const errorOf = (r: HttpReply) => WebErrorOutput.parse(r.json()).error;
const at = (ms: number): Pick<RecordSpec, "receivedAt"> => ({ receivedAt: [ms + 100, ms + 110] });

let runCounter = 0;
function observe(db: Database, spec: RecordSpec & { source?: "live" | "synthetic" } = {}): number {
  const runId = startRun(db, { runId: `run-${++runCounter}`, sourceType: spec.source ?? "live", startedAt: new Date(T0 + runCounter) });
  return persistObservation(db, runId, record(spec), META, ANALYTICS_VERSION).observationId;
}

/** Market 1: two live observations and one synthetic; market 2: synthetic only. */
function seed(): { path: string; live: number; synthetic: number } {
  const path = tempDbPath();
  const db = openMigrated(path);
  const live = observe(db, { ...at(0), ref: { bids: [["0.40", "0.000000000000000001"]], asks: [["0.45", "100"]] } });
  observe(db, at(60_000));
  const synthetic = observe(db, { ...at(120_000), source: "synthetic" });
  observe(db, { id: "2", ...at(180_000), source: "synthetic" });
  db.close();
  return { path, live, synthetic };
}

const STORED_ROUTES = ["/api/stored/runs", "/api/stored/markets", "/api/stored/markets/1/history", "/api/stored/observations/1"];

describe("missing database", () => {
  it("stored routes answer 404 database_missing, create nothing, and status and the live explorer keep working", async () => {
    const path = tempDbPath("absent.sqlite");
    const s = await startWeb({ dbPath: path, routes: { "/markets/keyset": json(fixture("gamma/keyset-v1.json")) } });
    for (const route of STORED_ROUTES) {
      const r = await s.get(route);
      expect(r.status, route).toBe(404);
      expect(errorOf(r)).toMatchObject({ category: "database_missing", code: "DATABASE_MISSING", retryable: false });
      expect(r.text).not.toContain(dirname(path));
    }
    expect(existsSync(path)).toBe(false);
    const status = WebStatusOutput.parse((await s.get("/api/status")).json());
    expect(status).toMatchObject({ live: { enabled: true }, stored: { defaultSource: "live", database: "missing" } });
    expect(s.urls).toEqual([]); // nothing above reached upstream
    expect((await s.get("/api/markets")).status).toBe(200);
    expect(s.urls).toHaveLength(1);
  });
});

describe("stored routes over a populated database", () => {
  it("make no upstream request and use no live budget", async () => {
    const { path, live } = seed();
    const s = await startWeb({ dbPath: path });
    for (const route of [...STORED_ROUTES.slice(0, 3), `/api/stored/observations/${live}`]) expect((await s.get(route)).status, route).toBe(200);
    expect(s.urls).toEqual([]);
    expect(s.gate.process.used).toBe(0);
    expect(s.gate.window).toMatchObject({ used: 0 });
    const status = WebStatusOutput.parse((await s.get("/api/status")).json());
    expect(status.budget.process).toEqual({ limit: 100, used: 0, remaining: 100 });
    expect(status.stored.database).toBe("present");
  });

  it("GET /api/stored/runs: live by default, both provenance types with source=all, each marked", async () => {
    const { path } = seed();
    const s = await startWeb({ dbPath: path });
    const live = WebRunsOutput.parse((await s.get("/api/stored/runs")).json());
    expect(live).toMatchObject({ contract: WEB_CONTRACT.storedRuns, source: "stored", appliedLimits: { limit: 20, source: "live" }, runs: { returnedCount: 2 } });
    expect(live.runs.items.every((r) => r.sourceType === "live")).toBe(true);
    const all = WebRunsOutput.parse((await s.get("/api/stored/runs?source=all&limit=3")).json());
    expect(all.runs).toMatchObject({ returnedCount: 3, hasMore: true });
    expect(all.runs.items.map((r) => r.sourceType)).toEqual(["synthetic", "synthetic", "live"]);
  });

  it("GET /api/stored/markets: synthetic-only markets appear only with source=all", async () => {
    const { path } = seed();
    const s = await startWeb({ dbPath: path });
    const live = StoredMarketsOutput.parse((await s.get("/api/stored/markets")).json());
    expect(live.markets.items.map((m) => [m.gammaId, m.observations, m.syntheticObservations])).toEqual([["1", 2, 0]]);
    const all = StoredMarketsOutput.parse((await s.get("/api/stored/markets?source=all&limit=1&offset=0")).json());
    expect(all).toMatchObject({ appliedLimits: { source: "all", limit: 1, offset: 0 }, markets: { returnedCount: 1, hasMore: true, nextOffset: 1 } });
    expect(all.markets.items[0]!.gammaId).toBe("2");
  });

  it("GET /api/stored/markets/:id/history: exact decimals, depth and provenance filtering", async () => {
    const { path } = seed();
    const s = await startWeb({ dbPath: path });
    const r = await s.get("/api/stored/markets/1/history");
    expect(r.status).toBe(200);
    const live = WebHistoryOutput.parse(r.json());
    expect(live).toMatchObject({ status: "ok", appliedLimits: { marketId: "1", source: "live", seriesMax: 2_000, spreadThreshold: "0.02" }, series: { returnedCount: 2, sourceCounts: { live: 2, synthetic: 0 } } });
    expect(live.series.items.at(-1)!.metrics).toMatchObject({ bestBidSize: "0.000000000000000001", depthBand: "0.05" });
    expect(r.text).toContain('"bestBidSize":"0.000000000000000001"');
    const all = WebHistoryOutput.parse((await s.get("/api/stored/markets/1/history?source=all&spreadThreshold=0.05&analyticsVersion=1")).json());
    expect(all.series.sourceCounts).toEqual({ live: 2, synthetic: 1 });
    expect(all.appliedLimits.spreadThreshold).toBe("0.05");
    const asOf = WebHistoryOutput.parse((await s.get(`/api/stored/markets/1/history?asOf=${encodeURIComponent("2026-10-28T23:05:12.110+02:00")}`)).json());
    expect(asOf.appliedLimits.asOf).toBe(iso(110)); // normalized to UTC
    expect(asOf.series.returnedCount).toBe(1);
  });

  it("history of a market with no matching observation is an explicit no_history (200)", async () => {
    const { path } = seed();
    const s = await startWeb({ dbPath: path });
    for (const route of ["/api/stored/markets/999/history", "/api/stored/markets/2/history"]) {
      const r = await s.get(route);
      expect(r.status).toBe(200);
      expect(WebHistoryOutput.parse(r.json())).toMatchObject({ status: "no_history", evidence: "insufficient", stats: null, series: { items: [] } });
    }
  });

  it("GET /api/stored/observations/:id enforces the same source filter as the history", async () => {
    const { path, live, synthetic } = seed();
    const s = await startWeb({ dbPath: path });
    const ok = DetailsOutput.parse((await s.get(`/api/stored/observations/${live}?levels=1`)).json());
    expect(ok).toMatchObject({ observation: { observationId: live, gammaId: "1" }, run: { sourceType: "live" }, appliedLimits: { levels: 1 } });
    const hidden = await s.get(`/api/stored/observations/${synthetic}`);
    expect(hidden.status).toBe(404);
    expect(errorOf(hidden)).toMatchObject({ category: "observation_not_found", code: "OBSERVATION_NOT_FOUND" });
    const shown = DetailsOutput.parse((await s.get(`/api/stored/observations/${synthetic}?source=all`)).json());
    expect(shown.run.sourceType).toBe("synthetic");
    expect(errorOf(await s.get("/api/stored/observations/999999"))).toMatchObject({ category: "observation_not_found" });
    const early = await s.get(`/api/stored/observations/${live}?asOf=${encodeURIComponent(iso(0))}`);
    expect(early.status).toBe(404);
    expect(errorOf(early).category).toBe("observation_not_available_as_of");
  });

  it("never returns local paths or host details", async () => {
    const { path, live } = seed();
    const s = await startWeb({ dbPath: path });
    for (const route of ["/api/stored/runs?source=all", "/api/stored/markets?source=all", "/api/stored/markets/1/history?source=all", `/api/stored/observations/${live}`, "/api/status"]) {
      const text = (await s.get(route)).text;
      expect(text, route).not.toContain(dirname(path));
      expect(text, route).not.toMatch(/mm-store-|test-host|"ownerPid"|"ownerHost"|"dbPath"/);
    }
  });
});

describe("validation and method", () => {
  it.each([
    ["/api/stored/runs?limit=0", "limit"],
    ["/api/stored/runs?limit=101", "limit"],
    ["/api/stored/runs?limit=1e2", "limit"],
    ["/api/stored/runs?source=synthetic", "source"],
    ["/api/stored/runs?verbose=1", "unknown"],
    ["/api/stored/runs?limit=1&limit=2", "repeated"],
    ["/api/stored/markets?offset=-1", "offset"],
    ["/api/stored/markets?offset=1000001", "offset"],
    ["/api/stored/markets?includeSynthetic=true", "unknown"],
    ["/api/stored/markets/abc/history", "marketId"],
    ["/api/stored/markets/1/history?asOf=yesterday", "asOf"],
    ["/api/stored/markets/1/history?spreadThreshold=2", "spreadThreshold"],
    ["/api/stored/markets/1/history?limit=5", "unknown"],
    ["/api/stored/markets/1/history?source=all&source=live", "repeated"],
    ["/api/stored/observations/0", "observationId"],
    ["/api/stored/observations/1.5", "observationId"],
    ["/api/stored/observations/1?levels=51", "levels"],
    ["/api/stored/observations/1?path=/etc/passwd", "unknown"],
  ])("%s is refused with 400 (%s) before the database is opened", async (route) => {
    const s = await startWeb({ dbPath: tempDbPath("never.sqlite") });
    const r = await s.get(route);
    expect(r.status).toBe(400);
    expect(errorOf(r).category).toBe("invalid_arguments");
  });

  it("only GET is allowed on stored routes", async () => {
    const { path } = seed();
    const s = await startWeb({ dbPath: path });
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await s.get("/api/stored/markets", { method });
      expect(r.status).toBe(405);
      expect(r.headers.allow).toBe("GET");
    }
  });
});

describe("storage errors", () => {
  it("an incompatible schema is a non-retryable 500 storage_error without a path", async () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    const s = await startWeb({ dbPath: path });
    const r = await s.get("/api/stored/markets");
    expect(r.status).toBe(500);
    expect(errorOf(r)).toEqual({ category: "storage_error", code: "SCHEMA_TOO_NEW", message: "Local database error (SCHEMA_TOO_NEW).", retryable: false, details: {} });
  });

  it("an unmigrated database is a non-retryable storage_error (SCHEMA_OUTDATED)", async () => {
    const path = tempDbPath();
    openDatabase({ path, readOnly: false }).close(); // empty, unmigrated
    const s = await startWeb({ dbPath: path });
    expect(errorOf(await s.get("/api/stored/runs"))).toMatchObject({ category: "storage_error", code: "SCHEMA_OUTDATED" });
  });

  it("HTTP statuses: missing data 404, busy 503, other storage failures 500", () => {
    const e = (category: WebError["error"]["category"], retryable = false): WebError["error"] => ({ category, code: null, message: "", retryable, details: {} });
    expect(httpStatusOf(e("database_missing"))).toBe(404);
    expect(httpStatusOf(e("observation_not_found"))).toBe(404);
    expect(httpStatusOf(e("observation_not_available_as_of"))).toBe(404);
    expect(httpStatusOf(e("storage_error", true))).toBe(503);
    expect(httpStatusOf(e("storage_error", false))).toBe(500);
  });
});

describe("server modes for a synthetic demonstration (no launcher yet)", () => {
  it("defaultSource 'all' includes synthetic data when a request names no source; an explicit source still wins", async () => {
    const { path } = seed();
    const s = await startWeb({ dbPath: path, defaultSource: "all" });
    const history = WebHistoryOutput.parse((await s.get("/api/stored/markets/1/history")).json());
    expect(history.appliedLimits.source).toBe("all");
    expect(history.series.sourceCounts.synthetic).toBe(1);
    const liveOnly = WebHistoryOutput.parse((await s.get("/api/stored/markets/1/history?source=live")).json());
    expect(liveOnly.series.sourceCounts.synthetic).toBe(0);
    expect(WebStatusOutput.parse((await s.get("/api/status")).json()).stored.defaultSource).toBe("all");
  });

  it("liveEnabled false refuses every live route before the gate, while stored routes work", async () => {
    const { path } = seed();
    const s = await startWeb({ dbPath: path, liveEnabled: false, routes: { "/markets/keyset": json(fixture("gamma/keyset-v1.json")) } });
    for (const route of ["/api/markets", "/api/markets?version=v2", "/api/markets/1/inspect"]) {
      const r = await s.get(route);
      expect(r.status, route).toBe(403);
      expect(errorOf(r)).toMatchObject({ category: "forbidden", code: "LIVE_DISABLED" });
    }
    expect((await s.get("/api/stored/markets/1/history")).status).toBe(200);
    expect(s.urls).toEqual([]);
    expect(s.gate.process.used).toBe(0);
    expect(WebStatusOutput.parse((await s.get("/api/status")).json()).live).toEqual({ enabled: false });
  });
});

describe("bounded output", () => {
  it("a long history returns at most 2,000 plotted observations while statistics cover the whole window", { timeout: 120_000 }, async () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    // A throwaway fixture: without an fsync per commit its ~6,000 transactions take about 2 s instead
    // of about a minute of disk flushes that stall the other workers' SQLite tests.
    db.exec("PRAGMA synchronous = OFF");
    const question = `Q${"x".repeat(1_000)}?`; // truncated to the shared untrusted-text bound
    // One observation per run (a market is observed at most once per run), as collect stores them.
    for (let i = 0; i < 2_050; i++) observe(db, { ...at(i * 60_000), gamma: { question } });
    db.close();
    const s = await startWeb({ dbPath: path });
    const r = await s.get("/api/stored/markets/1/history");
    const view = WebHistoryOutput.parse(r.json());
    expect(view.series).toMatchObject({ returnedCount: 2_000, windowObservations: 2_050, truncated: true });
    expect(view.analysisWindow).toMatchObject({ observations: 2_050, truncated: false });
    expect(view.stats!.eligible).toBe(2_050);
    expect(view.series.items[0]!.question.length).toBeLessThanOrEqual(300);
    expect(Buffer.byteLength(r.text)).toBeLessThan(4 * 1024 * 1024);
    expect(s.urls).toEqual([]);
  });
});
