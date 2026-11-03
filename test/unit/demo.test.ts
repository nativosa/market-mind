import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { FetchFn } from "../../src/adapters/polymarket/httpClient.js";
import { openDatabase } from "../../src/adapters/storage/sqlite.js";
import { collectionRuns, marketHistory, observationDetails, storedMarkets } from "../../src/app/marketHistory.js";
import { decimal } from "../../src/domain/decimal.js";
import { runDemo } from "../../src/demo/cli.js";
import { DEMO_LABEL, DEMO_MARKETS, demoTimeline, writeDemoDatabase, type DemoRun } from "../../src/demo/demoDatabase.js";
import { OFFLINE_HTTP, startDemo } from "../../src/demo/demoServer.js";
import { createDemoSession, DEMO_DIR_PREFIX } from "../../src/demo/session.js";
import { WebHistoryOutput, WebStatusOutput } from "../../src/research/contracts.js";
import { get } from "../webFixtures.js";

// Stage 3.2 Commit 7: the synthetic demonstration (npm run web:demo). The generator writes through
// the storage layer, deterministically; the server is offline with live routes refused; the
// temporary directory is the demonstration's own and is removed only after verification.

const roots: string[] = [];
/** A private temporary root for one test (removed afterwards). */
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "mm-demo-test-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TABLES = ["book_content", "book_observation", "collection_run", "market", "market_metrics", "market_observation", "outcome", "persistence_failure", "request_log", "schema_migrations"];

