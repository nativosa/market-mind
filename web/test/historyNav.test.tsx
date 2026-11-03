import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WEB_LIMITS } from "../../src/research/contracts";
import { createApiClient, type ApiError } from "../src/api";
import { HistoryApp, MarketsPage, RunsPage } from "../src/HistoryApp";
import { DEFAULT_NAV } from "../src/components/Header";
import { MissingDatabase } from "../src/components/ResourceState";
import { describeApiError } from "../src/format";
import { effectiveSource, historyReducer, initialHistoryState, isDatabaseMissing, keysFor, RUNS_MAX, runCount, type HistoryState } from "../src/history";
import { createHistoryStore } from "../src/historyStore";
import { navFor, Root, rootStateFor } from "../src/Root";
import { historyHash, isHistoryHash, navigateHistory, parseRoute, watchAppRoute, watchRoute, type HistoryRoute, type RouteWindow } from "../src/route";
import { NOW, response, serverError, status } from "./fixtures";
import { cleanupHistory, flush, ok, pendingApi, SEED_TIMEOUT_MS, seedEmpty, sharedHistory, storedServer, until, type Runs, type StoredMarkets } from "./historyFixtures";
import { appTree, button, call, findAll, html, text, textOf } from "./render";

// Stage 3.2 Commit 4: history routes, the section switch, the stored-data request store and the
// stored markets / runs lists. Lists render real API answers from a temporary database.

const MARKETS: HistoryRoute = { section: "history", page: "markets", source: null };
const RUNS: HistoryRoute = { section: "history", page: "runs", source: null };
const market = (marketId: string, observationId: number | null = null, source: "live" | "all" | null = null): HistoryRoute => ({
  section: "history",
  page: "market",
  marketId,
  observationId,
  source,
});

function fakeWindow(hash: string) {
  const listeners = new Set<() => void>();
  const win: RouteWindow & { fire: () => void; listeners: Set<() => void> } = {
    location: { hash },
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
    fire: () => listeners.forEach((l) => l()),
    listeners,
  };
  return win;
}

const dbMissing = (): ApiError => ({ kind: "server", httpStatus: 404, receivedAt: NOW, error: serverError("database_missing", "DATABASE_MISSING", {}, false).error });

afterAll(cleanupHistory);

describe("history routes", () => {
  it("parses the history routes, their source filter and nothing else", () => {
    expect(parseRoute("#/history")).toEqual(MARKETS);
    expect(parseRoute("#/history/")).toEqual(MARKETS);
    expect(parseRoute("#/history/runs?source=all")).toEqual({ ...RUNS, source: "all" });
    expect(parseRoute("#/history/market/123")).toEqual(market("123"));
    expect(parseRoute("#/history/market/123/obs/45?source=live")).toEqual(market("123", 45, "live"));
    expect(parseRoute("#/history/market/123?source=bogus")).toEqual(market("123"));
    // Not history: the Live Explorer's list (or market) as before.
    for (const hash of ["", "#/", "#/history/market/12a", "#/history/market/1/obs/0", "#/history/market/1/obs/x", "#/historyx", "#/history/runs/1"]) {
      expect(parseRoute(hash).section, hash).toBe("live");
    }
    expect(parseRoute("#/market/9")).toEqual({ section: "live", marketId: "9" });
    expect(isHistoryHash("#/history/runs")).toBe(true);
    expect(isHistoryHash("#/market/9")).toBe(false);
  });

  it("builds hashes that parse back to the same route, keeping only an explicit source", () => {
    for (const route of [MARKETS, { ...RUNS, source: "all" as const }, market("7"), market("7", 12, "live")]) expect(parseRoute(historyHash(route))).toEqual(route);
    expect(historyHash(market("7", 12, "all"))).toBe("#/history/market/7/obs/12?source=all");
    expect(historyHash(MARKETS)).toBe("#/history");
  });

  it("the explorer's route watcher ignores history hashes, so leaving it keeps its selection", () => {
    const win = fakeWindow("#/market/7");
    const seen: (string | null)[] = [];
    const stop = watchRoute(win, (id) => seen.push(id));
    win.location.hash = "#/history/market/7";
    win.fire();
    win.location.hash = "#/";
    win.fire();
    stop();
    expect(seen).toEqual(["7", null]);
  });

  it("the app route watcher reports every route and navigation adds an entry only on change", () => {
    const win = fakeWindow("#/history/runs");
    const seen: string[] = [];
    const stop = watchAppRoute(win, (route, hash) => seen.push(`${route.section}:${hash}`));
    navigateHistory(win, RUNS);
    expect(win.location.hash).toBe("#/history/runs");
    navigateHistory(win, market("5", 3));
    expect(win.location.hash).toBe("#/history/market/5/obs/3");
    win.fire();
    stop();
    expect(win.listeners.size).toBe(0);
    expect(seen).toEqual(["history:#/history/runs", "history:#/history/market/5/obs/3"]);
  });
});

