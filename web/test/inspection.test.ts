import { describe, expect, it } from "vitest";
import type { ApiClient, ApiError, ApiResult, Inspection, Markets } from "../src/api";
import { createController, INSPECT_LEVELS } from "../src/controller";
import { emptyInspection, initialState, newerBudget, reducer, type Action, type ExplorerState } from "../src/explorer";
import { INSPECT_V1, INSPECT_V2, inspected, inspectionOf, item, NOW, page, serverError, status, NO_STORED_READS } from "./fixtures";

// The selected market's inspection: one request at a time, superseded requests aborted, stale
// answers ignored, nothing retried or refreshed on its own.

interface Pending {
  marketId: string;
  levels: number | undefined;
  signal: AbortSignal;
  answer: (result: ApiResult<Inspection>) => void;
}

const loadedState = (): ExplorerState =>
  [
    { type: "request", version: "v1", mode: "first", requestId: 900 },
    {
      type: "loaded",
      version: "v1",
      requestId: 900,
      page: page([item("100001"), item("2"), item("77", { eligibility: { inspectable: false, reasons: ["order book is not enabled"], warnings: [] } })]),
      receivedAt: NOW,
    },
  ].reduce<ExplorerState>((s, a) => reducer(s, a as Action), initialState());

/** With `deferred`, dispatched actions apply only on `render()`, as React applies them at its next render. */
function harness(state: ExplorerState = loadedState(), deferred = false) {
  const queued: Action[] = [];
  const pending: Pending[] = [];
  let statusCalls = 0;
  const api: ApiClient = {
    ...NO_STORED_READS,
    markets: () => new Promise<ApiResult<Markets>>(() => undefined),
    status: () => {
      statusCalls++;
      return Promise.resolve({ ok: true, data: status, receivedAt: NOW });
    },
    inspect: (marketId, { levels }, signal) =>
      new Promise((resolve) => {
        pending.push({ marketId, levels, signal: signal!, answer: resolve });
        signal?.addEventListener("abort", () => resolve({ ok: false, error: { kind: "aborted" } }));
      }),
  };
  const render = () => {
    for (const action of queued.splice(0)) state = reducer(state, action);
  };
  const dispatch = (action: Action) => {
    queued.push(action);
    if (!deferred) render();
  };
  const controller = createController(api, dispatch, () => state);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { controller, pending, render, get state() { return state; }, statusCalls: () => statusCalls, settle };
}

const failure = (error: ApiError): ApiResult<Inspection> => ({ ok: false, error });

