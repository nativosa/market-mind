import { afterEach, describe, expect, it } from "vitest";
import type { FetchFn } from "../../src/adapters/polymarket/httpClient.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { InspectOutput, MarketsOutput, WEB_CONTRACT, WebErrorOutput, WebStatusOutput } from "../../src/research/contracts.js";
import type { CooldownGate } from "../../src/research/liveGate.js";
import { createWebServer, httpStatusOf } from "../../src/web/server.js";
import { fixture, json, timeoutError } from "../helpers.js";
import { V1_ROUTES, V2_ROUTES } from "../routes.js";
import { assetId, bookBody, gammaRecord, scanRoutes, type MarketSpec } from "../scanFixtures.js";
import { closeAllWeb, get, startWeb, WEB_CONFIG, WEB_NOW, type HttpReply } from "../webFixtures.js";

// Stage 3.1 local web API: real node:http server on an ephemeral 127.0.0.1 port, fake upstream fetch.

afterEach(closeAllWeb);

const KEYSET_V1 = { "/markets/keyset": json(fixture("gamma/keyset-v1.json")) };
const page = (records: Record<string, unknown>[], next: string | null = null) => json({ markets: records, next_cursor: next });
const errorOf = (r: HttpReply) => WebErrorOutput.parse(r.json()).error;

/** Inspection routes for one synthetic market with chosen books (scanRoutes covers CLOB; add the Gamma record). */
function marketRoutes(spec: MarketSpec) {
  return { ...scanRoutes([[spec]]), [`/markets/${spec.id}`]: json(gammaRecord(spec)) };
}

/** A fetch that answers only when released (or fails when its signal aborts), to hold a call in flight. */
function heldFetch(answer: () => Response = () => json(fixture("gamma/keyset-v1.json"))) {
  const started: AbortSignal[] = [];
  const waiting: (() => void)[] = [];
  const fetch: FetchFn = (_url, init) =>
    new Promise((resolve, reject) => {
      started.push(init.signal!);
      waiting.push(() => resolve(answer()));
      init.signal?.addEventListener("abort", () => reject(new MarketMindError("Cancelled", "aborted")));
    });
  return { fetch, started, releaseAll: () => waiting.splice(0).forEach((go) => go()) };
}

const until = async (condition: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("GET /api/status", () => {
  it("returns version, limits and remaining budget with security headers and no CORS", async () => {
    const s = await startWeb();
    const r = await s.get("/api/status");
    expect(r.status).toBe(200);
    const body = WebStatusOutput.parse(r.json());
    expect(body).toMatchObject({
      contract: WEB_CONTRACT.status,
      generatedAt: WEB_NOW.toISOString(),
      readOnly: true,
      limits: { list: { pageSize: 50, maxAttempts: 2, deadlineMs: 10_000 }, inspect: { maxAttempts: 8, deadlineMs: 20_000 }, rateLimitCooldownMs: 60_000 },
      budget: { process: { limit: 100, used: 0, remaining: 100 }, window: { limit: 60, windowMs: 300_000, used: 0, remaining: 60 } },
      rateLimit: { coolingDown: false, retryAfterMs: 0 },
    });
    expect(r.headers).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    });
    expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    expect(r.text).not.toMatch(/sqlite|MARKETMIND|[A-Za-z]:\\|\/Users\/|\/home\//);
    expect(s.urls).toEqual([]);
  });
});

