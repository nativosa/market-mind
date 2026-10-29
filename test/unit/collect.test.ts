import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchFn } from "../../src/adapters/polymarket/httpClient.js";
import { createRun, listRuns } from "../../src/adapters/storage/snapshotStore.js";
import { all, get, openDatabase, run, type Database } from "../../src/adapters/storage/sqlite.js";
import { collectMarkets, type CollectResult } from "../../src/app/collectMarkets.js";
import { scanMarkets, type ScanOptions } from "../../src/app/scanMarkets.js";
import { decimal } from "../../src/domain/decimal.js";
import type { MarketMindError } from "../../src/domain/errors.js";
import { fakeFetch, json, TEST_HTTP_OPTIONS, testDeps, type Reply } from "../helpers.js";
import { assetId, bookBody, conditionId, DEFAULT_BOOK, scanRoutes, type MarketSpec } from "../scanFixtures.js";
import { cleanupTemp, clock, fakeLiveness, openMigrated, runInput, T0, tempDbPath } from "../storageFixtures.js";

afterEach(cleanupTemp);

const GAMMA = "https://gamma.example";
const CLOB = "https://clob.example";
const OPTIONS: ScanOptions = {
  version: "v1",
  discoverOrder: "volume24hr",
  maxMarkets: 10,
  top: 10,
  pageSize: 50,
  maxPages: 2,
  filters: { minSpread: decimal("0"), minTopSize: decimal("10"), includeSuspicious: false },
  depthBand: decimal("0.05"),
  maxRequests: 48,
  concurrency: 4,
  maxDurationMs: 60_000,
};

interface Setup {
  scan?: Partial<ScanOptions>;
  dbPath?: string;
  maxDbBytes?: number;
  signal?: AbortSignal;
  deadline?: AbortSignal;
  wrap?: (inner: FetchFn, dbPath: string) => FetchFn;
  configureDatabase?: (db: Database) => void;
  createParentDir?: boolean;
}

async function collect(routes: Record<string, Reply | Reply[]>, setup: Setup = {}) {
  const fake = fakeFetch(routes);
  const dbPath = setup.dbPath ?? tempDbPath();
  const urls: string[] = [];
  const inner = setup.wrap ? setup.wrap(fake.fetch, dbPath) : fake.fetch;
  const fetch: FetchFn = (url, init) => {
    urls.push(url);
    return inner(url, init);
  };
  const result = await collectMarkets(
    {
      scan: { ...OPTIONS, ...setup.scan },
      dbPath,
      createParentDir: setup.createParentDir ?? false,
      maxDbBytes: setup.maxDbBytes ?? 1024 * 1024 * 1024,
      buildId: "test-build",
      sourceType: "synthetic",
    },
    {
      http: testDeps(fetch).deps,
      httpOptions: TEST_HTTP_OPTIONS,
      gammaBaseUrl: GAMMA,
      clobBaseUrl: CLOB,
      ...(setup.signal ? { signal: setup.signal } : {}),
      ...(setup.deadline ? { deadline: () => setup.deadline! } : {}),
      liveness: fakeLiveness({ 999: "alive" }),
      now: clock(),
      pid: 999,
      nodeVersion: "v24.0.0",
      newRunId: () => "run-x",
      ...(setup.configureDatabase ? { configureDatabase: setup.configureDatabase } : {}),
    },
  );
  return { result, urls, dbPath, calls: fake.calls };
}

const reader = (path: string) => openDatabase({ path, readOnly: true });
const n = (db: Database, sql: string) => (get(db, sql) as { n: number }).n;

