import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchFn } from "../../src/adapters/polymarket/httpClient.js";
import { all, get, openDatabase, run as sql, type Database } from "../../src/adapters/storage/sqlite.js";
import { observationDetails } from "../../src/app/marketHistory.js";
import { parseCli, USAGE } from "../../src/cli/args.js";
import { run } from "../../src/cli/run.js";
import { fakeFetch, json, testDeps, timeoutError, type Reply } from "../helpers.js";
import { assetId, bookBody, conditionId, gammaRecord, scanRoutes, type BookSpec, type MarketSpec } from "../scanFixtures.js";
import { cleanupTemp, clock, fakeLiveness, T0, tempDbPath } from "../storageFixtures.js";

afterEach(cleanupTemp);

const ID = "679030";
const MARKET: MarketSpec = { id: ID, book: { bids: [["0.11", "500"]], asks: [["0.12", "700"]] } };
const OTHER_BOOK: BookSpec = { bids: [["0.10", "500"]], asks: [["0.13", "700"]] };
const HOUR = 3_600_000;
const GAMMA = `gamma.example/markets/${ID}`;

type Routes = Record<string, Reply | Reply[]>;

/** The market's own routes, and a discovery route that holds another market, so any fallback shows up. */
function routes(spec: MarketSpec = MARKET, gamma: Reply | Reply[] = json(gammaRecord(spec))): Routes {
  const { "/markets/keyset": _keyset, ...own } = scanRoutes([[spec]]);
  return { [GAMMA]: gamma, "/markets/keyset": json({ markets: [gammaRecord({ id: "1" })], next_cursor: null }), ...own };
}

interface Setup {
  runId?: string;
  startMs?: number;
  signal?: AbortSignal;
  deadline?: AbortSignal;
  db?: string;
}

