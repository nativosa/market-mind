import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebHistoryOutput } from "../../src/research/contracts";
import type { History, HistoryItem } from "../src/api";
import { CHART, depthBandOf, exactExtent, gapIntervals, linearScale, marks, nearestIndex, position, referenceLabels, segments, timeScale, valueScale } from "../src/chart";
import { HistoryCharts, TimeChart } from "../src/components/HistoryCharts";
import { AnalysisWindowNote, HistoryStats } from "../src/components/HistoryStats";
import { MarketHistory } from "../src/components/MarketHistory";
import { flagTexts, ObservationTable, pageOf, TABLE_PAGE_SIZE } from "../src/components/ObservationTable";
import { initialHistoryState, type HistoryState } from "../src/history";
import type { HistoryRoute } from "../src/route";
import { NOW } from "./fixtures";
import { cleanupHistory, EXACT_SIZE, MINUTE, ok, SEED_TIMEOUT_MS, sharedHistory, storedServer } from "./historyFixtures";
import { appTree, button, call, expand, findAll, html, text } from "./render";

// Stage 3.2 Commit 5: the market dashboard's statistics, SVG charts and observation table, rendered
// from real API answers over a temporary database. Text values must be the stored exact strings.

let live: History;
let all: History;
let single: History;
let ids: Record<"first" | "second" | "unpaired" | "invalid" | "oneSided" | "regular" | "afterGap" | "synthetic" | "syntheticOnly" | "single", number>;
beforeAll(async () => {
  const seeded = sharedHistory();
  ids = seeded.ids;
  const server = await storedServer(seeded.path);
  live = ok(await server.api.history("1", {}));
  all = ok(await server.api.history("1", { source: "all" }));
  single = ok(await server.api.history("3", {}));
  expect(server.urls).toEqual([]);
}, SEED_TIMEOUT_MS);
afterAll(cleanupHistory);

const charts = (h: History, selectedId: number | null = null, onSelect: (id: number) => void = () => {}) =>
  html(<HistoryCharts items={h.series.items} spreadThreshold={h.appliedLimits.spreadThreshold} selectedId={selectedId} onSelect={onSelect} />);
const pathsOf = (markup: string) => [...markup.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]!);

/** `count` copies of a usable item, one minute apart, newest first, revalidated against the contract. */
function bigSeries(base: History, count: number): History {
  const template = base.series.items.find((i) => i.flags.notUsable === null)!;
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const items: HistoryItem[] = Array.from({ length: count }, (_, k) => {
    const n = count - 1 - k;
    return { ...template, observationId: n + 1, availableAt: new Date(t0 + n * MINUTE).toISOString(), metrics: { ...template.metrics!, spread: `0.${String(1 + (n % 9))}` } };
  });
  return WebHistoryOutput.parse({
    ...base,
    series: { ...base.series, items, returnedCount: count, windowObservations: 5_000, truncated: true, oldestAvailableAt: items.at(-1)!.availableAt, newestAvailableAt: items[0]!.availableAt },
    analysisWindow: { ...base.analysisWindow!, observations: 5_000 },
  });
}