describe("sections", () => {
  it("a history deep link never opens the Live Explorer; each section stays open once visited", () => {
    let s = rootStateFor(parseRoute("#/history/market/1/obs/2"), "#/history/market/1/obs/2");
    expect(s).toMatchObject({ liveOpened: false, historyOpened: true });
    s = rootStateFor(parseRoute("#/market/9"), "#/market/9", s);
    expect(s).toMatchObject({ liveOpened: true, historyOpened: true, liveHash: "#/market/9", historyRoute: market("1", 2) });
    s = rootStateFor(parseRoute("#/history"), "#/history", s);
    expect(s).toMatchObject({ liveOpened: true, liveHash: "#/market/9", historyRoute: MARKETS });
    const fresh = rootStateFor(parseRoute(""), "");
    expect(fresh).toMatchObject({ liveOpened: true, historyOpened: false, liveHash: "#/" });
  });

  it("section links return to where each section was left", () => {
    let s = rootStateFor(parseRoute("#/market/9"), "#/market/9");
    s = rootStateFor(parseRoute("#/history/market/1?source=all"), "#/history/market/1?source=all", s);
    expect(navFor(s, true)).toEqual({ section: "history", liveHref: "#/market/9", historyHref: "#/history?source=all", liveEnabled: true });
    s = rootStateFor(parseRoute("#/market/9"), "#/market/9", s);
    expect(navFor(s, false)).toEqual({ section: "live", liveHref: "#/", historyHref: "#/history/market/1?source=all", liveEnabled: false });
  });

  it("renders only the history section for a history address (no explorer list or controls)", () => {
    const { api, live } = pendingApi();
    const markup = html(<Root api={api} clock={() => NOW} routeWindow={null} initialHash="#/history/market/1" />);
    const t = text(markup);
    expect(t).toContain("Stored History");
    expect(t).toContain("Offline: reads the local database, never Polymarket");
    expect(t).not.toContain("Search loaded markets");
    expect(t).not.toContain("Requests left");
    expect(markup).toContain('aria-current="page"');
    expect(live).toEqual([]);
  });

  it("renders only the explorer for a live address, with the section links", () => {
    const { api } = pendingApi();
    const t = text(html(<Root api={api} clock={() => NOW} routeWindow={null} initialHash="#/" />));
    expect(t).toContain("Search loaded markets");
    expect(t).toContain("Live Explorer requests Polymarket");
    expect(t).toContain("Stored History offline, local database");
    expect(t).not.toContain("Collection runs");
  });

  it("a server with live requests disabled says so in the section link", () => {
    expect(text(html(<HistoryApp store={createHistoryStore(pendingApi().api)} route={MARKETS} active nav={{ ...DEFAULT_NAV, section: "history", liveEnabled: false }} routeWindow={null} />))).toContain(
      "Live Explorer disabled on this server",
    );
  });
});

