import type { HttpDeps } from "../adapters/polymarket/httpClient.js";
import { realLiveness } from "../adapters/storage/processLiveness.js";
import { DEFAULT_CONFIG } from "../config/config.js";
import { MarketMindError } from "../domain/errors.js";
import { WEB_LIMITS } from "../research/contracts.js";
import { createLiveGate, withRateLimitCooldown } from "../research/liveGate.js";
import { createWebServer, type WebServer } from "../web/server.js";
import { WEB_HOST } from "../web/settings.js";
import { writeDemoDatabase, type DemoSummary } from "./demoDatabase.js";
import { createDemoSession, type CleanupResult, type SessionDeps } from "./session.js";

// npm run web:demo: the normal web server over a freshly generated synthetic database, offline.
// Live routes are refused by the server before they reach the gate (liveEnabled: false), and the
// gate itself is built over an HTTP client that refuses every request, so no code path can reach
// Polymarket. The configured database (MARKETMIND_DB or data/marketmind.sqlite) is never read.

/** Every upstream request fails before any I/O: the demonstration has no network access at all. */
export const OFFLINE_HTTP: HttpDeps = {
  fetch: () => Promise.reject(new MarketMindError("Network", "The synthetic demonstration makes no network requests")),
  sleep: () => Promise.resolve(),
  now: () => new Date(),
};

export interface DemoOptions {
  port: number;
  staticRoot: string | null;
  log: (line: string) => void;
  session?: SessionDeps;
  /** The upstream client behind the (never used) live gate; tests pass a recording double. */
  http?: HttpDeps;
}

export interface Demo {
  /** The address to open: Stored History. */
  readonly url: string;
  readonly dir: string;
  readonly dbPath: string;
  readonly summary: DemoSummary;
  readonly web: WebServer;
  /** Close the server (and with it every database handle), then delete the demo directory. Idempotent. */
  stop(): Promise<CleanupResult>;
}

export async function startDemo(options: DemoOptions): Promise<Demo> {
  const session = createDemoSession(options.session);
  let web: WebServer | null = null;
  try {
    const summary = writeDemoDatabase(session.dbPath);
    const gate = withRateLimitCooldown(createLiveGate(options.http ?? OFFLINE_HTTP, 1, { window: { limit: WEB_LIMITS.inspect.maxAttempts, windowMs: WEB_LIMITS.window.windowMs } }), WEB_LIMITS.rateLimitCooldownMs);
    web = createWebServer({
      gate,
      // Unreachable addresses as well, should anything ever ask: the reserved .invalid domain.
      config: { ...DEFAULT_CONFIG, dbPath: session.dbPath, gammaBaseUrl: "https://gamma.synthetic-demo.invalid", clobBaseUrl: "https://clob.synthetic-demo.invalid", buildId: null },
      liveEnabled: false,
      stored: { dbPath: session.dbPath, defaultSource: "all", mode: "demo" },
      liveness: realLiveness,
      devOrigins: [],
      staticRoot: options.staticRoot,
      now: () => new Date(),
      log: options.log,
    });
    const port = await web.listen(options.port);
    const server = web;
    let stopped: Promise<CleanupResult> | null = null;
    return {
      url: `http://${WEB_HOST}:${port}/#/history`,
      dir: session.dir,
      dbPath: session.dbPath,
      summary,
      web: server,
      stop: () => (stopped ??= server.close().then(() => session.cleanup())),
    };
  } catch (error) {
    // Partial start: release the port and every handle first, then remove only our own directory.
    if (web) await web.close().catch(() => undefined);
    session.cleanup();
    throw error;
  }
}
