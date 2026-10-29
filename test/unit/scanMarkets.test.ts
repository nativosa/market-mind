import { describe, expect, it } from "vitest";
import type { FetchFn } from "../../src/adapters/polymarket/httpClient.js";
import { countScan, scanMarkets, type ScanOptions, type ScanResult } from "../../src/app/scanMarkets.js";
import { scanJson } from "../../src/cli/jsonView.js";
import { decimal } from "../../src/domain/decimal.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { fakeFetch, json, TEST_HTTP_OPTIONS, testDeps, type Reply } from "../helpers.js";
import { assetId, conditionId, gammaRecord as gamma, scanRoutes, type MarketSpec } from "../scanFixtures.js";

const GAMMA = "https://gamma.example";
const CLOB = "https://clob.example";

export const BASE_OPTIONS: ScanOptions = {
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

interface ScanSetup {
  wrap?: (inner: FetchFn) => FetchFn;
  signal?: AbortSignal;
  deadline?: AbortSignal;
  now?: () => Date;
}

async function scan(routes: Record<string, Reply | Reply[]>, overrides: Partial<ScanOptions> = {}, setup: ScanSetup = {}) {
  const fake = fakeFetch(routes);
  const urls: string[] = [];
  const inner = setup.wrap ? setup.wrap(fake.fetch) : fake.fetch;
  const fetch: FetchFn = (url, init) => {
    urls.push(url);
    return inner(url, init);
  };
  const options = { ...BASE_OPTIONS, ...overrides };
  const result = await scanMarkets(options, {
    http: testDeps(fetch, setup.now).deps,
    httpOptions: TEST_HTTP_OPTIONS,
    gammaBaseUrl: GAMMA,
    clobBaseUrl: CLOB,
    ...(setup.signal ? { signal: setup.signal } : {}),
    ...(setup.deadline ? { deadline: () => setup.deadline! } : {}),
  });
  assertAccounting(result);
  expect(urls.length).toBeLessThanOrEqual(options.maxRequests);
  expect(result.budget.used).toBe(urls.length);
  return { result, calls: fake.calls, urls };
}

const PRE_BOOK_EXCLUDED = new Set(["NOT_BINARY", "ORDER_BOOK_DISABLED", "NOT_ACTIVE", "CLOSED", "NOT_ACCEPTING_ORDERS", "STATUS_UNKNOWN"]);

/** The six accounting invariants from the plan, asserted for every scan. */
export function assertAccounting(result: ScanResult): void {
  const c = countScan(result);
  const e = result.entries;
  // 1. Every discovered record is in exactly one bucket.
  expect(c.discovered).toBe(c.rankedTotal + c.filtered + c.excluded + c.failed + c.notScanned);
  // 2. Eligible = discovered minus metadata failures and pre-book exclusions.
  const metadataFailed = e.filter((x) => x.bucket === "failed" && !x.selected).length;
  const preBook = e.filter((x) => x.bucket === "excluded" && !x.selected);
  expect(preBook.every((x) => x.reasons.every((r) => PRE_BOOK_EXCLUDED.has(r.code)))).toBe(true);
  expect(c.eligible).toBe(c.discovered - metadataFailed - preBook.length);
  // 3. Selection.
  expect(c.selected).toBe(Math.min(c.eligible, result.options.maxMarkets));
  expect(c.notScannedByReason.SAMPLE_LIMIT).toBe(c.eligible - c.selected);
  // 4. Every selected market ends in exactly one post-selection bucket.
  const sel = e.filter((x) => x.selected);
  const execStopped = sel.filter((x) => x.bucket === "notScanned" && x.reasons[0]!.code !== "SAMPLE_LIMIT").length;
  const selFailed = sel.filter((x) => x.bucket === "failed").length;
  const selExcluded = sel.filter((x) => x.bucket === "excluded").length;
  expect(c.selected).toBe(c.rankedTotal + c.filtered + selExcluded + selFailed + execStopped);
  // 5. Displayed ranking is a prefix of the full ranking.
  const view = scanJson(result);
  expect(view.ranked.map((r) => r.gammaId)).toEqual(result.ranked.slice(0, result.options.top).map((r) => r.gammaId));
  expect(view.rankedTotal).toBe(result.ranked.length);
  // 6. No market id appears twice.
  const ids = e.map((x) => x.gammaId).filter((id) => id !== null);
  expect(new Set(ids).size).toBe(ids.length);
  // Every non-ranked entry explains itself; every ranked one is fully measured.
  for (const x of e) {
    if (x.bucket === "ranked") {
      expect(x.reasons).toEqual([]);
      expect(x.metrics!.spread).not.toBeNull();
      expect(x.explanation.length).toBeGreaterThan(0);
    } else {
      expect(x.reasons.length).toBeGreaterThan(0);
    }
  }
  // Status follows the incomplete-execution rule.
  const incomplete = c.failed > 0 || c.notScanned - c.notScannedByReason.SAMPLE_LIMIT > 0 || result.stopReasons.length > 0;
  expect(result.status).toBe(incomplete ? "partial" : "complete");
}

const bucketOf = (r: ScanResult): Record<string, string> =>
  Object.fromEntries(r.entries.map((e) => [e.gammaId ?? "(no id)", [e.bucket, ...e.reasons.map((x) => x.code)].join(" ")]));

const V1_SCENARIO: MarketSpec[] = [
  { id: "11", volume24hr: 800, book: { bids: [["0.40", "100"]], asks: [["0.46", "100"]] } },
  { id: "12", volume24hr: 700, book: { bids: [["0.30", "50"]], asks: [["0.40", "60"]] } },
  { id: "13", volume24hr: 600, book: { bids: [["0.40", "200"]], asks: [["0.46", "300"]] } },
  { id: "14", volume24hr: 500, book: { bids: [], asks: [] } },
  { id: "15", volume24hr: 400, book: { bids: [["0.20", "2"]], asks: [["0.40", "2"]] } },
  { id: "16", volume24hr: 300, gamma: { acceptingOrders: false } },
  {
    id: "17",
    volume24hr: 200,
    replies: { association: json({ t: [{ t: assetId("17", 0), o: "No" }, { t: assetId("17", 1), o: "Yes" }] }) },
  },
  { id: "18", volume24hr: 100, book: { bids: [["0.4005", "100"]], asks: [["0.45", "100"]] } },
];

describe("scanMarkets: V1 end to end", () => {
  it("ranks, filters, excludes and fails with explicit reasons; displays the top N of rankedTotal", async () => {
    const { result, calls } = await scan(scanRoutes([V1_SCENARIO]), { top: 2 });

    expect(calls[0]!.url).toBe(`${GAMMA}/markets/keyset?closed=false&limit=50&version=v1&order=volume24hr&ascending=false`);
    expect(result.ranked.map((e) => e.gammaId)).toEqual(["12", "13", "11"]); // 0.10 > 0.06 (size 200 > 100)
    expect(scanJson(result).ranked.map((r) => [r.rank, r.gammaId])).toEqual([
      [1, "12"],
      [2, "13"],
    ]);
    expect(bucketOf(result)).toEqual({
      "11": "ranked",
      "12": "ranked",
      "13": "ranked",
      "14": "excluded EMPTY_BOOK",
      "15": "filtered TOP_SIZE_BELOW_MIN",
      "16": "excluded NOT_ACCEPTING_ORDERS",
      "17": "failed ASSOCIATION_MISMATCH",
      "18": "filtered SUSPICIOUS_BOOK",
    });
    expect(countScan(result)).toMatchObject({ discovered: 8, eligible: 7, selected: 7, rankedTotal: 3, filtered: 2, excluded: 2, failed: 1 });
    expect(result.status).toBe("partial"); // the association mismatch is a genuine failure
    expect(result.stopReasons).toEqual([]);
    expect(result.discovery).toMatchObject({ pages: 1, stoppedBecause: "NO_MORE_PAGES", duplicates: [], warnings: [] });

    // Reference outcome is explicit; metrics come from it.
    const top = result.ranked[0]!;
    expect(top.metrics!.reference).toEqual({ index: 0, label: "Yes", assetId: assetId("12", 0) });
    expect(top.explanation[1]).toBe("spread 0.1 >= min 0");

    // 1 page + 7 markets x (association + 2 books), except 17 stops after association.
    expect(calls).toHaveLength(1 + 6 * 3 + 1);
    // Requests are listed in deterministic scope order, each with its own timing.
    expect(result.requests.map((r) => r.scope).slice(0, 5)).toEqual([
      "discovery page 1",
      "market 11 association",
      "market 11 book Yes",
      "market 11 book No",
      "market 12 association",
    ]);
    expect(result.requests.every((r) => r.timing !== null && r.httpStatus === 200)).toBe(true);
    expect(result.window!.firstRequestStartedAt <= result.window!.lastResponseReceivedAt).toBe(true);
  });

  it("is complete (exit-0 semantics) when only the sampling limit leaves markets unscanned", async () => {
    const markets = ["21", "22", "23"].map((id) => ({ id }));
    const { result, calls } = await scan(scanRoutes([markets]), { maxMarkets: 2 });
    expect(result.status).toBe("complete");
    expect(bucketOf(result)).toEqual({ "21": "ranked", "22": "ranked", "23": "notScanned SAMPLE_LIMIT" });
    expect(calls.some((c) => c.url.includes(conditionId("23")))).toBe(false);
  });
});

describe("scanMarkets: V2", () => {
  it("uses positionIds and supports non-YES/NO labels", async () => {
    const markets: MarketSpec[] = [
      { id: "31", version: "v2", labels: ["Team Alpha", "Team Beta"], book: { bids: [["0.55", "40"]], asks: [["0.60", "40"]] } },
      { id: "32", version: "v2", labels: ["Over", "Under"], book: { bids: [], asks: [["0.5", "10"]] } },
    ];
    const { result, calls } = await scan(scanRoutes([markets]), { version: "v2" });
    expect(calls[0]!.url).toContain("version=v2");
    expect(calls.filter((c) => c.url.includes("/book?token_id=")).map((c) => c.url.split("=")[1])).toEqual(
      expect.arrayContaining([assetId("31", 0), assetId("31", 1), assetId("32", 0), assetId("32", 1)]),
    );
    const ranked = result.ranked[0]!;
    expect(ranked.metrics!.reference.label).toBe("Team Alpha");
    expect(ranked.outcomes.map((o) => [o.outcome.assetIdKind, o.outcome.role])).toEqual([
      ["positionId", null],
      ["positionId", null],
    ]);
    expect(bucketOf(result)["32"]).toBe("excluded ONE_SIDED_BOOK");
    expect(result.status).toBe("complete");
  });
});

describe("scanMarkets: discovery", () => {
  it("follows cursors up to max pages and stops early once enough candidates are found", async () => {
    const pages = [[{ id: "41" }], [{ id: "42" }], [{ id: "43" }]];
    const two = await scan(scanRoutes(pages), { maxPages: 2 });
    expect(two.result.discovery).toMatchObject({ pages: 2, stoppedBecause: "MAX_PAGES" });
    expect(two.calls[1]!.url).toContain("after_cursor=cursor-2");
    const all = await scan(scanRoutes(pages), { maxPages: 3 });
    expect(all.result.discovery).toMatchObject({ pages: 3, stoppedBecause: "NO_MORE_PAGES" });
    const enough = await scan(scanRoutes(pages), { maxPages: 3, maxMarkets: 1 });
    expect(enough.result.discovery).toMatchObject({ pages: 1, stoppedBecause: "ENOUGH_CANDIDATES" });
  });

  it("omits ordering with --discover-order none (Stage 1 URL)", async () => {
    const { calls } = await scan(scanRoutes([[{ id: "44" }]]), { discoverOrder: "none" });
    expect(calls[0]!.url).toBe(`${GAMMA}/markets/keyset?closed=false&limit=50&version=v1`);
  });

  it("does not silently fall back when Gamma rejects the order field", async () => {
    const routes = scanRoutes([[]], { keyset: json({ type: "validation error", error: "order fields are not valid" }, 422) });
    const error = await scan(routes).then(
      () => null,
      (e: unknown) => e as MarketMindError,
    );
    expect(error).toBeInstanceOf(MarketMindError);
    expect(error!.kind).toBe("Validation");
    expect(error!.message).toContain('Gamma rejected discovery order "volume24hr"');
    expect(error!.message).toContain("--discover-order none");
  });

  it("propagates a first-page failure (nothing to report)", async () => {
    const error = await scan(scanRoutes([[]], { keyset: json({ error: "down" }, 500) })).catch((e: unknown) => e as MarketMindError);
    expect(error).toMatchObject({ kind: "Upstream5xx" });
  });

  it("keeps earlier pages when a later page fails (partial, DISCOVERY_FAILED)", async () => {
    const routes = scanRoutes([[{ id: "45" }], [{ id: "46" }]]);
    routes["after_cursor=cursor-2"] = json({ markets: "not an array" });
    const { result } = await scan(routes);
    expect(result.stopReasons).toEqual(["DISCOVERY_FAILED"]);
    expect(result.discovery.stoppedBecause).toBe("INTERRUPTED");
    expect(bucketOf(result)).toEqual({ "45": "ranked" });
    expect(result.requests[1]).toMatchObject({ scope: "discovery page 2", httpStatus: 200 });
  });

  it("reports malformed records and duplicates instead of dropping them", async () => {
    const routes = scanRoutes([[{ id: "47" }], [{ id: "47" }, { id: "48" }]]);
    routes["/markets/keyset"] = json({ markets: [{ id: "49", question: 5 }, gamma({ id: "47" })], next_cursor: "cursor-2" });
    const { result } = await scan(routes);
    expect(bucketOf(result)).toEqual({ "49": "failed MALFORMED_RECORD", "47": "ranked", "48": "ranked" });
    expect(result.discovery.duplicates).toEqual([{ gammaId: "47", page: 2 }]);
    expect(result.status).toBe("partial");
  });

  it("warns (advisory) when the server order is not monotonic", async () => {
    const { result } = await scan(scanRoutes([[{ id: "51", volume24hr: 5 }, { id: "52", volume24hr: null }, { id: "53", volume24hr: 9 }]]));
    expect(result.discovery.warnings).toEqual(["DISCOVERY_ORDER_NOT_MONOTONIC: market 53 volume24hr 9 > 5 of market 51"]);
    expect(result.status).toBe("complete");
  });
});

describe("scanMarkets: per-market failure isolation", () => {
  it("isolates HTTP errors and invalid books; other markets are still ranked", async () => {
    const markets: MarketSpec[] = [
      { id: "61", replies: { book0: json({ error: "boom" }, 500) } },
      { id: "62", replies: { association: json({ error: "no market" }, 404) } },
      { id: "63", book: { bids: [["0.4", "100"]], asks: [["0.45", "100"]], raw: { asset_id: "999" } } },
      { id: "64" },
      { id: "65", replies: { book1: json({ unexpected: true }) } },
    ];
    const { result, calls } = await scan(scanRoutes([markets]));
    expect(bucketOf(result)).toEqual({
      "61": "failed HTTP_UPSTREAM_5XX",
      "62": "failed HTTP_NOT_FOUND",
      "63": "failed INVALID_BOOK",
      "64": "ranked",
      "65": "failed VALIDATION",
    });
    // Failed /book was retried exactly once (scan max retries = 1).
    expect(calls.filter((c) => c.url.includes(assetId("61", 0)))).toHaveLength(2);
    const failed61 = result.entries.find((e) => e.gammaId === "61")!;
    expect(failed61.issues[0]).toContain(`token_id=${assetId("61", 0)}`);
    expect(result.requests.find((r) => r.scope === "market 61 book Yes")).toMatchObject({ httpStatus: 500, attempts: 2, error: { kind: "Upstream5xx" } });
    expect(result.status).toBe("partial");
    expect(result.stopReasons).toEqual([]);
  });
});

describe("scanMarkets: request budget", () => {
  it("reserves whole markets up front; markets the budget cannot cover are notScanned", async () => {
    const markets = ["71", "72", "73"].map((id) => ({ id }));
    const { result, urls } = await scan(scanRoutes([markets]), { maxRequests: 7 });
    expect(urls).toHaveLength(7);
    expect(bucketOf(result)).toEqual({ "71": "ranked", "72": "ranked", "73": "notScanned BUDGET_EXHAUSTED" });
    expect(result.stopReasons).toEqual(["BUDGET_EXHAUSTED"]);
    expect(result.budget).toEqual({ limit: 7, used: 7 });
  });

  it("counts retries: a retry the budget cannot grant fails the market with the real cause", async () => {
    const markets: MarketSpec[] = [{ id: "74", replies: { book0: [json({}, 503), json({})] } }];
    const { result, urls } = await scan(scanRoutes([markets]), { maxRequests: 4 });
    expect(urls).toHaveLength(4);
    const entry = result.entries[0]!;
    expect(entry.bucket).toBe("failed");
    expect(entry.reasons[0]!.code).toBe("HTTP_UPSTREAM_5XX");
    expect(entry.reasons[0]!.detail).toContain("retry refused: request budget exhausted");
    expect(result.stopReasons).toEqual(["BUDGET_EXHAUSTED"]);
  });

  it("returns unused reservation units to the pool so later retries can use them", async () => {
    const markets: MarketSpec[] = [
      { id: "75", replies: { association: json({ error: "gone" }, 404) } },
      { id: "76" },
    ];
    // Market 76's first book fails once, then succeeds on retry.
    const routes = scanRoutes([markets]);
    const good = routes[`token_id=${assetId("76", 0)}`] as Response;
    routes[`token_id=${assetId("76", 0)}`] = [json({}, 503), good];
    const { result, urls } = await scan(routes, { maxRequests: 7, concurrency: 1 });
    // 1 page + 75 association + 76 (association + 503 + retry + other book) = 6.
    expect(urls).toHaveLength(6);
    expect(bucketOf(result)).toEqual({ "75": "failed HTTP_NOT_FOUND", "76": "ranked" });
    expect(result.stopReasons).toEqual([]);
  });

  it("stops discovery when the budget cannot cover another page", async () => {
    const { result, urls } = await scan(scanRoutes([[{ id: "77" }], [{ id: "78" }]]), { maxRequests: 1, maxMarkets: 5 });
    expect(urls).toHaveLength(1);
    expect(result.discovery.stoppedBecause).toBe("INTERRUPTED");
    expect(bucketOf(result)).toEqual({ "77": "notScanned BUDGET_EXHAUSTED" });
  });
});

describe("scanMarkets: concurrency", () => {
  it("never has more requests in flight than --concurrency", async () => {
    const markets = Array.from({ length: 8 }, (_, i) => ({ id: String(80 + i) }));
    for (const concurrency of [1, 3, 4]) {
      let inFlight = 0;
      let peak = 0;
      const wrap = (inner: FetchFn): FetchFn => async (url, init) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        try {
          return await inner(url, init);
        } finally {
          inFlight--;
        }
      };
      const { result } = await scan(scanRoutes([markets]), { concurrency }, { wrap });
      expect(peak).toBeLessThanOrEqual(concurrency);
      expect(peak).toBe(concurrency);
      expect(result.ranked).toHaveLength(8);
    }
  });
});