describe("GET /api/markets", () => {
  it("lists one V1 page with one upstream GET", async () => {
    const s = await startWeb({ routes: KEYSET_V1 });
    const r = await s.get("/api/markets");
    expect(r.status).toBe(200);
    const body = MarketsOutput.parse(r.json());
    expect(body).toMatchObject({ status: "ok", appliedLimits: { version: "v1", pageSize: 50, maxAttempts: 2 }, budget: { call: { used: 1, limit: 2 }, window: { used: 1 } } });
    expect(body.markets.items.map((m) => m.gammaId)).toEqual(["100001", "100002"]);
    expect(s.urls).toHaveLength(1);
    expect(new URL(s.urls[0]!).searchParams.get("version")).toBe("v1");
  });

  it("lists V2 when asked", async () => {
    const s = await startWeb({ routes: { "/markets/keyset": json(fixture("gamma/keyset-v2.json")) } });
    const body = MarketsOutput.parse((await s.get("/api/markets?version=v2")).json());
    expect(body.appliedLimits.version).toBe("v2");
    expect(new URL(s.urls[0]!).searchParams.get("version")).toBe("v2");
  });

  it("round-trips an opaque cursor, encoded only as the after_cursor value", async () => {
    const opaque = "a&b=c/d?e#f %2F";
    const s = await startWeb({ routes: { after_cursor: page([gammaRecord({ id: "2" })]), "/markets/keyset": page([gammaRecord({ id: "1" })], opaque) } });
    const first = MarketsOutput.parse((await s.get("/api/markets")).json());
    expect(first.pagination).toEqual({ nextCursor: opaque, stoppedReason: null });
    const second = MarketsOutput.parse((await s.get(`/api/markets?cursor=${encodeURIComponent(first.pagination.nextCursor!)}`)).json());
    expect(second.query.cursor).toBe(opaque);
    expect(second.markets.items.map((m) => m.gammaId)).toEqual(["2"]);
    const upstream = new URL(s.urls[1]!);
    expect(upstream.origin + upstream.pathname).toBe("https://gamma.example/markets/keyset");
    expect(upstream.searchParams.get("after_cursor")).toBe(opaque);
    expect(upstream.searchParams.getAll("closed")).toEqual(["false"]);
  });

  it("reports an empty page", async () => {
    const s = await startWeb({ routes: { "/markets/keyset": page([]) } });
    const r = await s.get("/api/markets");
    expect(r.status).toBe(200);
    expect(MarketsOutput.parse(r.json())).toMatchObject({ status: "empty", markets: { returnedCount: 0 }, pagination: { stoppedReason: "LAST_PAGE" } });
  });
});

describe("GET /api/markets/:id/inspect", () => {
  it("inspects a V1 market: pairing, both books, metrics and provenance", async () => {
    const s = await startWeb({ routes: V1_ROUTES });
    const r = await s.get("/api/markets/100001/inspect?levels=2&depthBand=0.05");
    expect(r.status).toBe(200);
    const body = InspectOutput.parse(r.json());
    expect(body).toMatchObject({ status: "ok", market: { gammaId: "100001", protocolVersion: "v1" }, appliedLimits: { levels: 2, depthBand: "0.05", maxAttempts: 8 } });
    expect(body.outcomes.map((o) => o.role)).toEqual(["YES", "NO"]);
    expect(body.outcomes.every((o) => o.metrics !== null && o.levels.returnedPerSide <= 2)).toBe(true);
    expect(body.requests).toHaveLength(4);
    expect(body.budget.call).toEqual({ used: 4, limit: 8 });
    expect(s.urls).toHaveLength(4);
  });

  it("inspects a V2 market with one empty book, and accepts depthBand=none", async () => {
    const s = await startWeb({ routes: V2_ROUTES });
    const body = InspectOutput.parse((await s.get("/api/markets/200002/inspect?depthBand=none")).json());
    expect(body).toMatchObject({ status: "ok", market: { protocolVersion: "v2" }, appliedLimits: { levels: 5, depthBand: null } });
    expect(body.outcomes.map((o) => o.metrics?.state)).toContain("empty");
  });

  it("returns empty and one-sided books as valid evidence", async () => {
    const spec: MarketSpec = { id: "81", book: { bids: [], asks: [] }, other: { bids: [["0.40", "10"]], asks: [] } };
    const s = await startWeb({ routes: marketRoutes(spec) });
    const r = await s.get("/api/markets/81/inspect");
    expect(r.status).toBe(200);
    const body = InspectOutput.parse(r.json());
    expect(body.outcomes.map((o) => o.metrics?.state)).toEqual(["empty", "bid-only"]);
  });

  it("returns an invalid book as status invalid_book with its evidence", async () => {
    const spec = { id: "78" };
    const routes = { ...marketRoutes(spec), [`token_id=${assetId("78", 1)}`]: json(bookBody(spec, 1, { bids: [["abc", "1"]], asks: [] })) };
    const s = await startWeb({ routes });
    const r = await s.get("/api/markets/78/inspect");
    expect(r.status).toBe(200);
    expect(InspectOutput.parse(r.json())).toMatchObject({ status: "invalid_book" });
  });

  it.each([
    ["404", json({ error: "not found" }, 404)],
    ["422", json({ error: "id is invalid" }, 422)],
  ])("maps an unknown market (upstream %s) to 404 market_not_found", async (_name, reply) => {
    const s = await startWeb({ routes: { "/markets/555": reply } });
    const r = await s.get("/api/markets/555/inspect");
    expect(r.status).toBe(404);
    expect(errorOf(r)).toMatchObject({ category: "market_not_found", retryable: false });
  });

  it("refuses an ineligible market with 422 after one request", async () => {
    const s = await startWeb({ routes: { "/markets/77": json(gammaRecord({ id: "77", gamma: { enableOrderBook: false } })) } });
    const r = await s.get("/api/markets/77/inspect");
    expect(r.status).toBe(422);
    expect(errorOf(r).category).toBe("market_ineligible");
    expect(s.urls).toHaveLength(1);
  });
});

