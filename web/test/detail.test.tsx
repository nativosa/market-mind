import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ApiError, Inspection } from "../src/api";
import { App } from "../src/App";
import { BookComparison } from "../src/components/BookComparison";
import { DetailPanel } from "../src/components/DetailPanel";
import { emptyInspection, initialState, reducer, type Action, type ExplorerState, type InspectionState } from "../src/explorer";
import type { RouteWindow } from "../src/route";
import { deepLevels, INSPECT_INVALID, INSPECT_V1, INSPECT_V2, inspected, item, NOW, page, scriptedApi, serverError, withOutcome } from "./fixtures";
import { appTree as renderTree, button, call, expand, findAll, html, text } from "./render";

// What the detail view shows for each inspection outcome, rendered to static HTML.

const appTree = (props: React.ComponentProps<typeof App>) => renderTree(props, App);
const done = (data: Inspection, receivedAt = NOW): InspectionState => ({ marketId: data.market.gammaId, requestId: 1, loading: false, error: null, result: { data, receivedAt } });
const failed = (error: ApiError, id = "100001"): InspectionState => ({ ...emptyInspection(id), requestId: 1, error });
const server = (httpStatus: number, category: string, code: string | null, details: Record<string, unknown> = {}, retryable = true): ApiError => ({
  kind: "server",
  httpStatus,
  error: serverError(category, code, details, retryable).error,
  receivedAt: NOW,
});

function detail(inspection: InspectionState, extra: Partial<React.ComponentProps<typeof DetailPanel>> = {}) {
  const id = inspection.marketId ?? "100001";
  return (
    <DetailPanel
      market={item(id, { question: "Listed question?" })}
      selectedId={id}
      inspection={inspection}
      depth={5}
      now={NOW}
      onInspect={() => {}}
      onCancel={() => {}}
      onDepth={() => {}}
      onClose={() => {}}
      {...extra}
    />
  );
}
const view = (inspection: InspectionState, extra: Partial<React.ComponentProps<typeof DetailPanel>> = {}) => text(html(detail(inspection, extra)));
const bookOf = (markup: string, label: string) => {
  const start = markup.indexOf(`>${label}</h4>`);
  expect(start, label).toBeGreaterThan(-1);
  const end = markup.indexOf("</article>", start);
  return markup.slice(start, end);
};
/** Prices of one ladder side, in rendered order. */
const ladderPrices = (bookMarkup: string, side: "Bids" | "Asks") => {
  const start = bookMarkup.indexOf(`<caption`, bookMarkup.indexOf(side === "Bids" ? ">Bids<" : ">Asks<") - 80);
  const table = bookMarkup.slice(start, bookMarkup.indexOf("</table>", start));
  return [...table.matchAll(/<td class="mono">([^<]+)<\/td>/g)].map((m) => m[1]);
};

