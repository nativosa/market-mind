import { afterEach, describe, expect, it } from "vitest";
import { createRun, finalizeRun } from "../../src/adapters/storage/snapshotStore.js";
import { MCP_LIMITS } from "../../src/mcp/contracts.js";
import { json } from "../helpers.js";
import { gammaRecord, scanRoutes, type BookSpec, type MarketSpec } from "../scanFixtures.js";
import { cleanupTemp, openMigrated, runInput, T0, tempDbPath } from "../storageFixtures.js";
import { call, connect, ok, seedObservation, type CallResult, type Connected } from "../mcpFixtures.js";

const open: Connected[] = [];
async function server(options: Parameters<typeof connect>[0] = {}) {
  const c = await connect(options);
  open.push(c);
  return c;
}
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  cleanupTemp();
});

const MAX = MCP_LIMITS.maxResultChars;
const size = (r: CallResult) => JSON.stringify(r).length;
const LONG = `Will ${"a very long and possibly adversarial market question ".repeat(40)}?`;
const LONG_LABEL = "Outcome label ".repeat(50);
const measured: Record<string, number> = {};

/** A deep book: `n` bid levels from 0.001 up and `n` ask levels from 0.999 down (tick 0.001). */
function deepBook(n: number): BookSpec {
  const p = (k: number) => (k / 1000).toFixed(3);
  return {
    bids: Array.from({ length: n }, (_, i) => [p(i + 1), `${1000 + i}.123456789012345678`] as [string, string]),
    asks: Array.from({ length: n }, (_, i) => [p(999 - i), `${2000 + i}.123456789012345678`] as [string, string]),
  };
}

function expectBounded(name: string, r: CallResult) {
  measured[name] = size(r);
  expect(r.isError, r.content[0]?.text).toBeFalsy();
  expect(size(r), name).toBeLessThanOrEqual(MAX);
  // The text fallback stays a short summary; the payload is never duplicated into it.
  expect(r.content[0]!.text!.length, name).toBeLessThanOrEqual(1_500);
}