describe("malformed requests and methods", () => {
  it.each([
    "/api/markets?version=v3",
    "/api/markets?limit=1000",
    "/api/markets?version=v1&version=v2",
    "/api/markets?cursor=",
    `/api/markets?cursor=${"x".repeat(513)}`,
    "/api/markets?cursor=a%00b",
    "/api/markets?url=https://evil.example",
    "/api/markets/abc/inspect",
    "/api/markets/100001/inspect?levels=99",
    "/api/markets/100001/inspect?levels=-1",
    "/api/markets/100001/inspect?levels=1.5",
    "/api/markets/100001/inspect?depthBand=2",
    "/api/markets/100001/inspect?constructor=1",
    "/api/status?debug=1",
  ])("400 for %s, with no upstream request", async (path) => {
    const s = await startWeb({ routes: { ...KEYSET_V1, ...V1_ROUTES } });
    const r = await s.get(path);
    expect(r.status).toBe(400);
    expect(errorOf(r)).toMatchObject({ category: "invalid_arguments", retryable: false });
    expect(s.urls).toEqual([]);
  });

  it("refuses an over-long URL", async () => {
    const s = await startWeb();
    const r = await s.get(`/api/markets?cursor=${"x".repeat(3_000)}`);
    expect(r.status).toBe(400);
    expect(errorOf(r).code).toBe("URL_TOO_LONG");
  });

  it.each(["/api", "/api/", "/api/markets/", "/api/markets/1/inspect/", "/api/runs", "/api/markets/1/history", "/api/collect"])("404 for unknown route %s", async (path) => {
    const s = await startWeb();
    const r = await s.get(path);
    expect(r.status).toBe(404);
    expect(errorOf(r)).toMatchObject({ category: "route_not_found" });
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "TRACE"])("405 for %s, with no upstream request and no CORS", async (method) => {
    const s = await startWeb({ routes: KEYSET_V1 });
    const r = await s.get("/api/markets", { method });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("GET");
    expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    if (method !== "HEAD") expect(errorOf(r).category).toBe("method_not_allowed");
    expect(s.urls).toEqual([]);
  });

  it.each([{ "content-length": "2" }, { "transfer-encoding": "chunked" }])("refuses a GET with a body (%j)", async (framing) => {
    const s = await startWeb({ routes: KEYSET_V1 });
    const r = await s.get("/api/markets", { body: "{}", headers: { "content-type": "application/json", ...framing } });
    expect(r.status).toBe(400);
    expect(errorOf(r).code).toBe("BODY_NOT_ALLOWED");
    expect(s.urls).toEqual([]);
  });
});