describe("chart geometry", () => {
  it("places only finite numbers; malformed or extreme values are not placed", () => {
    expect(position("0.45")).toBe(0.45);
    expect(position(null)).toBeNull();
    expect(position("abc")).toBeNull();
    expect(position(`1${"0".repeat(400)}`)).toBeNull();
  });

  it("scales stay inside the plot for constant, inverted, non-finite and extreme domains", () => {
    const constant = linearScale(0.5, 0.5, 10, 110);
    expect(constant(0.5)).toBe(60);
    const zero = linearScale(0, 0, 0, 100);
    expect(zero(0)).toBe(50);
    const s = linearScale(0, 1, 100, 0);
    expect(s(0.25)).toBe(75);
    expect(s(1e300)).toBe(0);
    expect(s(-1e300)).toBe(100);
    expect(s(Number.NaN)).toBe(50);
    const broken = linearScale(Number.NaN, Number.POSITIVE_INFINITY, 0, 10);
    expect(broken.domain).toEqual([0, 1]);
    expect(valueScale([null, "x"])).toBeNull();
    expect(valueScale(["0.3"])!(0.3)).toBeCloseTo((CHART.plotBottom + CHART.top) / 2, 9);
  });

  it("the x axis is the observations' actual times; one observation is centred", () => {
    const x = timeScale(live.series.items);
    expect(x.domain[0]).toBe(Date.parse(live.series.oldestAvailableAt!));
    expect(x.domain[1]).toBe(Date.parse(live.series.newestAvailableAt!));
    expect(timeScale(single.series.items)(Date.parse(single.series.items[0]!.availableAt))).toBe(CHART.width / 2);
    expect(timeScale([]).domain).toEqual([0, 1]);
  });

  it("range labels are exact decimal strings, compared exactly", () => {
    // 100.000000000000000001 > 100.0000000000000000009: floating point cannot tell these apart.
    expect(exactExtent(["0.1", "100.0000000000000000009", EXACT_SIZE, "100", null])).toEqual({ min: "0.1", max: EXACT_SIZE });
    expect(exactExtent([null])).toBeNull();
  });

  it("finds the nearest observation by time", () => {
    expect(nearestIndex([], 5)).toBe(-1);
    expect(nearestIndex([10, 20, 30], 24)).toBe(1);
    expect(nearestIndex([10, 20, 30], 26)).toBe(2);
    expect(nearestIndex([10, 20, 30], -100)).toBe(0);
    expect(nearestIndex([10, 20, 30], 1e9)).toBe(2);
  });

  it("marks are separate sub-paths: one move per point, never a line between observations", () => {
    const pts = [
      { x: 1, y: 2 },
      { x: 3, y: Number.NaN },
      { x: 5, y: 6 },
    ];
    for (const shape of ["dot", "square", "tick", "cross", "diamond"] as const) {
      const d = marks(pts, shape);
      expect(d.match(/M/g)).toHaveLength(2);
      expect(d).not.toMatch(/NaN|Infinity|L/);
    }
    expect(segments([{ x: 1, y0: 2, y1: 3 }, { x: Number.POSITIVE_INFINITY, y0: 0, y1: 1 }])).toBe("M1 2V3");
  });

  it("gap bands come only from the server's irregular-gap flags", () => {
    const gaps = gapIntervals(live.series.items);
    expect(gaps).toEqual([{ id: ids.afterGap, from: Date.parse(live.series.items[0]!.availableAt) - 30 * MINUTE, to: Date.parse(live.series.items[0]!.availableAt) }]);
    expect(live.series.items.filter((i) => i.flags.irregularGap)).toHaveLength(live.stats!.gaps.irregular);
  });

  it("band depth is charted only when every usable observation used the same band", () => {
    expect(depthBandOf(live.series.items)).toEqual({ band: "0.05", bands: ["0.05"] });
    const mixed = live.series.items.map((i, k) => (i.metrics && k === 0 ? { ...i, metrics: { ...i.metrics, depthBand: "0.1" } } : i));
    expect(depthBandOf(mixed)).toEqual({ band: null, bands: ["0.05", "0.1"] });
    const missing = live.series.items.map((i, k) => (i.metrics && k === 0 ? { ...i, metrics: { ...i.metrics, depthBand: null } } : i));
    expect(depthBandOf(missing)).toEqual({ band: null, bands: ["0.05", "none"] });
    expect(referenceLabels(live.series.items)).toEqual(["Yes"]);
  });
});