/** Persistence accounting, checked against the database for every finalized collect. */
function assertAccounting(result: CollectResult, dbPath: string) {
  const p = result.persist;
  const db = reader(dbPath);
  try {
    expect(n(db, "SELECT count(*) AS n FROM market_observation WHERE run_id = 'run-x'")).toBe(p.persistedObservations);
    expect(n(db, "SELECT count(*) AS n FROM persistence_failure WHERE run_id = 'run-x'")).toBe(p.persistenceFailures);
    expect(n(db, "SELECT count(*) AS n FROM book_observation b JOIN market_observation m ON m.id = b.market_observation_id WHERE m.run_id = 'run-x'")).toBe(
      p.booksWritten,
    );
    if (p.selected !== null) {
      expect(p.selected).toBe(p.persistedObservations + p.persistenceFailures + p.persistenceFailuresUnrecorded);
      expect(result.accounting).toBe("verified");
    }
    if (p.discovered !== null) expect(p.discovered).toBe(p.selected! + p.notSelected!);
    if (result.status === "complete") expect(p.persistenceFailures + p.persistenceFailuresUnrecorded).toBe(0);
  } finally {
    db.close();
  }
}

const MARKETS: MarketSpec[] = [
  { id: "91", book: { bids: [["0.40", "100"]], asks: [["0.46", "100"]] } },
  { id: "92", book: { bids: [["0.30", "50"]], asks: [["0.40", "60"]] } },
  { id: "93", book: { bids: [], asks: [] } },
];

describe("collectMarkets: complete runs", () => {
  it("persists every selected market (ranked, excluded alike) and finalizes a verified complete run", async () => {
    const { result, dbPath } = await collect(scanRoutes([[...MARKETS, { id: "94", gamma: { acceptingOrders: false } }]]));
    assertAccounting(result, dbPath);
    expect(result).toMatchObject({ status: "complete", accounting: "verified", finalized: true, scanError: null, storageError: null });
    expect(result.persist).toEqual({
      discovered: 4,
      notSelected: 1,
      selected: 3,
      persistedObservations: 3,
      persistenceFailures: 0,
      persistenceFailuresUnrecorded: 0,
      booksWritten: 6,
      bookContentsNew: 5, // market 93's two empty books have identical content: stored once
      bookContentsReused: 1,
      metricsWritten: 3,
    });
    const db = reader(dbPath);
    expect(all(db, "SELECT gamma_id, bucket, pairing FROM market_observation ORDER BY gamma_id")).toEqual([
      { gamma_id: "91", bucket: "ranked", pairing: "paired" },
      { gamma_id: "92", bucket: "ranked", pairing: "paired" },
      { gamma_id: "93", bucket: "excluded", pairing: "paired" },
    ]);
    const [r] = listRuns(db, 1);
    expect(r).toMatchObject({
      runId: "run-x",
      status: "complete",
      accounting: "verified",
      sourceType: "synthetic",
      buildId: "test-build",
      ownerPid: 999,
      ownerHost: "test-host",
      budgetLimit: 48,
      budgetUsed: 10,
      stopReasons: [],
    });
    expect(r!.scanCounts).toMatchObject({ discovered: 4, selected: 3, recordsReceived: 4, duplicates: 0 });
    expect(r!.windowFirst).not.toBeNull();
    db.close();
  });

  it("V2: stores positionIds and team labels", async () => {
    const v2: MarketSpec[] = [{ id: "81", version: "v2", labels: ["Alpha", "Beta"], book: { bids: [["0.5", "20"]], asks: [["0.6", "20"]] } }];
    const { result, dbPath } = await collect(scanRoutes([v2]), { scan: { version: "v2" } });
    assertAccounting(result, dbPath);
    const db = reader(dbPath);
    expect(all(db, "SELECT asset_id_kind, asset_id FROM outcome ORDER BY outcome_index")).toEqual([
      { asset_id_kind: "positionId", asset_id: assetId("81", 0) },
      { asset_id_kind: "positionId", asset_id: assetId("81", 1) },
    ]);
    expect(all(db, "SELECT label_observed FROM book_observation ORDER BY outcome_index").map((r) => r.label_observed)).toEqual(["Alpha", "Beta"]);
    db.close();
  });

  it("makes exactly the same read-only HTTP requests as a plain scan", async () => {
    const routes = scanRoutes([MARKETS]);
    const { urls, calls } = await collect(routes, { scan: { concurrency: 1 } });
    const scanUrls: string[] = [];
    const fake = fakeFetch(routes);
    await scanMarkets({ ...OPTIONS, concurrency: 1 }, {
      http: testDeps((u, i) => (scanUrls.push(u), fake.fetch(u, i))).deps,
      httpOptions: TEST_HTTP_OPTIONS,
      gammaBaseUrl: GAMMA,
      clobBaseUrl: CLOB,
    });
    expect(urls).toEqual(scanUrls);
    expect(calls.every((c) => c.init.method === "GET" && c.init.body === undefined)).toBe(true);
  });

  it("creates the default data directory only when asked", async () => {
    const base = tempDbPath();
    const nested = join(dirname(base), "data", "nested.sqlite");
    const refused = await collect(scanRoutes([MARKETS]), { dbPath: nested }).catch((e: unknown) => e as MarketMindError);
    expect(refused).toMatchObject({ kind: "Storage", details: { code: "CANNOT_OPEN" } });
    const { result } = await collect(scanRoutes([MARKETS]), { dbPath: nested, createParentDir: true });
    expect(result.status).toBe("complete");
    expect(existsSync(nested)).toBe(true);
  });
});