/** Fetch wrapper: when `trigger` matches, abort `controller` and hang until the request is aborted. */
function abortOn(trigger: string, controller: AbortController, reason: unknown) {
  return (inner: FetchFn): FetchFn =>
    (url, init) => {
      if (!url.includes(trigger)) return inner(url, init);
      controller.abort(reason);
      return new Promise((_resolve, reject) => {
        const signal = init.signal!;
        if (signal.aborted) reject(signal.reason as Error);
        else signal.addEventListener("abort", () => reject(signal.reason as Error));
      });
    };
}

describe("scanMarkets: deadline, cancellation and rate limits", () => {
  const markets = ["91", "92", "93"].map((id) => ({ id }));

  it("deadline: aborts the in-flight request, keeps completed work, reports the rest", async () => {
    const deadline = new AbortController();
    const wrap = abortOn(conditionId("92"), deadline, new DOMException("deadline", "TimeoutError"));
    const { result, urls } = await scan(scanRoutes([markets]), { concurrency: 1 }, { wrap, deadline: deadline.signal });
    expect(bucketOf(result)).toEqual({ "91": "ranked", "92": "notScanned DEADLINE", "93": "notScanned DEADLINE" });
    expect(result.stopReasons).toEqual(["DEADLINE"]);
    expect(result.status).toBe("partial");
    expect(urls.at(-1)).toContain(conditionId("92")); // nothing started after the deadline
    expect(result.requests.find((r) => r.scope === "market 92 association")!.error!.kind).toBe("Cancelled");
  });

  it("user cancellation mid-scan is reported as CANCELLED", async () => {
    const user = new AbortController();
    const wrap = abortOn(assetId("92", 1), user, new Error("SIGINT"));
    const { result } = await scan(scanRoutes([markets]), { concurrency: 1 }, { wrap, signal: user.signal });
    expect(bucketOf(result)).toEqual({ "91": "ranked", "92": "notScanned CANCELLED", "93": "notScanned CANCELLED" });
    expect(result.stopReasons).toEqual(["CANCELLED"]);
  });

  it("a pre-cancelled scan makes no requests and still reports", async () => {
    const user = new AbortController();
    user.abort();
    const { result, urls } = await scan(scanRoutes([markets]), {}, { signal: user.signal });
    expect(urls).toHaveLength(0);
    expect(result.entries).toEqual([]);
    expect(result.stopReasons).toEqual(["CANCELLED"]);
    expect(result.status).toBe("partial");
    expect(result.window).toBeNull();
  });

  it("cancellation during the first discovery page reports an empty partial scan", async () => {
    const user = new AbortController();
    const { result } = await scan(scanRoutes([markets]), {}, { wrap: abortOn("/markets/keyset", user, new Error("SIGINT")), signal: user.signal });
    expect(result.entries).toEqual([]);
    expect(result.stopReasons).toEqual(["CANCELLED"]);
  });

  it("a 429 that survives its retry trips the circuit: no further markets start", async () => {
    const specs: MarketSpec[] = [{ id: "91" }, { id: "92", replies: { book0: json({ error: "slow down" }, 429) } }, { id: "93" }];
    const { result, calls } = await scan(scanRoutes([specs]), { concurrency: 1 });
    expect(bucketOf(result)).toEqual({ "91": "ranked", "92": "failed HTTP_RATE_LIMITED", "93": "notScanned RATE_LIMITED" });
    expect(result.stopReasons).toEqual(["RATE_LIMITED"]);
    expect(calls.filter((c) => c.url.includes(assetId("92", 0)))).toHaveLength(2);
    expect(calls.some((c) => c.url.includes(conditionId("93")))).toBe(false);
  });
});