describe("charts", () => {
  it("render discrete marks with no invalid coordinates, unusable samples on the rug and one gap band", () => {
    const markup = charts(all);
    expect(markup).not.toMatch(/NaN|Infinity/);
    expect(markup).not.toMatch(/<polyline|<line[^>]*class="[^"]*span/);
    // Three unusable observations (unpaired, invalid book, one-sided) are crosses on each chart's rug.
    const rugs = [...markup.matchAll(/class="[^"]*rug[^"]*" d="([^"]*)"/g)].map((m) => m[1]!).filter((d) => d.length > 0 && d.split("M").length > 2);
    expect(rugs.map((d) => (d.match(/M/g) ?? []).length)).toEqual([3, 3, 3]);
    expect(markup.match(/<rect[^>]*class="[^"]*gap/g)).toHaveLength(3);
    const t = text(markup);
    expect(t).toContain("Best bid and ask, with midpoint (reference outcome: Yes)");
    expect(t).toContain("Plotted values from 0.03 to 0.8 · Dashed line: threshold: 0.02");
    expect(t).toContain("Plotted values from 5 to 120");
    expect(t).toContain("Bid depth within 0.05 of best");
    expect(t).toContain("not executable liquidity");
    expect(t).toContain("Synthetic observation");
  });

  it("synthetic observations get their own hollow marks; live-only shows none", () => {
    const hollow = (markup: string) => [...markup.matchAll(/class="[^"]*hollow[^"]*" d="([^"]+)"/g)].map((m) => m[1]!);
    expect(hollow(charts(all)).length).toBeGreaterThan(0);
    expect(hollow(charts(live)).filter((d) => d.split("M").length > 2)).toEqual([]);
  });

  it("one observation and constant values render centred, without errors", () => {
    const markup = charts(single);
    expect(markup).not.toMatch(/NaN|Infinity/);
    expect(pathsOf(markup).some((d) => d.includes("320"))).toBe(true);
    expect(text(markup)).toContain("Plotted values from 0.05 to 0.05");
  });

  it("no usable value: the charts say so", () => {
    const none = live.series.items.filter((i) => i.flags.notUsable !== null);
    const t = text(html(<HistoryCharts items={none} spreadThreshold="0.02" selectedId={null} onSelect={() => {}} />));
    expect(t).toContain("No usable value to plot.");
  });

  it("mixed depth bands: band depth is not charted and the reason is given", () => {
    const items = live.series.items.map((i, k) => (i.metrics && k === 0 ? { ...i, metrics: { ...i.metrics, depthBand: "0.1" } } : i));
    const t = text(html(<HistoryCharts items={items} spreadThreshold="0.02" selectedId={null} onSelect={() => {}} />));
    expect(t).not.toContain("within 0.05 of best");
    expect(t).toContain("used different depth bands (0.05, 0.1)");
  });

  it("2,000 plotted observations render as a bounded number of paths", () => {
    const big = bigSeries(live, 2_000);
    const started = performance.now();
    const markup = charts(big);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(markup).not.toMatch(/NaN|Infinity/);
    expect(markup.match(/<path/g)!.length).toBeLessThan(60);
  });

  it("a click selects the nearest observation, in viewBox coordinates", () => {
    const selected: number[] = [];
    const items = [...live.series.items].reverse();
    const tree = expand(<TimeChart id="t" title="T" items={items} series={[]} selectedId={null} onSelect={(id) => selected.push(id)} />);
    const hit = findAll(tree, (e) => e.type === "rect" && typeof e.props.onClick === "function")[0]!;
    const click = (clientX: number, width = 320) => call(hit.props.onClick, { clientX, currentTarget: { getBoundingClientRect: () => ({ left: 0, width }) } });
    click(320); // right edge: the newest observation
    click(0); // left edge: the oldest
    click(10, 0); // not laid out: ignored
    expect(selected).toEqual([items.at(-1)!.observationId, items[0]!.observationId]);
  });

  it("marks the selected observation on every chart", () => {
    expect(charts(live, ids.regular).match(/class="[^"]*selection/g)).toHaveLength(3);
    expect(charts(live, 999_999)).not.toMatch(/class="[^"]*selection/);
  });
});

