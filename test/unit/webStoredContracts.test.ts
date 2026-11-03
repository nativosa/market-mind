import { afterEach, describe, expect, it } from "vitest";
import { persistObservation } from "../../src/adapters/storage/snapshotStore.js";
import type { Database } from "../../src/adapters/storage/sqlite.js";
import { ANALYTICS_VERSION } from "../../src/analytics/version.js";
import { collectionRuns, marketHistory, storedMarkets } from "../../src/app/marketHistory.js";
import { decimal } from "../../src/domain/decimal.js";
import {
  HistoryOutput,
  StoredMarketsInput,
  StoredMarketsOutput,
  WEB_CONTRACT,
  WEB_LIMITS,
  WebDetailsInput,
  WebHistoryInput,
  WebHistoryOutput,
  WebRunsInput,
  WebRunsOutput,
} from "../../src/research/contracts.js";
import { historyRowView, historyView, storedMarketsView, webHistoryView, webNoHistoryView, webRunsView, type WebHistoryQuery } from "../../src/research/views.js";
import { cleanupTemp, fakeLiveness, iso, META, openMigrated, record, startRun, T0, tempDbPath, type RecordSpec } from "../storageFixtures.js";

// Stage 3.2 browser-facing stored-data contracts: the web history reuses get_market_history's
// statistics, analysis window and row mapping, adding depth, irregular-gap flags and a plotted series.

afterEach(cleanupTemp);

const NOW = new Date("2026-11-03T12:00:00.000Z");
let runCounter = 0;
function observe(db: Database, spec: RecordSpec & { source?: "live" | "synthetic" } = {}): number {
  const runId = startRun(db, { runId: `run-${++runCounter}`, sourceType: spec.source ?? "live", startedAt: new Date(T0 + runCounter) });
  return persistObservation(db, runId, record(spec), META, ANALYTICS_VERSION).observationId;
}
const at = (ms: number): Pick<RecordSpec, "receivedAt"> => ({ receivedAt: [ms + 100, ms + 110] });

/** Market 1: regular one-minute samples, an exact 18-place size, an unpaired sample, a 30-minute gap and one synthetic sample. */
function seed(path: string): void {
  const db = openMigrated(path);
  observe(db, { ...at(0), ref: { bids: [["0.40", "0.000000000000000001"]], asks: [["0.45", "100"]] } });
  observe(db, { ...at(60_000) });
  observe(db, { ...at(90_000), other: null });
  observe(db, { ...at(120_000) });
  observe(db, { ...at(1_920_000) });
  observe(db, { ...at(1_980_000), source: "synthetic" });
  db.close();
}

const query = (overrides: Partial<WebHistoryQuery> = {}): WebHistoryQuery => ({
  marketId: "1",
  source: "live",
  asOf: null,
  spreadThreshold: decimal("0.02"),
  analyticsVersion: ANALYTICS_VERSION,
  ...overrides,
});

function webHistory(path: string, q: WebHistoryQuery = query(), limit: number = WEB_LIMITS.history.seriesMax) {
  const result = marketHistory({
    dbPath: path,
    gammaId: q.marketId,
    asOf: q.asOf,
    limit,
    threshold: q.spreadThreshold,
    analyticsVersion: q.analyticsVersion,
    includeSynthetic: q.source === "all",
  });
  return { result, view: WebHistoryOutput.parse(webHistoryView(result, q, NOW)) };
}

