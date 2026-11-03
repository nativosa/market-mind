import { describe, expect, it } from "vitest";
import type { ApiClient, ApiResult, Markets, Version } from "../src/api";
import { createController } from "../src/controller";
import { initialState, reducer, visibleMarkets, type Action, type ExplorerState } from "../src/explorer";
import { item, NOW, page, range, status, NO_STORED_READS } from "./fixtures";

// The explorer's request logic against a fake API whose answers the test releases one by one.

interface Pending {
  version: Version;
  cursor: string | null;
  signal: AbortSignal;
  answer: (result: ApiResult<Markets>) => void;
}

function harness(state: ExplorerState = initialState()) {
  const pending: Pending[] = [];
  let statusCalls = 0;
  const api: ApiClient = {
    ...NO_STORED_READS,
    markets: ({ version, cursor }, signal) =>
      new Promise((resolve) => {
        const entry: Pending = { version, cursor: cursor ?? null, signal: signal!, answer: resolve };
        pending.push(entry);
        signal?.addEventListener("abort", () => resolve({ ok: false, error: { kind: "aborted" } }));
      }),
    status: () => {
      statusCalls++;
      return Promise.resolve({ ok: true, data: status, receivedAt: NOW });
    },
    inspect: () => Promise.reject(new Error("unused")),
  };
  const actions: Action[] = [];
  const dispatch = (action: Action) => {
    actions.push(action);
    state = reducer(state, action);
  };
  const controller = createController(api, dispatch, () => state);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { controller, pending, actions, get state() { return state; }, statusCalls: () => statusCalls, settle };
}

const ok = (p: Markets): ApiResult<Markets> => ({ ok: true, data: p, receivedAt: NOW });

describe("explorer controller", () => {
  it("loads the first page once, then the next page with the server's cursor", async () => {
    const h = harness();
    h.controller.ensureFirstPage();
    h.controller.ensureFirstPage(); // already loading: no second request
    expect(h.pending).toHaveLength(1);
    expect(h.pending[0]).toMatchObject({ version: "v1", cursor: null });
    h.pending[0]!.answer(ok(page(range(1, 50), { nextCursor: "cursor-2" })));
    await h.settle();
    h.controller.load("v1", "more");
    h.controller.load("v1", "more"); // a double click sends one request
    expect(h.pending).toHaveLength(2);
    expect(h.pending[1]).toMatchObject({ version: "v1", cursor: "cursor-2" });
    h.pending[1]!.answer(ok(page(range(51, 50), { nextCursor: null })));
    await h.settle();
    expect(h.state.feeds.v1).toMatchObject({ pages: 2, end: "last_page" });
    h.controller.load("v1", "more"); // nothing more to load
    expect(h.pending).toHaveLength(2);
  });

  it("switching version aborts the shown version's request and ignores its late answer", async () => {
    const h = harness();
    h.controller.ensureFirstPage();
    const v1 = h.pending[0]!;
    h.controller.switchVersion("v2");
    expect(v1.signal.aborted).toBe(true);
    expect(h.pending[1]).toMatchObject({ version: "v2", cursor: null });
    v1.answer(ok(page([item("late")]))); // too late: the promise already settled as aborted
    h.pending[1]!.answer(ok(page([item("2")], { version: "v2" })));
    await h.settle();
    expect(h.state.version).toBe("v2");
    expect(visibleMarkets(h.state).map((m) => m.gammaId)).toEqual(["2"]);
    expect(h.state.feeds.v1).toMatchObject({ pages: 0, loading: null, error: null });
    // Back to v1: its abandoned first page loads again.
    h.controller.switchVersion("v1");
    expect(h.pending[2]).toMatchObject({ version: "v1", cursor: null });
    h.controller.switchVersion("v1"); // no-op
    expect(h.pending).toHaveLength(3);
  });

  it("keeps a loaded version when switching back, without refetching", async () => {
    const h = harness();
    h.controller.ensureFirstPage();
    h.pending[0]!.answer(ok(page([item("1")])));
    await h.settle();
    h.controller.switchVersion("v2");
    h.pending[1]!.answer(ok(page([item("2")], { version: "v2" })));
    await h.settle();
    h.controller.switchVersion("v1");
    expect(h.pending).toHaveLength(2);
    expect(visibleMarkets(h.state).map((m) => m.gammaId)).toEqual(["1"]);
  });

  it("never retries a failure on its own; an explicit retry or refresh sends one new request", async () => {
    const h = harness();
    h.controller.ensureFirstPage();
    h.pending[0]!.answer({ ok: false, error: { kind: "network" } });
    await h.settle();
    h.controller.ensureFirstPage();
    expect(h.pending).toHaveLength(1);
    h.controller.load("v1", "first");
    expect(h.pending).toHaveLength(2);
    h.pending[1]!.answer(ok(page([item("1")])));
    await h.settle();
    expect(h.state.feeds.v1.markets).toHaveLength(1);
  });

  it("a refresh supersedes a pending load-more", async () => {
    const h = harness();
    h.controller.ensureFirstPage();
    h.pending[0]!.answer(ok(page(range(1, 50), { nextCursor: "c2" })));
    await h.settle();
    h.controller.load("v1", "more");
    h.controller.load("v1", "first");
    expect(h.pending[1]!.signal.aborted).toBe(true);
    h.pending[2]!.answer(ok(page([item("fresh")])));
    await h.settle();
    expect(h.state.feeds.v1.markets.map((m) => m.gammaId)).toEqual(["fresh"]);
  });

  it("loads status on request and aborts everything on dispose", async () => {
    const h = harness();
    h.controller.loadStatus();
    await h.settle();
    expect(h.statusCalls()).toBe(1);
    expect(h.state.status?.readOnly).toBe(true);
    h.controller.ensureFirstPage();
    h.controller.dispose();
    expect(h.pending[0]!.signal.aborted).toBe(true);
    await h.settle();
    expect(h.state.feeds.v1.loading).toBeNull();
  });
});