describe("history store requests", () => {
  const harness = () => {
    const h = pendingApi();
    const deferred: (() => void)[] = [];
    const store = createHistoryStore(h.api, { now: () => NOW, defer: (fn) => (deferred.push(fn), () => deferred.splice(deferred.indexOf(fn), 1)) });
    return { ...h, store, runDeferred: () => deferred.splice(0).forEach((fn) => fn()) };
  };

  it("loads what the route shows, once, however often it is synced (StrictMode runs effects twice)", () => {
    const { store, pending, live } = harness();
    store.sync(MARKETS);
    store.sync(MARKETS);
    expect(pending.map((p) => [p.method, p.args])).toEqual([["storedMarkets", [{ source: null, offset: 0 }]]]);
    expect(store.getState().markets).toMatchObject({ loading: true, key: "default|0" });
    expect(live).toEqual([]);
  });

  it("a deep link to an observation loads the market's history and that observation only", () => {
    const { store, pending, live } = harness();
    store.sync(market("1", 7, "all"));
    expect(pending.map((p) => [p.method, p.args])).toEqual([
      ["history", ["1", { source: "all" }]],
      ["observation", [7, { source: "all", levels: 50 }]],
    ]);
    expect(live).toEqual([]);
  });

  it("closing the observation keeps the loaded history: nothing is requested again", { timeout: SEED_TIMEOUT_MS }, async () => {
    const { api } = pendingApi();
    const server = await storedServer(sharedHistory().path);
    const store = createHistoryStore({ ...api, history: (...a) => server.api.history(...a), observation: (...a) => server.api.observation(...a) });
    store.sync(market("1", 1));
    await until(() => !store.getState().history.loading && !store.getState().observation.loading);
    expect(store.getState().history.data?.status).toBe("ok");
    expect(store.getState().observation.data?.observation.observationId).toBe(1);
    store.sync(market("1"));
    store.sync(market("1", 2));
    await until(() => !store.getState().observation.loading);
    expect(server.paths).toEqual(["/api/stored/markets/1/history", "/api/stored/observations/1?levels=50", "/api/stored/observations/2?levels=50"]);
    expect(server.urls).toEqual([]);
  });

  it("switching market or source aborts the superseded request and ignores its late answer", () => {
    const { store, pending } = harness();
    store.sync(market("1"));
    store.sync(market("2"));
    expect(pending[0]!.signal.aborted).toBe(true);
    store.sync(market("2", null, "all"));
    expect(pending[1]!.signal.aborted).toBe(true);
    expect(pending.map((p) => p.args[0])).toEqual(["1", "2", "2"]);
    expect(pending.map((p) => (p.args[1] as { source: string | null }).source)).toEqual([null, null, "all"]);
    // A superseded answer that still arrives changes nothing.
    const before = store.getState();
    expect(historyReducer(before, { type: "loaded", resource: "history", requestId: 1, data: {}, receivedAt: NOW })).toBe(before);
    expect(store.getState().history).toMatchObject({ key: "2|all", loading: true, data: null });
  });

  it("refuses an answer for another market than the one asked for", async () => {
    const { store, pending } = harness();
    store.sync(market("1"));
    pending[0]!.answer({ ok: true, receivedAt: NOW, data: { appliedLimits: { marketId: "2", source: "live" } } });
    await flush();
    expect(store.getState().history.error).toEqual({ kind: "invalid_response", httpStatus: 200, issues: ["appliedLimits.marketId: expected 1"] });
    pending.length = 0;
    store.reload("history");
    expect(pending).toHaveLength(1);
  });

  it("refuses a list answer for another source filter than the explicit one", async () => {
    const { store, pending } = harness();
    store.sync({ ...MARKETS, source: "live" });
    pending[0]!.answer({ ok: true, receivedAt: NOW, data: { appliedLimits: { source: "all" } } });
    await flush();
    expect(store.getState().markets.error).toMatchObject({ kind: "invalid_response" });
  });

  it("a failure waits for an explicit retry; nothing retries on its own", async () => {
    const { store, pending } = harness();
    store.sync(RUNS);
    pending[0]!.answer({ ok: false, error: dbMissing() });
    await flush();
    store.sync(RUNS);
    expect(pending).toHaveLength(1);
    expect(isDatabaseMissing(store.getState().runs.error)).toBe(true);
    store.reload("runs");
    store.reload("runs"); // ignored while loading
    expect(pending).toHaveLength(2);
    store.reload("markets"); // not shown by this route
    expect(pending).toHaveLength(2);
  });

  it("pages stored markets and grows the runs list, keeping shown runs while more load", async () => {
    const { store, pending } = harness();
    store.sync(MARKETS);
    store.setOffset(50);
    expect(pending.map((p) => p.args[0])).toEqual([
      { source: null, offset: 0 },
      { source: null, offset: 50 },
    ]);
    expect(pending[0]!.signal.aborted).toBe(true);
    store.sync(RUNS);
    pending[2]!.answer({ ok: true, receivedAt: NOW, data: { appliedLimits: { source: "live" }, runs: { items: [] } } });
    await flush();
    store.showMoreRuns();
    expect(pending[3]!.args[0]).toEqual({ source: null, limit: 40 });
    expect(store.getState().runs.data).not.toBeNull();
    store.showMoreRuns(); // ignored while loading
    expect(pending).toHaveLength(4);
    store.resetPaging();
    expect(store.getState()).toMatchObject({ marketsOffset: 0, runsLimit: 20 });
  });

  it("stops at the API's most runs", () => {
    const state = historyReducer(initialHistoryState(), { type: "runs_limit", limit: 10_000 });
    expect(state.runsLimit).toBe(RUNS_MAX);
    expect(RUNS_MAX).toBe(WEB_LIMITS.storedRuns.limit.max);
    expect(historyReducer(state, { type: "offset", offset: -5 }).marketsOffset).toBe(0);
  });

  it("unmounting aborts everything, but a StrictMode remount in between keeps requests alive", () => {
    const { store, pending, statusCalls, runDeferred } = harness();
    store.attach();
    store.sync(MARKETS);
    store.detach();
    store.attach(); // StrictMode: cleanup and effect again, at once
    runDeferred();
    expect(pending[0]!.signal.aborted).toBe(false);
    expect(statusCalls()).toBe(1);
    store.detach();
    runDeferred();
    expect(pending[0]!.signal.aborted).toBe(true);
    // An aborted request leaves no error; showing the route again requests it.
    store.sync(MARKETS);
    expect(pending).toHaveLength(1);
  });

  it("keys name the resource, page and source a route shows", () => {
    const state = initialHistoryState();
    expect(keysFor(MARKETS, state)).toEqual({ markets: "default|0" });
    expect(keysFor({ ...RUNS, source: "all" }, state)).toEqual({ runs: "all|20" });
    expect(keysFor(market("4", 9, "live"), state)).toEqual({ history: "4|live", observation: "9|live" });
  });

  it("the source in effect: the route's choice, else what the server applied, else its default", () => {
    expect(effectiveSource({ ...MARKETS, source: "all" }, "live", status)).toBe("all");
    expect(effectiveSource(MARKETS, "all", status)).toBe("all");
    expect(effectiveSource(MARKETS, null, { ...status, stored: { defaultSource: "all", database: "present" } })).toBe("all");
    expect(effectiveSource(MARKETS, undefined, null)).toBe("live");
  });
});

