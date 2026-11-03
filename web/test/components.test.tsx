import { describe, expect, it } from "vitest";
import type { ApiError } from "../src/api";
import { App, ListBody } from "../src/App";
import { Controls } from "../src/components/Controls";
import { DetailPanel } from "../src/components/DetailPanel";
import { Header } from "../src/components/Header";
import { MarketTable } from "../src/components/MarketTable";
import { ErrorNotice } from "../src/components/Notice";
import { END_TEXT, Pager } from "../src/components/Pager";
import { DEFAULT_FILTERS, emptyInspection, initialState, reducer, visibleMarkets, type Action, type ExplorerState } from "../src/explorer";
import { item, NOW, page, range, scriptedApi, serverError } from "./fixtures";
import { button, call, expand, findAll, html, appTree as renderTree, text } from "./render";

const appTree = (props: React.ComponentProps<typeof App>) => renderTree(props, App);
const detail = (props: Partial<React.ComponentProps<typeof DetailPanel>>) => (
  <DetailPanel market={null} selectedId={null} inspection={emptyInspection()} depth={5} now={NOW} onInspect={() => {}} onCancel={() => {}} onDepth={() => {}} onClose={() => {}} {...props} />
);

// Components render to static HTML (no DOM needed): what a user would see for each state.

const run = (actions: Action[], state: ExplorerState = initialState()) => actions.reduce(reducer, state);
const loaded = (p = page(range(1, 3)), version: "v1" | "v2" = "v1") =>
  run([{ type: "version", version }, { type: "request", version, mode: "first", requestId: 1 }, { type: "loaded", version, requestId: 1, page: p, receivedAt: NOW }]);
const body = (state: ExplorerState, now = NOW) => text(html(<ListBody state={state} visible={visibleMarkets(state)} now={now} onRetry={() => {}} onSelect={() => {}} onClear={() => {}} />));
const server = (category: string, code: string | null, details: Record<string, unknown> = {}, retryable = true): ApiError => ({ kind: "server", httpStatus: 503, error: serverError(category, code, details, retryable).error, receivedAt: NOW });

describe("market table", () => {
  it("renders exact decimal strings, ids, version, status and unknowns honestly", () => {
    const markup = html(
      <MarketTable
        markets={[
          item("123", { gammaVolume24hr: "1234567.890000001", endDate: "2027-01-15T00:00:00Z" }),
          item("456", { gammaVolume24hr: null, endDate: null, enableOrderBook: null, acceptingOrders: null, eligibility: { inspectable: false, reasons: ["NO_ORDER_BOOK"], warnings: [] } }),
        ]}
        selectedId="456"
        onSelect={() => {}}
      />,
    );
    const t = text(markup);
    expect(t).toContain("1,234,567.890000001");
    expect(t).toContain("2027-01-15");
    expect(t).toContain("Not reported");
    expect(t).toContain("Order book not reported");
    expect(t).toContain("Inspectable");
    expect(t).toContain("Not inspectable");
    expect(t).toContain("Gamma 24h volume");
    expect(t).not.toMatch(/liquidity/i);
    expect(markup).toMatch(/aria-selected="true"[^>]*>\s*<td><button[^>]*aria-pressed="true"/);
  });

  it("renders untrusted market text as plain text, never as HTML", () => {
    const evil = item("9", { question: `<img src=x onerror="alert(1)"><script>alert(2)</script>`, slug: "<b>slug</b>" });
    const markup = html(<MarketTable markets={[evil]} selectedId={null} onSelect={() => {}} />);
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });
});

describe("list states", () => {
  it("initial loading", () => {
    expect(body(initialState())).toContain("Loading V1 markets");
    expect(text(html(<App api={scriptedApi([]).api} clock={() => NOW} />))).toContain("Loading V1 markets");
  });

  it("empty page", () => {
    expect(body(loaded(page([])))).toContain("No open V1 markets returned");
  });

  it("no local matches, with the loaded scope", () => {
    const s = run([{ type: "filters", patch: { query: "zzz" } }], loaded());
    const t = body(s);
    expect(t).toContain("No loaded markets match");
    expect(t).toContain("Only the 3 loaded markets were searched");
  });

  it("first-page failures with retry guidance", () => {
    const failed = (error: ApiError) => run([{ type: "request", version: "v1", mode: "first", requestId: 1 }, { type: "failed", version: "v1", requestId: 1, error }]);
    expect(body(failed({ kind: "network" }))).toContain("Cannot reach the MarketMind server");
    expect(body(failed({ kind: "invalid_response", httpStatus: 200, issues: ["x"] }))).toContain("Unexpected response");
    const cooldown = body(failed(server("rate_limited", "LOCAL_COOLDOWN", { retryAfterMs: 45_000 })));
    expect(cooldown).toContain("Pausing after a Polymarket rate limit");
    expect(cooldown).toContain("Retry possible in about 45 s");
    expect(body(failed(server("budget_exhausted", "WINDOW_BUDGET_EXHAUSTED", { retryAfterMs: 300_000 })))).toContain("Retry possible in about 5 min");
    expect(body(failed(server("budget_exhausted", "PROCESS_BUDGET_EXHAUSTED", {}, false)))).toContain("Restart the MarketMind web server");
    expect(body(failed(server("upstream_unavailable", null, { kind: "Upstream5xx" })))).toContain("Polymarket is unavailable");
  });
});

