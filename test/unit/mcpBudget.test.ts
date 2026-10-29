import { afterEach, describe, expect, it } from "vitest";
import type { FetchFn } from "../../src/adapters/polymarket/httpClient.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { CONTRACT, MCP_LIMITS } from "../../src/mcp/contracts.js";
import { createLiveGate } from "../../src/mcp/liveBudget.js";
import { categoryOf, describeError, failure, fitted, success, untrusted } from "../../src/mcp/results.js";
import { mcpSettings } from "../../src/mcp/server.js";
import { json, testDeps } from "../helpers.js";
import { V1_ROUTES } from "../routes.js";
import { scanRoutes } from "../scanFixtures.js";
import { call, connect, errorOf, ok, type Connected } from "../mcpFixtures.js";

const open: Connected[] = [];
async function server(options: Parameters<typeof connect>[0] = {}) {
  const c = await connect(options);
  open.push(c);
  return c;
}
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

const never: FetchFn = (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason as Error)));

/** Counts every physical fetch the HTTP layer makes (the gate wraps inside this). */
function counting(inner?: FetchFn) {
  const urls: string[] = [];
  const wrap = (fake: FetchFn): FetchFn => (url, init) => {
    urls.push(url);
    return (inner ?? fake)(url, init);
  };
  return { urls, wrap };
}

describe("process-wide live request ceiling", () => {
  it("normal completion charges actual attempts and returns the unused reservation", async () => {
    const n = counting();
    const c = await server({ routes: scanRoutes([[{ id: "91" }]]), wrap: n.wrap });
    const v = ok(await call(c, "scan_markets", { maxMarkets: 1, maxRequests: 16 }));
    expect(n.urls).toHaveLength(4);
    expect(v.budget).toEqual({ call: { limit: 16, used: 4 }, process: { limit: 200, used: 4, remaining: 196 } });
    expect(c.gate.process).toEqual({ limit: 200, used: 4, remaining: 196 });
  });

  it("a failure after some attempts still charges every attempt, retries included", async () => {
    const n = counting();
    const c = await server({ routes: { "token_id=": json({ error: "down" }, 500), ...V1_ROUTES }, wrap: n.wrap });
    const e = errorOf(await call(c, "inspect_market", { marketId: "100001" }));
    expect(e.category).toBe("upstream_unavailable");
    // market + association + 2 books x (1 + 1 retry)
    expect(n.urls).toHaveLength(6);
    expect(c.gate.process).toEqual({ limit: 200, used: 6, remaining: 194 });
  });

  it("cancellation during an active request charges the attempts made and releases the rest", async () => {
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const urls: string[] = [];
    const blocking = await server({
      routes: V1_ROUTES,
      wrap: (fake) => (url, init) => {
        urls.push(url);
        if (url.includes("/clob-markets/")) {
          started();
          return never(url, init);
        }
        return fake(url, init);
      },
    });
    const user = new AbortController();
    const pending = call(blocking, "inspect_market", { marketId: "100001" }, { signal: user.signal });
    await inFlight;
    user.abort(new Error("user"));
    await expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(urls).toHaveLength(2);
    expect(blocking.gate.process).toEqual({ limit: 200, used: 2, remaining: 198 });
  });

  it("a call cancelled while queued sends nothing and holds no reservation", async () => {
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    const urls: string[] = [];
    const c = await server({
      routes: V1_ROUTES,
      wrap: (fake) => async (url, init) => {
        urls.push(url);
        if (url.includes("/markets/100001") && urls.length === 1) {
          started();
          await gateOpen;
        }
        return fake(url, init);
      },
    });
    const first = call(c, "inspect_market", { marketId: "100001" });
    await inFlight;
    const queued = new AbortController();
    const second = call(c, "inspect_market", { marketId: "100001" }, { signal: queued.signal });
    await new Promise((r) => setTimeout(r, 10));
    // Only the first call holds a reservation (8) while the second waits.
    expect(c.gate.process).toEqual({ limit: 200, used: 1, remaining: 192 });
    queued.abort(new Error("changed my mind"));
    await expect(second).rejects.toThrow();
    release();
    ok(await first);
    expect(urls).toHaveLength(4);
    expect(c.gate.process).toEqual({ limit: 200, used: 4, remaining: 196 });
  });

  it("sequential failing calls approach the ceiling, then are refused before any request", async () => {
    const urls: string[] = [];
    const c = await server({
      processLimit: 20,
      routes: { "/markets/100001": json({ error: "down" }, 503) },
      wrap: (fake) => (url, init) => {
        urls.push(url);
        return fake(url, init);
      },
    });
    const categories: string[] = [];
    for (let i = 0; i < 9; i++) categories.push(errorOf(await call(c, "inspect_market", { marketId: "100001" })).category);
    // Each failing call makes 2 attempts (1 + 1 retry) but needs an 8-attempt reservation to start.
    expect(categories.slice(0, 7)).toEqual(Array(7).fill("upstream_unavailable"));
    expect(categories.slice(7)).toEqual(["budget_exhausted", "budget_exhausted"]);
    expect(urls).toHaveLength(14);
    expect(c.gate.process).toEqual({ limit: 20, used: 14, remaining: 6 });
  });

  it("after exhaustion no physical attempt is made by any live tool", async () => {
    const urls: string[] = [];
    const c = await server({
      processLimit: 4,
      routes: scanRoutes([[{ id: "91" }]]),
      wrap: (fake) => (url, init) => {
        urls.push(url);
        return fake(url, init);
      },
    });
    ok(await call(c, "scan_markets", { maxMarkets: 1, maxRequests: 4 }));
    expect(urls).toHaveLength(4);
    const scan = errorOf(await call(c, "scan_markets", { maxMarkets: 1, maxRequests: 1 }));
    const inspect = errorOf(await call(c, "inspect_market", { marketId: "91" }));
    expect([scan.category, scan.code, inspect.category]).toEqual(["budget_exhausted", "PROCESS_BUDGET_EXHAUSTED", "budget_exhausted"]);
    expect(urls).toHaveLength(4);
  });

  it("the per-call budget caps a scan below the process ceiling", async () => {
    const c = await server({ routes: scanRoutes([[{ id: "91" }, { id: "92" }]]) });
    const v = ok(await call(c, "scan_markets", { maxMarkets: 2, maxRequests: 4 }));
    expect(v.budget.call).toEqual({ limit: 4, used: 4 });
    expect(v.stopReasons).toContain("BUDGET_EXHAUSTED");
    expect(v.status).toBe("partial");
  });
});