describe("valid books", () => {
  it("V1: outcome labels and roles, exact bid/ask strings, sizes in shares, spread and midpoint", () => {
    const markup = html(detail(done(INSPECT_V1)));
    const t = text(markup);
    expect(t).toContain("Synthetic: Will the test suite pass?");
    expect(t).not.toContain("Listed question?"); // the inspection's metadata replaces the listing's
    expect(t).toContain("Outcomes Yes (Yes side) / No (No side)");
    const yes = text(bookOf(markup, "Yes"));
    expect(yes).toContain("Outcome 1 · Yes side");
    expect(yes).toContain("Quality: Valid");
    expect(yes).toContain("Two-sided");
    expect(yes).toContain("Best bid 0.036 117.97 shares");
    expect(yes).toContain("Best ask 0.037 3,500.66 shares");
    expect(yes).toContain("Spread 0.001");
    expect(yes).toContain("Midpoint 0.0365");
    expect(yes).toContain("Total bid depth (shares) 10,200,582.31");
    expect(yes).toContain("Bid depth within 0.05 of best 10,200,582.31");
    expect(yes).toContain("Tick size 0.001");
    expect(yes).toContain("Minimum order size (shares) 5");
    const no = text(bookOf(markup, "No"));
    expect(no).toContain("Outcome 2 · No side");
    expect(no).toContain("Best bid 0.963");
    expect(no).toContain("Best ask 0.964");
    expect(t).toContain("not dollars, and not a promise that an order of that size would fill");
    expect(t).not.toMatch(/\$\s?\d|liquidity available|profit of|you should (buy|sell)/i);
  });

  it("V2: team-name outcomes without Yes/No roles; an empty book is valid, not a failure", () => {
    const markup = html(detail(done(INSPECT_V2)));
    const alpha = text(bookOf(markup, "Team Alpha"));
    expect(alpha).toContain("No Yes/No role");
    expect(alpha).toContain("Quality: Valid");
    expect(alpha).toContain("Empty: no bids or asks");
    expect(alpha).toContain("Best bid No bids");
    expect(alpha).toContain("Spread Needs both a bid and an ask");
    expect(alpha).toContain("No bids in this book.");
    expect(alpha).toContain("No asks in this book.");
    expect(alpha).not.toMatch(/failed|cannot reach/i);
    const beta = text(bookOf(markup, "Team Beta"));
    expect(beta).toContain("Best bid 0.45 20 shares");
    expect(beta).toContain("Spread 0.1");
    expect(text(markup)).not.toMatch(/\bYes side\b/);
  });

  it("a one-sided book shows the side it has and withholds spread and midpoint", () => {
    const oneSided = withOutcome(INSPECT_V1, 0, (o) => ({
      ...o,
      metrics: { ...o.metrics!, bestAsk: null, bestAskSize: null, spread: null, midpoint: null, askDepth: "0", askDepthWithinBand: null, state: "bid-only" },
      levels: { ...o.levels, asks: [], totalAsks: 0 },
    }));
    const yes = text(bookOf(html(detail(done(oneSided))), "Yes"));
    expect(yes).toContain("One-sided: bids only");
    expect(yes).toContain("Best bid 0.036");
    expect(yes).toContain("Best ask No asks");
    expect(yes).toContain("Midpoint Needs both a bid and an ask");
    expect(yes).toContain("Ask depth within 0.05 of best No asks");
    expect(yes).toContain("No asks in this book.");
  });

  it("renders the ladder best price first, in the server's order, to the chosen depth", () => {
    const deep = withOutcome(INSPECT_V1, 0, (o) => ({ ...o, levels: deepLevels(20) }), { appliedLimits: { ...INSPECT_V1.appliedLimits, levels: 20 } });
    const whole = html(detail(done(deep)));
    const five = bookOf(whole, "Yes");
    expect(ladderPrices(five, "Bids")).toEqual(["0.50", "0.49", "0.48", "0.47", "0.46"]);
    expect(ladderPrices(five, "Asks")).toEqual(["0.51", "0.52", "0.53", "0.54", "0.55"]);
    expect(text(five)).toContain("Showing 5 of 23 bid levels and 5 of 23 ask levels. Best price first, same-price orders added together.");
    expect(five).toContain("100.5"); // sizes unchanged
    const ten = bookOf(html(detail(done(deep), { depth: 10 })), "Yes");
    expect(ladderPrices(ten, "Bids")).toHaveLength(10);
    expect(ladderPrices(ten, "Bids")[9]).toBe("0.41");
    // Bars share one scale across both books (the largest shown size is the No book's 3,500.66);
    // widths are approximate and only in style attributes.
    expect(whole).toContain('style="width:100%"');
    expect(five).toContain('style="width:2.9%"');
  });

  it("offers ladder depths up to the API maximum that was applied", () => {
    const options = (data: Inspection) => [...html(<BookComparison inspection={data} depth={5} onDepth={() => {}} />).matchAll(/<option[^>]*value="(\d+)"/g)].map((m) => m[1]);
    expect(options({ ...INSPECT_V1, appliedLimits: { ...INSPECT_V1.appliedLimits, levels: 20 } })).toEqual(["5", "10", "20"]);
    expect(options(INSPECT_V1)).toEqual(["2"]); // the golden result was made with levels=2
    const depths: number[] = [];
    const tree = expand(<BookComparison inspection={INSPECT_V1} depth={5} onDepth={(d) => depths.push(d)} />);
    call(findAll(tree, (e) => e.type === "select")[0]!.props.onChange, { currentTarget: { value: "10" } });
    expect(depths).toEqual([10]);
  });

  it("flags crossed and locked books", () => {
    const crossed = withOutcome(INSPECT_V1, 0, (o) => ({ ...o, quality: "suspicious", issues: [{ code: "CROSSED_BOOK", severity: "warning" }], metrics: { ...o.metrics!, crossed: true } }));
    const t = text(bookOf(html(detail(done(crossed))), "Yes"));
    expect(t).toContain("Quality: Suspicious");
    expect(t).toContain("CROSSED_BOOK (warning) The best bid is above the best ask.");
    expect(t).toContain("Crossed book: the best bid is above the best ask.");
    const locked = withOutcome(INSPECT_V1, 0, (o) => ({ ...o, metrics: { ...o.metrics!, locked: true } }));
    expect(text(html(detail(done(locked))))).toContain("Locked book: the best bid equals the best ask.");
  });

  it("shows missing book metadata as not reported", () => {
    const sparse = withOutcome(INSPECT_V1, 1, (o) => ({
      ...o,
      quality: "incomplete",
      issues: [{ code: "MISSING_TICK_SIZE", severity: "warning" }],
      book: { ...o.book, tickSize: null, minOrderSize: null, lastTradePrice: null, serverTimestamp: { raw: null, iso: null } },
    }));
    const markup = html(detail(done(sparse)));
    const no = text(bookOf(markup, "No"));
    expect(no).toContain("Quality: Incomplete metadata");
    expect(no).toContain("Tick size Not reported");
    expect(no).toContain("Minimum order size (shares) Not reported");
    expect(text(markup)).toContain("No book: Polymarket timestamp Not reported");
  });
});