describe("worst-case response sizes (structured content + text, serialized)", () => {
  it("scan_markets at maximum inputs", async () => {
    const eligible: MarketSpec[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(100 + i),
      labels: [LONG_LABEL, `${LONG_LABEL}B`],
      gamma: { question: LONG },
      book: { bids: [[`0.${10 + i}`, "100"]], asks: [["0.90", "100"]] },
    }));
    const closed: MarketSpec[] = Array.from({ length: 40 }, (_, i) => ({ id: String(200 + i), gamma: { question: LONG, closed: true } }));
    const c = await server({ routes: scanRoutes([[...eligible, ...closed]]) });
    const r = await call(c, "scan_markets", { maxMarkets: 10, top: 10, pageSize: 50, maxRequests: 32 });
    expectBounded("scan_markets", r);
    const v = ok(r);
    expect(v.ranked.returnedCount).toBe(10);
    expect(v.notRanked).toMatchObject({ totalCount: 40, returnedCount: 10, truncated: true });
  });

  it("inspect_market with 200-level books at levels 20", async () => {
    const spec: MarketSpec = { id: "77", labels: [LONG_LABEL, `${LONG_LABEL}B`], gamma: { question: LONG }, book: deepBook(200) };
    const c = await server({ routes: { ...scanRoutes([[spec]]), "/markets/77": json(gammaRecord(spec)) } });
    const r = await call(c, "inspect_market", { marketId: "77", levels: 20 });
    expectBounded("inspect_market", r);
    expect(ok(r).outcomes[0]!.levels).toMatchObject({ totalBids: 200, returnedPerSide: 20, truncated: true });
  });

  it("list_collection_runs with 60 finalized runs at limit 50", async () => {
    const dbPath = tempDbPath();
    const db = openMigrated(dbPath);
    for (let i = 0; i < 60; i++) {
      createRun(db, runInput({ runId: `run-${String(i).padStart(3, "0")}-${"x".repeat(20)}`, sourceType: "live", startedAt: new Date(T0 + i * 1_000) }));
      finalizeRun(db, `run-${String(i).padStart(3, "0")}-${"x".repeat(20)}`, {
        status: "partial",
        accounting: "verified",
        finishedAt: new Date(T0 + i * 1_000 + 500),
        stopReasons: ["BUDGET_EXHAUSTED", "RATE_LIMITED"],
        scanCounts: { discovered: 50, eligible: 40, selected: 30, rankedTotal: 10, filtered: 5, excluded: 5, failed: 5, notScanned: 25, notScannedByReason: { SAMPLE_LIMIT: 10, BUDGET_EXHAUSTED: 15, DEADLINE: 0, CANCELLED: 0, RATE_LIMITED: 0 } },
        persistCounts: { selected: 30, discovered: 50, persistedObservations: 29, persistenceFailures: 1, booksWritten: 58, metricsWritten: 28, bookContentsNew: 40, bookContentsReused: 18 },
        budgetUsed: 99,
        window: { first: new Date(T0).toISOString(), last: new Date(T0 + 400).toISOString() },
        error: null,
      });
    }
    db.close();
    const r = await call(await server({ dbPath }), "list_collection_runs", { limit: 50 });
    expectBounded("list_collection_runs", r);
    const v = ok(r);
    expect(v.appliedLimits.limit).toBe(50);
    // Cut by the size bound if needed, and then always flagged: returnedCount < requested with hasMore.
    expect(v.runs.returnedCount === 50 || v.runs.hasMore).toBe(true);
  });

  it("get_market_history with 30 long observations at limit 25", async () => {
    const dbPath = tempDbPath();
    for (let i = 0; i < 30; i++) seedObservation(dbPath, { id: "1", labels: [LONG_LABEL, `${LONG_LABEL}B`], gamma: { question: LONG }, receivedAt: [i * 60_000 + 100, i * 60_000 + 110] });
    const r = await call(await server({ dbPath }), "get_market_history", { marketId: "1", limit: 25 });
    expectBounded("get_market_history", r);
    const v = ok(r);
    expect(v.stats!.usable).toBe(30);
    expect(v.rows.totalCount).toBe(30);
    expect(v.rows.truncated).toBe(true);
  });

  it("get_observation_details with 300-level books at levels 50", async () => {
    const dbPath = tempDbPath();
    const id = seedObservation(dbPath, { labels: [LONG_LABEL, `${LONG_LABEL}B`], gamma: { question: LONG }, ref: deepBook(300) });
    const r = await call(await server({ dbPath }), "get_observation_details", { observationId: id, levels: 50 });
    expectBounded("get_observation_details", r);
    expect(ok(r).books[0]!.levels).toMatchObject({ totalBids: 300, totalAsks: 300, returnedPerSide: 50, truncated: true });
  });

  it("a tight bound truncates whole items deterministically, keeping every essential field and valid schemas", async () => {
    const dbPath = tempDbPath();
    const id = seedObservation(dbPath, { ref: deepBook(300) });
    for (let i = 1; i < 20; i++) seedObservation(dbPath, { id: "1", receivedAt: [i * 60_000 + 100, i * 60_000 + 110] });
    const c = await server({ dbPath, maxResultChars: 8_000 });
    const d1 = ok(await call(c, "get_observation_details", { observationId: id, levels: 50 }));
    const d2 = ok(await call(c, "get_observation_details", { observationId: id, levels: 50 }));
    expect(JSON.stringify(d1)).toBe(JSON.stringify(d2));
    expect(d1.books[0]!.levels.returnedPerSide).toBeLessThan(50);
    expect(d1.books[0]!.levels.truncated).toBe(true);
    expect(d1.books[0]!.levels.bids).toHaveLength(d1.books[0]!.levels.returnedPerSide);
    expect(d1.books[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d1.books[0]!.quality).toBe("valid");
    expect(d1.books[0]!.request.responseReceivedAt).toMatch(/Z$/);
    const h = ok(await call(c, "get_market_history", { marketId: "1", limit: 25 }));
    expect(h.rows.returnedCount).toBeLessThan(20);
    expect(h.rows).toMatchObject({ totalCount: 20, truncated: true });
    for (const row of h.rows.items) {
      expect(row.observationId).toBeGreaterThan(0);
      expect(row.availableAt).toMatch(/Z$/);
      expect(row.flags.changes).toBeInstanceOf(Array);
    }
    expect(h.stats!.usable).toBe(20);
  });

  it("records the measured sizes", () => {
    // Printed for the implementation report; every value is asserted above.
    console.log(`[mcp sizes] ${JSON.stringify(measured)} (bound ${MAX})`);
    expect(Object.keys(measured)).toHaveLength(5);
  });
});

describe("size bound floor", () => {
  it("every tool shrinks through its caps and, if even the floor does not fit, fails safely instead of truncating JSON", async () => {
    const dbPath = tempDbPath();
    const id = seedObservation(dbPath, { id: "1" });
    const routes = { ...scanRoutes([[{ id: "91" }]]), "/markets/91": json(gammaRecord({ id: "91" })) };
    const c = await server({ dbPath, routes, maxResultChars: 300 });
    for (const [name, args] of [
      ["scan_markets", { maxMarkets: 1 }],
      ["inspect_market", { marketId: "91", levels: 20 }],
      ["list_collection_runs", { limit: 50 }],
      ["get_market_history", { marketId: "1", limit: 25 }],
      ["get_observation_details", { observationId: id, levels: 50 }],
    ] as const) {
      const r = await call(c, name, args);
      expect(r.isError, name).toBe(true);
      expect(JSON.parse(r.content[0]!.text!), name).toMatchObject({ error: { category: "internal_error" } });
    }
    expect(c.logs.filter((l) => l.includes("exceeds the response size bound"))).toHaveLength(5);
  });
});