describe("createLiveGate", () => {
  const http = testDeps(() => Promise.resolve(json({}))).deps;

  it("refuses an already-cancelled call before reserving anything", async () => {
    const gate = createLiveGate(http, 10);
    const ac = new AbortController();
    ac.abort(new Error("x"));
    await expect(gate.run(5, ac.signal, () => Promise.resolve(1))).rejects.toMatchObject({ kind: "Cancelled", details: { code: "CANCELLED_WHILE_QUEUED", attempts: 0 } });
    expect(gate.process).toEqual({ limit: 10, used: 0, remaining: 10 });
  });

  it("conservatively charges the whole reservation after an unexpected (non-MarketMind) failure", async () => {
    const gate = createLiveGate(http, 10);
    await expect(gate.run(5, new AbortController().signal, () => Promise.reject(new TypeError("bug")))).rejects.toThrow("bug");
    expect(gate.process).toEqual({ limit: 10, used: 5, remaining: 5 });
  });

  it("charges exactly the attempts made when a MarketMind error is thrown", async () => {
    const gate = createLiveGate(http, 10);
    await expect(
      gate.run(5, new AbortController().signal, async (h) => {
        await h.fetch("https://clob.example/book", {});
        throw new MarketMindError("Upstream5xx", "down");
      }),
    ).rejects.toMatchObject({ kind: "Upstream5xx" });
    expect(gate.process).toEqual({ limit: 10, used: 1, remaining: 9 });
  });

  it("fails closed if a call tries to exceed its reservation", async () => {
    const gate = createLiveGate(http, 10);
    await expect(
      gate.run(1, new AbortController().signal, async (h, usage) => {
        await h.fetch("https://a.example", {});
        await h.fetch("https://a.example", {}).catch((e: unknown) => {
          throw e;
        });
        return usage;
      }),
    ).rejects.toMatchObject({ kind: "BudgetExceeded", details: { code: "RESERVATION_EXHAUSTED" } });
    expect(gate.process.used).toBe(1);
  });

  it("serializes calls: a waiter cancelled mid-queue never lets a later call overtake the running one", async () => {
    const gate = createLiveGate(http, 100);
    const order: string[] = [];
    let finishA!: () => void;
    const a = gate.run(1, new AbortController().signal, () => new Promise<void>((r) => (finishA = r)).then(() => void order.push("a")));
    const bSignal = new AbortController();
    const b = gate.run(1, bSignal.signal, () => Promise.resolve(void order.push("b")));
    const c = gate.run(1, new AbortController().signal, () => Promise.resolve(void order.push("c")));
    await new Promise((r) => setTimeout(r, 5));
    bSignal.abort(new Error("cancel b"));
    await expect(b).rejects.toMatchObject({ kind: "Cancelled" });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);
    finishA();
    await a;
    await c;
    expect(order).toEqual(["a", "c"]);
  });
});