describe("invalid books", () => {
  it("withholds the invalid book's metrics and ladder, keeps the valid one, and says why", () => {
    const markup = html(detail(done(INSPECT_INVALID)));
    const t = text(markup);
    expect(t).toContain("At least one order book is invalid");
    const no = text(bookOf(markup, "No"));
    expect(no).toContain("Quality: Invalid");
    expect(no).toContain("MALFORMED_PRICE (error) A price level is not a valid decimal.");
    expect(no).toContain("Metrics withheld");
    expect(no).not.toMatch(/Best bid|Spread|Midpoint|Total bid depth|Showing \d+ of/);
    const yes = text(bookOf(markup, "Yes"));
    expect(yes).toContain("Best bid 0.4");
    expect(yes).toContain("Spread 0.05");
  });
});

describe("loading, cancellation and errors", () => {
  it("loading shows a skeleton and a cancel button, and the metadata stays", () => {
    const events: string[] = [];
    const loading: InspectionState = { ...emptyInspection("100001"), requestId: 1, loading: true };
    const t = view(loading);
    expect(t).toContain("Listed question?");
    expect(t).toContain("Inspecting the order books");
    expect(html(detail(loading))).toContain('aria-busy="true"');
    call(button(expand(detail(loading, { onCancel: () => events.push("cancel") })), "Cancel").onClick);
    expect(events).toEqual(["cancel"]);
  });

  it("a cancelled inspection says so and offers an explicit new one", () => {
    const events: string[] = [];
    const cancelled = failed({ kind: "aborted" });
    expect(view(cancelled)).toContain("Inspection cancelled");
    call(button(expand(detail(cancelled, { onInspect: () => events.push("inspect") })), "Inspect order books").onClick);
    expect(events).toEqual(["inspect"]);
  });

  it("an unknown market and an ineligible market are clear, final errors", () => {
    const missing = view(failed(server(404, "market_not_found", null, {}, false)));
    expect(missing).toContain("Inspection failed: Polymarket has no market with this ID");
    expect(missing).not.toContain("Try again");
    const ineligible = view(failed(server(422, "market_ineligible", null, { issues: ["order book is not enabled", 7] }, false), "77"));
    expect(ineligible).toContain("This market cannot be inspected");
    expect(ineligible).toContain("Reported reasons order book is not enabled");
    expect(ineligible).not.toContain("Try again");
  });

  it("network failures and invalid responses can be retried explicitly", () => {
    const events: string[] = [];
    const net = failed({ kind: "network" });
    expect(view(net)).toContain("Cannot reach the MarketMind server");
    call(button(expand(detail(net, { onInspect: () => events.push("retry") })), "Try again").onClick);
    expect(events).toEqual(["retry"]);
    expect(view(failed({ kind: "invalid_response", httpStatus: 200, issues: ["outcomes: required"] }))).toContain("Unexpected response");
  });

  it("window budget, lifetime budget and rate-limit cooldown are distinct, with retry timing", () => {
    const windowed = view(failed(server(429, "budget_exhausted", "WINDOW_BUDGET_EXHAUSTED", { retryAfterMs: 90_000 })));
    expect(windowed).toContain("Request budget for the last 5 minutes is used up");
    expect(windowed).toContain("Retry possible in about 2 min");
    expect(html(detail(failed(server(429, "budget_exhausted", "WINDOW_BUDGET_EXHAUSTED", { retryAfterMs: 90_000 }))))).toMatch(/<button type="button" disabled="">Try again<\/button>/);
    const lifetime = view(failed(server(503, "budget_exhausted", "PROCESS_BUDGET_EXHAUSTED", {}, false)));
    expect(lifetime).toContain("This server's request budget is used up");
    expect(lifetime).not.toContain("Try again");
    const cooldown = view(failed(server(503, "rate_limited", "LOCAL_COOLDOWN", { retryAfterMs: 40_000 })));
    expect(cooldown).toContain("Pausing after a Polymarket rate limit");
    expect(cooldown).toContain("Retry possible in about 40 s");
  });

  it("a market the listing marks as not inspectable is not requested, but can be checked on request", () => {
    const notInspectable = item("77", { eligibility: { inspectable: false, reasons: ["order book is not enabled"], warnings: [] } });
    const t = view(emptyInspection("77"), { market: notInspectable, selectedId: "77" });
    expect(t).toContain("Why it cannot be inspected order book is not enabled");
    expect(t).toContain("Order books were not requested");
    expect(t).toContain("Check with Polymarket anyway");
  });

  it("a market outside the loaded list (opened from the address) waits for an explicit inspection", () => {
    const t = view(emptyInspection("555"), { market: null, selectedId: "555" });
    expect(t).toContain("Market 555");
    expect(t).toContain("not among the loaded markets");
    expect(t).toContain("Inspect order books");
  });
});

