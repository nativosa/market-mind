import { describe, expect, it } from "vitest";
import type { ApiError } from "../src/api";
import {
  canLoadMore,
  compareDecimals,
  initialState,
  MAX_PAGES,
  needsFirstPage,
  reducer,
  scopeText,
  selectedMarket,
  sortMarkets,
  visibleMarkets,
  type Action,
  type ExplorerState,
} from "../src/explorer";
import { item, NOW, page, range, serverError, status } from "./fixtures";

const run = (actions: Action[], state: ExplorerState = initialState()) => actions.reduce(reducer, state);
let id = 0;
/** Request and receive one page for `version` (first or more). */
const fetched = (state: ExplorerState, mode: "first" | "more", p = page([item("1")]), version: "v1" | "v2" = "v1") => {
  const requestId = ++id;
  return run([{ type: "request", version, mode, requestId }, { type: "loaded", version, requestId, page: p, receivedAt: NOW }], state);
};
const serverFailure = (category: string, code: string | null, details: Record<string, unknown> = {}): ApiError => ({ kind: "server", httpStatus: 503, error: serverError(category, code, details).error, receivedAt: NOW });

describe("pagination", () => {
  it("loads the first page, then more on request, deduplicating by market id", () => {
    let s = fetched(initialState(), "first", page(range(1, 50), { nextCursor: "c2" }));
    expect(s.feeds.v1).toMatchObject({ pages: 1, nextCursor: "c2", end: null, loading: null, fetchedAt: NOW });
    expect(canLoadMore(s.feeds.v1)).toBe(true);
    s = fetched(s, "more", page([...range(41, 10), ...range(51, 40)], { nextCursor: "c3" }));
    expect(s.feeds.v1.markets).toHaveLength(90);
    expect(new Set(s.feeds.v1.markets.map((m) => m.gammaId)).size).toBe(90);
    expect(s.feeds.v1).toMatchObject({ pages: 2, duplicates: 10 });
  });

  it("stops at five pages (250 markets) and says it is the local cap, not the end", () => {
    let s = fetched(initialState(), "first", page(range(1, 50), { nextCursor: "c" }));
    for (let p = 2; p <= MAX_PAGES; p++) s = fetched(s, "more", page(range((p - 1) * 50 + 1, 50), { nextCursor: "c" }));
    expect(s.feeds.v1).toMatchObject({ pages: 5, end: "page_cap" });
    expect(s.feeds.v1.markets).toHaveLength(250);
    expect(canLoadMore(s.feeds.v1)).toBe(false);
    const ignored = run([{ type: "request", version: "v1", mode: "more", requestId: 999 }], s);
    expect(ignored).toBe(s);
  });

  it("distinguishes the real end of results and an unusable cursor", () => {
    expect(fetched(initialState(), "first", page([item("1")])).feeds.v1.end).toBe("last_page");
    expect(fetched(initialState(), "first", page([item("1")], { nextCursor: null, stoppedReason: "CURSOR_UNSUPPORTED" })).feeds.v1.end).toBe("cursor_unsupported");
  });

  it("keeps earlier pages when a later page fails, and allows an explicit retry", () => {
    const s = fetched(initialState(), "first", page(range(1, 50), { nextCursor: "c2" }));
    const failed = run([{ type: "request", version: "v1", mode: "more", requestId: 500 }, { type: "failed", version: "v1", requestId: 500, error: serverFailure("upstream_unavailable", null, { kind: "Upstream5xx" }) }], s);
    expect(failed.feeds.v1.markets).toHaveLength(50);
    expect(failed.feeds.v1).toMatchObject({ pages: 1, loading: null, error: null, nextCursor: "c2" });
    expect(failed.feeds.v1.moreError).not.toBeNull();
    expect(canLoadMore(failed.feeds.v1)).toBe(true);
  });

  it("refuses a second load-more while one is in flight", () => {
    const s = fetched(initialState(), "first", page(range(1, 50), { nextCursor: "c2" }));
    const loading = run([{ type: "request", version: "v1", mode: "more", requestId: 600 }], s);
    expect(canLoadMore(loading.feeds.v1)).toBe(false);
    expect(run([{ type: "request", version: "v1", mode: "more", requestId: 601 }], loading)).toBe(loading);
  });

  it("a first-page failure leaves nothing loaded and no automatic retry", () => {
    const s = run([{ type: "request", version: "v1", mode: "first", requestId: 1 }, { type: "failed", version: "v1", requestId: 1, error: { kind: "network" } }]);
    expect(s.feeds.v1).toMatchObject({ pages: 0, loading: null, error: { kind: "network" } });
    expect(needsFirstPage(s.feeds.v1)).toBe(false);
    expect(s.connection).toBe("unreachable");
  });

  it("reports an empty first page as loaded with no markets", () => {
    const s = fetched(initialState(), "first", page([]));
    expect(s.feeds.v1).toMatchObject({ pages: 1, markets: [], end: "last_page" });
  });

  it("records the latest budget and counts invalid upstream records", () => {
    const s = fetched(initialState(), "first", page([item("1")], { used: 7, skipped: 3 }));
    expect(s.budget).toEqual({ process: { limit: 2_000, used: 7, remaining: 1_993 }, window: { limit: 60, windowMs: 300_000, used: 7, remaining: 53 } });
    expect(s.feeds.v1.skipped).toBe(3);
    expect(s.connection).toBe("connected");
  });
});

