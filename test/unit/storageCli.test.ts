import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchFn } from "../../src/adapters/polymarket/httpClient.js";
import { parseCli } from "../../src/cli/args.js";
import { exitCodeFor, run } from "../../src/cli/run.js";
import { APP_VERSION, DEFAULT_CONFIG, loadConfig, parseDbPath } from "../../src/config/config.js";
import type { MarketMindError } from "../../src/domain/errors.js";
import { fakeFetch, json, testDeps, type Reply } from "../helpers.js";
import { scanRoutes, type MarketSpec } from "../scanFixtures.js";
import { cleanupTemp, clock, fakeLiveness, openMigrated, tempDbPath } from "../storageFixtures.js";

afterEach(cleanupTemp);

const ENV = { MARKETMIND_GAMMA_URL: "https://gamma.example", MARKETMIND_CLOB_URL: "https://clob.example" };

async function cli(argv: string[], routes: Record<string, Reply | Reply[]> | "forbidden" = {}) {
  const calls: string[] = [];
  const fetch: FetchFn =
    routes === "forbidden"
      ? (url) => {
          calls.push(url);
          throw new Error(`network forbidden: ${url}`);
        }
      : (url, init) => {
          calls.push(url);
          return fakeFetch(routes).fetch(url, init);
        };
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    http: testDeps(fetch, clock()).deps,
    env: ENV,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    liveness: fakeLiveness({ 4321: "alive" }),
    pid: 4321,
    newRunId: () => "cli-run-0001",
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

function usageError(argv: string[]): MarketMindError {
  try {
    parseCli(argv);
  } catch (e) {
    return e as MarketMindError;
  }
  throw new Error("expected usage error");
}

const MARKETS: MarketSpec[] = [
  { id: "11", book: { bids: [["0.40", "100"]], asks: [["0.46", "100"]] } },
  { id: "12", book: { bids: [["0.30", "50"]], asks: [["0.40", "60"]] } },
];

describe("storage command parsing", () => {
  it("collect accepts all scan options plus --db and --max-db-mb", () => {
    expect(parseCli(["collect"])).toMatchObject({ kind: "collect", maxMarkets: 10, maxRequests: 48, db: null, maxDbMb: 1024, json: false });
    expect(parseCli(["collect", "--max-markets", "3", "--db", "x/y.sqlite", "--max-db-mb", "5", "--json"])).toMatchObject({
      maxMarkets: 3,
      db: "x/y.sqlite",
      maxDbMb: 5,
      json: true,
    });
  });

  it("history and runs defaults", () => {
    expect(parseCli(["history", "--market-id", "42"])).toEqual({
      kind: "history",
      marketId: "42",
      asOf: null,
      limit: 20,
      spreadThreshold: "0.02",
      analyticsVersion: 1,
      includeSynthetic: false,
      db: null,
      json: false,
    });
    expect(parseCli(["runs"])).toEqual({ kind: "runs", limit: 10, db: null, json: false });
  });

  it("normalizes --as-of to UTC", () => {
    expect(parseCli(["history", "--market-id", "1", "--as-of", "2026-10-29T10:00:00+02:00"])).toMatchObject({ asOf: "2026-10-29T08:00:00.000Z" });
    expect(parseCli(["history", "--market-id", "1", "--as-of", "2026-10-29T08:00Z"])).toMatchObject({ asOf: "2026-10-29T08:00:00.000Z" });
  });

  it.each([
    [["collect", "--max-db-mb", "0"]],
    [["collect", "--max-db-mb", "10241"]],
    [["collect", "--db", ":memory:"]],
    [["collect", "--db", "data/notes.txt"]],
    [["collect", "--db", "file:x.sqlite"]],
    [["collect", "--limit", "5"]],
    [["collect", "--max-requests", "121"]],
    [["scan", "--db", "x.sqlite"]],
    [["history"]],
    [["history", "--market-id", "abc"]],
    [["history", "--market-id", "1", "--as-of", "2026-10-29T08:00:00"]],
    [["history", "--market-id", "1", "--as-of", "yesterday"]],
    [["history", "--market-id", "1", "--limit", "501"]],
    [["history", "--market-id", "1", "--spread-threshold", "2"]],
    [["history", "--market-id", "1", "--analytics-version", "0"]],
    [["history", "--market-id", "1", "--max-markets", "3"]],
    [["runs", "--market-id", "1"]],
    [["runs", "--limit", "101"]],
    [["markets", "--db", "x.sqlite"]],
    [["inspect", "--market-id", "1", "--as-of", "2026-10-29T08:00:00Z"]],
  ])("rejects %j", (argv) => {
    expect(usageError(argv).kind).toBe("Usage");
  });

  it("Storage maps to exit 7", () => {
    expect(exitCodeFor("Storage")).toBe(7);
  });
});

describe("configuration", () => {
  it("APP_VERSION, the User-Agent and package-lock.json match package.json", () => {
    const read = (file: string) => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")) as { version: string; packages: Record<string, { version: string }> };
    const pkg = read("package.json");
    const lock = read("package-lock.json");
    expect(APP_VERSION).toBe(pkg.version);
    expect(DEFAULT_CONFIG.userAgent).toBe(`market-mind/${pkg.version} (read-only educational explorer)`);
    expect([lock.version, lock.packages[""]!.version]).toEqual([pkg.version, pkg.version]);
  });

  it("database path and build id come from validated environment variables", () => {
    expect(DEFAULT_CONFIG).toMatchObject({ dbPath: "data/marketmind.sqlite", buildId: null });
    expect(loadConfig({ MARKETMIND_DB: " other/db.sqlite ", MARKETMIND_BUILD_ID: "fe89427" })).toMatchObject({ dbPath: "other/db.sqlite", buildId: "fe89427" });
    expect(() => loadConfig({ MARKETMIND_DB: ":memory:" })).toThrow();
    expect(() => loadConfig({ MARKETMIND_BUILD_ID: "has spaces" })).toThrow();
    expect(() => loadConfig({ MARKETMIND_BUILD_ID: "x".repeat(65) })).toThrow();
    expect(() => parseDbPath("a\0b.sqlite", "--db")).toThrow();
    expect(parseDbPath("C:\\data\\m.db", "--db")).toBe("C:\\data\\m.db");
  });
});

describe("collect, history and runs commands", () => {
  it("collect persists and prints the scan report plus persistence accounting (exit 0)", async () => {
    const db = tempDbPath();
    const r = await cli(["collect", "--db", db], scanRoutes([MARKETS]));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("status=COMPLETE");
    expect(r.stdout).toContain("Persistence  run cli-run-0001  status=COMPLETE  accounting=verified");
    expect(r.stdout).toContain("Accounting: selected 2 = persisted 2 + failures 0; not selected 0 of 2 discovered (counts only, not stored)");
    expect(r.stdout).toContain("Books written 4 (new contents 4, deduplicated 0); metrics rows 2");
    expect(r.calls.every((u) => u.startsWith("https://"))).toBe(true);
  });

  it("collect --json reports run, persistence counts and the embedded scan", async () => {
    const r = await cli(["collect", "--db", tempDbPath(), "--json"], scanRoutes([MARKETS]));
    const body = JSON.parse(r.stdout) as { run: unknown; persistence: { counts: Record<string, unknown> }; scan: { counts: unknown } };
    expect(body.run).toMatchObject({ runId: "cli-run-0001", status: "complete", accounting: "verified", finalized: true });
    expect(body.persistence.counts).toMatchObject({ selected: 2, persistedObservations: 2, persistenceFailures: 0 });
    expect(body.scan.counts).toMatchObject({ selected: 2 });
  });

  it("collect exit codes: 6 partial, 7 size limit, 4 discovery failure", async () => {
    const db = tempDbPath();
    const partial = await cli(["collect", "--db", db], scanRoutes([[...MARKETS, { id: "13", replies: { book0: json({}, 500) } }]]));
    expect(partial.code).toBe(6);
    expect(partial.stderr).toContain("collection partial (run cli-run-0001");
    const big = tempDbPath();
    const filler = openMigrated(big);
    filler.exec("CREATE TABLE pad (b BLOB) STRICT");
    filler.prepare("INSERT INTO pad VALUES (?)").run(new Uint8Array(2 * 1024 * 1024));
    filler.close();
    const refused = await cli(["collect", "--db", big, "--max-db-mb", "1"], scanRoutes([MARKETS]));
    expect(refused.code).toBe(7);
    expect(refused.calls).toEqual([]); // refused before any HTTP request
    expect(refused.stderr).toContain("soft limit");
    const failed = await cli(["collect", "--db", tempDbPath()], scanRoutes([[]], { keyset: json({ error: "x" }, 503) }));
    expect(failed.code).toBe(4);
    expect(failed.stdout).toContain("status=FAILED");
  });

  it("history and runs make zero network requests", async () => {
    const db = tempDbPath();
    await cli(["collect", "--db", db], scanRoutes([MARKETS]));
    const h = await cli(["history", "--market-id", "12", "--db", db], "forbidden");
    expect(h.code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.stdout).toContain("History  market 12");
    expect(h.stdout).toContain("Spread (n=1): current 0.1");
    expect(h.stdout).toContain("observed in 1 of 1 samples (100% of samples, not of time)");
    expect(h.stdout).toContain("Limitations");
    const hj = await cli(["history", "--market-id", "12", "--db", db, "--json"], "forbidden");
    const body = JSON.parse(hj.stdout) as { stats: { spread: { current: unknown; n: number } }; rows: { metrics: { spread: unknown } }[] };
    expect(body.stats.spread).toMatchObject({ current: "0.1", n: 1 });
    expect(body.rows[0]!.metrics.spread).toBe("0.1");
    const runs = await cli(["runs", "--db", db], "forbidden");
    expect(runs.code).toBe(0);
    expect(runs.calls).toEqual([]);
    expect(runs.stdout).toContain("cli-run-");
    expect(runs.stdout).toContain("complete  verified");
    const rj = await cli(["runs", "--db", db, "--json"], "forbidden");
    expect((JSON.parse(rj.stdout) as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it("history on a missing database exits 3 and creates nothing", async () => {
    const db = tempDbPath("absent.sqlite");
    const r = await cli(["history", "--market-id", "1", "--db", db], "forbidden");
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("No database at");
    expect(existsSync(db)).toBe(false);
    const runs = await cli(["runs", "--db", db], "forbidden");
    expect(runs.code).toBe(3);
  });

  it("history for an unknown market exits 3", async () => {
    const db = tempDbPath();
    await cli(["collect", "--db", db], scanRoutes([MARKETS]));
    const r = await cli(["history", "--market-id", "999", "--db", db], "forbidden");
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("No live observations for market 999");
  });
});