describe("refresh, freshness and provenance", () => {
  it("refresh is a button; while refreshing the earlier result stays and can be cancelled", () => {
    const events: string[] = [];
    const t = view(done(INSPECT_V1));
    expect(t).toContain("Refresh inspection");
    expect(t).toContain("nothing refreshes on its own");
    call(button(expand(detail(done(INSPECT_V1), { onInspect: () => events.push("refresh") })), "Refresh inspection").onClick);
    const refreshing = { ...done(INSPECT_V1), loading: true };
    const markup = html(detail(refreshing));
    expect(markup).toMatch(/<button type="button" disabled="">Refreshing…<\/button>/);
    expect(text(markup)).toContain("Best bid 0.036");
    call(button(expand(detail(refreshing, { onCancel: () => events.push("cancel") })), "Cancel").onClick);
    expect(events).toEqual(["refresh", "cancel"]);
  });

  it("a failed or cancelled refresh keeps the earlier result and says so", () => {
    const refreshFailed = { ...done(INSPECT_V1), error: server(502, "upstream_unavailable", null, { kind: "Upstream5xx" }) };
    const t = view(refreshFailed);
    expect(t).toContain("Refresh failed, the earlier result is shown: Polymarket is unavailable");
    expect(t).toContain("Best bid 0.036");
    expect(view({ ...done(INSPECT_V1), error: { kind: "aborted" } })).toContain("Refresh cancelled");
  });

  it("labels local and upstream times separately, the pair skew, request cost and staleness", () => {
    const fresh = view(done(INSPECT_V1, NOW), { now: NOW + 5_000 });
    expect(fresh).toContain("Inspected just now.");
    expect(fresh).toContain("Answer generated by the local server 2026-10-29 12:00:00.000 UTC");
    expect(fresh).toContain("Yes book: Polymarket timestamp 2026-10-28 21:05:37.744 UTC");
    expect(fresh).toContain("No book: Polymarket timestamp 2026-10-28 21:05:37.751 UTC");
    expect(fresh).toContain("Yes book: received by the local server");
    expect(fresh).toContain("Gap between the two book responses 10 ms");
    expect(fresh).toContain("separate requests made one after another, not an atomic snapshot");
    expect(fresh).toContain("an old timestamp alone does not prove a book is stale");
    expect(fresh).toContain("Requests to Polymarket for this inspection 4 of at most 8");
    expect(fresh).toContain("Requests made (4)");
    const stale = view(done(INSPECT_V1, NOW), { now: NOW + 3 * 60_000 });
    expect(stale).toContain("Stale: inspected 3 min ago. Refresh to observe the books again.");
    const skewed = view(done({ ...INSPECT_V1, pairSkewMs: 7_250 }));
    expect(skewed).toContain("7,250 ms (more than 5,000 ms)");
  });

  it("shows pairing status, the evidence note, limitations and the research-only disclaimer", () => {
    const t = view(done(INSPECT_V1));
    expect(t).toContain("Outcome pairing Tokens paired from Polymarket's CLOB market record; Gamma's outcome order agrees");
    expect(t).toContain("Metadata from the latest inspection");
    expect(t).toContain("Research only. MarketMind cannot place orders and recommends none.");
    expect(t).toContain(INSPECT_V1.evidenceNote);
    for (const limitation of INSPECT_V1.limitations) expect(t).toContain(limitation);
  });

  it("renders untrusted labels and questions as text", () => {
    const evil = withOutcome(INSPECT_V1, 0, (o) => ({ ...o, label: "<img src=x onerror=alert(1)>" }), { market: { ...INSPECT_V1.market, question: "<script>alert(1)</script>" } });
    const markup = html(detail(done(evil)));
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });
});