describe("inspection controller", () => {
  it("selecting a market shows it at once and sends exactly one inspection, for the API's maximum levels", async () => {
    const h = harness();
    h.controller.select("100001");
    expect(h.state.selectedId).toBe("100001");
    expect(h.state.inspection).toMatchObject({ marketId: "100001", loading: true, result: null });
    expect(h.pending).toHaveLength(1);
    expect(h.pending[0]).toMatchObject({ marketId: "100001", levels: INSPECT_LEVELS });
    expect(INSPECT_LEVELS).toBe(20);
    // Re-selecting the same market (a double click, a re-run effect) sends nothing more.
    h.controller.select("100001");
    h.controller.inspect();
    expect(h.pending).toHaveLength(1);
    h.pending[0]!.answer(inspected(INSPECT_V1));
    await h.settle();
    expect(h.state.inspection).toMatchObject({ loading: false, error: null, result: { data: INSPECT_V1, receivedAt: NOW } });
    expect(h.statusCalls()).toBe(1); // window figures come from the local status route afterwards
  });

  it("works when the state catches up only at the next render, and a fast double click still sends one request", () => {
    const h = harness(loadedState(), true);
    h.controller.select("100001");
    h.controller.select("100001"); // before React re-rendered
    h.controller.inspect();
    expect(h.pending).toHaveLength(1);
    expect(h.state.selectedId).toBeNull(); // not rendered yet
    h.render();
    expect(h.state.inspection).toMatchObject({ marketId: "100001", loading: true });
    h.controller.select("77"); // not inspectable: no request, and the previous one is aborted
    expect(h.pending[0]!.signal.aborted).toBe(true);
    h.render();
    expect(h.pending).toHaveLength(1);
    expect(h.state.inspection).toMatchObject({ marketId: "77", loading: false });
  });

  it("a new selection aborts the superseded inspection, releases its state and ignores its late answer", async () => {
    const h = harness();
    h.controller.select("100001");
    const first = h.pending[0]!;
    h.controller.select("2");
    expect(first.signal.aborted).toBe(true);
    expect(h.state.inspection).toMatchObject({ marketId: "2", loading: true, result: null });
    first.answer(inspected(INSPECT_V1)); // already settled as aborted: ignored
    h.pending[1]!.answer(inspected(inspectionOf("2")));
    await h.settle();
    expect(h.state.inspection.result?.data.market.gammaId).toBe("2");
    expect(h.state.inspection.error).toBeNull();
  });

  it("drops a stale answer that still arrives for an old request id", () => {
    let s = reducer(loadedState(), { type: "select", id: "100001" });
    s = reducer(s, { type: "inspect_request", id: "100001", requestId: 1 });
    s = reducer(s, { type: "inspect_request", id: "100001", requestId: 2 });
    expect(reducer(s, { type: "inspected", requestId: 1, data: INSPECT_V1, receivedAt: NOW })).toBe(s);
    expect(reducer(s, { type: "inspect_failed", requestId: 1, error: { kind: "network" } })).toBe(s);
    // A request for a market that is no longer selected is not even recorded.
    expect(reducer(s, { type: "inspect_request", id: "2", requestId: 3 })).toBe(s);
    // An answer about a different market than the one asked for is refused, not shown.
    const wrong = reducer(s, { type: "inspected", requestId: 2, data: inspectionOf("999"), receivedAt: NOW });
    expect(wrong.inspection).toMatchObject({ loading: false, result: null, error: { kind: "invalid_response" } });
  });

  it("closing the details aborts the inspection and clears it", () => {
    const h = harness();
    h.controller.select("100001");
    h.controller.select(null);
    expect(h.pending[0]!.signal.aborted).toBe(true);
    expect(h.state.selectedId).toBeNull();
    expect(h.state.inspection).toEqual(emptyInspection(null));
  });

  it("cancel stops the request and says so; nothing is retried until asked", async () => {
    const h = harness();
    h.controller.select("100001");
    h.controller.cancelInspection();
    await h.settle();
    expect(h.state.inspection).toMatchObject({ loading: false, error: { kind: "aborted" }, result: null });
    expect(h.statusCalls()).toBe(0);
    await h.settle();
    expect(h.pending).toHaveLength(1);
    h.controller.inspect();
    expect(h.pending).toHaveLength(2);
  });

  it("an error is shown and never retried automatically; an explicit retry sends one request", async () => {
    const h = harness();
    h.controller.select("100001");
    h.pending[0]!.answer(failure({ kind: "network" }));
    await h.settle();
    expect(h.state.inspection.error).toEqual({ kind: "network" });
    expect(h.state.connection).toBe("unreachable");
    await h.settle();
    expect(h.pending).toHaveLength(1);
    h.controller.inspect();
    expect(h.pending).toHaveLength(2);
  });

  it("refresh keeps the earlier result visible while loading and after a failure", async () => {
    const h = harness();
    h.controller.select("100001");
    h.pending[0]!.answer(inspected(INSPECT_V1, NOW));
    await h.settle();
    h.controller.inspect();
    expect(h.state.inspection).toMatchObject({ loading: true, result: { receivedAt: NOW } });
    const budget = serverError("budget_exhausted", "WINDOW_BUDGET_EXHAUSTED", { retryAfterMs: 30_000 });
    h.pending[1]!.answer(failure({ kind: "server", httpStatus: 429, error: budget.error, receivedAt: NOW + 5 }));
    await h.settle();
    expect(h.state.inspection).toMatchObject({ loading: false, result: { receivedAt: NOW }, error: { kind: "server", httpStatus: 429 } });
    expect(h.statusCalls()).toBe(2); // after the success and after the server's refusal
    h.controller.inspect();
    h.pending[2]!.answer(inspected(INSPECT_V1, NOW + 60_000));
    await h.settle();
    expect(h.state.inspection).toMatchObject({ error: null, result: { receivedAt: NOW + 60_000 } });
  });

  it("does not request a market the listing marks as not inspectable until asked", () => {
    const h = harness();
    h.controller.select("77");
    expect(h.pending).toHaveLength(0);
    expect(h.state.inspection).toMatchObject({ marketId: "77", loading: false });
    h.controller.inspect();
    expect(h.pending).toEqual([expect.objectContaining({ marketId: "77" })]);
  });

  it("a route-driven selection never inspects; markets outside the loaded list can be inspected on request", () => {
    const h = harness();
    h.controller.select("555", { inspect: false });
    expect(h.state.selectedId).toBe("555");
    expect(h.pending).toHaveLength(0);
    h.controller.inspect();
    expect(h.pending[0]!.marketId).toBe("555");
    h.controller.select(null);
    h.controller.inspect(); // nothing selected: nothing to inspect
    expect(h.pending).toHaveLength(1);
  });

  it("dispose aborts the inspection in flight", () => {
    const h = harness();
    h.controller.select("100001");
    h.controller.dispose();
    expect(h.pending[0]!.signal.aborted).toBe(true);
  });

  it("an inspection updates the lifetime budget; the window figure is kept until status reports it", () => {
    const listed = loadedState();
    expect(listed.budget?.window).not.toBeNull();
    let s = reducer(listed, { type: "select", id: "100001" });
    s = reducer(s, { type: "inspect_request", id: "100001", requestId: 1 });
    const data = { ...INSPECT_V1, budget: { call: { limit: 8, used: 4 }, process: { limit: 2_000, used: 5, remaining: 1_995 } } };
    s = reducer(s, { type: "inspected", requestId: 1, data, receivedAt: NOW });
    expect(s.budget).toEqual({ process: { limit: 2_000, used: 5, remaining: 1_995 }, window: listed.budget!.window });
  });
});