describe("scanMarkets: determinism and safety", () => {
  function seeded(seed: number) {
    let x = seed;
    return () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
  }

  it("produces byte-identical JSON regardless of response completion order", async () => {
    const constantClock = () => new Date("2026-10-28T21:05:12.000Z");
    const outputs: string[] = [];
    for (const seed of [1, 2, 3]) {
      const random = seeded(seed);
      const wrap = (inner: FetchFn): FetchFn => async (url, init) => {
        await new Promise((r) => setTimeout(r, Math.floor(random() * 5)));
        return inner(url, init);
      };
      const { result } = await scan(scanRoutes([V1_SCENARIO]), {}, { wrap, now: constantClock });
      outputs.push(JSON.stringify(scanJson(result)));
    }
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[2]).toBe(outputs[0]);
  });

  it("only sends unauthenticated GETs to the allowlisted read-only endpoints", async () => {
    const { calls } = await scan(scanRoutes([V1_SCENARIO]));
    expect(calls.length).toBeGreaterThan(0);
    for (const { url, init } of calls) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBeNull();
      expect([...headers.keys()].some((k) => k.startsWith("poly"))).toBe(false);
      const u = new URL(url);
      expect([GAMMA, CLOB]).toContain(u.origin);
      expect(u.pathname).toMatch(/^\/(markets\/keyset|clob-markets\/0x[0-9a-c]+|book)$/);
    }
  });

  it("rejects options outside the hard limits even when called directly", async () => {
    const error = (await scan(scanRoutes([[]]), { maxRequests: 121, concurrency: 0 }).catch((e: unknown) => e)) as MarketMindError;
    expect(error).toMatchObject({ kind: "Usage" });
    expect(error.details.issues).toEqual(["maxRequests=121 not in 1..120", "concurrency=0 not in 1..8"]);
  });
});