describe("error notice", () => {
  it("disables retry until the server's retry time has passed, then enables it", () => {
    const error = server("budget_exhausted", "WINDOW_BUDGET_EXHAUSTED", { retryAfterMs: 10_000 });
    expect(html(<ErrorNotice error={error} now={NOW} onRetry={() => {}} />)).toMatch(/<button type="button" disabled="">Try again<\/button>/);
    const later = html(<ErrorNotice error={error} now={NOW + 10_000} onRetry={() => {}} />);
    expect(later).toMatch(/<button type="button">Try again<\/button>/);
    expect(text(later)).toContain("You can retry now");
  });

  it("offers no retry for the exhausted lifetime budget", () => {
    expect(html(<ErrorNotice error={server("budget_exhausted", "PROCESS_BUDGET_EXHAUSTED", {}, false)} now={NOW} onRetry={() => {}} />)).not.toContain("<button");
  });
});

describe("pager", () => {
  const feed = (p = page(range(1, 50), { nextCursor: "c2" })) => loaded(p).feeds.v1;

  it("offers load more while a cursor is available", () => {
    const t = html(<Pager feed={feed()} onLoadMore={() => {}} />);
    expect(text(t)).toContain("50 markets in 1 of at most 5 pages");
    expect(t).toMatch(/<button[^>]*>Load more<\/button>/);
  });

  it("states the end of results, the local cap and an unusable cursor differently", () => {
    expect(text(html(<Pager feed={feed(page([item("1")]))} onLoadMore={() => {}} />))).toContain(END_TEXT.last_page);
    expect(text(html(<Pager feed={{ ...feed(), pages: 5, end: "page_cap" }} onLoadMore={() => {}} />))).toContain("Local limit reached");
    expect(text(html(<Pager feed={feed(page([item("1")], { stoppedReason: "CURSOR_UNSUPPORTED" }))} onLoadMore={() => {}} />))).toContain(END_TEXT.cursor_unsupported);
  });

  it("disables load more while a page is loading and reports skipped records", () => {
    const busy = { ...feed(page(range(1, 50), { nextCursor: "c2", skipped: 2 })), loading: "more" as const, duplicates: 1 };
    const t = html(<Pager feed={busy} onLoadMore={() => {}} />);
    expect(t).toMatch(/<button[^>]*disabled=""[^>]*>Loading next page\.\.\.<\/button>/);
    expect(text(t)).toContain("1 repeated market skipped");
    expect(text(t)).toContain("2 invalid upstream records not shown");
  });
});

describe("header, controls and detail panel", () => {
  it("shows the research-only notice, connection state and remaining budget", () => {
    const t = text(html(<Header connection="connected" budget={page([item("1")], { used: 12 }).budget} />));
    expect(t).toContain("Research only · no trading");
    expect(t).toContain("Local server connected");
    expect(t).toContain("Requests left: 1,988 of 2,000 · 48 of 60 per 5 min");
    expect(text(html(<Header connection="unreachable" budget={null} />))).toContain("Request budget: not known yet");
  });

  it("labels every control and states that search is local", () => {
    const markup = html(<Controls version="v2" filters={DEFAULT_FILTERS} sort="volume" onVersion={() => {}} onFilters={() => {}} onSort={() => {}} />);
    expect(text(markup)).toContain("Search loaded markets");
    expect(markup).toMatch(/<input type="radio" name="version" checked="" value="v2"\/>/);
    for (const label of ["Order book enabled", "Accepting orders", "Inspectable only", "Question (A to Z)"]) expect(text(markup)).toContain(label);
  });

  it("shows selected-market metadata at once, before any inspection data", () => {
    const m = item("42", { question: "Selected?", negRisk: null, eligibility: { inspectable: true, reasons: [], warnings: ["LOW_VOLUME"] } });
    const t = text(html(detail({ market: m, selectedId: "42", inspection: emptyInspection("42") })));
    expect(t).toContain("Selected?");
    expect(t).toContain("Neg-risk Not reported");
    expect(t).toContain("LOW_VOLUME");
    expect(t).toContain("Nothing has been requested from Polymarket for this market yet");
    expect(t).not.toContain("Best bid");
    expect(t).not.toContain("Levels per side");
    expect(text(html(detail({})))).toContain("Select a market");
    expect(text(html(detail({ selectedId: "42" })))).toContain("not among the loaded markets");
  });

  it("renders a loaded app with scope text, freshness and the detail panel", () => {
    const s = run([{ type: "select", id: "2" }, { type: "filters", patch: { query: "market 2" } }], loaded());
    const t = text(html(<App api={scriptedApi([]).api} clock={() => NOW + 150_000} initial={s} />));
    expect(t).toContain("1 match among 3 loaded V1 markets");
    expect(t).toContain("search covers loaded markets only, not all of Polymarket");
    expect(t).toContain("Stale: fetched 2 min ago");
    expect(t).toContain("Synthetic market 2?");
    expect(t).toContain("cannot place trades");
  });
});