describe("request origin checks (all before any upstream request)", () => {
  const forbidden = async (headers: Record<string, string>, path = "/api/markets") => {
    const s = await startWeb({ routes: { ...KEYSET_V1, ...V1_ROUTES } });
    const r = await s.get(path, { headers });
    expect(r.status, JSON.stringify(headers)).toBe(403);
    expect(errorOf(r).category).toBe("forbidden");
    expect(s.urls).toEqual([]);
    return errorOf(r).code;
  };

  it("rejects a foreign or wrong-port Host (DNS rebinding)", async () => {
    expect(await forbidden({ host: "evil.example" })).toBe("HOST_NOT_ALLOWED");
    expect(await forbidden({ host: "evil.example:4317" })).toBe("HOST_NOT_ALLOWED");
    expect(await forbidden({ host: "127.0.0.1:1" }, "/api/markets/100001/inspect")).toBe("HOST_NOT_ALLOWED");
    expect(await forbidden({ host: "0.0.0.0" }, "/")).toBe("HOST_NOT_ALLOWED");
  });

  it("rejects foreign and opaque Origins", async () => {
    for (const origin of ["https://evil.example", "null", "http://127.0.0.1.evil.example", "http://localhost:5173"]) {
      expect(await forbidden({ origin })).toBe("ORIGIN_NOT_ALLOWED");
    }
  });

  it("rejects cross-site Fetch Metadata, and same-site without an allowed Origin", async () => {
    expect(await forbidden({ "sec-fetch-site": "cross-site" })).toBe("CROSS_SITE_REQUEST");
    expect(await forbidden({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).toBe("CROSS_SITE_REQUEST");
    expect(await forbidden({ "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" }, "/api/markets/100001/inspect")).toBe("CROSS_SITE_REQUEST");
  });

  it("accepts same-origin browser requests on either loopback name", async () => {
    const s = await startWeb({ routes: KEYSET_V1 });
    for (const host of ["127.0.0.1", "localhost"]) {
      const headers = { host: `${host}:${s.port}`, origin: `http://${host}:${s.port}`, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
      expect((await s.get("/api/markets", { headers })).status).toBe(200);
    }
    expect((await s.get("/api/status", { headers: { "sec-fetch-site": "none" } })).status).toBe(200);
  });

  it("accepts a configured local dev proxy origin, and only that one", async () => {
    const s = await startWeb({ routes: KEYSET_V1, devOrigins: ["http://localhost:5173"] });
    // Vite's proxy forwards the browser's Host and Origin unchanged unless changeOrigin is set.
    const viaProxy = { host: "localhost:5173", origin: "http://localhost:5173", "sec-fetch-site": "same-origin" };
    expect((await s.get("/api/markets", { headers: viaProxy })).status).toBe(200);
    const changeOrigin = { host: `127.0.0.1:${s.port}`, origin: "http://localhost:5173", "sec-fetch-site": "same-origin" };
    expect((await s.get("/api/markets", { headers: changeOrigin })).status).toBe(200);
    const other = await s.get("/api/markets", { headers: { host: "localhost:5174", origin: "http://localhost:5174" } });
    expect(other.status).toBe(403);
    expect(s.urls).toHaveLength(2);
  });

  it("rejects absolute-form and protocol-relative request targets", async () => {
    const s = await startWeb({ routes: KEYSET_V1 });
    for (const path of ["http://evil.example/api/markets", "//evil.example/api/markets"]) {
      const r = await s.get(path);
      expect(r.status, path).toBe(400);
    }
    expect(s.urls).toEqual([]);
  });
});

describe("errors never leak internals", () => {
  it("an unexpected failure is a generic 500; the stack goes to the log only", async () => {
    const gate: CooldownGate = {
      process: { limit: 1, used: 0, remaining: 1 },
      window: null,
      cooldownRemainingMs: 0,
      run: () => Promise.reject(new TypeError("boom reading C:\\Users\\someone\\secret.sqlite with MARKETMIND_DB=x")),
    };
    const logs: string[] = [];
    const web = createWebServer({ gate, config: WEB_CONFIG, devOrigins: [], staticRoot: null, now: () => WEB_NOW, log: (l) => logs.push(l) });
    const port = await web.listen(0);
    try {
      const r = await get(port, "/api/markets");
      expect(r.status).toBe(500);
      expect(errorOf(r)).toEqual({ category: "internal_error", code: null, message: "Internal error in the MarketMind web server; see its stderr log.", retryable: false, details: {} });
      expect(r.text).not.toMatch(/Users|secret|MARKETMIND_DB|boom|at /);
      expect(logs.join("\n")).toContain("TypeError: boom");
    } finally {
      await web.close();
    }
  });

  it("redacts local paths in upstream error text", async () => {
    const s = await startWeb({ routes: { "/markets/keyset": json({ error: "failed at C:\\Users\\someone\\x.ts and /home/someone/y" }, 418) } });
    const r = await s.get("/api/markets");
    expect(r.status).toBe(502);
    expect(r.text).not.toMatch(/someone/);
  });

  it("logs one line per request without query strings or cursors", async () => {
    const s = await startWeb({ routes: KEYSET_V1 });
    await s.get("/api/markets?cursor=secret-cursor-value");
    await s.get("/api/nope?x=1");
    expect(s.logs.some((l) => /^GET markets 200 \d+ ms$/.test(l))).toBe(true);
    expect(s.logs.some((l) => /^GET - 404 \d+ ms$/.test(l))).toBe(true);
    expect(s.logs.join("\n")).not.toContain("secret-cursor-value");
  });
});

describe("budgets and upstream failures", () => {
  it("a listing makes at most two physical attempts, retries included", async () => {
    const s = await startWeb({ routes: { "/markets/keyset": json({ error: "down" }, 503) } });
    const r = await s.get("/api/markets");
    expect(r.status).toBe(502);
    expect(errorOf(r)).toMatchObject({ category: "upstream_unavailable", retryable: true, details: { kind: "Upstream5xx", attempts: 2 } });
    expect(s.urls).toHaveLength(2);
    expect(s.gate.process.used).toBe(2);
  });

  it("an inspection makes at most eight physical attempts, retries included", async () => {
    const s = await startWeb({ routes: { token_id: json({ error: "down" }, 503), ...V1_ROUTES, "/clob-markets/": [json({ error: "down" }, 503), json(fixture("clob/v1-market-info.json"))] } });
    const r = await s.get("/api/markets/100001/inspect");
    expect(r.status).toBe(502);
    expect(s.urls.length).toBeLessThanOrEqual(8);
    expect(s.gate.process.used).toBe(s.urls.length);
    expect(s.gate.window).toMatchObject({ used: s.urls.length, remaining: 60 - s.urls.length });
  });

  it("maps upstream timeouts to 504", async () => {
    const s = await startWeb({ routes: { "/markets/keyset": timeoutError() } });
    const r = await s.get("/api/markets");
    expect(r.status).toBe(504);
    expect(errorOf(r)).toMatchObject({ category: "upstream_unavailable", details: { kind: "Timeout", attempts: 2 } });
  });

  it("refuses with 429 and an exact Retry-After when the rolling window is spent, and recovers", async () => {
    const s = await startWeb({ routes: V1_ROUTES, window: { limit: 10, windowMs: 300_000 } });
    expect((await s.get("/api/markets/100001/inspect")).status).toBe(200); // 4 attempts charged
    const r = await s.get("/api/markets/100001/inspect"); // needs 8, 6 left
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("300");
    expect(errorOf(r)).toMatchObject({ category: "budget_exhausted", code: "WINDOW_BUDGET_EXHAUSTED", retryable: true, details: { attempts: 0, retryAfterMs: 300_000 } });
    expect(s.urls).toHaveLength(4);
    s.advance(300_000);
    expect((await s.get("/api/markets/100001/inspect")).status).toBe(200);
    expect(s.urls).toHaveLength(8);
  });

  it("refuses with 503 and no retry when the lifetime ceiling is spent", async () => {
    const s = await startWeb({ routes: { ...KEYSET_V1, ...V1_ROUTES }, processLimit: 5 });
    expect((await s.get("/api/markets")).status).toBe(200);
    const r = await s.get("/api/markets/100001/inspect");
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBeUndefined();
    expect(errorOf(r)).toMatchObject({ category: "budget_exhausted", code: "PROCESS_BUDGET_EXHAUSTED", retryable: false });
    expect(s.urls).toHaveLength(1);
  });

  it("an upstream 429 starts a 60 s local cooldown: later requests never reach Polymarket", async () => {
    const s = await startWeb({ routes: { "/markets/keyset": json({ error: "slow down" }, 429), ...V1_ROUTES } });
    const first = await s.get("/api/markets");
    expect(first.status).toBe(503);
    expect(first.headers["retry-after"]).toBe("60");
    expect(errorOf(first)).toMatchObject({ category: "rate_limited", code: null, retryable: true, details: { retryAfterMs: 60_000 } });
    const sent = s.urls.length;
    expect(sent).toBeLessThanOrEqual(2);

    s.advance(15_000);
    for (const path of ["/api/markets", "/api/markets/100001/inspect"]) {
      const r = await s.get(path);
      expect(r.status).toBe(503);
      expect(r.headers["retry-after"]).toBe("45");
      expect(errorOf(r)).toMatchObject({ category: "rate_limited", code: "LOCAL_COOLDOWN", details: { attempts: 0, retryAfterMs: 45_000 } });
    }
    expect(s.urls).toHaveLength(sent);
    expect(WebStatusOutput.parse((await s.get("/api/status")).json()).rateLimit).toEqual({ coolingDown: true, retryAfterMs: 45_000 });
    expect(s.gate.window).toMatchObject({ used: sent, remaining: 60 - sent });

    s.advance(45_000);
    expect((await s.get("/api/markets/100001/inspect")).status).toBe(200);
    expect(s.urls).toHaveLength(sent + 4);
  });

  it("a call queued behind the one that hit 429 is refused without a request", async () => {
    const held = heldFetch(() => json({ error: "slow down" }, 429));
    const s = await startWeb({ fetch: held.fetch });
    const first = s.get("/api/markets");
    await until(() => held.started.length === 1);
    const second = s.get("/api/markets/100001/inspect");
    await new Promise((r) => setTimeout(r, 20));
    held.releaseAll();
    await until(() => held.started.length === 2); // the listing's one retry
    held.releaseAll();
    expect((await first).status).toBe(503);
    const r = await second;
    expect(errorOf(r)).toMatchObject({ category: "rate_limited", code: "LOCAL_COOLDOWN" });
    expect(s.urls).toHaveLength(2);
  });

  it("serializes concurrent requests: one upstream call at a time, all answered", async () => {
    let active = 0;
    let peak = 0;
    const fetch: FetchFn = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return json(fixture("gamma/keyset-v1.json"));
    };
    const s = await startWeb({ fetch });
    const replies = await Promise.all(Array.from({ length: 6 }, () => s.get("/api/markets")));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(peak).toBe(1);
    expect(s.gate.window).toMatchObject({ used: 6, remaining: 54 });
  });
});

describe("cancellation", () => {
  it("does not abort a normal GET: the request stream closing is not a disconnect", async () => {
    const signals: AbortSignal[] = [];
    const fetch: FetchFn = async (_url, init) => {
      signals.push(init.signal!);
      await new Promise((r) => setTimeout(r, 50)); // long after the GET request stream has closed
      return json(fixture("gamma/keyset-v1.json"));
    };
    const s = await startWeb({ fetch });
    const r = await s.get("/api/markets");
    expect(r.status).toBe(200);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
  });

  it("a browser disconnect in flight aborts the upstream request and releases the unused reservation", async () => {
    const held = heldFetch();
    const s = await startWeb({ fetch: held.fetch });
    const client = new AbortController();
    const pending = s.get("/api/markets/100001/inspect", { signal: client.signal }).catch((e: unknown) => e);
    await until(() => held.started.length === 1);
    expect(s.gate.window).toMatchObject({ used: 1, remaining: 52 });
    client.abort();
    await pending;
    await until(() => held.started[0]!.aborted && s.logs.some((l) => l.startsWith("GET inspect closed")));
    expect(s.gate.window).toMatchObject({ used: 1, remaining: 59 });
    expect(s.gate.process).toEqual({ limit: 100, used: 1, remaining: 99 });
  });

  it("a browser disconnect while queued leaves without spending or holding budget", async () => {
    const held = heldFetch();
    const s = await startWeb({ fetch: held.fetch });
    const first = s.get("/api/markets");
    await until(() => held.started.length === 1);
    const client = new AbortController();
    const queued = s.get("/api/markets/100001/inspect", { signal: client.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));
    client.abort();
    await queued;
    await until(() => s.logs.some((l) => l.startsWith("GET inspect closed")));
    held.releaseAll();
    expect((await first).status).toBe(200);
    expect(held.started).toHaveLength(1);
    expect(s.gate.window).toMatchObject({ used: 1, remaining: 59 });
    expect(s.gate.process).toEqual({ limit: 100, used: 1, remaining: 99 });
  });

  it("shutdown cancels in-flight and queued calls, answers them 503 and leaks no reservation", async () => {
    const held = heldFetch();
    const s = await startWeb({ fetch: held.fetch });
    const inFlight = s.get("/api/markets/100001/inspect");
    await until(() => held.started.length === 1);
    const queued = s.get("/api/markets");
    await new Promise((r) => setTimeout(r, 20));
    await s.web.close();
    for (const r of [await inFlight, await queued]) {
      expect(r.status).toBe(503);
      expect(errorOf(r)).toMatchObject({ category: "cancelled", code: "SHUTTING_DOWN" });
    }
    expect(held.started[0]!.aborted).toBe(true);
    expect(held.started).toHaveLength(1);
    expect(s.gate.window).toMatchObject({ used: 1, remaining: 59 });
    expect(s.gate.process).toEqual({ limit: 100, used: 1, remaining: 99 });
  });
});

describe("httpStatusOf", () => {
  it("gives every failure class a distinct, appropriate status", () => {
    const e = (category: string, code: string | null = null, details: Record<string, unknown> = {}) =>
      httpStatusOf(WebErrorOutput.shape.error.parse({ category, code, message: "", retryable: false, details }));
    expect(e("budget_exhausted", "WINDOW_BUDGET_EXHAUSTED")).toBe(429);
    expect(e("budget_exhausted", "PROCESS_BUDGET_EXHAUSTED")).toBe(503);
    expect(e("rate_limited")).toBe(503);
    expect(e("upstream_unavailable", null, { kind: "Upstream5xx" })).toBe(502);
    expect(e("upstream_unavailable", null, { kind: "Timeout" })).toBe(504);
    expect(e("upstream_invalid_data")).toBe(502);
    expect(e("deadline_exceeded", "DEADLINE")).toBe(504);
    expect(e("invalid_arguments")).toBe(400);
    expect(e("internal_error")).toBe(500);
    expect(e("storage_error")).toBe(500);
  });
});
