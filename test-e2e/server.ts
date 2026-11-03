import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { realHttpDeps } from "../src/adapters/polymarket/httpClient.js";
import { realLiveness } from "../src/adapters/storage/processLiveness.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { OFFLINE_HTTP, startDemo } from "../src/demo/demoServer.js";
import { WEB_LIMITS } from "../src/research/contracts.js";
import { createLiveGate, withRateLimitCooldown } from "../src/research/liveGate.js";
import { createWebServer, type WebServer } from "../src/web/server.js";
import { staticRootOf } from "../src/web/static.js";
import { TEST_HTTP_OPTIONS } from "../test/helpers.js";
import { seedEmpty, seedHistory, seedLarge } from "../test/historySeed.js";
import { CLOB, createUpstream, GAMMA, type Upstream } from "./upstream.js";

// E2E entry point (test-only; never imported by the application). It runs, all on 127.0.0.1:
// - the real MarketMind web server serving the production build of web/ over the fixture upstream;
// - a Vite dev server for the same app (React StrictMode development build), proxying /api to it;
// - a control port the specs use to reset the server (fresh budgets, cooldown and URL log, and which
//   local database the stored routes read), to read which upstream URLs were requested, and to
//   fingerprint the database files (stored routes must never write);
// - the synthetic demonstration (npm run web:demo's startDemo) on its own port, over an HTTP client
//   that records any request (there must be none).
// The stored-history databases are temporary fixtures written through the collect code path.

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4417);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 4418);
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 4419);
const DEV_ORIGIN = `http://127.0.0.1:${DEV_PORT}`;
const DEMO_PORT = Number(process.env.E2E_DEMO_PORT ?? 4420);

const config = { ...DEFAULT_CONFIG, ...TEST_HTTP_OPTIONS, timeoutMs: 5_000, gammaBaseUrl: GAMMA, clobBaseUrl: CLOB, dbPath: "unused-e2e.sqlite", buildId: null };
const staticRoot = await staticRootOf(resolve("web/dist"));
if (staticRoot === null) throw new Error("web/dist is missing: run npm run web:build first");

export interface Limits {
  processLimit?: number;
  windowLimit?: number;
  /** The database the stored routes read: none (default), a migrated empty one, the history fixture or a 2,050-observation market. */
  db?: "missing" | "empty" | "history" | "large";
}

// A fixed, git-ignored folder, recreated on every start: the server may be killed without cleanup.
const dbDir = resolve("test-results/e2e-db");
rmSync(dbDir, { recursive: true, force: true });
mkdirSync(dbDir, { recursive: true });
const databases = {
  missing: "unused-e2e.sqlite",
  empty: seedEmpty(resolve(dbDir, "empty.sqlite")),
  history: seedHistory(resolve(dbDir, "history.sqlite")).path,
  large: seedLarge(resolve(dbDir, "large.sqlite")),
};

/**
 * Size, modification time and content hash of a database and its rollback journal, and the WAL's
 * frames. A reader of a WAL database may create an empty -wal and the -shm file (SQLite's
 * shared-memory index, whose read marks every reader updates): neither is a write to the database,
 * so an absent or empty WAL count as "no frames" and -shm is not compared.
 */
function fingerprint(path: string): Record<string, string> {
  return Object.fromEntries(
    ["", "-wal", "-journal"].map((suffix) => {
      const file = path + suffix;
      if (suffix === "-wal" && (!existsSync(file) || statSync(file).size === 0)) return [suffix, "no frames"];
      if (!existsSync(file)) return [suffix || "main", "absent"];
      const s = statSync(file);
      return [suffix || "main", `${s.size} ${s.mtimeMs} ${createHash("sha256").update(readFileSync(file)).digest("hex")}`];
    }),
  );
}

// The demonstration, as npm run web:demo starts it; its temporary directory goes under dbDir.
const demoUrls: string[] = [];
const demo = await startDemo({
  port: DEMO_PORT,
  staticRoot,
  log: () => undefined,
  session: { tmpRoot: dbDir },
  http: {
    ...OFFLINE_HTTP,
    fetch: (url) => {
      demoUrls.push(url);
      return OFFLINE_HTTP.fetch(url, {});
    },
  },
});

let upstream: Upstream = createUpstream();
let web: WebServer | null = null;
let currentDb = databases.missing;

async function start(limits: Limits): Promise<void> {
  if (web) await web.close();
  upstream = createUpstream();
  currentDb = databases[limits.db ?? "missing"];
  const gate = withRateLimitCooldown(
    createLiveGate({ ...realHttpDeps, fetch: upstream.fetch }, limits.processLimit ?? 2_000, { window: { limit: limits.windowLimit ?? 60, windowMs: WEB_LIMITS.window.windowMs } }),
    WEB_LIMITS.rateLimitCooldownMs,
  );
  web = createWebServer({
    gate,
    config,
    liveEnabled: true,
    stored: { dbPath: currentDb, defaultSource: "live" },
    liveness: realLiveness,
    devOrigins: [DEV_ORIGIN],
    staticRoot,
    now: () => new Date(),
    log: () => undefined,
  });
  await web.listen(WEB_PORT);
}

await start({});

// The development build, through Vite's own proxy (its config reads MARKETMIND_WEB_PORT).
process.env.MARKETMIND_WEB_PORT = String(WEB_PORT);
const { createServer: createVite } = await import("vite");
const vite = await createVite({ configFile: resolve("web/vite.config.ts"), server: { host: "127.0.0.1", port: DEV_PORT, strictPort: true }, logLevel: "warn" });
await vite.listen();

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function control(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = req.url ?? "/";
  if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && path === "/log") return send(res, 200, { urls: upstream.urls, unexpected: upstream.unexpected, demoUrls });
  if (req.method === "GET" && path === "/db") return send(res, 200, { app: fingerprint(currentDb), demo: fingerprint(demo.dbPath) });
  if (req.method === "POST" && path === "/reset") {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    await start((raw ? JSON.parse(raw) : {}) as Limits);
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: "unknown control route" });
}

const controlServer = createHttpServer((req, res) => {
  control(req, res).catch((error: unknown) => send(res, 500, { error: String(error) }));
});
await new Promise<void>((done) => controlServer.listen(CONTROL_PORT, "127.0.0.1", done));
process.stdout.write(`e2e servers: app http://127.0.0.1:${WEB_PORT}, dev ${DEV_ORIGIN}, demo ${demo.url}, control http://127.0.0.1:${CONTROL_PORT}\n`);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void Promise.allSettled([web?.close(), demo.stop(), vite.close(), new Promise((done) => controlServer.close(done))]).then(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