describe("WebHistoryOutput", () => {
  it("has the same statistics and analysis window as get_market_history, and the same row fields plus depth", () => {
    const path = tempDbPath();
    seed(path);
    const { result, view } = webHistory(path);
    const mcp = HistoryOutput.parse(
      historyView(result, { marketId: "1", asOf: null, limit: 25, spreadThreshold: decimal("0.02"), analyticsVersion: ANALYTICS_VERSION, includeSynthetic: false }, 25, NOW),
    );
    expect(view).toMatchObject({ contract: WEB_CONTRACT.history, source: "stored", status: "ok", evidence: "available" });
    expect(view.stats).toEqual(mcp.stats);
    expect(view.analysisWindow).toEqual(mcp.analysisWindow);
    view.series.items.forEach((row, i) => {
      const { metrics, flags, ...rest } = row;
      const { metrics: mcpMetrics, flags: mcpFlags, ...mcpRest } = mcp.rows.items[i]!;
      expect(rest).toEqual(mcpRest);
      expect(flags).toEqual({ ...mcpFlags, irregularGap: flags.irregularGap });
      if (mcpMetrics === null) expect(metrics).toBeNull();
      else expect(metrics).toMatchObject(mcpMetrics);
    });
  });

  it("keeps exact decimal strings, depth of the selected version and irregular-gap flags", () => {
    const path = tempDbPath();
    seed(path);
    const { view } = webHistory(path);
    const oldest = view.series.items.at(-1)!;
    expect(oldest.metrics).toMatchObject({ bestBidSize: "0.000000000000000001", bestAskSize: "100", bidDepth: "0.000000000000000001", depthBand: "0.05", bidLevels: 1, analyticsVersion: ANALYTICS_VERSION });
    expect(view.series.items.map((r) => [r.flags.notUsable, r.flags.irregularGap])).toEqual([
      [null, true],
      [null, false],
      ["NOT_PAIRED", false],
      [null, false],
      [null, false],
    ]);
    expect(view.series.items.filter((r) => r.flags.irregularGap)).toHaveLength(view.stats!.gaps.irregular);
    expect(view.series.items[2]!.metrics).toBeNull();
    // The unpaired sample is available when its only book arrived (+100).
    expect(view.series.items.map((r) => r.availableAt)).toEqual([iso(1_920_110), iso(120_110), iso(90_100), iso(60_110), iso(110)]);
  });

  it("separates the plotted series from the statistical window", () => {
    const path = tempDbPath();
    seed(path);
    const { view } = webHistory(path, query(), 2);
    expect(view.series).toMatchObject({ returnedCount: 2, windowObservations: 5, truncated: true, oldestAvailableAt: iso(120_110), newestAvailableAt: iso(1_920_110) });
    expect(view.analysisWindow).toMatchObject({ observations: 5, truncated: false, maxObservations: 20_000 });
    expect(view.stats!.eligible).toBe(5);
    expect(view.appliedLimits.seriesMax).toBe(2_000);
    expect(view.limitations.join(" ")).toContain("newest 2000 observations of the analysis window");
  });

  it("source 'all' includes and counts synthetic observations, and says so", () => {
    const path = tempDbPath();
    seed(path);
    const live = webHistory(path).view;
    const all = webHistory(path, query({ source: "all" })).view;
    expect(live.series.sourceCounts).toEqual({ live: 5, synthetic: 0 });
    expect(all.series.sourceCounts).toEqual({ live: 5, synthetic: 1 });
    expect(all.series.items[0]!.sourceType).toBe("synthetic");
    expect(all.appliedLimits.source).toBe("all");
    expect(all.limitations.some((l) => l.includes("synthetic"))).toBe(true);
    expect(live.limitations.some((l) => l.includes("source 'all'"))).toBe(false);
  });

  it("with asOf, withholds run status and marks retrospective metrics like get_market_history", () => {
    const path = tempDbPath();
    seed(path);
    const { view } = webHistory(path, query({ asOf: iso(120_110) }));
    expect(view.series.returnedCount).toBe(4);
    expect(view.series.items.every((r) => r.runStatus === undefined)).toBe(true);
    expect(view.appliedLimits.asOf).toBe(iso(120_110));
  });

  it("no_history is explicit, parses, and carries no statistics", () => {
    const view = WebHistoryOutput.parse(webNoHistoryView(query({ marketId: "999" }), NOW));
    expect(view).toMatchObject({ status: "no_history", evidence: "insufficient", analysisWindow: null, stats: null, series: { returnedCount: 0, items: [] } });
    expect(view.limitations.some((l) => l.includes("not evidence of absence"))).toBe(true);
  });

  it("is strict and bounded", () => {
    const path = tempDbPath();
    seed(path);
    const { view } = webHistory(path);
    const item = view.series.items[0]!;
    expect(WebHistoryOutput.safeParse({ ...view, extra: 1 }).success).toBe(false);
    expect(WebHistoryOutput.safeParse({ ...view, series: { ...view.series, items: [{ ...item, flags: { ...item.flags, guess: true } }] } }).success).toBe(false);
    expect(WebHistoryOutput.safeParse({ ...view, series: { ...view.series, items: [{ ...item, metrics: { ...item.metrics, bidDepth: 1.5 } }] } }).success).toBe(false);
    const tooMany = Array.from({ length: WEB_LIMITS.history.seriesMax + 1 }, () => item);
    expect(WebHistoryOutput.safeParse({ ...view, series: { ...view.series, items: tooMany } }).success).toBe(false);
  });
});

describe("historyRowView", () => {
  it("is the row mapping get_market_history uses", () => {
    const path = tempDbPath();
    seed(path);
    const result = marketHistory({ dbPath: path, gammaId: "1", asOf: null, limit: 25, threshold: decimal("0.02"), analyticsVersion: ANALYTICS_VERSION, includeSynthetic: false });
    const mcp = historyView(result, { marketId: "1", asOf: null, limit: 25, spreadThreshold: decimal("0.02"), analyticsVersion: ANALYTICS_VERSION, includeSynthetic: false }, 25, NOW);
    expect(JSON.stringify(mcp.rows.items)).toBe(JSON.stringify(result.rows.map((r) => historyRowView(r.point, r.flags, null))));
  });
});