describe("stored lists (real API answers from a temporary database)", () => {
  let api: Awaited<ReturnType<typeof storedServer>>;
  let liveMarkets: StoredMarkets;
  let allMarkets: StoredMarkets;
  let liveRuns: Runs;
  let allRuns: Runs;
  beforeAll(async () => {
    api = await storedServer(sharedHistory().path);
    liveMarkets = ok(await api.api.storedMarkets({}));
    allMarkets = ok(await api.api.storedMarkets({ source: "all" }));
    liveRuns = ok(await api.api.storedRuns({}));
    allRuns = ok(await api.api.storedRuns({ source: "all", limit: 3 }));
  }, SEED_TIMEOUT_MS);

  const withData = (patch: Partial<HistoryState>): HistoryState => ({ ...initialHistoryState(), ...patch });
  const loaded = <T,>(data: T) => ({ key: "k", requestId: 1, loading: false, data, receivedAt: NOW, error: null });
  const marketsPage = (data: StoredMarkets, route: HistoryRoute = MARKETS) => text(html(<MarketsPage state={withData({ markets: loaded(data) })} route={route} now={NOW} onRetry={() => {}} onOffset={() => {}} />));
  const runsPage = (data: Runs) => text(html(<RunsPage state={withData({ runs: loaded(data) })} now={NOW} onRetry={() => {}} onMore={() => {}} />));

  it("the server applied the filter: live only hides synthetic markets and runs; no upstream request was made", () => {
    expect(liveMarkets.markets.items.map((m) => m.gammaId)).toEqual(["3", "1"]);
    expect(allMarkets.markets.items.map((m) => m.gammaId)).toEqual(["3", "2", "1"]);
    expect(liveRuns.runs.items.every((r) => r.sourceType === "live")).toBe(true);
    expect(allRuns.runs.items.some((r) => r.sourceType === "synthetic")).toBe(true);
    expect(api.paths).toEqual(["/api/stored/markets", "/api/stored/markets?source=all", "/api/stored/runs", "/api/stored/runs?source=all&limit=3"]);
    expect(api.urls).toEqual([]);
  });

  it("lists stored markets with ids, version, counts, provenance and exact timestamps", () => {
    const t = marketsPage(allMarkets);
    expect(t).toContain("Markets 1 to 3 with stored observations");
    expect(t).toContain("Will market 1 resolve Yes?");
    expect(t).toContain("8 7 live · 1 synthetic");
    expect(t).toContain("2026-10-28 21:05:12.110 UTC");
    expect(t).toContain("Synthetic");
    expect(t).toContain("End of stored markets.");
    const markup = html(<MarketsPage state={withData({ markets: loaded(allMarkets) })} route={{ ...MARKETS, source: "all" }} now={NOW} onRetry={() => {}} onOffset={() => {}} />);
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).toContain('href="#/history/market/1?source=all"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Previous page/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Next page/);
  });

  it("offers the next page only when more markets exist", () => {
    const more: StoredMarkets = { ...liveMarkets, appliedLimits: { ...liveMarkets.appliedLimits, offset: 50 }, markets: { ...liveMarkets.markets, hasMore: true, nextOffset: 52 } };
    const markup = html(<MarketsPage state={withData({ markets: loaded(more) })} route={MARKETS} now={NOW} onRetry={() => {}} onOffset={() => {}} />);
    expect(text(markup)).toContain("Markets 51 to 52");
    expect(markup).not.toMatch(/disabled=""[^>]*>(Previous|Next) page/);
  });

  it("lists runs with status, source, counts and unknowns honestly", () => {
    const t = runsPage(allRuns);
    expect(t).toContain("The 3 most recent collection runs");
    expect(t).toContain("Synthetic");
    expect(t).toContain("Running");
    expect(t).toContain("Not finished");
    expect(t).toContain("Complete Request accounting verified");
    expect(runsPage(liveRuns)).toContain("Partial Request accounting incomplete");
    expect(runsPage(liveRuns)).toContain("Stopped: DEADLINE");
    expect(t).toContain("Not reported");
    expect(t).toContain("Its process is gone; the next collect marks it interrupted.");
    expect(t).toContain("Show more runs");
    const capped: Runs = { ...allRuns, appliedLimits: { ...allRuns.appliedLimits, limit: RUNS_MAX } };
    expect(runsPage(capped)).toContain(`Showing the ${RUNS_MAX} most recent runs`);
    const done = runsPage({ ...allRuns, runs: { ...allRuns.runs, hasMore: false } });
    expect(done).toContain("End of collection runs.");
  });

  it("reads persist counts as numbers or not reported, never zero", () => {
    const r = allRuns.runs.items[0]!;
    expect(runCount({ ...r, persistCounts: { selected: 4, booksWritten: null } }, "selected")).toBe(4);
    expect(runCount({ ...r, persistCounts: { selected: 4, booksWritten: null } }, "booksWritten")).toBeNull();
    expect(runCount({ ...r, persistCounts: null }, "selected")).toBeNull();
  });

  it("empty database: no markets and no runs, with what to do and the synthetic hint under Live only", { timeout: SEED_TIMEOUT_MS }, async () => {
    const empty = await storedServer(seedEmpty());
    const m = ok(await empty.api.storedMarkets({}));
    const r = ok(await empty.api.storedRuns({ source: "all" }));
    expect(marketsPage(m)).toContain("No stored markets");
    expect(marketsPage(m)).toContain("appear only with Live + synthetic");
    expect(marketsPage({ ...m, appliedLimits: { ...m.appliedLimits, source: "all" } })).toContain("The database holds no observations yet");
    expect(marketsPage({ ...m, appliedLimits: { ...m.appliedLimits, offset: 50 } })).toContain("No more stored markets");
    expect(runsPage(r)).toContain("No collection runs recorded");
    expect(runsPage({ ...r, appliedLimits: { ...r.appliedLimits, source: "live" } })).toContain("No live collection run is stored");
  });

  it("missing database: a useful empty state, and the server creates no file", async () => {
    const missing = await storedServer("no-such-dir/history.sqlite");
    const result = await missing.api.storedMarkets({});
    expect(result.ok).toBe(false);
    const error = result.ok ? null : result.error;
    expect(isDatabaseMissing(error)).toBe(true);
    const t = text(html(<MarketsPage state={withData({ markets: { ...loaded(null), error } })} route={MARKETS} now={NOW} onRetry={() => {}} onOffset={() => {}} />));
    expect(t).toContain("No local history database yet");
    expect(t).toContain("npm run cli -- collect");
    expect(t).toContain("never creates one");
    expect(text(html(<MissingDatabase />))).toContain("The Live Explorer works without a database.");
    expect(missing.urls).toEqual([]);
  });

  it("loading, failure with retry, and runs that failed to grow keep the shown runs", () => {
    const loading = text(html(<MarketsPage state={withData({ markets: { ...loaded(null), loading: true } })} route={MARKETS} now={NOW} onRetry={() => {}} onOffset={() => {}} />));
    expect(loading).toContain("Loading stored markets");
    const busy: ApiError = { kind: "server", httpStatus: 503, receivedAt: NOW, error: serverError("storage_error", "DATABASE_BUSY", {}, true).error };
    const failed = text(html(<MarketsPage state={withData({ markets: { ...loaded(null), error: busy } })} route={MARKETS} now={NOW} onRetry={() => {}} onOffset={() => {}} />));
    expect(failed).toContain("Loading stored markets failed: The local database is busy");
    expect(failed).toContain("Try again");
    const grown = text(html(<RunsPage state={withData({ runs: { ...loaded(allRuns), error: { kind: "network" } } })} now={NOW} onRetry={() => {}} onMore={() => {}} />));
    expect(grown).toContain("Loading more runs failed");
    expect(grown).toContain("The 3 most recent collection runs");
  });

  it("the synthetic notice appears whenever synthetic observations are included", async () => {
    const store = createHistoryStore(api.api);
    store.sync({ ...MARKETS, source: "all" });
    await until(() => !store.getState().markets.loading);
    const t = text(html(<HistoryApp store={store} route={{ ...MARKETS, source: "all" }} active nav={{ ...DEFAULT_NAV, section: "history" }} routeWindow={null} />));
    expect(t).toContain("Synthetic observations included");
    expect(t).toContain("may mix simulated and real observations");
    const liveOnly = createHistoryStore(api.api);
    expect(text(html(<HistoryApp store={liveOnly} route={MARKETS} active nav={{ ...DEFAULT_NAV, section: "history" }} routeWindow={null} />))).not.toContain(
      "Synthetic observations included",
    );
  });
});