describe("results: errors, sanitizing and size", () => {
  it.each([
    [new MarketMindError("Usage", "bad"), "invalid_arguments", false],
    [new MarketMindError("NotFound", "x", { code: "DATABASE_MISSING" }), "database_missing", false],
    [new MarketMindError("NotFound", "x", { code: "OBSERVATION_NOT_FOUND" }), "observation_not_found", false],
    [new MarketMindError("NotFound", "x", { code: "OBSERVATION_NOT_AVAILABLE_AS_OF" }), "observation_not_available_as_of", false],
    [new MarketMindError("NotFound", "x", { status: 404 }), "market_not_found", false],
    [new MarketMindError("Ineligible", "x"), "market_ineligible", false],
    [new MarketMindError("Network", "x"), "upstream_unavailable", true],
    [new MarketMindError("HttpStatus", "x", { status: 418 }), "upstream_unavailable", true],
    [new MarketMindError("RateLimited", "x"), "rate_limited", true],
    [new MarketMindError("Validation", "x"), "upstream_invalid_data", false],
    [new MarketMindError("InvalidBook", "x"), "upstream_invalid_data", false],
    [new MarketMindError("BudgetExceeded", "x"), "budget_exhausted", false],
    [new MarketMindError("Cancelled", "x"), "cancelled", false],
    [new MarketMindError("Cancelled", "x", { code: "DEADLINE" }), "deadline_exceeded", true],
    [new MarketMindError("Storage", "x", { code: "DATABASE_BUSY" }), "storage_error", true],
    [new MarketMindError("Storage", "x", { code: "SCHEMA_TOO_NEW" }), "storage_error", false],
    [new Error("boom"), "internal_error", false],
  ])("maps %s to %s (retryable %s)", (error, category, retryable) => {
    expect(describeError(error)).toMatchObject({ category, retryable });
  });

  it("never forwards local paths or storage error text", () => {
    const storage = describeError(new MarketMindError("Storage", "Cannot open database C:\\Users\\alice\\data\\x.sqlite", { code: "CANNOT_OPEN" }));
    expect(storage.message).toBe("Local database error (CANNOT_OPEN).");
    const usage = describeError(new MarketMindError("Usage", "bad file /home/alice/x and D:/secret/y and \\\\server\\share\\z", { issues: ["see /Users/bob/z"] }));
    expect(usage.message).toBe("bad file <path> and <path> and <path>");
    expect(usage.details.issues).toEqual(["see <path>"]);
    const upstream = describeError(new MarketMindError("Network", "fetch https://clob.polymarket.com/book?token_id=1 failed", { url: "https://clob.polymarket.com/book" }));
    expect(upstream.message).toContain("https://clob.polymarket.com/book?token_id=1");
  });

  it("internal errors log details to stderr only and return a generic message", () => {
    const lines: string[] = [];
    const r = failure(new TypeError("secret detail at C:\\x"), (l) => lines.push(l));
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(r)).not.toContain("secret detail");
    expect(lines[0]).toContain("secret detail");
    expect(JSON.parse((r.content[0] as { text: string }).text)).toMatchObject({ contract: CONTRACT.error, error: { category: "internal_error" } });
  });

  it("strips control and bidi characters and truncates deterministically", () => {
    expect(untrusted("a\u0000b\u202ec\nd", 100)).toBe("a b c d");
    const t = untrusted("x".repeat(500), 100);
    expect(t).toHaveLength(100);
    expect(t.endsWith(" [truncated]")).toBe(true);
    expect(untrusted("x".repeat(500), 100)).toBe(t);
  });

  it("fits results by shrinking caps, and fails safely when even the floor is too large", () => {
    const build = (n: number) => success({ contract: "c", items: Array.from({ length: n }, (_, i) => "x".repeat(100) + i) }, "s");
    const r = fitted<number>(64, build, (n) => (n > 0 ? Math.floor(n / 2) : null), 2_000);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(2_000);
    // 64 -> 32 -> 16: the first (largest) cap that fits; 32 items would exceed 2,000 characters.
    expect((r.structuredContent as { items: string[] }).items.length).toBe(16);
    expect(() => fitted(1, () => success({ contract: "c", blob: "y".repeat(5_000) }, "s"), () => null, 2_000)).toThrow(/size bound/);
  });

  it("categoryOf reads the category of an error result and is empty otherwise", () => {
    expect(categoryOf(failure(new MarketMindError("RateLimited", "x"), () => undefined))).toBe("rate_limited");
    expect(categoryOf({ content: [{ type: "text", text: "not json" }] })).toBe("");
    expect(categoryOf({ content: [] })).toBe("");
  });

  it("success text is a short fallback summary, not a copy of the payload", () => {
    const r = success({ contract: "c", big: "z".repeat(10_000) }, "summary line");
    expect((r.content[0] as { text: string }).text).toBe("summary line\nFull result: structuredContent (contract c).");
  });
});

describe("mcpSettings", () => {
  it("defaults the process ceiling and validates overrides", () => {
    expect(mcpSettings({}).processRequestLimit).toBe(MCP_LIMITS.processRequests.default);
    expect(mcpSettings({ MARKETMIND_MCP_MAX_REQUESTS: "12" }).processRequestLimit).toBe(12);
    for (const bad of ["0", "1001", "abc", "1.5"]) expect(() => mcpSettings({ MARKETMIND_MCP_MAX_REQUESTS: bad })).toThrow(/MARKETMIND_MCP_MAX_REQUESTS/);
    expect(mcpSettings({ MARKETMIND_DB: "x/y.sqlite" }).config).toMatchObject({ ...DEFAULT_CONFIG, dbPath: "x/y.sqlite" });
  });
});