describe("StoredMarketsOutput", () => {
  it("lists markets with provenance counts, sanitized third-party text and an offset cursor", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    observe(db, { id: "1", gamma: { question: "Will it‮ rain?" } });
    observe(db, { id: "2", ...at(60_000), source: "synthetic" });
    db.close();
    const q = { source: "all" as const, limit: 1, offset: 0 };
    const view = StoredMarketsOutput.parse(storedMarketsView(storedMarkets({ dbPath: path, includeSynthetic: true, limit: q.limit, offset: q.offset }), q, NOW));
    expect(view).toMatchObject({ contract: WEB_CONTRACT.storedMarkets, source: "stored", status: "ok", appliedLimits: q, markets: { returnedCount: 1, hasMore: true, nextOffset: 1 } });
    expect(view.markets.items[0]).toMatchObject({ gammaId: "2", observations: 1, liveObservations: 0, syntheticObservations: 1, latest: { sourceType: "synthetic", outcomeCount: 2 } });
    expect(view.untrustedTextFields).toEqual(["markets.items[].latest.question", "markets.items[].latest.outcomeLabels[]"]);
    const next = StoredMarketsOutput.parse(storedMarketsView(storedMarkets({ dbPath: path, includeSynthetic: true, limit: 1, offset: 1 }), { ...q, offset: 1 }, NOW));
    expect(next.markets).toMatchObject({ returnedCount: 1, hasMore: false, nextOffset: null });
    expect(next.markets.items[0]!.latest.question).toBe("Will it  rain?");
  });

  it("an empty listing is status empty", () => {
    const view = StoredMarketsOutput.parse(storedMarketsView({ markets: [], hasMore: false }, { source: "live", limit: 50, offset: 0 }, NOW));
    expect(view).toMatchObject({ status: "empty", markets: { returnedCount: 0, hasMore: false, nextOffset: null, items: [] } });
  });
});

describe("WebRunsOutput", () => {
  it("is the runs view with the web contract and the source filter that produced it", () => {
    const path = tempDbPath();
    const db = openMigrated(path);
    startRun(db, { runId: "live-1", sourceType: "live" });
    startRun(db, { runId: "synth-1", sourceType: "synthetic", startedAt: new Date(T0 + 1) });
    db.close();
    const runs = (source: "live" | "all") =>
      WebRunsOutput.parse(webRunsView(collectionRuns({ dbPath: path, limit: 11, liveness: fakeLiveness(), now: () => NOW, includeSynthetic: source === "all" }), { source, limit: 10 }, "test-host", NOW));
    const live = runs("live");
    expect(live).toMatchObject({ contract: WEB_CONTRACT.storedRuns, source: "stored", appliedLimits: { limit: 10, source: "live" }, runs: { returnedCount: 1, hasMore: false } });
    expect(live.runs.items.map((r) => [r.runId, r.sourceType])).toEqual([["live-1", "live"]]);
    const all = runs("all");
    expect(all.runs.items.map((r) => [r.runId, r.sourceType])).toEqual([
      ["synth-1", "synthetic"],
      ["live-1", "live"],
    ]);
    expect(all.limitations.some((l) => l.includes("synthetic"))).toBe(true);
    expect(JSON.stringify(all)).not.toMatch(/test-host|4242|sqlite/i);
    expect(WebRunsOutput.safeParse({ ...all, appliedLimits: { limit: 10 } }).success).toBe(false);
  });
});

describe("stored-data inputs", () => {
  it("apply defaults and leave source to the server when omitted", () => {
    expect(StoredMarketsInput.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(WebRunsInput.parse({})).toEqual({ limit: 20 });
    expect(WebHistoryInput.parse({ marketId: "1" })).toEqual({ marketId: "1", spreadThreshold: "0.02", analyticsVersion: ANALYTICS_VERSION });
    expect(WebDetailsInput.parse({ observationId: 3 })).toEqual({ observationId: 3, levels: 10 });
  });

  it("refuse out-of-range, unknown and malformed values", () => {
    expect(StoredMarketsInput.safeParse({ source: "synthetic" }).success).toBe(false);
    expect(StoredMarketsInput.safeParse({ limit: 101 }).success).toBe(false);
    expect(StoredMarketsInput.safeParse({ offset: -1 }).success).toBe(false);
    expect(StoredMarketsInput.safeParse({ offset: 1_000_001 }).success).toBe(false);
    expect(WebRunsInput.safeParse({ limit: 0 }).success).toBe(false);
    expect(WebHistoryInput.safeParse({ marketId: "../etc" }).success).toBe(false);
    expect(WebHistoryInput.safeParse({ marketId: "1", asOf: "yesterday" }).success).toBe(false);
    expect(WebHistoryInput.safeParse({ marketId: "1", spreadThreshold: "1.5" }).success).toBe(false);
    expect(WebHistoryInput.safeParse({ marketId: "1", limit: 5 }).success).toBe(false);
    expect(WebDetailsInput.safeParse({ observationId: 0 }).success).toBe(false);
    expect(WebDetailsInput.safeParse({ observationId: 1, levels: 51 }).success).toBe(false);
  });
});
