import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { realHttpDeps } from "../src/adapters/polymarket/httpClient.js";
import { realLiveness } from "../src/adapters/storage/processLiveness.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { WEB_LIMITS } from "../src/research/contracts.js";
import { createLiveGate, withRateLimitCooldown } from "../src/research/liveGate.js";
import { createWebServer, type WebServer } from "../src/web/server.js";
import { staticRootOf } from "../src/web/static.js";
import { TEST_HTTP_OPTIONS } from "../test/helpers.js";
import { seedEmpty, seedHistory } from "../test/historySeed.js";
import { cleanupTemp } from "../test/storageFixtures.js";
import { CLOB, createUpstream, GAMMA, type Upstream } from "./upstream.js";

// E2E entry point (test-only; never imported by the application). It runs, all on 127.0.0.1:
// - the real MarketMind web server serving the production build of web/ over the fixture upstream;
// - a Vite dev server for the same app (React StrictMode development build), proxying /api to it;
// - a control port the specs use to reset the server (fresh budgets, cooldown and URL log, and which
//   local database the stored routes read) and to read which upstream URLs were requested.
// The stored-history databases are temporary fixtures written through the collect code path.

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4417);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 4418);
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 4419);
const DEV_ORIGIN = `http://127.0.0.1:${DEV_PORT}`;

const config = { ...DEFAULT_CONFIG, ...TEST_HTTP_OPTIONS, timeoutMs: 5_000, gammaBaseUrl: GAMMA, clobBaseUrl: CLOB, dbPath: "unused-e2e.sqlite", buildId: null };
const staticRoot = await staticRootOf(resolve("web/dist"));
if (staticRoot === null) throw new Error("web/dist is missing: run npm run web:build first");

export interface Limits {
  processLimit?: number;
  windowLimit?: number;
  /** The database the stored routes read: none (default), a migrated empty one, or the history fixture. */
  db?: "missing" | "empty" | "history";
}

const databases = { missing: "unused-e2e.sqlite", empty: seedEmpty(), history: seedHistory().path };

let upstream: Upstream = createUpstream();
let web: WebServer | null = null;

async function start(limits: Limits): Promise<void> {
  if (web) await web.close();
  upstream = createUpstream();
  const gate = withRateLimitCooldown(
    createLiveGate({ ...realHttpDeps, fetch: upstream.fetch }, limits.processLimit ?? 2_000, { window: { limit: limits.windowLimit ?? 60, windowMs: WEB_LIMITS.window.windowMs } }),
    WEB_LIMITS.rateLimitCooldownMs,
  );
  web = createWebServer({
    gate,
    config,
    liveEnabled: true,
    stored: { dbPath: databases[limits.db ?? "missing"], defaultSource: "live" },
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
  if (req.method === "GET" && path === "/log") return send(res, 200, { urls: upstream.urls, unexpected: upstream.unexpected });
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
process.stdout.write(`e2e servers: app http://127.0.0.1:${WEB_PORT}, dev ${DEV_ORIGIN}, control http://127.0.0.1:${CONTROL_PORT}\n`);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void Promise.allSettled([web?.close(), vite.close(), new Promise((done) => controlServer.close(done))]).then(() => {
    cleanupTemp();
    process.exit(0);
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
