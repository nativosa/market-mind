import { describe, expect, it } from "vitest";
import type { ApiClient, Status } from "../src/api";
import { App } from "../src/App";
import { DemoBanner } from "../src/components/DemoBanner";
import { DEFAULT_NAV } from "../src/components/Header";
import { LiveUnavailable } from "../src/components/LiveUnavailable";
import { historyReducer, initialHistoryState } from "../src/history";
import { createHistoryStore } from "../src/historyStore";
import { Root } from "../src/Root";
import { replaceHash } from "../src/route";
import { NO_STORED_READS, NOW, status } from "./fixtures";
import { flush, pendingApi } from "./historyFixtures";
import { appTree, html, text } from "./render";

// Stage 3.2 Commit 7: what the browser does on a server that refuses live requests (npm run web:demo)
// and before it knows whether the server allows them.

const DEMO_STATUS: Status = { ...status, live: { enabled: false }, stored: { mode: "demo", defaultSource: "all", database: "present" } };

/** Records every live call; the status answer is fixed (or fails). */
function statusApi(answer: Status | "fail") {
  const live: string[] = [];
  let statusCalls = 0;
  const api: ApiClient = {
    ...NO_STORED_READS,
    status: () => {
      statusCalls++;
      return Promise.resolve(answer === "fail" ? { ok: false, error: { kind: "network" } } : { ok: true, data: answer, receivedAt: NOW });
    },
    markets: (query) => {
      live.push(`markets ${JSON.stringify(query)}`);
      return new Promise(() => undefined);
    },
    inspect: (id) => {
      live.push(`inspect ${id}`);
      return new Promise(() => undefined);
    },
  };
  return { api, live, statusCalls: () => statusCalls };
}

async function rootWith(answer: Status | "fail", hash: string) {
  const s = statusApi(answer);
  const store = createHistoryStore(s.api);
  store.loadStatus();
  await flush();
  return { ...s, store, markup: html(<Root api={s.api} clock={() => NOW} routeWindow={null} initialHash={hash} historyStore={store} />) };
}

describe("live section before the server's status is known", () => {
  it("starts nothing that could reach Polymarket and says it is checking", () => {
    const { api, live } = pendingApi();
    const t = text(html(<Root api={api} clock={() => NOW} routeWindow={null} initialHash="#/market/7" />));
    expect(t).toContain("Checking what the local server allows");
    expect(t).not.toContain("Search loaded markets");
    expect(live).toEqual([]);
  });

  it("a status the server could not give still opens the explorer, which reports the connection itself", async () => {
    const { markup, live } = await rootWith("fail", "#/");
    expect(text(markup)).toContain("Search loaded markets");
    expect(live).toEqual([]); // effects (the first listing) do not run in a static render
  });
});

describe("synthetic demonstration server", () => {
  it("shows the demonstration banner on every section and the Live Explorer as disabled", async () => {
    for (const hash of ["#/market/7", "#/history", "#/history/market/990000000000000001/obs/3"]) {
      const { markup, live } = await rootWith(DEMO_STATUS, hash);
      const t = text(markup);
      expect(t, hash).toContain("Synthetic demonstration data");
      expect(t, hash).toContain("not Polymarket market evidence");
      expect(t, hash).toContain("Live Explorer disabled on this server");
      expect(markup, hash).toContain('aria-label="Synthetic demonstration data"');
      expect(live, hash).toEqual([]);
    }
    const t = text((await rootWith(DEMO_STATUS, "#/market/7")).markup);
    expect(t).toContain("Live Explorer is disabled on this server");
    expect(t).toContain("Nothing was requested");
    expect(t).not.toContain("Search loaded markets");
  });

  it("a normal server shows no banner, and the explorer gets the status Root read instead of reading it again", async () => {
    const { markup, statusCalls } = await rootWith(status, "#/");
    expect(text(markup)).not.toContain("Synthetic demonstration data");
    expect(text(markup)).toContain("Local server connected");
    expect(statusCalls()).toBe(1);
  });

  it("the disabled panel links to Stored History; checking shows no link", () => {
    const disabled = html(<LiveUnavailable nav={{ ...DEFAULT_NAV, liveEnabled: false, historyHref: "#/history?source=all" }} reason="disabled" connection="connected" />);
    expect(disabled).toContain('href="#/history?source=all"');
    expect(text(html(<LiveUnavailable nav={DEFAULT_NAV} reason="checking" connection="checking" />))).not.toContain("Open Stored History");
    expect(text(html(<DemoBanner />))).toContain("its temporary database is deleted when it stops");
  });

  it("an explorer given a status renders with it and does not ask again", () => {
    const { api, statusCalls } = statusApi(status);
    const tree = appTree({ api, clock: () => NOW, routeWindow: null, status }, (p) => App(p));
    expect(tree).not.toBeNull();
    expect(text(html(<App api={api} clock={() => NOW} routeWindow={null} status={status} />))).toContain("Requests left: 2,000 of 2,000");
    expect(statusCalls()).toBe(0);
  });
});

describe("status state", () => {
  it("records a failed status read, ignores an aborted one and clears the failure when status arrives", () => {
    const failed = historyReducer(initialHistoryState(), { type: "status_failed", error: { kind: "network" } });
    expect(failed.statusError).toEqual({ kind: "network" });
    expect(historyReducer(initialHistoryState(), { type: "status_failed", error: { kind: "aborted" } })).toEqual(initialHistoryState());
    expect(historyReducer(failed, { type: "status", status }).statusError).toBeNull();
  });

  it("the store reads status once, and again after a failure", async () => {
    let answer: "fail" | Status = "fail";
    let calls = 0;
    const api: ApiClient = { ...statusApi(status).api, status: () => (calls++, Promise.resolve(answer === "fail" ? { ok: false, error: { kind: "network" } } : { ok: true, data: answer, receivedAt: NOW })) };
    const store = createHistoryStore(api);
    store.loadStatus();
    await flush();
    expect(store.getState().statusError).not.toBeNull();
    answer = DEMO_STATUS;
    store.loadStatus();
    await flush();
    store.loadStatus();
    expect(calls).toBe(2);
    expect(store.getState()).toMatchObject({ status: DEMO_STATUS, statusError: null });
  });
});

describe("replaceHash", () => {
  it("replaces in place when the location can, sets the hash otherwise, and does nothing when already there", () => {
    const replaced: string[] = [];
    const browser = { location: { hash: "#/", replace: (url: string) => replaced.push(url) } };
    replaceHash(browser, "#/history");
    expect(replaced).toEqual(["#/history"]);
    const plain = { location: { hash: "" } };
    replaceHash(plain, "#/history");
    expect(plain.location.hash).toBe("#/history");
    replaceHash(plain, "#/history");
    replaceHash({ location: { hash: "#/history", replace: () => replaced.push("again") } }, "#/history");
    expect(replaced).toEqual(["#/history"]);
  });
});