describe("interactions", () => {
  it("controls report search, version, eligibility, toggles and sort changes", () => {
    const calls: unknown[] = [];
    const tree = expand(
      <Controls version="v1" filters={DEFAULT_FILTERS} sort="volume" onVersion={(v) => calls.push(["version", v])} onFilters={(p) => calls.push(["filters", p])} onSort={(s) => calls.push(["sort", s])} />,
    );
    const inputs = findAll(tree, (e) => e.type === "input");
    const selects = findAll(tree, (e) => e.type === "select");
    call(inputs.find((e) => e.props.type === "search")!.props.onChange, { target: { value: "btc" } });
    call(inputs.find((e) => e.props.value === "v2")!.props.onChange);
    call(selects[0]!.props.onChange, { target: { value: "inspectable" } });
    call(selects[1]!.props.onChange, { target: { value: "question" } });
    const boxes = inputs.filter((e) => e.props.type === "checkbox");
    call(boxes[0]!.props.onChange, { target: { checked: true } });
    call(boxes[1]!.props.onChange, { target: { checked: true } });
    let prevented = false;
    call(findAll(tree, (e) => e.type === "form")[0]!.props.onSubmit, { preventDefault: () => (prevented = true) });
    expect(calls).toEqual([
      ["filters", { query: "btc" }],
      ["version", "v2"],
      ["filters", { eligibility: "inspectable" }],
      ["sort", "question"],
      ["filters", { orderBookEnabled: true }],
      ["filters", { acceptingOrders: true }],
    ]);
    expect(prevented).toBe(true);
  });

  it("table rows select, pager loads more, notices retry and clear, detail panel closes", () => {
    const events: string[] = [];
    call(button(expand(<MarketTable markets={[item("5")]} selectedId={null} onSelect={(id) => events.push(`select ${id}`)} />), "Synthetic market 5?").onClick);
    call(button(expand(<Pager feed={loaded(page(range(1, 50), { nextCursor: "c" })).feeds.v1} onLoadMore={() => events.push("more")} />), "Load more").onClick);
    call(button(expand(<ErrorNotice error={{ kind: "network" }} now={NOW} onRetry={() => events.push("retry")} />), "Try again").onClick);
    const s = run([{ type: "filters", patch: { query: "zzz" } }], loaded());
    call(button(expand(<ListBody state={s} visible={[]} now={NOW} onRetry={() => {}} onSelect={() => {}} onClear={() => events.push("clear")} />), "Clear search").onClick);
    call(button(expand(detail({ market: item("5"), selectedId: "5", onClose: () => events.push("close") })), "Back to markets").onClick);
    expect(events).toEqual(["select 5", "more", "retry", "clear", "close"]);
  });

  it("app buttons trigger only explicit requests: refresh, retry, load more and a version switch", () => {
    const { api, queries } = scriptedApi([]);
    const withMore = loaded(page(range(1, 50), { nextCursor: "next-cursor" }));
    const failedMore = run([{ type: "request", version: "v1", mode: "more", requestId: 50 }, { type: "failed", version: "v1", requestId: 50, error: { kind: "network" } }], withMore);
    const tree = appTree({ api, clock: () => NOW, initial: run([{ type: "select", id: "1" }], failedMore) });
    expect(queries).toEqual([]); // rendering alone requests nothing
    call(button(tree, "Retry next page").onClick);
    call(button(tree, "Load more").onClick); // the first click is already in flight
    expect(queries).toEqual([{ version: "v1", cursor: "next-cursor" }]);
    call(button(tree, "Refresh").onClick);
    expect(queries.at(-1)).toEqual({ version: "v1", cursor: null });
    const radio = findAll(tree, (e) => e.type === "input" && e.props.value === "v2")[0]!;
    call(radio.props.onChange);
    expect(queries.at(-1)).toEqual({ version: "v2", cursor: null });
    // Other handlers dispatch local state changes only.
    const before = queries.length;
    call(findAll(tree, (e) => e.type === "input" && e.props.type === "search")[0]!.props.onChange, { target: { value: "x" } });
    call(findAll(tree, (e) => e.type === "select")[1]!.props.onChange, { target: { value: "question" } });
    call(button(tree, "Synthetic market 1?").onClick);
    call(button(tree, "Back to markets").onClick);
    expect(queries).toHaveLength(before);
  });

  it("a failed first page offers an explicit retry in the app", () => {
    const { api, queries } = scriptedApi([]);
    const failed = run([{ type: "request", version: "v1", mode: "first", requestId: 1 }, { type: "failed", version: "v1", requestId: 1, error: { kind: "network" } }]);
    const tree = appTree({ api, clock: () => NOW, initial: failed });
    call(button(tree, "Try again").onClick);
    expect(queries).toEqual([{ version: "v1", cursor: null }]);
  });
});
