import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DetailsOutput } from "../../src/research/contracts";
import type { ApiError, History, ObservationDetails } from "../src/api";
import { describeApiError } from "../src/format";
import { MarketHistory } from "../src/components/MarketHistory";
import { ObservationPanel } from "../src/components/ObservationPanel";
import { initialHistoryState, type HistoryState } from "../src/history";
import { createHistoryStore } from "../src/historyStore";
import type { HistoryRoute } from "../src/route";
import { NOW } from "./fixtures";
import { cleanupHistory, EXACT_SIZE, flush, ok, pendingApi, SEED_TIMEOUT_MS, sharedHistory, storedServer } from "./historyFixtures";
import { button, call, expand, findAll, html, text } from "./render";

// Stage 3.2 Commit 6: the stored observation evidence panel, rendered from real API answers.

type Ids = Record<"first" | "second" | "unpaired" | "invalid" | "oneSided" | "regular" | "afterGap" | "synthetic" | "syntheticOnly" | "single", number>;
let ids: Ids;
let server: Awaited<ReturnType<typeof storedServer>>;
let history: History;
let first: ObservationDetails;
let unpaired: ObservationDetails;
let invalid: ObservationDetails;
let synthetic: ObservationDetails;
let syntheticHidden: ApiError;
beforeAll(async () => {
  const seeded = sharedHistory();
  ids = seeded.ids as Ids;
  server = await storedServer(seeded.path);
  history = ok(await server.api.history("1", {}));
  first = ok(await server.api.observation(ids.first, { levels: 50 }));
  unpaired = ok(await server.api.observation(ids.unpaired, { levels: 50 }));
  invalid = ok(await server.api.observation(ids.invalid, { levels: 50 }));
  synthetic = ok(await server.api.observation(ids.synthetic, { source: "all", levels: 50 }));
  const hidden = await server.api.observation(ids.synthetic, { levels: 50 });
  if (hidden.ok) throw new Error("expected the synthetic observation to be hidden under Live only");
  syntheticHidden = hidden.error;
}, SEED_TIMEOUT_MS);
afterAll(cleanupHistory);

const route = (observationId: number | null, source: "live" | "all" | null = null): Extract<HistoryRoute, { page: "market" }> => ({
  section: "history",
  page: "market",
  marketId: "1",
  observationId,
  source,
});
const panel = (data: ObservationDetails | null, patch: Partial<React.ComponentProps<typeof ObservationPanel>> = {}) =>
  html(<ObservationPanel route={route(data?.observation.observationId ?? 1)} data={data} loading={false} error={null} now={NOW} analyticsVersion={1} onRetry={() => {}} onClose={() => {}} {...patch} />);

describe("stored observation API", () => {
  it("reads only the requested observation, offline, under the active source filter", () => {
    expect(server.paths).toEqual([
      "/api/stored/markets/1/history",
      `/api/stored/observations/${ids.first}?levels=50`,
      `/api/stored/observations/${ids.unpaired}?levels=50`,
      `/api/stored/observations/${ids.invalid}?levels=50`,
      `/api/stored/observations/${ids.synthetic}?source=all&levels=50`,
      `/api/stored/observations/${ids.synthetic}?levels=50`,
    ]);
    expect(server.urls).toEqual([]);
    expect(syntheticHidden).toMatchObject({ kind: "server", httpStatus: 404, error: { category: "observation_not_found" } });
    expect(describeApiError(syntheticHidden, NOW).detail).toContain("Synthetic observations appear only with Live + synthetic");
  });
});