describe("stale responses", () => {
  it("ignores an answer from a superseded request", () => {
    const s = run([
      { type: "request", version: "v1", mode: "first", requestId: 1 },
      { type: "request", version: "v1", mode: "first", requestId: 2 },
      { type: "loaded", version: "v1", requestId: 1, page: page([item("old")]), receivedAt: NOW },
    ]);
    expect(s.feeds.v1).toMatchObject({ loading: "first", requestId: 2, markets: [] });
    const done = run([{ type: "loaded", version: "v1", requestId: 2, page: page([item("new")]), receivedAt: NOW }], s);
    expect(done.feeds.v1.markets.map((m) => m.gammaId)).toEqual(["new"]);
  });

  it("ignores a page whose version does not match the feed", () => {
    const s = run([
      { type: "request", version: "v2", mode: "first", requestId: 3 },
      { type: "loaded", version: "v2", requestId: 3, page: page([item("1")], { version: "v1" }), receivedAt: NOW },
    ]);
    expect(s.feeds.v2).toMatchObject({ loading: "first", pages: 0 });
  });

  it("an aborted request settles quietly, so the version loads again when shown", () => {
    const s = run([
      { type: "request", version: "v1", mode: "first", requestId: 4 },
      { type: "version", version: "v2" },
      { type: "failed", version: "v1", requestId: 4, error: { kind: "aborted" } },
    ]);
    expect(s.feeds.v1).toMatchObject({ loading: null, error: null, pages: 0 });
    expect(needsFirstPage(s.feeds.v1)).toBe(true);
    expect(s.version).toBe("v2");
    expect(needsFirstPage(s.feeds.v2)).toBe(true);
  });

  it("switching versions keeps each version's loaded pages separately", () => {
    let s = fetched(initialState(), "first", page([item("1")]), "v1");
    s = run([{ type: "version", version: "v2" }], s);
    s = fetched(s, "first", page([item("2"), item("3")], { version: "v2" }), "v2");
    expect(s.feeds.v1.markets.map((m) => m.gammaId)).toEqual(["1"]);
    expect(visibleMarkets(s).map((m) => m.gammaId)).toEqual(["2", "3"]);
  });
});