describe("collectMarkets: request provenance", () => {
  it("stores each logical request once with its real attempts and status; attempts sum to budget.used", async () => {
    const markets: MarketSpec[] = [
      { id: "91", replies: { book0: [json({ error: "busy" }, 503), json(bookBody({ id: "91" }, 0, DEFAULT_BOOK))] } },
      { id: "92", labels: ["Yes", "Yes"] },
      { id: "93" },
    ];
    const { result, dbPath, urls } = await collect(scanRoutes([markets]));
    assertAccounting(result, dbPath);
    const db = reader(dbPath);
    const rows = all(db, "SELECT scope, url, http_status, attempts, started_at, received_at FROM request_log WHERE run_id = 'run-x' ORDER BY id");
    // Same logical requests as the scan: discovery page once, no duplicates, nothing dropped.
    const key = (scope: unknown, url: unknown) => `${String(scope)} ${String(url)}`;
    expect(rows.map((r) => key(r.scope, r.url)).sort()).toEqual(result.scan!.requests.map((r) => key(r.scope, r.url)).sort());
    expect(rows.reduce((sum, r) => sum + Number(r.attempts), 0)).toBe(result.scan!.budget.used);
    expect(result.scan!.budget.used).toBe(urls.length);
    expect(rows.filter((r) => r.scope === "market 92 book Yes")).toHaveLength(2);
    const retried = rows.find((r) => r.scope === "market 91 book Yes")!;
    expect(retried).toMatchObject({ http_status: 200, attempts: 2 });
    const book = get(db, "SELECT attempts, http_status, first_attempt_started_at, final_attempt_started_at FROM book_observation WHERE asset_id = ?", assetId("91", 0))!;
    expect(book).toMatchObject({ attempts: 2, http_status: 200, first_attempt_started_at: retried.started_at });
    expect(String(book.final_attempt_started_at) > String(book.first_attempt_started_at)).toBe(true);
    db.close();
  });

  it("persists no request headers or credentials: only the public URL and the server Date header", async () => {
    const { dbPath } = await collect(scanRoutes([MARKETS]));
    const db = reader(dbPath);
    const tables = all(db, "SELECT name FROM sqlite_schema WHERE type = 'table'").map((r) => String(r.name));
    const columns = tables.flatMap((t) => all(db, `SELECT name FROM pragma_table_info('${t}')`).map((r) => `${t}.${String(r.name)}`));
    expect(columns.filter((c) => /header|auth|cookie|secret|password|api_?key|user_agent/i.test(c))).toEqual(["book_observation.server_date_header"]);
    const stored = all(db, "SELECT url FROM request_log UNION ALL SELECT request_url FROM book_observation").map((r) => String(r.url));
    for (const url of stored) expect(url).toMatch(/^https:\/\/(gamma|clob)\.example\/[^@\s]*$/);
    db.close();
  });
});