describe("budget snapshots", () => {
  const snap = (used: number, window: { used: number } | null = { used }) => ({
    process: { limit: 100, used, remaining: 100 - used },
    window: window && { limit: 60, windowMs: 300_000, used: window.used, remaining: 60 - window.used },
  });

  it("keeps the newest snapshot: fewer lifetime attempts used means older", () => {
    expect(newerBudget(null, snap(3))).toEqual(snap(3));
    expect(newerBudget(snap(5), snap(3))).toEqual(snap(5));
    expect(newerBudget(snap(5), snap(5, { used: 1 }))).toEqual(snap(5, { used: 1 }));
    expect(newerBudget(snap(5), { process: snap(9).process })).toEqual({ process: snap(9).process, window: snap(5).window });
    // A different ceiling means a different server process: take it as is.
    expect(newerBudget(snap(50), { process: { limit: 300, used: 0, remaining: 300 }, window: null })).toEqual({ process: { limit: 300, used: 0, remaining: 300 }, window: null });
  });

  it("a status answered before a listing does not undo the listing's budget", () => {
    const listed = loadedState(); // used 1
    const s = reducer(listed, { type: "status", status });
    expect(s.budget).toEqual(listed.budget);
  });

  it("V2 inspections carry team-name outcomes without a Yes/No role", () => {
    expect(INSPECT_V2.outcomes.map((o) => [o.label, o.role])).toEqual([
      ["Team Alpha", null],
      ["Team Beta", null],
    ]);
  });
});