describe("history page handlers", () => {
  let server: Awaited<ReturnType<typeof storedServer>>;
  beforeAll(async () => {
    server = await storedServer(sharedHistory().path);
  }, SEED_TIMEOUT_MS);

  /** A store answering from the real server, with the History page's element tree for its handlers. */
  async function page(route: HistoryRoute, hash = historyHash(route)) {
    const calls: string[] = [];
    const counting: typeof server.api = {
      ...server.api,
      storedMarkets: (q, signal) => (calls.push(`markets ${JSON.stringify(q)}`), server.api.storedMarkets(q, signal)),
      storedRuns: (q, signal) => (calls.push(`runs ${JSON.stringify(q)}`), server.api.storedRuns(q, signal)),
    };
    const store = createHistoryStore(counting);
    store.sync(route);
    await until(() => !["markets", "runs", "history"].some((r) => store.getState()[r as "markets"].loading));
    const win = fakeWindow(hash);
    const tree = () => appTree({ store, route, active: true, nav: { ...DEFAULT_NAV, section: "history" }, routeWindow: win, clock: () => NOW }, HistoryApp);
    return { store, win, calls, tree };
  }

  it("the source filter navigates (resetting paging) and the server applies it; choosing the shown source does nothing", async () => {
    const { store, win, tree } = await page(MARKETS);
    store.setOffset(50);
    const radios = findAll(tree(), (e) => e.type === "input" && e.props.name === "history-source");
    call(radios[0]!.props.onChange); // Live only: already shown
    expect(win.location.hash).toBe("#/history");
    call(radios[1]!.props.onChange);
    expect(win.location.hash).toBe("#/history?source=all");
    expect(store.getState().marketsOffset).toBe(0);
  });

  it("pages stored markets with explicit Previous and Next", async () => {
    const { store, calls, tree } = await page(MARKETS);
    const prev = button(tree(), "Previous page");
    expect(prev.disabled).toBe(true);
    // One market per page, through the store, to exercise both buttons on real answers.
    store.setOffset(1);
    await until(() => !store.getState().markets.loading);
    call(button(tree(), "Previous page").onClick);
    await until(() => !store.getState().markets.loading);
    expect(calls).toEqual(['markets {"source":null,"offset":0}', 'markets {"source":null,"offset":1}', 'markets {"source":null,"offset":0}']);
    call(button(tree(), "Next page").onClick); // no next page: nothing requested
    expect(calls).toHaveLength(3);
  });

  it("more runs and an explicit retry go through the store", async () => {
    const { store, calls, tree } = await page(RUNS);
    expect(text(html(tree() as React.ReactElement))).toContain("End of collection runs.");
    expect(findAll(tree(), (e) => e.type === "a" && textOf(e.props.children) === "Collection runs")[0]!.props["aria-current"]).toBe("page");
    store.reload("runs");
    await until(() => !store.getState().runs.loading);
    expect(calls).toEqual(['runs {"source":null,"limit":20}', 'runs {"source":null,"limit":20}']);
  });

  it("a failed list offers a retry that requests it again", async () => {
    const { api, pending } = pendingApi();
    const store = createHistoryStore(api);
    store.sync(MARKETS);
    pending[0]!.answer({ ok: false, error: { kind: "network" } });
    await flush();
    const tree = appTree({ store, route: MARKETS, active: true, nav: { ...DEFAULT_NAV, section: "history" }, routeWindow: null, clock: () => NOW }, HistoryApp);
    expect(text(html(<HistoryApp store={store} route={MARKETS} active nav={{ ...DEFAULT_NAV, section: "history" }} routeWindow={null} />))).toContain("Local server unreachable");
    call(button(tree, "Try again").onClick);
    expect(pending).toHaveLength(2);
    // Without a window, choosing a source syncs the store directly.
    call(findAll(tree, (e) => e.type === "input" && e.props.name === "history-source")[1]!.props.onChange);
    expect(pending.at(-1)!.args[0]).toEqual({ source: "all", offset: 0 });
  });

  it("the runs page offers more runs while the server has more", async () => {
    const { api, pending } = pendingApi();
    const store = createHistoryStore(api);
    store.sync(RUNS);
    const runs = ok(await server.api.storedRuns({ limit: 2 }));
    pending[0]!.answer({ ok: true, receivedAt: NOW, data: runs });
    await flush();
    const tree = appTree({ store, route: RUNS, active: true, nav: { ...DEFAULT_NAV, section: "history" }, routeWindow: null, clock: () => NOW }, HistoryApp);
    call(button(tree, "Show more runs").onClick);
    expect(pending[1]!.args[0]).toEqual({ source: null, limit: 40 });
  });

  it("an inactive page (Live Explorer shown) renders but requests nothing on its own", () => {
    const { api, pending } = pendingApi();
    const store = createHistoryStore(api);
    html(<HistoryApp store={store} route={MARKETS} active={false} nav={DEFAULT_NAV} routeWindow={null} />);
    expect(pending).toEqual([]);
  });
});