describe("collectMarkets: partial, cancelled and failed runs", () => {
  it("keeps the received sibling book when the other request fails (incomplete, no metrics); run partial", async () => {
    const markets: MarketSpec[] = [...MARKETS.slice(0, 2), { id: "95", replies: { book1: json({ error: "boom" }, 500) } }];
    const { result, dbPath } = await collect(scanRoutes([markets]));
    assertAccounting(result, dbPath);
    expect(result.status).toBe("partial");
    const db = reader(dbPath);
    expect(get(db, "SELECT pairing, bucket, availability_basis FROM market_observation WHERE gamma_id = '95'")).toEqual({
      pairing: "incomplete",
      bucket: "failed",
      availability_basis: "single_book",
    });
    expect(n(db, "SELECT count(*) AS n FROM market_metrics x JOIN market_observation m ON m.id = x.market_observation_id WHERE m.gamma_id = '95'")).toBe(0);
    expect(all(db, "SELECT error_kind, http_status FROM request_log WHERE scope = 'market 95 book No'")).toEqual([{ error_kind: "Upstream5xx", http_status: 500 }]);
    db.close();
  });

  it("Ctrl+C mid-run: earlier markets are durable, the in-flight market keeps its received books, run interrupted", async () => {
    const user = new AbortController();
    const wrap = (inner: FetchFn): FetchFn => (url, init) => {
      if (!url.includes(assetId("92", 1))) return inner(url, init);
      user.abort(new Error("SIGINT"));
      return new Promise((_r, reject) => {
        const s = init.signal!;
        if (s.aborted) reject(s.reason as Error);
        else s.addEventListener("abort", () => reject(s.reason as Error));
      });
    };
    const { result, dbPath } = await collect(scanRoutes([MARKETS]), { signal: user.signal, wrap, scan: { concurrency: 1 } });
    assertAccounting(result, dbPath);
    expect(result).toMatchObject({ status: "interrupted", accounting: "verified", finalized: true });
    const db = reader(dbPath);
    expect(all(db, "SELECT gamma_id, bucket, pairing, association, reasons_json FROM market_observation ORDER BY gamma_id").map((r) => [r.gamma_id, r.bucket, r.pairing, r.association, (JSON.parse(String(r.reasons_json)) as { code: string }[])[0]?.code ?? null])).toEqual([
      ["91", "ranked", "paired", "confirmed", null],
      ["92", "notScanned", "incomplete", "confirmed", "CANCELLED"],
      ["93", "notScanned", "none", "not_attempted", "CANCELLED"],
    ]);
    expect(listRuns(db, 1)[0]!.stopReasons).toEqual(["CANCELLED"]);
    db.close();
  });

  it("deadline mid-run is reported as interrupted with DEADLINE", async () => {
    const deadline = new AbortController();
    const wrap = (inner: FetchFn): FetchFn => (url, init) => {
      if (url.includes(conditionId("92"))) deadline.abort(new DOMException("deadline", "TimeoutError"));
      return inner(url, init);
    };
    const { result, dbPath } = await collect(scanRoutes([MARKETS]), { deadline: deadline.signal, wrap, scan: { concurrency: 1 } });
    assertAccounting(result, dbPath);
    expect(result.status).toBe("interrupted");
    expect(result.scan!.stopReasons).toEqual(["DEADLINE"]);
  });

  it("budget exhaustion: unscanned selected markets are still stored as observations", async () => {
    const { result, dbPath } = await collect(scanRoutes([MARKETS]), { scan: { maxRequests: 4 } });
    assertAccounting(result, dbPath);
    expect(result.status).toBe("partial");
    const db = reader(dbPath);
    expect(all(db, "SELECT gamma_id, bucket, pairing, availability_basis FROM market_observation ORDER BY gamma_id")).toEqual([
      { gamma_id: "91", bucket: "ranked", pairing: "paired", availability_basis: "paired_books" },
      { gamma_id: "92", bucket: "notScanned", pairing: "none", availability_basis: "discovery" },
      { gamma_id: "93", bucket: "notScanned", pairing: "none", availability_basis: "discovery" },
    ]);
    db.close();
  });

  it("a first-page discovery failure finalizes a failed run with verified (empty) accounting", async () => {
    const { result, dbPath, urls } = await collect(scanRoutes([[]], { keyset: json({ error: "down" }, 503) }));
    assertAccounting(result, dbPath);
    expect(result).toMatchObject({ status: "failed", finalized: true });
    expect(result.scanError!.kind).toBe("Upstream5xx");
    expect(result.persist).toMatchObject({ selected: 0, persistedObservations: 0, discovered: null });
    expect(urls).toHaveLength(2);
    const db = reader(dbPath);
    expect(listRuns(db, 1)[0]).toMatchObject({ status: "failed", error: { kind: "Upstream5xx" } });
    db.close();
  });
});