describe("statistics and analysis window", () => {
  const stats = (h: History) => text(html(<HistoryStats stats={h.stats!} window={h.analysisWindow!} threshold={h.appliedLimits.spreadThreshold} />));

  it("shows the server's statistics as exact strings with their sample counts", () => {
    const t = stats(all);
    expect(t).toContain("5 of 8");
    expect(t).toContain("Not usable: 1 because only one of the two books was received; 1 because a book failed validation; 1 because the reference book was one-sided or empty.");
    expect(t).toContain("Latest spread 0.8 Previous 0.03 · change 0.77 (latest two usable samples)");
    expect(t).toContain("0.03 to 0.8 Median 0.05 over 5 usable samples");
    expect(t).toContain("5 of 5 usable samples 100% of samples, not of time");
    expect(t).toContain("Previous 60 · change -55 (2 usable samples)");
    expect(t).toContain("5 Changes of book contents");
    expect(t).toContain("Median 120,000 ms (about 2 min)");
    expect(t).toContain("1 irregular (longer than twice the median)");
    expect(t).toContain("2026-10-28 21:05:12.110 UTC");
  });

  it("live-only and live + synthetic statistics differ: the server applied the filter", () => {
    expect(live.stats!.usable).toBe(4);
    expect(stats(live)).toContain("Latest spread 0.03");
    expect(all.appliedLimits.source).toBe("all");
  });

  it("states what statistics and charts use, and the gap when the series is truncated", () => {
    const t = text(html(<AnalysisWindowNote history={all} />));
    expect(t).toContain("Statistics use all 8 observations of the analysis window (the newest up to 20,000)");
    expect(t).toContain("Charts and table show all 8 of those 8 (at most 2,000 are plotted): 7 live and 1 synthetic.");
    expect(t).not.toContain("Plotted:");
    const truncated = text(html(<AnalysisWindowNote history={bigSeries(live, 2_000)} />));
    expect(truncated).toContain("Charts and table show the newest 2,000 of those 5,000");
    expect(truncated).toContain("Plotted: 2,000 observations · Analysed: 5,000 observations.");
    const capped = text(html(<AnalysisWindowNote history={{ ...live, analysisWindow: { ...live.analysisWindow!, truncated: true } }} />));
    expect(capped).toContain("Older stored observations exist and are not included.");
    expect(html(<AnalysisWindowNote history={{ ...live, analysisWindow: null }} />)).toBe("");
  });
});