describe("api client: stored reads", () => {
  it("sends the source filter to the server, only when chosen, and validates each answer against its contract", async () => {
    const urls: string[] = [];
    const client = createApiClient((url) => {
      urls.push(url);
      return Promise.resolve(response({ unexpected: true }));
    });
    const results = [
      await client.storedMarkets({ source: "all", limit: 50, offset: 100 }),
      await client.storedMarkets({ source: null }),
      await client.storedRuns({ source: "live", limit: 40 }),
      await client.history("12", { source: "all" }),
      await client.observation(34, { source: null, levels: 50 }),
    ];
    expect(urls).toEqual([
      "/api/stored/markets?source=all&limit=50&offset=100",
      "/api/stored/markets",
      "/api/stored/runs?source=live&limit=40",
      "/api/stored/markets/12/history?source=all",
      "/api/stored/observations/34?levels=50",
    ]);
    expect(results.every((r) => !r.ok && r.error.kind === "invalid_response")).toBe(true);
  });
});

describe("stored-data error copy", () => {
  const view = (category: string, code: string | null) => describeApiError({ kind: "server", httpStatus: 500, receivedAt: NOW, error: serverError(category, code).error }, NOW).title;
  it("explains each stored-data failure", () => {
    expect(view("database_missing", "DATABASE_MISSING")).toBe("No local history database yet");
    expect(view("observation_not_found", "OBSERVATION_NOT_FOUND")).toBe("This observation is not available");
    expect(view("observation_not_available_as_of", null)).toBe("This observation was not available yet");
    expect(view("storage_error", "SCHEMA_OUTDATED")).toBe("The local database needs an upgrade");
    expect(view("storage_error", "SCHEMA_TOO_NEW")).toBe("The local database is from a newer MarketMind");
    expect(view("storage_error", "SQLITE_CORRUPT")).toBe("The local database could not be read");
    expect(view("forbidden", "LIVE_DISABLED")).toBe("Live requests are disabled on this server");
  });
});