async function cli(argv: string[], routeTable: Routes, setup: Setup = {}) {
  const fake = fakeFetch(routeTable);
  const urls: string[] = [];
  const fetch: FetchFn = (url, init) => {
    urls.push(url);
    return fake.fetch(url, init);
  };
  const out: string[] = [];
  const err: string[] = [];
  const db = setup.db ?? tempDbPath();
  const code = await run([...argv, "--db", db], {
    http: testDeps(fetch, clock(setup.startMs ?? T0)).deps,
    env: { MARKETMIND_GAMMA_URL: "https://gamma.example", MARKETMIND_CLOB_URL: "https://clob.example" },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    liveness: fakeLiveness({ 4321: "alive" }),
    pid: 4321,
    newRunId: () => setup.runId ?? "run-1",
    ...(setup.signal ? { signal: setup.signal } : {}),
    ...(setup.deadline ? { deadline: () => setup.deadline! } : {}),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n"), urls, calls: fake.calls, db };
}

const collect = (table: Routes = routes(), setup: Setup = {}, extra: string[] = []) => cli(["collect", "--market-id", ID, ...extra], table, setup);

function read<T>(db: string, use: (d: Database) => T): T {
  const d = openDatabase({ path: db, readOnly: true });
  try {
    return use(d);
  } finally {
    d.close();
  }
}

const count = (db: string, table: string) => read(db, (d) => (get(d, `SELECT count(*) AS n FROM ${table}`) as { n: number }).n);
const counts = (db: string) => Object.fromEntries(["collection_run", "market", "outcome", "market_observation", "book_observation", "book_content", "market_metrics"].map((t) => [t, count(db, t)]));
const runRow = (db: string, runId = "run-1") => read(db, (d) => get(d, "SELECT * FROM collection_run WHERE run_id = ?", runId)!);
const history = async (db: string) => JSON.parse((await cli(["history", "--market-id", ID, "--json"], {}, { db })).stdout) as { analysisWindow: { observations: number }; stats: { usable: number; states: { distinct: number } }; rows: { observationId: number; runId: string; availableAt: string; sourceType: string; flags: { unchanged: boolean | null } }[] };

/** Nothing about a refused target may look like a collection. */
function assertNothingStored(r: Awaited<ReturnType<typeof cli>>) {
  expect(count(r.db, "market_observation")).toBe(0);
  expect(count(r.db, "market")).toBe(0);
  expect(r.stdout).not.toContain("collected as");
  expect(r.urls.some((u) => u.includes("keyset"))).toBe(false);
}

describe("arguments", () => {
  it("targeted mode: one market, a budget of 8 and no discovery", () => {
    expect(parseCli(["collect", "--market-id", ID, "--max-requests", "8"])).toMatchObject({ kind: "collect", targetMarketId: ID, maxRequests: 8, maxMarkets: 1, top: 1, pageSize: 1, maxPages: 1, discoverOrder: "none" });
    expect(parseCli(["collect", "--market-id", ID])).toMatchObject({ maxRequests: 8 });
  });

  it("keeps the options that still apply to one market", () => {
    expect(parseCli(["collect", "--market-id", ID, "--version", "v2", "--depth-band", "none", "--max-duration-ms", "5000", "--max-db-mb", "5", "--json"])).toMatchObject({ version: "v2", depthBand: null, maxDurationMs: 5000, maxDbMb: 5, json: true });
  });

  it.each([
    ["--discover-order", "none"],
    ["--max-markets", "1"],
    ["--top", "1"],
    ["--page-size", "1"],
    ["--max-pages", "1"],
    ["--min-spread", "0"],
    ["--min-top-size", "1"],
    ["--concurrency", "1"],
  ])("refuses %s with --market-id rather than ignoring it, and makes no request", async (flag, value) => {
    const db = tempDbPath();
    const r = await cli(["collect", "--market-id", ID, flag, value], { "": new Error("network forbidden") }, { db });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`${flag} cannot be used with --market-id`);
    expect(r.urls).toEqual([]);
    expect(existsSync(db)).toBe(false);
  });

  it("refuses --include-suspicious, naming every discovery option given", () => {
    expect(() => parseCli(["collect", "--market-id", ID, "--include-suspicious", "--top", "2"])).toThrow(/--top, --include-suspicious cannot be used/);
  });

  it.each([["abc"], ["12a"], ["-1"], ["1.5"], ["0x12"]])("refuses the market id %s before any request", async (id) => {
    const db = tempDbPath();
    const r = await cli(["collect", `--market-id=${id}`], { "": new Error("network forbidden") }, { db });
    expect(r.code).toBe(2);
    expect(r.urls).toEqual([]);
    expect(existsSync(db)).toBe(false);
  });

  it.each([["3"], ["9"], ["48"]])("refuses a budget of %s, which is not what one market needs", (n) => {
    expect(() => parseCli(["collect", "--market-id", ID, "--max-requests", n])).toThrow(/--max-requests must be an integer between 4 and 8/);
  });

  it("scan and synthetic options stay refused", () => {
    expect(() => parseCli(["scan", "--market-id", ID])).toThrow(/--market-id not valid for scan/);
    expect(() => parseCli(["collect", "--market-id", ID, "--include-synthetic"])).toThrow(/--include-synthetic not valid for collect/);
  });

  it("documents the mode", () => {
    expect(USAGE).toContain("collect --market-id <gamma id> [--max-requests 4..8]");
  });
});

describe("one target", () => {
  it("stores one live observation from exactly 4 GETs, and no other market", async () => {
    const r = await collect();
    expect(r.code).toBe(0);
    expect(r.urls).toEqual([
      `https://gamma.example/markets/${ID}`,
      `https://clob.example/clob-markets/${conditionId(ID)}`,
      `https://clob.example/book?token_id=${assetId(ID, 0)}`,
      `https://clob.example/book?token_id=${assetId(ID, 1)}`,
    ]);
    expect(r.calls.every((c) => (c.init.method ?? "GET") === "GET")).toBe(true);
    expect(counts(r.db)).toEqual({ collection_run: 1, market: 1, outcome: 2, market_observation: 1, book_observation: 2, book_content: 2, market_metrics: 1 });
    expect(r.stdout).toContain(`Target: market ${ID} only; no discovery`);
    expect(r.stdout).toContain(`Target market ${ID}: collected as observation 1 (bucket ranked)`);
    expect(r.stdout).not.toContain("Discovery:");
  });

  it("records the run as a live, verified run of this target, with its budget", async () => {
    const { db } = await collect();
    const row = runRow(db);
    expect(row).toMatchObject({ source_type: "live", status: "complete", accounting: "verified", budget_limit: 8, budget_used: 4, error_json: null });
    expect(JSON.parse(String(row.config_json))).toMatchObject({ targetMarketId: ID, discoverOrder: "none", maxMarkets: 1, maxRequests: 8 });
    expect(JSON.parse(String(row.scan_counts_json))).toMatchObject({ discovered: 1, selected: 1, rankedTotal: 1, notScanned: 0 });
    expect(read(db, (d) => all(d, "SELECT gamma_id, discovery_position, pairing, association, bucket, availability_basis FROM market_observation"))).toEqual([
      { gamma_id: ID, discovery_position: 0, pairing: "paired", association: "confirmed", bucket: "ranked", availability_basis: "paired_books" },
    ]);
    expect(read(db, (d) => get(d, "SELECT count(*) AS n FROM collection_run WHERE source_type <> 'live'"))).toEqual({ n: 0 });
  });

  it("links the Gamma request to the observation's evidence", async () => {
    const { db } = await collect();
    const details = observationDetails({ dbPath: db, observationId: 1, asOf: null });
    expect(details.run.sourceType).toBe("live");
    expect(details.requests.map((q) => q.scope)).toEqual([`market ${ID} metadata`, `market ${ID} association`, `market ${ID} book Yes`, `market ${ID} book No`]);
  });

  it("reports the target in JSON", async () => {
    const r = await collect(routes(), {}, ["--json"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ target: { marketId: ID, collected: true, observationId: 1, bucket: "ranked", reasons: [] }, run: { status: "complete" }, scan: { discovery: { pages: 1, stoppedBecause: "TARGET_MARKET" } } });
  });

  it("keeps a filtered market as a genuine observation", async () => {
    const r = await collect(routes({ id: ID, book: { bids: [["0.11", "5"]], asks: [["0.12", "5"]] } }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/collected as observation 1 \(bucket filtered, TOP_SIZE_BELOW_MIN\)/);
  });

  it("collects a v2 market when asked for v2, and stores its position ids", async () => {
    const spec: MarketSpec = { ...MARKET, version: "v2" };
    const r = await collect(routes(spec), {}, ["--version", "v2"]);
    expect(r.code).toBe(0);
    expect(read(r.db, (d) => all(d, "SELECT asset_id_kind FROM outcome"))).toEqual([{ asset_id_kind: "positionId" }, { asset_id_kind: "positionId" }]);
    expect(runRow(r.db).protocol_version).toBe("v2");
  });
});

describe("repeated runs of one market", () => {
  const twice = async (first: MarketSpec, second: MarketSpec) => {
    const db = tempDbPath();
    expect((await collect(routes(first), { db, runId: "run-1" })).code).toBe(0);
    const before = read(db, (d) => all(d, "SELECT * FROM market_observation"));
    const books = read(db, (d) => all(d, "SELECT * FROM book_observation"));
    const r = await collect(routes(second), { db, runId: "run-2", startMs: T0 + HOUR });
    expect(r.code).toBe(0);
    return { db, before, books, stdout: r.stdout };
  };

  it("a changed book is a new observation with its own time and state, and history shows both", async () => {
    const { db, before, books } = await twice(MARKET, { ...MARKET, book: OTHER_BOOK });
    expect(read(db, (d) => all(d, "SELECT * FROM market_observation WHERE id = 1"))).toEqual(before);
    expect(read(db, (d) => all(d, "SELECT * FROM book_observation WHERE market_observation_id = 1"))).toEqual(books);
    expect(counts(db)).toMatchObject({ collection_run: 2, market: 1, outcome: 2, market_observation: 2, book_observation: 4, book_content: 4, market_metrics: 2 });
    const h = await history(db);
    expect(h.rows.map((row) => row.runId)).toEqual(["run-2", "run-1"]);
    expect(new Set(h.rows.map((row) => row.availableAt)).size).toBe(2);
    expect(h.rows.every((row) => row.sourceType === "live")).toBe(true);
    expect(h.stats).toMatchObject({ usable: 2, states: { distinct: 2 } });
  });

  it("an unchanged book reuses its stored content and stays one state: a second time, not a second market event", async () => {
    const { db, stdout } = await twice(MARKET, MARKET);
    expect(stdout).toContain("Books written 2 (new contents 0, deduplicated 2)");
    expect(counts(db)).toMatchObject({ market_observation: 2, book_observation: 4, book_content: 2 });
    const h = await history(db);
    expect(new Set(h.rows.map((row) => row.availableAt)).size).toBe(2);
    expect(h.stats).toMatchObject({ usable: 2, states: { distinct: 1 } });
    expect(h.rows[0]!.flags.unchanged).toBe(true);
  });

  it("joins the history of a market first seen by a ranked run, leaving that run's rows alone", async () => {
    const db = tempDbPath();
    const page = scanRoutes([[{ id: "11" }, { id: "12" }, MARKET]]);
    expect((await cli(["collect"], page, { db, runId: "ranked" })).code).toBe(0);
    const before = read(db, (d) => all(d, "SELECT * FROM market_observation ORDER BY id"));
    expect((await collect(routes(), { db, runId: "targeted", startMs: T0 + HOUR })).code).toBe(0);
    expect(read(db, (d) => all(d, "SELECT * FROM market_observation WHERE run_id = 'ranked' ORDER BY id"))).toEqual(before);
    expect(count(db, "market_observation")).toBe(4);
    expect((await history(db)).rows.map((row) => row.runId)).toEqual(["targeted", "ranked"]);
  });
});

describe("identity", () => {
  it("refuses a Gamma answer for another market, and asks the CLOB nothing", async () => {
    const r = await collect(routes(MARKET, json(gammaRecord({ id: "1" }))));
    expect(r.code).toBe(5);
    expect(r.stderr).toContain(`Gamma answered market ${ID} with market 1`);
    expect(r.urls).toHaveLength(1);
    assertNothingStored(r);
    expect(runRow(r.db)).toMatchObject({ status: "failed", source_type: "live" });
  });

  it("refuses a market of another protocol version than the run records", async () => {
    const r = await collect(routes({ ...MARKET, version: "v2" }));
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("rerun with --version v2");
    assertNothingStored(r);
  });

  it("a condition id that conflicts with the stored market writes nothing, and is not called collected", async () => {
    const db = tempDbPath();
    await collect(routes(), { db });
    const stored = counts(db);
    const moved: MarketSpec = { id: ID, gamma: { conditionId: conditionId("777") } };
    const table = routes(moved);
    table[`/clob-markets/${conditionId("777")}`] = json({ t: ["Yes", "No"].map((o, i) => ({ t: assetId(ID, i), o })) });
    const body = (i: number) => json({ ...bookBody(moved, i, i === 0 ? MARKET.book! : { bids: [["0.88", "700"]], asks: [["0.89", "500"]] }), market: conditionId("777") });
    table[`token_id=${assetId(ID, 0)}`] = body(0);
    table[`token_id=${assetId(ID, 1)}`] = body(1);
    const r = await collect(table, { db, runId: "run-2", startMs: T0 + HOUR });
    expect(r.code).toBe(6);
    expect(r.stdout).toContain(`Target market ${ID}: NOT COLLECTED`);
    expect(r.stdout).toContain("IDENTITY_CONFLICT");
    expect(counts(db)).toEqual({ ...stored, collection_run: 2 });
    expect(runRow(db, "run-2")).toMatchObject({ status: "partial" });
  });

  it("an outcome pairing that does not match stores no book and is not called collected", async () => {
    const swapped = json({ t: [{ t: assetId(ID, 1), o: "Yes" }, { t: assetId(ID, 0), o: "No" }] });
    const r = await collect(routes({ ...MARKET, replies: { association: swapped } }));
    expect(r.code).toBe(6);
    expect(r.stdout).toContain(`Target market ${ID}: NOT COLLECTED (bucket failed, ASSOCIATION_MISMATCH)`);
    expect(r.urls.filter((u) => u.includes("/book"))).toEqual([]);
    expect(counts(r.db)).toMatchObject({ book_observation: 0, market_metrics: 0 });
  });
});

describe("a market that cannot be collected", () => {
  it.each<[string, number, Reply]>([
    ["404", 3, json({ error: "not found" }, 404)],
    ["422, Gamma's answer for an unknown id", 3, json({ error: "id is invalid" }, 422)],
    ["a malformed record", 5, json({ id: ID })],
    ["two identical token ids", 5, json(gammaRecord({ id: ID, gamma: { clobTokenIds: JSON.stringify([assetId(ID, 0), assetId(ID, 0)]) } }))],
    ["closed", 3, json(gammaRecord({ id: ID, gamma: { closed: true } }))],
    ["inactive", 3, json(gammaRecord({ id: ID, gamma: { active: false } }))],
    ["not accepting orders", 3, json(gammaRecord({ id: ID, gamma: { acceptingOrders: false } }))],
    ["order book disabled", 3, json(gammaRecord({ id: ID, gamma: { enableOrderBook: false } }))],
    ["trading status unknown", 3, json(gammaRecord({ id: ID, gamma: { acceptingOrders: null } }))],
    ["not binary", 3, json(gammaRecord({ id: ID, labels: ["A", "B", "C"] }))],
  ])("%s: exits %i, with no market and no other market instead", async (_name, code, reply) => {
    const r = await collect(routes(MARKET, reply));
    expect(r.code).toBe(code);
    expect(r.urls).toHaveLength(1);
    assertNothingStored(r);
    expect(runRow(r.db)).toMatchObject({ status: "failed", source_type: "live" });
  });

  it("names why a market is ineligible", async () => {
    const r = await collect(routes(MARKET, json(gammaRecord({ id: ID, gamma: { closed: true } }))));
    expect(r.stderr).toContain("CLOSED: market is closed");
    expect(JSON.parse(String(runRow(r.db).error_json))).toMatchObject({ kind: "Ineligible" });
  });

  it("a Gamma timeout exits 4 after its one retry", async () => {
    const r = await collect(routes(MARKET, timeoutError()));
    expect(r.code).toBe(4);
    expect(r.urls).toHaveLength(2);
    assertNothingStored(r);
  });

  it("a rate limit on Gamma exits 4 and is recorded on the failed run", async () => {
    const r = await collect(routes(MARKET, json({}, 429)));
    expect(r.code).toBe(4);
    assertNothingStored(r);
    expect(runRow(r.db).status).toBe("failed");
  });
});

describe("books", () => {
  it("empty books are a genuine observation of an empty market, stored as excluded", async () => {
    const r = await collect(routes({ id: ID, book: { bids: [], asks: [] } }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Target market ${ID}: collected as observation 1 (bucket excluded, EMPTY_BOOK)`);
    expect((await history(r.db)).stats.usable).toBe(0);
  });

  it("a one-sided book is stored as excluded, and history does not count it as usable", async () => {
    const r = await collect(routes({ id: ID, book: { bids: [], asks: [["0.002", "100"]] } }));
    expect(r.stdout).toContain("(bucket excluded, ONE_SIDED_BOOK)");
    expect((await history(r.db)).stats.usable).toBe(0);
  });

  it.each<[string, MarketSpec["replies"]]>([
    ["a malformed book", { book0: json({ bids: "not a list" }) }],
    ["a missing book", { book1: json({ error: "no book" }, 404) }],
    ["a book timeout", { book0: timeoutError() }],
    ["an upstream failure", { book1: json({}, 503) }],
  ])("%s stores no metrics and is not called collected", async (_name, replies) => {
    const r = await collect(routes({ ...MARKET, replies: replies! }));
    expect(r.code).toBe(6);
    expect(r.stdout).toContain(`Target market ${ID}: NOT COLLECTED (bucket failed`);
    expect(count(r.db, "market_metrics")).toBe(0);
    expect(runRow(r.db).status).toBe("partial");
    expect(read(r.db, (d) => all(d, "SELECT bucket FROM market_observation"))).toEqual([{ bucket: "failed" }]);
  });

  it("a book from another market is invalid evidence: no metrics, not collected", async () => {
    const r = await collect(routes({ ...MARKET, book: { ...MARKET.book!, raw: { market: conditionId("777") } } }));
    expect(r.code).toBe(6);
    expect(r.stdout).toContain("NOT COLLECTED");
    expect(count(r.db, "market_metrics")).toBe(0);
  });
});

describe("the request budget", () => {
  it("8 covers every request retried once, and counts each attempt", async () => {
    const fail = json({}, 503);
    const spec: MarketSpec = { ...MARKET, replies: { association: [fail, json({ t: ["Yes", "No"].map((o, i) => ({ t: assetId(ID, i), o })) })], book0: [fail, json(bookBody(MARKET, 0, MARKET.book!))], book1: [fail, json(bookBody(MARKET, 1, { bids: [["0.88", "700"]], asks: [["0.89", "500"]] }))] } };
    const r = await collect(routes(spec, [fail, json(gammaRecord(MARKET))]));
    expect(r.code).toBe(0);
    expect(r.urls).toHaveLength(8);
    expect(runRow(r.db).budget_used).toBe(8);
    expect(r.stdout).toContain("collected as observation 1");
  });

  it("a budget spent on a Gamma retry leaves the market unscanned, stops, and is not called collected", async () => {
    const r = await collect(routes(MARKET, [json({}, 503), json(gammaRecord(MARKET))]), {}, ["--max-requests", "4"]);
    expect(r.code).toBe(6);
    expect(r.urls).toHaveLength(2);
    expect(r.urls.filter((u) => u.includes("clob"))).toEqual([]);
    expect(r.stdout).toContain(`Target market ${ID}: NOT COLLECTED (bucket notScanned, BUDGET_EXHAUSTED)`);
    expect(count(r.db, "book_observation")).toBe(0);
    expect(runRow(r.db)).toMatchObject({ status: "partial", budget_used: 2 });
  });

  it("never exceeds the budget when a book's retry is refused", async () => {
    const r = await collect(routes({ ...MARKET, replies: { book0: json({}, 503) } }), {}, ["--max-requests", "4"]);
    expect(r.code).toBe(6);
    expect(r.urls).toHaveLength(4);
    expect(r.stdout).toContain("NOT COLLECTED");
    expect(runRow(r.db).budget_used).toBe(4);
  });

  it("a passed deadline makes no request and stores nothing", async () => {
    const r = await collect(routes(), { deadline: AbortSignal.abort() });
    expect(r.code).toBe(6);
    expect(r.urls).toEqual([]);
    expect(r.stdout).toContain(`Target market ${ID}: NOT COLLECTED`);
    expect(count(r.db, "market_observation")).toBe(0);
    expect(runRow(r.db).status).toBe("interrupted");
  });

  it("Ctrl+C makes no request and stores nothing", async () => {
    const r = await collect(routes(), { signal: AbortSignal.abort() });
    expect(r.code).toBe(6);
    expect(r.urls).toEqual([]);
    expect(count(r.db, "market_observation")).toBe(0);
  });
});

describe("storage", () => {
  const withDb = (db: string, change: (d: Database) => void) => {
    const d = openDatabase({ path: db, readOnly: false });
    try {
      change(d);
    } finally {
      d.close();
    }
  };

  it("a failure late in the transaction rolls back the whole observation, leaving earlier ones", async () => {
    const db = tempDbPath();
    await collect(routes(), { db });
    const stored = counts(db);
    withDb(db, (d) => void sql(d, "CREATE TRIGGER no_metrics BEFORE INSERT ON market_metrics BEGIN SELECT RAISE(ABORT, 'disk trouble'); END"));
    const r = await collect(routes({ ...MARKET, book: OTHER_BOOK }), { db, runId: "run-2", startMs: T0 + HOUR });
    expect(r.code).toBe(6);
    expect(r.stdout).toContain(`Target market ${ID}: NOT COLLECTED`);
    expect(counts(db)).toEqual({ ...stored, collection_run: 2 });
    expect(count(db, "persistence_failure")).toBe(1);
    expect(runRow(db, "run-2")).toMatchObject({ status: "partial", accounting: "verified" });
    expect((await history(db)).rows.map((row) => row.runId)).toEqual(["run-1"]);
  });

  it("a database with a newer schema is refused before any request", async () => {
    const db = tempDbPath();
    await collect(routes(), { db });
    withDb(db, (d) => void d.exec("PRAGMA user_version = 99"));
    const r = await collect(routes(), { db, runId: "run-2" });
    expect(r.code).toBe(7);
    expect(r.urls).toEqual([]);
  });

  it("a database at its size limit is refused before any request", async () => {
    const db = tempDbPath();
    await collect(routes(), { db });
    expect((await collect(routes(), { db, runId: "run-2" }, ["--max-db-mb", "1"])).urls).toHaveLength(4);
    withDb(db, (d) => void d.exec(`CREATE TABLE padding (x BLOB); INSERT INTO padding VALUES (zeroblob(${2 * 1024 * 1024}))`));
    const refused = await collect(routes(), { db, runId: "run-3" }, ["--max-db-mb", "1"]);
    expect(refused.code).toBe(7);
    expect(refused.urls).toEqual([]);
  });
});

describe("ranked collection is unchanged", () => {
  const PAGE = scanRoutes([[{ id: "11" }, { id: "12" }]]);

  it("still discovers, and reports no target", async () => {
    const r = await cli(["collect", "--json"], PAGE);
    expect(r.code).toBe(0);
    expect(r.urls[0]).toContain("/markets/keyset");
    expect(JSON.parse(r.stdout)).not.toHaveProperty("target");
    expect(JSON.parse(String(runRow(r.db).config_json))).not.toHaveProperty("targetMarketId");
    expect(read(r.db, (d) => all(d, "SELECT DISTINCT scope FROM request_log WHERE source = 'gamma'"))).toEqual([{ scope: "discovery page 1" }]);
  });

  it("keeps its text and its defaults", async () => {
    const r = await cli(["collect"], PAGE);
    expect(r.stdout).toContain("Discovery: 1 page(s)");
    expect(r.stdout).toContain("stopped: NO_MORE_PAGES");
    expect(r.stdout).not.toContain("Target");
    expect(parseCli(["collect"])).toMatchObject({ targetMarketId: null, maxRequests: 48, maxMarkets: 10, top: 10, pageSize: 50, maxPages: 2, discoverOrder: "volume24hr" });
    expect(parseCli(["collect", "--max-markets", "3", "--min-top-size", "1"])).toMatchObject({ targetMarketId: null, maxMarkets: 3 });
  });
});