describe("local search, filters and sorting", () => {
  const markets = [
    item("1", { question: "Will BTC close above $100k?", slug: "btc-100k", gammaVolume24hr: "950.5" }),
    item("2", { question: "Who wins the final?", slug: "final-winner", gammaVolume24hr: "12000", eligibility: { inspectable: false, reasons: ["CLOSED"], warnings: [] }, closed: true }),
    item("3", { question: "Rain in Paris tomorrow?", slug: "paris-rain-btc", gammaVolume24hr: null, enableOrderBook: null }),
    item("4", { question: "apple earnings beat?", slug: "aapl", gammaVolume24hr: "950.50001", acceptingOrders: false }),
  ];
  const loaded = fetched(initialState(), "first", page(markets));
  const ids = (patch: Partial<ExplorerState["filters"]>, sort: ExplorerState["sort"] = "volume") =>
    visibleMarkets(run([{ type: "filters", patch }, { type: "sort", sort }], loaded)).map((m) => m.gammaId);

  it("searches question and slug case-insensitively", () => {
    expect(ids({ query: "btc" })).toEqual(["1", "3"]);
    expect(ids({ query: "  PARIS " })).toEqual(["3"]);
    expect(ids({ query: "nothing like this" })).toEqual([]);
  });

  it("filters by eligibility, order book and accepting orders (unknown never counts as yes)", () => {
    expect(ids({ eligibility: "inspectable" })).toEqual(["4", "1", "3"]);
    expect(ids({ eligibility: "not_inspectable" })).toEqual(["2"]);
    expect(ids({ orderBookEnabled: true })).toEqual(["2", "4", "1"]);
    expect(ids({ acceptingOrders: true })).toEqual(["2", "1", "3"]);
  });

  it("sorts by exact Gamma volume (unknown last) or by question", () => {
    expect(ids({})).toEqual(["2", "4", "1", "3"]);
    expect(ids({}, "question")).toEqual(["4", "3", "2", "1"]);
  });

  it("filtering never changes or refetches the loaded set", () => {
    const s = run([{ type: "filters", patch: { query: "btc" } }], loaded);
    expect(s.feeds).toBe(loaded.feeds);
  });

  it("states the search scope honestly", () => {
    expect(scopeText(12, 100, "v1", true)).toBe("12 matches among 100 loaded V1 markets");
    expect(scopeText(1, 1, "v2", true)).toBe("1 match among 1 loaded V2 market");
    expect(scopeText(100, 100, "v1", false)).toBe("Showing all 100 loaded V1 markets");
  });
});

describe("compareDecimals", () => {
  it.each([
    ["0.1", "0.10", 0],
    ["10", "9.999999999999999999", 1],
    ["950.5", "950.50001", -1],
    ["00012", "12.0", 0],
    ["123456789012345678901234567890.5", "123456789012345678901234567890.4", 1],
    ["1e+21", "5", 1],
  ])("%s vs %s", (a, b, expected) => {
    expect(Math.sign(compareDecimals(a, b))).toBe(expected);
  });

  it("keeps the loaded order for equal volumes", () => {
    expect(sortMarkets([item("a", { gammaVolume24hr: "5" }), item("b", { gammaVolume24hr: "5.0" })], "volume").map((m) => m.gammaId)).toEqual(["a", "b"]);
  });
});

describe("selection and status", () => {
  it("keeps the selected id and finds it in either version's loaded markets", () => {
    let s = fetched(initialState(), "first", page([item("7")]));
    s = run([{ type: "select", id: "7" }, { type: "version", version: "v2" }], s);
    expect(selectedMarket(s)?.gammaId).toBe("7");
    expect(selectedMarket(run([{ type: "select", id: "999" }], s))).toBeNull();
    expect(selectedMarket(run([{ type: "select", id: null }], s))).toBeNull();
  });

  it("takes the budget from status until a listing reports a newer one", () => {
    const s = run([{ type: "status", status }]);
    expect(s).toMatchObject({ connection: "connected", budget: { process: { remaining: 2_000 } } });
    expect(run([{ type: "status_failed", error: { kind: "network" } }]).connection).toBe("unreachable");
    expect(run([{ type: "status_failed", error: { kind: "aborted" } }]).connection).toBe("checking");
  });

  it("a server error still means the server is reachable", () => {
    const s = run([{ type: "request", version: "v1", mode: "first", requestId: 9 }, { type: "failed", version: "v1", requestId: 9, error: serverFailure("rate_limited", "LOCAL_COOLDOWN") }]);
    expect(s.connection).toBe("connected");
  });
});