describe("scanMarkets: review hardening", () => {
  it("budget.used equals actual HTTP attempts under concurrency with retries and failures", async () => {
    const markets: MarketSpec[] = Array.from({ length: 6 }, (_, i) => ({ id: String(500 + i) }));
    const routes = scanRoutes([markets]);
    routes[`token_id=${assetId("501", 0)}`] = [json({}, 503), routes[`token_id=${assetId("501", 0)}`] as Response];
    routes[`/clob-markets/${conditionId("503")}`] = json({}, 503);
    routes[`token_id=${assetId("505", 1)}`] = json({}, 404);
    const { result, urls } = await scan(routes, { concurrency: 4 });
    // 1 page + 6 associations (+1 retry for 503) + 10 books (+1 retry for 501) = 19.
    expect(urls).toHaveLength(19);
    expect(result.budget.used).toBe(19);
    expect(result.requests.reduce((n, r) => n + r.attempts, 0)).toBe(19);
    expect(bucketOf(result)).toMatchObject({ "501": "ranked", "503": "failed HTTP_UPSTREAM_5XX", "505": "failed HTTP_NOT_FOUND" });
  });

  it("distinguishes budget exhaustion from cancellation in the same scan", async () => {
    const user = new AbortController();
    const markets = ["511", "512", "513", "514"].map((id) => ({ id }));
    // The budget covers the page and 2 markets; the user cancels during the second market.
    const wrap = abortOn(assetId("512", 1), user, new Error("SIGINT"));
    const { result } = await scan(scanRoutes([markets]), { concurrency: 1, maxRequests: 7 }, { wrap, signal: user.signal });
    expect(bucketOf(result)).toEqual({
      "511": "ranked",
      "512": "notScanned CANCELLED",
      "513": "notScanned BUDGET_EXHAUSTED",
      "514": "notScanned BUDGET_EXHAUSTED",
    });
    expect(result.stopReasons).toEqual(["BUDGET_EXHAUSTED", "CANCELLED"]);
  });

  it("duplicates across pages are inspected once and do not inflate counts", async () => {
    const routes = scanRoutes([[{ id: "521" }, { id: "522" }], [{ id: "522" }, { id: "521" }, { id: "523" }]]);
    const { result, calls } = await scan(routes, { maxMarkets: 5 });
    expect(result.discovery.recordsReceived).toBe(5);
    expect(result.discovery.duplicates).toEqual([
      { gammaId: "522", page: 2 },
      { gammaId: "521", page: 2 },
    ]);
    expect(result.discovery.recordsReceived).toBe(result.entries.length + result.discovery.duplicates.length);
    expect(countScan(result)).toMatchObject({ discovered: 3, eligible: 3, selected: 3, rankedTotal: 3 });
    for (const id of ["521", "522", "523"]) {
      expect(calls.filter((c) => c.url.includes(conditionId(id)))).toHaveLength(1);
      expect(calls.filter((c) => c.url.includes(assetId(id, 0)))).toHaveLength(1);
    }
  });

  it("duplicates do not count toward the enough-candidates stop", async () => {
    const routes = scanRoutes([[{ id: "531" }], [{ id: "531" }], [{ id: "532" }]]);
    const { result } = await scan(routes, { maxMarkets: 2, maxPages: 3 });
    expect(result.discovery).toMatchObject({ pages: 3, recordsReceived: 3, stoppedBecause: "NO_MORE_PAGES" });
    expect(countScan(result).selected).toBe(2);
  });

  it("validates both books and never adds the other outcome's liquidity", async () => {
    const markets: MarketSpec[] = [
      // Outcome 1 shows far more size than outcome 0: the market row must use outcome 0 only.
      { id: "541", book: { bids: [["0.40", "100"]], asks: [["0.45", "100"]] }, other: { bids: [["0.55", "9999"]], asks: [["0.60", "9999"]] } },
      // Outcome 1 book is invalid (condition id mismatch) even though outcome 0 is clean.
      { id: "542", other: { bids: [["0.55", "100"]], asks: [["0.60", "100"]], raw: { market: "0xdead" } } },
    ];
    const { result } = await scan(scanRoutes([markets]));
    const row = result.entries.find((e) => e.gammaId === "541")!;
    expect(row.bucket).toBe("ranked");
    expect(row.metrics!.topSize!.toFixed()).toBe("100");
    expect(row.metrics!.bidDepth!.toFixed()).toBe("100");
    expect(row.warnings.some((w) => w.code === "COMPLEMENT_MISMATCH")).toBe(true); // advisory only
    expect(bucketOf(result)["542"]).toBe("failed INVALID_BOOK");
    expect(result.ranked.map((e) => e.gammaId)).toEqual(["541"]);
  });
});