/** Every row of every table, in insertion order. */
function dump(path: string): Record<string, unknown[]> {
  const db = openDatabase({ path, readOnly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    return Object.fromEntries(names.map((name) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  } finally {
    db.close();
  }
}

function generate(): string {
  const path = join(root(), "demo.sqlite");
  writeDemoDatabase(path);
  return path;
}

const history = (path: string, gammaId: string) =>
  marketHistory({ dbPath: path, gammaId, asOf: null, limit: 100, threshold: decimal("0.02"), analyticsVersion: 1, includeSynthetic: true });

describe("demo database generator", () => {
  it("two generations store the same records", () => {
    const a = dump(generate());
    const b = dump(generate());
    expect(Object.keys(a)).toEqual(TABLES);
    expect(b).toEqual(a);
    expect(a.market_observation).toHaveLength(26);
  });

  it("is synthetic everywhere: runs, questions, URLs and fixed 2026-01-05 timestamps", () => {
    const rows = dump(generate());
    const runs = rows.collection_run as { source_type: string; status: string; owner_host: string; started_at: string }[];
    expect(runs).toHaveLength(17);
    expect(new Set(runs.map((r) => r.source_type))).toEqual(new Set(["synthetic"]));
    expect(new Set(runs.map((r) => r.owner_host))).toEqual(new Set(["synthetic-demo.invalid"]));
    expect(runs.every((r) => r.started_at.startsWith("2026-01-05T"))).toBe(true);
    const urls = (rows.request_log as { url: string }[]).map((r) => new URL(r.url).hostname);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((h) => h.endsWith(".synthetic-demo.invalid"))).toBe(true);
    const questions = (rows.market_observation as { question: string }[]).map((r) => r.question);
    expect(questions.every((q) => q.startsWith(DEMO_LABEL))).toBe(true);
  });

  it("passes the storage invariants and reads back through the application functions", () => {
    const path = generate();
    const db = openDatabase({ path, readOnly: true });
    try {
      expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
    const runs = collectionRuns({ dbPath: path, limit: 50, liveness: { hostname: () => "this-host", probe: () => "alive" }, now: () => new Date(), includeSynthetic: true }).runs;
    const byStatus = (s: string) => runs.filter((r) => r.status === s).map((r) => r.runId);
    expect(byStatus("running")).toEqual([]);
    expect(byStatus("interrupted")).toEqual(["synthetic-demo-11"]);
    expect(byStatus("partial")).toEqual(["synthetic-demo-10"]);
    expect(runs.find((r) => r.status === "interrupted")).toMatchObject({ accounting: "incomplete", recoveredReason: "OWNER_PROCESS_GONE" });
    // Nothing is visible without synthetic data.
    expect(collectionRuns({ dbPath: path, limit: 50, liveness: { hostname: () => "h", probe: () => "gone" }, now: () => new Date(), includeSynthetic: false }).runs).toEqual([]);
    expect(storedMarkets({ dbPath: path, includeSynthetic: false, limit: 10, offset: 0 }).markets).toEqual([]);
    expect(storedMarkets({ dbPath: path, includeSynthetic: true, limit: 10, offset: 0 }).markets.map((m) => [m.gammaId, m.observations, m.liveObservations])).toEqual([
      [DEMO_MARKETS.irregular.gammaId, 8, 0],
      [DEMO_MARKETS.steady.gammaId, 16, 0],
      [DEMO_MARKETS.sparse.gammaId, 2, 0],
    ]);
  });

  it("covers the demonstrated cases: varied prices and depth, irregular gaps, an invalid book, an incomplete observation, a sparse market", () => {
    const path = generate();
    const steady = history(path, DEMO_MARKETS.steady.gammaId).stats;
    expect(steady).toMatchObject({ eligible: 16, usable: 16, spread: { n: 16 } });
    expect([String(steady.spread.min), String(steady.spread.max)]).toEqual(["0.006", "0.03"]);
    const irregular = history(path, DEMO_MARKETS.irregular.gammaId).stats;
    expect(irregular).toMatchObject({ eligible: 8, usable: 6, notUsable: { NOT_PAIRED: 1, INVALID_BOOK: 1 } });
    expect(irregular.gaps.irregular).toBe(1); // 2 h 38 min without a usable sample, against a 15-minute median
    const sparse = history(path, DEMO_MARKETS.sparse.gammaId).stats;
    expect(sparse).toMatchObject({ eligible: 2, usable: 0, notUsable: { NOT_TWO_SIDED: 2 } });
    const details = observationDetails({ dbPath: path, observationId: 1, asOf: null });
    expect(details.observation.question.startsWith(DEMO_LABEL)).toBe(true);
    expect(details.run).toMatchObject({ sourceType: "synthetic" });
  });

  it("never opens an existing database: the file and its journal siblings must be new", () => {
    const dir = root();
    const existing = join(dir, "marketmind.sqlite");
    writeFileSync(existing, "not a database, and not to be touched");
    const before = { hash: createHash("sha256").update(readFileSync(existing)).digest("hex"), mtime: statSync(existing).mtimeMs };
    expect(() => writeDemoDatabase(existing)).toThrow(/must be a new file/);
    writeFileSync(join(dir, "other.sqlite-wal"), "");
    expect(() => writeDemoDatabase(join(dir, "other.sqlite"))).toThrow(/must be a new file/);
    expect({ hash: createHash("sha256").update(readFileSync(existing)).digest("hex"), mtime: statSync(existing).mtimeMs }).toEqual(before);
    expect(existsSync(join(dir, "other.sqlite"))).toBe(false);
  });

  it("a failure part-way propagates with the database closed, so the directory can be deleted (Windows included)", () => {
    const dir = root();
    const path = join(dir, "broken.sqlite");
    const [first] = demoTimeline();
    // The same market twice in one run violates UNIQUE (run_id, gamma_id) at the second write.
    const broken: DemoRun[] = [{ ...first!, samples: [first!.samples[0]!, first!.samples[0]!] }];
    expect(() => writeDemoDatabase(path, broken)).toThrow();
    expect(() => rmSync(dir, { recursive: true })).not.toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});

describe("demo session directory", () => {
  it("is created fresh under the temporary root, marked, and removed by its own session only once", () => {
    const tmp = root();
    const session = createDemoSession({ tmpRoot: tmp });
    expect(session.dir.startsWith(tmp)).toBe(true);
    expect(session.dir).toContain(DEMO_DIR_PREFIX);
    expect(existsSync(session.dbPath)).toBe(false);
    expect(readdirSync(session.dir)).toEqual(["marketmind-demo.json"]);
    expect(session.cleanup()).toEqual({ removed: true });
    expect(existsSync(session.dir)).toBe(false);
    expect(session.cleanup()).toEqual({ removed: true });
  });

  it("never removes a directory whose mark is not its own, is missing, or that no longer exists", () => {
    const tmp = root();
    const foreign = createDemoSession({ tmpRoot: tmp });
    writeFileSync(join(foreign.dir, "marketmind-demo.json"), JSON.stringify({ token: "someone else" }));
    expect(foreign.cleanup()).toEqual({ removed: false, reason: "the directory's ownership mark belongs to another process" });
    expect(existsSync(foreign.dir)).toBe(true);

    const unmarked = createDemoSession({ tmpRoot: tmp });
    rmSync(join(unmarked.dir, "marketmind-demo.json"));
    expect(unmarked.cleanup()).toMatchObject({ removed: false, reason: "the directory's ownership mark is missing or unreadable" });
    expect(existsSync(unmarked.dir)).toBe(true);

    const replaced = createDemoSession({ tmpRoot: tmp });
    rmSync(replaced.dir, { recursive: true });
    mkdirSync(replaced.dir);
    writeFileSync(join(replaced.dir, "keep.txt"), "a directory someone else made at the same path");
    expect(replaced.cleanup()).toMatchObject({ removed: false });
    expect(existsSync(join(replaced.dir, "keep.txt"))).toBe(true);

    const gone = createDemoSession({ tmpRoot: tmp });
    rmSync(gone.dir, { recursive: true });
    expect(gone.cleanup()).toEqual({ removed: false, reason: "the directory no longer exists" });
  });

  it("defaults to the OS temporary folder and reports a removal that fails (e.g. a file still locked on Windows)", () => {
    const session = createDemoSession();
    expect(session.dir.startsWith(realpathSync.native(tmpdir()))).toBe(true);
    expect(session.cleanup()).toEqual({ removed: true });
    const locked = createDemoSession({
      tmpRoot: root(),
      remove: () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    });
    expect(locked.cleanup()).toEqual({ removed: false, reason: "removal failed: EBUSY" });
    expect(existsSync(locked.dir)).toBe(true);
  });
});

/** An HTTP client double that records any call (there must be none). */
function recordingHttp() {
  const calls: string[] = [];
  const fetch: FetchFn = (url) => {
    calls.push(url);
    return Promise.reject(new Error("unexpected network request"));
  };
  return { http: { ...OFFLINE_HTTP, fetch }, calls };
}

describe("demo server", () => {
  const stops: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  it("is offline: status says demo, live routes are refused before the gate, stored data defaults to Live + synthetic", async () => {
    const { http, calls } = recordingHttp();
    const demo = await startDemo({ port: 0, staticRoot: null, log: () => undefined, session: { tmpRoot: root() }, http });
    stops.push(() => demo.stop());
    const port = Number(new URL(demo.url).port);
    expect(demo.url).toBe(`http://127.0.0.1:${port}/#/history`);
    const status = WebStatusOutput.parse((await get(port, "/api/status")).json());
    expect(status).toMatchObject({ live: { enabled: false }, stored: { mode: "demo", defaultSource: "all", database: "present" } });
    for (const path of ["/api/markets", "/api/markets?version=v2", "/api/markets/990000000000000001/inspect"]) {
      const r = await get(port, path);
      expect(r.status, path).toBe(403);
      expect(r.json(), path).toMatchObject({ error: { category: "forbidden", code: "LIVE_DISABLED" } });
    }
    const h = WebHistoryOutput.parse((await get(port, `/api/stored/markets/${DEMO_MARKETS.steady.gammaId}/history`)).json());
    expect(h.appliedLimits.source).toBe("all");
    expect(h.series.sourceCounts).toEqual({ live: 0, synthetic: 16 });
    expect(h.series.items.every((i) => i.sourceType === "synthetic")).toBe(true);
    expect((await get(port, "/api/stored/markets?source=live")).json()).toMatchObject({ status: "empty", markets: { items: [] } });
    expect(calls).toEqual([]);
    expect(status.budget.process.used).toBe(0);
  });

  it("stop closes the server, then deletes the directory; a second stop changes nothing", async () => {
    const demo = await startDemo({ port: 0, staticRoot: null, log: () => undefined, session: { tmpRoot: root() } });
    const port = Number(new URL(demo.url).port);
    expect((await get(port, `/api/stored/markets/${DEMO_MARKETS.sparse.gammaId}/history`)).status).toBe(200);
    expect(existsSync(demo.dbPath)).toBe(true);
    expect(await demo.stop()).toEqual({ removed: true });
    expect(existsSync(demo.dir)).toBe(false);
    expect(await demo.stop()).toEqual({ removed: true });
    await expect(get(port, "/api/status")).rejects.toThrow();
  });

  it("a start that fails part-way (port taken) releases everything and removes its directory", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    const tmp = root();
    try {
      await expect(startDemo({ port, staticRoot: null, log: () => undefined, session: { tmpRoot: tmp } })).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("runDemo ignores the configured database, logs the address, and on Ctrl+C stops and cleans up", async () => {
    const tmp = root();
    const configured = join(tmp, "configured.sqlite");
    writeFileSync(configured, "the user's database: must stay untouched");
    const before = statSync(configured).mtimeMs;
    const signals = new EventEmitter();
    const lines: string[] = [];
    const running = await runDemo({ env: { MARKETMIND_DB: configured, MARKETMIND_WEB_PORT: "4999" }, signals, log: (l) => lines.push(l), staticDir: join(tmp, "no-ui"), session: { tmpRoot: tmp } }).catch(
      async () => runDemo({ env: { MARKETMIND_DB: configured }, signals, log: (l) => lines.push(l), staticDir: join(tmp, "no-ui"), session: { tmpRoot: tmp } }),
    );
    expect(running).not.toBeNull();
    const { demo, stopped } = running!;
    expect(lines.join("\n")).toContain("SYNTHETIC DEMONSTRATION: 3 markets, 17 runs, 26 observations; offline, live Polymarket requests disabled");
    expect(lines.join("\n")).toContain(`temporary database: ${demo.dbPath}`);
    expect(lines.join("\n")).toContain("UI not built");
    expect(demo.dbPath.startsWith(tmp)).toBe(true);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    expect(await stopped).toEqual({ removed: true });
    expect(lines).toContain("stopped; temporary database deleted");
    expect(existsSync(demo.dir)).toBe(false);
    expect(readFileSync(configured, "utf8")).toBe("the user's database: must stay untouched");
    expect(statSync(configured).mtimeMs).toBe(before);
  });

  it("the offline HTTP client refuses every request before any I/O", async () => {
    await expect(OFFLINE_HTTP.fetch("https://clob.polymarket.com/book", {})).rejects.toMatchObject({ kind: "Network" });
    await expect(OFFLINE_HTTP.sleep(10_000)).resolves.toBeUndefined();
    expect(OFFLINE_HTTP.now()).toBeInstanceOf(Date);
  });

  it("runDemo with a built UI logs the Stored History address; a directory it cannot delete is reported, not hidden", async () => {
    const tmp = root();
    const ui = join(tmp, "ui");
    mkdirSync(ui);
    const signals = new EventEmitter();
    const lines: string[] = [];
    const remove = () => {
      throw Object.assign(new Error("locked"), { code: "EPERM" });
    };
    const port = await freePort();
    const running = await runDemo({ env: { MARKETMIND_WEB_PORT: String(port) }, signals, log: (l) => lines.push(l), staticDir: ui, session: { tmpRoot: tmp, remove } });
    expect(running).not.toBeNull();
    expect(lines.join("\n")).toMatch(/open http:\/\/127\.0\.0\.1:\d+\/#\/history {2}\(Ctrl\+C stops the server and deletes the temporary database\)/);
    signals.emit("SIGBREAK");
    expect(await running!.stopped).toEqual({ removed: false, reason: "removal failed: EPERM" });
    expect(lines.at(-1)).toBe(`stopped; temporary directory kept (removal failed: EPERM): ${running!.demo.dir}`);
  });

  it("runDemo explains a port in use", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    const tmp = root();
    const lines: string[] = [];
    try {
      expect(await runDemo({ env: { MARKETMIND_WEB_PORT: String(port) }, signals: new EventEmitter(), log: (l) => lines.push(l), session: { tmpRoot: tmp } })).toBeNull();
      expect(lines).toEqual([`startup failed: port ${port} is already in use; set MARKETMIND_WEB_PORT to another port`]);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("runDemo reports a startup failure without leaving anything behind", async () => {
    const tmp = root();
    const lines: string[] = [];
    expect(await runDemo({ env: { MARKETMIND_WEB_PORT: "80" }, signals: new EventEmitter(), log: (l) => lines.push(l), session: { tmpRoot: tmp } })).toBeNull();
    expect(lines.join("\n")).toContain("startup failed: Invalid MARKETMIND_WEB_PORT");
    expect(readdirSync(tmp)).toEqual([]);
  });
});

// The real launcher in a child process: no network module can be used (any fetch is blocked and
// reported), and its temporary folder is redirected to a private directory.
const LAUNCHER = fileURLToPath(new URL("../../bin/marketmind-web-demo.mjs", import.meta.url));
const FORBID_NETWORK = pathToFileURL(fileURLToPath(new URL("../mcp/forbidNetwork.mjs", import.meta.url))).href;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise((r) => probe.close(r));
  return port;
}

describe("spawned demo launcher (bin/marketmind-web-demo.mjs)", () => {
  it("starts offline from outside the repository, serves the synthetic history, refuses live routes", async () => {
    const tmp = root();
    const configured = join(tmp, "configured.sqlite");
    writeFileSync(configured, "untouched");
    const port = await freePort();
    const child = spawn(process.execPath, [LAUNCHER], {
      cwd: tmpdir(),
      env: { ...process.env, NODE_OPTIONS: `--import ${FORBID_NETWORK}`, MARKETMIND_WEB_PORT: String(port), MARKETMIND_DB: configured, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    try {
      const end = Date.now() + 30_000;
      while (!stderr.includes("open http://")) {
        if (Date.now() > end || child.exitCode !== null) throw new Error(`demo did not start: ${stderr}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(stderr).toContain(`open http://127.0.0.1:${port}/#/history`);
      const status = WebStatusOutput.parse((await get(port, "/api/status")).json());
      expect(status.stored).toEqual({ mode: "demo", defaultSource: "all", database: "present" });
      expect((await get(port, "/api/markets")).status).toBe(403);
      expect((await get(port, "/api/stored/markets")).json()).toMatchObject({ markets: { returnedCount: 3 } });
      expect((await get(port, "/")).status).toBe(200);
      const dirs = readdirSync(tmp).filter((d) => d.startsWith(DEMO_DIR_PREFIX));
      expect(dirs).toHaveLength(1);
      expect(stderr).toContain(join(tmp, dirs[0]!, "demo.sqlite"));
      expect(stderr).not.toContain("[forbidNetwork]");
      expect(readFileSync(configured, "utf8")).toBe("untouched");
    } finally {
      // On Windows a child cannot be sent Ctrl+C: kill() terminates it, which leaves the directory
      // (the documented behaviour of an abrupt stop); the private root is removed afterwards.
      child.kill();
      await exited;
    }
  }, 60_000);
});