describe("observation table", () => {
  const table = (h: History, selectedId: number | null = null) => text(html(<ObservationTable items={h.series.items} selectedId={selectedId} onSelect={() => {}} />));

  it("lists every plotted observation newest first with exact values, provenance, quality and flags", () => {
    const t = table(all);
    const order = all.series.items.map((i) => `#${i.observationId}`);
    expect(order[0]).toBe(`#${ids.synthetic}`);
    let last = -1;
    for (const id of order) {
      const at = t.indexOf(id);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
    expect(t).toContain(EXACT_SIZE);
    expect(t).toContain("Synthetic");
    expect(t).toContain("Not usable only one of the two books was received");
    expect(t).toContain("Not usable a book failed validation");
    expect(t).toContain("Yes: Invalid · No: Valid");
    expect(t).toContain("Irregular gap 1,800,000 ms");
    expect(t).toContain("One book missing");
    expect(t).toContain("Rows 1 to 8 of 8 · page 1 of 1");
  });

  it("missing values are not reported, never zero", () => {
    const t = table(live);
    const invalidRow = t.slice(t.indexOf(`#${ids.invalid}`), t.indexOf(`#${ids.second}`));
    expect(invalidRow).toContain("Not reported");
    expect(invalidRow).not.toMatch(/\b0\.00?\b/);
  });

  it("pages within the bounded series and opens on the selected observation's page", () => {
    const big = bigSeries(live, 2_000);
    expect(pageOf(big.series.items, 1)).toBe(Math.floor(1_999 / TABLE_PAGE_SIZE));
    expect(pageOf(big.series.items, null)).toBeNull();
    expect(pageOf(big.series.items, 123_456)).toBeNull();
    expect(table(big)).toContain("Rows 1 to 50 of 2,000 · page 1 of 40");
    expect(table(big, 1)).toContain("Rows 1,951 to 2,000 of 2,000 · page 40 of 40");
    const tree = appTree({ items: big.series.items, selectedId: null, onSelect: () => {} }, ObservationTable);
    expect(button(tree, "Newer").disabled).toBe(true);
    expect(button(tree, "Older").disabled).toBe(false);
  });

  it("selecting a row reports its observation", () => {
    const chosen: number[] = [];
    const tree = appTree({ items: live.series.items, selectedId: ids.regular, onSelect: (id: number) => chosen.push(id) }, ObservationTable);
    const opener = findAll(tree, (e) => e.type === "button" && e.props.id === `observation-${ids.oneSided}`)[0]!;
    call(opener.props.onClick);
    expect(chosen).toEqual([ids.oneSided]);
    expect(html(<ObservationTable items={live.series.items} selectedId={ids.regular} onSelect={() => {}} />)).toMatch(/aria-selected="true"[^>]*>\s*<td><button[^>]*aria-pressed="true"/);
  });

  it("describes the server's row flags in words", () => {
    const item = live.series.items[0]!;
    expect(flagTexts({ ...item, association: "not_attempted", flags: { ...item.flags, unchanged: true, irregularGap: false, gapMs: 60_000, changes: ["QUESTION_CHANGED", "NEW_CODE"] } })).toEqual([
      "Token pairing not attempted",
      "Same books as the previous usable sample",
      "Gap 60,000 ms",
      "Question changed",
      "NEW_CODE",
    ]);
    expect(flagTexts({ ...item, pairing: "none", flags: { ...item.flags, gapMs: null, irregularGap: false } })).toEqual(["No books"]);
  });
});

describe("market dashboard", () => {
  const route = (observationId: number | null = null): Extract<HistoryRoute, { page: "market" }> => ({ section: "history", page: "market", marketId: "1", observationId, source: null });
  const withHistory = (h: History | null, patch: Partial<HistoryState["history"]> = {}): HistoryState => ({
    ...initialHistoryState(),
    history: { key: "1|default", requestId: 1, loading: false, data: h, receivedAt: NOW, error: null, ...patch },
  });

  it("composes the question, window note, statistics, charts, table and limitations", () => {
    const markup = html(<MarketHistory state={withHistory(live)} route={route()} now={NOW} onRetry={() => {}} onRetryObservation={() => {}} onRoute={() => {}} />);
    const t = text(markup);
    expect(markup).not.toContain("<img");
    expect(t).toContain("Will market 1 resolve Yes?");
    expect(t).toContain("Statistics (sample counts, not time)");
    expect(t).toContain("Observations, newest first");
    expect(t).toContain("What this history cannot tell you");
    expect(t).toContain("Statistics count samples, not time");
    expect(t).toContain("v1 (metrics of other versions are never mixed in)");
  });

  it("selecting an observation navigates to its address, keeping market and source", () => {
    const routes: HistoryRoute[] = [];
    // Shallow: the body element carries the selection handler the charts and the table receive.
    const tree = MarketHistory({ state: withHistory(live), route: { ...route(), source: "live" }, now: NOW, onRetry: () => {}, onRetryObservation: () => {}, onRoute: (r) => routes.push(r) });
    call(findAll(tree, (e) => typeof e.props.onSelect === "function")[0]!.props.onSelect, ids.second);
    expect(routes).toEqual([{ section: "history", page: "market", marketId: "1", observationId: ids.second, source: "live" }]);
  });

  it("no history and no usable observation are stated as insufficient evidence", () => {
    const none = WebHistoryOutput.parse({ ...live, status: "no_history", evidence: "insufficient", analysisWindow: null, stats: null, series: { ...live.series, items: [], returnedCount: 0, windowObservations: 0, oldestAvailableAt: null, newestAvailableAt: null, sourceCounts: { live: 0, synthetic: 0 } } });
    const t = text(html(<MarketHistory state={withHistory(none)} route={route()} now={NOW} onRetry={() => {}} onRetryObservation={() => {}} onRoute={() => {}} />));
    expect(t).toContain("No stored observations of this market");
    expect(t).toContain("insufficient evidence, not evidence that nothing happened");
    expect(t).toContain("appear only with Live + synthetic");
    const unusable = WebHistoryOutput.parse({
      ...live,
      evidence: "insufficient",
      stats: { ...live.stats!, usable: 0 },
      series: { ...live.series, items: live.series.items.filter((i) => i.flags.notUsable !== null) },
    });
    const u = text(html(<MarketHistory state={withHistory(unusable)} route={route()} now={NOW} onRetry={() => {}} onRetryObservation={() => {}} onRoute={() => {}} />));
    expect(u).toContain("Insufficient evidence");
    expect(u).not.toContain("Statistics (sample counts, not time)");
  });

  it("loading and failure states, with the market's ID as the title until its question is known", () => {
    const loading = text(html(<MarketHistory state={withHistory(null, { loading: true })} route={route()} now={NOW} onRetry={() => {}} onRetryObservation={() => {}} onRoute={() => {}} />));
    expect(loading).toContain("Market 1");
    expect(loading).toContain("Loading this market's stored history");
    const failed = text(html(<MarketHistory state={withHistory(null, { error: { kind: "network" } })} route={route()} now={NOW} onRetry={() => {}} onRetryObservation={() => {}} onRoute={() => {}} />));
    expect(failed).toContain("Loading this market's stored history failed");
  });
});