describe("observation panel", () => {
  it("shows identities, exact timings, run and provenance as stored", () => {
    const t = text(panel(first));
    expect(t).toContain(`Observation #${ids.first}`);
    expect(t).toContain("Stored evidence exactly as recorded by collect.");
    expect(t).toContain(`Run ID ${first.run.runId}`);
    expect(t).toContain(`Available at ${first.observation.availableAt.replace("T", " ").replace("Z", "")} UTC`);
    expect(t).toContain("when the second of the two books arrived");
    expect(t).toContain("Complete · Request accounting verified");
    expect(t).toContain("MarketMind 0.0.0-test · schema v1 · analytics v1 · V1");
    expect(t).toContain("Both outcome books received");
    expect(t).toContain("Confirmed from Polymarket's CLOB market record");
    expect(t).toContain("Live");
  });

  it("shows both books' levels exactly as stored, in the order received", () => {
    const t = text(panel(first));
    expect(t).toContain(EXACT_SIZE);
    expect(t).toContain("1 of 1 bid and 1 of 1 ask levels, in the order Polymarket sent them, not re-sorted.");
    expect(t).toContain("Polymarket book timestamp");
    expect(t).toContain("HTTP 200 · 1 attempt");
    expect(t).toContain(first.books[0]!.contentHash);
    // Untrusted labels and question are text.
    expect(panel(first)).not.toContain("<img");
    expect(t).toContain("Will market 1 resolve Yes?");
  });

  it("marks metrics computed at collection and the version this history uses; retrospective rows are distinguished", () => {
    const t = text(panel(first));
    expect(t).toContain("Analytics v1 At collection Used by this history");
    expect(t).toContain(`Best bid (size) 0.4 (${EXACT_SIZE})`);
    expect(t).not.toContain("Retrospective");
    const later = DetailsOutput.parse({
      ...first,
      metrics: [...first.metrics, { ...first.metrics[0]!, analyticsVersion: 2, computedBy: "recompute", retrospective: true }],
    });
    const r = text(panel(later));
    expect(r).toContain("Analytics v2 Recomputed later Retrospective: computed after the time asked for");
    expect(r).toContain("Stored metrics (2)");
  });

  it("an unpaired observation: one book, no metrics, and the gap is not invented", () => {
    const t = text(panel(unpaired));
    expect(t).toContain("Only one outcome book received");
    expect(t).toContain("Order books (1 stored)");
    expect(t).toContain("No metrics are stored: they need two valid books.");
    expect(t).toContain("when the only received book arrived");
  });

  it("an invalid book: its quality issues in words", () => {
    const t = text(panel(invalid));
    expect(t).toContain("Quality: Invalid");
    expect(t).toContain("ASSET_ID_MISMATCH");
    expect(t).toContain("The book is for a different token than the one requested.");
  });

  it("a synthetic observation is labelled as not market evidence", () => {
    expect(text(panel(synthetic))).toContain("Synthetic observation: test or demonstration data, not market evidence.");
  });

  it("an observation of another market says so and links to it", () => {
    const other = DetailsOutput.parse({ ...first, observation: { ...first.observation, gammaId: "3" } });
    const markup = panel(other);
    expect(text(markup)).toContain("This observation belongs to market 3, not market 1.");
    expect(markup).toContain(`href="#/history/market/3/obs/${ids.first}"`);
  });

  it("loading, not found under the filter, and close", () => {
    expect(text(panel(null, { loading: true }))).toContain("Loading this observation");
    const t = text(panel(null, { error: syntheticHidden }));
    expect(t).toContain("Loading this observation failed: This observation is not available");
    let closed = 0;
    const tree = expand(
      <ObservationPanel route={route(ids.first)} data={first} loading={false} error={null} now={NOW} analyticsVersion={1} onRetry={() => {}} onClose={() => (closed += 1)} />,
    );
    call(button(tree, "Close observation").onClick);
    expect(closed).toBe(1);
  });
});

describe("market page with an observation open", () => {
  const state = (observation: Partial<HistoryState["observation"]>): HistoryState => ({
    ...initialHistoryState(),
    history: { key: "1|default", requestId: 1, loading: false, data: history, receivedAt: NOW, error: null },
    observation: { key: null, requestId: 0, loading: false, data: null, receivedAt: null, error: null, ...observation },
  });
  const page = (s: HistoryState, r = route(ids.first)) =>
    text(html(<MarketHistory state={s} route={r} now={NOW} onRetry={() => {}} onRetryObservation={() => {}} onRoute={() => {}} />));

  it("shows the evidence beside the still-loaded history", () => {
    const t = page(state({ key: `${ids.first}|default`, data: first }));
    expect(t).toContain(`Observation #${ids.first}`);
    expect(t).toContain("Statistics (sample counts, not time)");
    expect(t).toContain("Observations, newest first");
  });

  it("never shows another observation's evidence while the requested one loads", () => {
    const t = page(state({ key: `${ids.second}|default`, data: ok({ ok: true, data: first, receivedAt: NOW }) }));
    expect(t).toContain(`Observation #${ids.first}`);
    expect(t).toContain("Loading this observation");
    expect(t).not.toContain("Order books (");
  });

  it("closing returns to the market address with the same source", () => {
    const routes: HistoryRoute[] = [];
    const tree = MarketHistory({
      state: state({ key: `${ids.first}|all`, data: first }),
      route: route(ids.first, "all"),
      now: NOW,
      onRetry: () => {},
      onRetryObservation: () => {},
      onRoute: (r) => routes.push(r),
    });
    const panelElement = findAll(tree, (e) => typeof e.props.onClose === "function")[0]!;
    call(panelElement.props.onClose);
    const body = findAll(tree, (e) => typeof e.props.onSelect === "function")[0]!;
    call(body.props.onSelect, ids.second);
    expect(routes).toEqual([route(null, "all"), route(ids.second, "all")]);
  });

  it("opening another observation aborts the previous request; the history is not requested again", async () => {
    const { api, pending } = pendingApi();
    const store = createHistoryStore(api);
    store.sync(route(ids.first));
    store.sync(route(ids.second));
    expect(pending.map((p) => p.method)).toEqual(["history", "observation", "observation"]);
    expect(pending[1]!.signal.aborted).toBe(true);
    expect(pending[0]!.signal.aborted).toBe(false);
    store.sync(route(null)); // close: nothing new, and the observation still loading is cancelled
    expect(pending).toHaveLength(3);
    expect(pending[2]!.signal.aborted).toBe(true);
    expect(pending[0]!.signal.aborted).toBe(false);
    await flush();
    store.sync(route(ids.second)); // reopened: requested again
    expect(pending.map((p) => p.method)).toEqual(["history", "observation", "observation", "observation"]);
  });

  it("leaving a list that is still loading for a market cancels the list", () => {
    const { api, pending } = pendingApi();
    const store = createHistoryStore(api);
    store.sync({ section: "history", page: "markets", source: null });
    store.sync(route(null));
    expect(pending.map((p) => [p.method, p.signal.aborted])).toEqual([
      ["storedMarkets", true],
      ["history", false],
    ]);
  });
});
