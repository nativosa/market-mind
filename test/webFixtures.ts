import { request, type IncomingHttpHeaders } from "node:http";
import type { FetchFn } from "../src/adapters/polymarket/httpClient.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { WEB_LIMITS } from "../src/research/contracts.js";
import { createLiveGate, withRateLimitCooldown, type RollingWindowLimit } from "../src/research/liveGate.js";
import { createWebServer, type WebServer } from "../src/web/server.js";
import { fakeFetch, TEST_HTTP_OPTIONS, testDeps, type Reply } from "./helpers.js";

/** Fixed "now" for views; the budget window and cooldown use a separate, advanceable millisecond clock. */
export const WEB_NOW = new Date("2026-11-02T12:00:00.000Z");
export const WEB_CONFIG = { ...DEFAULT_CONFIG, ...TEST_HTTP_OPTIONS, gammaBaseUrl: "https://gamma.example", clobBaseUrl: "https://clob.example", dbPath: "unused.sqlite", buildId: null };

export interface HttpReply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: () => Record<string, unknown>;
}

export interface GetOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort the client request (closing the socket) when this signal fires. */
  signal?: AbortSignal;
}

/** A plain node:http client request (global fetch is disabled in the offline suite). */
export function get(port: number, path: string, options: GetOptions = {}): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers ?? {}, ...(options.signal ? { signal: options.signal } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) as Record<string, unknown> });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

export interface WebOptions {
  routes?: Record<string, Reply | Reply[]>;
  /** Replaces the fake routes entirely (e.g. a fetch that never answers). */
  fetch?: FetchFn;
  processLimit?: number;
  window?: RollingWindowLimit;
  staticRoot?: string | null;
  devOrigins?: string[];
}

const running: WebServer[] = [];

/** Close every server started by `startWeb` (call from afterEach). */
export async function closeAllWeb(): Promise<void> {
  for (const web of running.splice(0)) await web.close();
}

/** A real web server on an ephemeral 127.0.0.1 port over fake upstream HTTP. Every upstream URL is recorded. */
export async function startWeb(options: WebOptions = {}) {
  const fake = fakeFetch(options.routes ?? {});
  const urls: string[] = [];
  const inner = options.fetch ?? fake.fetch;
  const fetch: FetchFn = (url, init) => {
    urls.push(url);
    return inner(url, init);
  };
  let t = 1_000_000;
  const clock = () => t;
  const gate = withRateLimitCooldown(
    createLiveGate(testDeps(fetch).deps, options.processLimit ?? 100, { window: options.window ?? { limit: 60, windowMs: 300_000 }, now: clock }),
    WEB_LIMITS.rateLimitCooldownMs,
    clock,
  );
  const logs: string[] = [];
  const web = createWebServer({
    gate,
    config: WEB_CONFIG,
    devOrigins: options.devOrigins ?? [],
    staticRoot: options.staticRoot ?? null,
    now: () => WEB_NOW,
    log: (line) => logs.push(line),
  });
  running.push(web);
  const port = await web.listen(0);
  return {
    web,
    port,
    gate,
    urls,
    logs,
    advance: (ms: number) => (t += ms),
    get: (path: string, opts: GetOptions = {}) => get(port, path, opts),
  };
}