describe("collectMarkets: incremental durability and persistence failures", () => {
  it("each market is durable as soon as it settles, while the scan is still running", async () => {
    const seen: number[] = [];
    const wrap = (inner: FetchFn, dbPath: string): FetchFn => (url, init) => {
      if (url.includes("/clob-markets/")) {
        const db = reader(dbPath);
        seen.push(n(db, "SELECT count(*) AS n FROM market_observation"));
        db.close();
      }
      return inner(url, init);
    };
    await collect(scanRoutes([MARKETS]), { wrap, scan: { concurrency: 1 } });
    expect(seen).toEqual([0, 1, 2]);
  });

  it("a later persistence failure leaves earlier markets committed, records the failure, and never reports complete", async () => {
    const dbPath = tempDbPath();
    const pre = openMigrated(dbPath);
    pre.exec("CREATE TRIGGER inject BEFORE INSERT ON market_observation WHEN NEW.gamma_id = '93' BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    pre.close();
    const { result } = await collect(scanRoutes([MARKETS]), { dbPath, scan: { concurrency: 1 } });
    assertAccounting(result, dbPath);
    expect(result.status).toBe("partial");
    expect(result.persist).toMatchObject({ selected: 3, persistedObservations: 2, persistenceFailures: 1, persistenceFailuresUnrecorded: 0 });
    expect(result.failures).toEqual([{ gammaId: "93", discoveryPosition: 2, code: "CONSTRAINT", message: expect.stringContaining("injected") as string, recorded: true }]);
    const db = reader(dbPath);
    expect(all(db, "SELECT gamma_id FROM market_observation ORDER BY gamma_id").map((r) => r.gamma_id)).toEqual(["91", "92"]);
    expect(n(db, "SELECT count(*) AS n FROM book_observation b JOIN market_observation m ON m.id = b.market_observation_id WHERE m.gamma_id = '93'")).toBe(0);
    db.close();
  });

  it("an identity conflict is a recorded persistence failure, not an overwrite", async () => {
    const dbPath = tempDbPath();
    const pre = openMigrated(dbPath);
    createRun(pre, runInput({ runId: "old" }));
    run(pre, "INSERT INTO market VALUES ('92', '0xsomethingelse', 'v1', 'old')");
    pre.close();
    const { result } = await collect(scanRoutes([MARKETS]), { dbPath });
    assertAccounting(result, dbPath);
    expect(result.failures.map((f) => [f.gammaId, f.code])).toEqual([["92", "IDENTITY_CONFLICT"]]);
    expect(result.status).toBe("partial");
  });

  it("a fatal storage error stops the scan; remaining markets are counted as unrecorded failures; exit-7 semantics", async () => {
    const { result, urls } = await collect(scanRoutes([[...MARKETS, { id: "96" }, { id: "97" }]]), {
      scan: { concurrency: 1 },
      configureDatabase: (db) => {
        const pages = (get(db, "PRAGMA page_count") as { page_count: number }).page_count;
        db.exec(`PRAGMA max_page_count = ${pages}`);
      },
    });
    expect(result.storageError).toMatchObject({ kind: "Storage", details: { code: "DISK_FULL" } });
    expect(result.status).toBe("failed");
    // Markets committed before the disk filled stay durable; everything after is an explicit failure.
    expect(result.persist.persistedObservations).toBeLessThan(5);
    expect(result.persist.selected).toBe(result.persist.persistedObservations + result.failures.length);
    expect(result.accounting).toBe("verified");
    expect(result.failures.some((f) => f.code === "STORAGE_UNAVAILABLE")).toBe(true);
    expect(result.scan!.stopReasons).toContain("CANCELLED"); // the scan was stopped, not left running
    expect(urls.length).toBeLessThan(1 + 5 * 3);
  });
});

describe("collectMarkets: failures of the failure path", () => {
  it("a failure that cannot even be recorded is kept in memory and still balances the accounting", async () => {
    const dbPath = tempDbPath();
    const pre = openMigrated(dbPath);
    pre.exec("CREATE TRIGGER a BEFORE INSERT ON market_observation WHEN NEW.gamma_id = '92' BEGIN SELECT RAISE(ABORT, 'obs'); END;");
    pre.exec("CREATE TRIGGER b BEFORE INSERT ON persistence_failure BEGIN SELECT RAISE(ABORT, 'fail row'); END;");
    pre.close();
    const { result } = await collect(scanRoutes([MARKETS]), { dbPath });
    assertAccounting(result, dbPath);
    expect(result.persist).toMatchObject({ selected: 3, persistedObservations: 2, persistenceFailures: 0, persistenceFailuresUnrecorded: 1 });
    expect(result.failures).toEqual([expect.objectContaining({ gammaId: "92", recorded: false })]);
    expect(result).toMatchObject({ status: "partial", accounting: "verified", finalized: true });
    const db = reader(dbPath);
    expect(listRuns(db, 1)[0]!.persistCounts).toMatchObject({ persistenceFailuresUnrecorded: 1 });
    db.close();
  });

  it("if the final run update fails the run stays running (for later safe recovery) and storage error is reported", async () => {
    const dbPath = tempDbPath();
    const pre = openMigrated(dbPath);
    pre.exec("CREATE TRIGGER f BEFORE UPDATE OF status ON collection_run WHEN NEW.status <> 'running' BEGIN SELECT RAISE(ABORT, 'no finalize'); END;");
    pre.close();
    const { result } = await collect(scanRoutes([MARKETS]), { dbPath });
    expect(result.finalized).toBe(false);
    expect(result.storageError).toMatchObject({ kind: "Storage" });
    const db = reader(dbPath);
    expect(get(db, "SELECT status, accounting FROM collection_run")).toEqual({ status: "running", accounting: "pending" });
    expect(n(db, "SELECT count(*) AS n FROM market_observation")).toBe(3); // observations are durable regardless
    db.close();
  });
});

describe("collectMarkets: admission", () => {
  it("refuses before any HTTP request when database + WAL + SHM reach the soft limit", async () => {
    const dbPath = tempDbPath();
    openMigrated(dbPath).close();
    const error = await collect(scanRoutes([MARKETS]), { dbPath, maxDbBytes: 1 }).catch((e: unknown) => e as MarketMindError);
    expect(error).toMatchObject({ kind: "Storage", details: { code: "DB_SIZE_LIMIT" } });
  });

  it("an admitted run may cross the soft limit and reports it", async () => {
    const dbPath = tempDbPath();
    const { result } = await collect(scanRoutes([MARKETS]), { dbPath, maxDbBytes: 4096 });
    expect(result.status).toBe("complete");
    expect(result.footprintBefore.total).toBe(0);
    expect(result.sizeLimitExceeded).toBe(true);
  });

  it("recovers provably abandoned runs and leaves live ones alone", async () => {
    const dbPath = tempDbPath();
    const pre = openMigrated(dbPath);
    createRun(pre, runInput({ runId: "dead", owner: { pid: 111, host: "test-host" }, startedAt: new Date(T0 - 10 * 60_000) }));
    createRun(pre, runInput({ runId: "alive", owner: { pid: 999, host: "test-host" }, startedAt: new Date(T0 - 10 * 60_000) }));
    pre.close();
    const { result } = await collect(scanRoutes([MARKETS]), { dbPath });
    expect(result.recovery).toEqual({ recovered: ["dead"], unverified: [{ runId: "alive", reason: "OWNER_ALIVE" }] });
    const db = reader(dbPath);
    expect(all(db, "SELECT run_id, status, accounting FROM collection_run ORDER BY run_id")).toEqual([
      { run_id: "alive", status: "running", accounting: "pending" },
      { run_id: "dead", status: "interrupted", accounting: "incomplete" },
      { run_id: "run-x", status: "complete", accounting: "verified" },
    ]);
    db.close();
  });
});