describe("layout and accessibility", () => {
  it("is keyboard reachable: a back button, a focusable heading, labelled controls and table captions", () => {
    const markup = html(detail(done(INSPECT_V1)));
    expect(markup).toMatch(/<button type="button"[^>]*><span aria-hidden="true">← <\/span>Back to markets<\/button>/);
    expect(markup).toMatch(/<h2 id="market-detail-heading"[^>]*tabindex="-1"/);
    expect(markup).toMatch(/<label[^>]*for="ladder-depth"[^>]*>Levels per side<select id="ladder-depth"/);
    expect(markup).toContain('aria-labelledby="outcome-book-0"');
    expect(markup).toContain('<h4 id="outcome-book-0"');
    expect(text(markup)).toContain("Bids for Yes, best price first");
    expect(markup).toContain('<th scope="col">Price</th>');
    // Colour is never the only signal: sides and quality are written out.
    expect(text(markup)).toContain("Quality: Valid");
  });

  it("stacks two book panels on narrow screens and hides the list behind the details below 1080px", () => {
    const css = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    expect(css("components/BookComparison.module.css")).toMatch(/\.books \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 280px\), 1fr\)\)/);
    const app = css("App.module.css");
    expect(app).toMatch(/@media \(max-width: 1080px\)[\s\S]*\.selecting \.listColumn \{\s*display: none;/);
    expect(app).toMatch(/\.selecting \.main \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1\.15fr\);/);
  });
});

describe("app integration", () => {
  const loadedState = (): ExplorerState =>
    (
      [
        { type: "request", version: "v1", mode: "first", requestId: 1 },
        { type: "loaded", version: "v1", requestId: 1, page: page([item("100001"), item("2")]), receivedAt: NOW },
      ] as Action[]
    ).reduce(reducer, initialState());

  function fakeWindow(hash = "") {
    const added: string[] = [];
    const win: RouteWindow = { location: { hash }, addEventListener: () => added.push("hashchange"), removeEventListener: () => undefined };
    return { win, added };
  }

  it("clicking a market inspects it once, routes to it, and touches only the local /api", () => {
    const { api, queries, inspections } = scriptedApi([], undefined, [inspected(INSPECT_V1)]);
    const { win } = fakeWindow();
    const tree = appTree({ api, clock: () => NOW, initial: loadedState(), routeWindow: win });
    expect(inspections).toEqual([]); // rendering alone requests nothing
    call(button(tree, "Synthetic market 100001?").onClick);
    expect(inspections).toEqual([{ marketId: "100001", levels: 20 }]);
    expect(win.location.hash).toBe("#/market/100001");
    expect(queries).toEqual([]);
  });

  it("the open detail view wires refresh, cancel, depth and back to the controller and route", () => {
    const { api, inspections } = scriptedApi([]);
    const { win } = fakeWindow("#/market/100001");
    const state = reducer(reducer(reducer(loadedState(), { type: "select", id: "100001" }), { type: "inspect_request", id: "100001", requestId: 5 }), {
      type: "inspected",
      requestId: 5,
      data: INSPECT_V1,
      receivedAt: NOW,
    });
    const tree = appTree({ api, clock: () => NOW, initial: state, routeWindow: win });
    call(button(tree, "Refresh inspection").onClick);
    expect(inspections).toEqual([{ marketId: "100001", levels: 20 }]);
    call(findAll(tree, (e) => e.type === "select" && e.props.id === "ladder-depth")[0]!.props.onChange, { currentTarget: { value: "10" } });
    call(button(tree, "Back to markets").onClick);
    expect(win.location.hash).toBe("#/");
    expect(inspections).toHaveLength(1);
  });

  it("renders without a window (no routing) and with a market route that is not yet inspected", () => {
    const t = text(html(<App api={scriptedApi([]).api} clock={() => NOW} initial={reducer(loadedState(), { type: "select", id: "2" })} routeWindow={null} />));
    expect(t).toContain("Not inspected yet");
    const tree = appTree({ api: scriptedApi([]).api, clock: () => NOW, initial: reducer(loadedState(), { type: "select", id: "2" }), routeWindow: null });
    call(button(tree, "Back to markets").onClick);
  });
});
