import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createApiClient, type ApiClient } from "./api";
import { App, defaultRouteWindow } from "./App";
import { DemoBanner } from "./components/DemoBanner";
import type { NavProps } from "./components/Header";
import { LiveUnavailable } from "./components/LiveUnavailable";
import { HistoryApp } from "./HistoryApp";
import { createHistoryStore, type HistoryStore } from "./historyStore";
import { historyHash, parseRoute, replaceHash, watchAppRoute, type AppRoute, type HistoryRoute, type RouteWindow } from "./route";

/**
 * Which section the hash shows, and which sections have been opened. A section mounts the first
 * time its route is shown and then stays mounted (hidden) so its state survives a visit to the
 * other one. In particular, a Stored History address, deep link included, never mounts the Live
 * Explorer: nothing is listed or inspected, and no Polymarket request is made, until the user opens it.
 */
export interface RootState {
  route: AppRoute;
  liveOpened: boolean;
  historyOpened: boolean;
  /** Where each section was left, for the section links. */
  liveHash: string;
  historyRoute: HistoryRoute;
}

const HISTORY_HOME: HistoryRoute = { section: "history", page: "markets", source: null };

export function rootStateFor(route: AppRoute, hash: string, previous: RootState | null = null): RootState {
  const live = route.section === "live";
  return {
    route,
    liveOpened: (previous?.liveOpened ?? false) || live,
    historyOpened: (previous?.historyOpened ?? false) || !live,
    liveHash: live ? hash || "#/" : (previous?.liveHash ?? "#/"),
    historyRoute: live ? (previous?.historyRoute ?? HISTORY_HOME) : route,
  };
}

/** Section links: the active section's link returns to its start; the other returns to where it was left. */
export function navFor(state: RootState, liveEnabled: boolean): NavProps {
  const live = state.route.section === "live";
  return {
    section: live ? "live" : "history",
    liveHref: live ? "#/" : state.liveHash,
    historyHref: live ? historyHash(state.historyRoute) : historyHash({ ...HISTORY_HOME, source: state.historyRoute.source }),
    liveEnabled,
  };
}

export interface RootProps {
  api?: ApiClient;
  clock?: () => number;
  routeWindow?: RouteWindow | null;
  /** The route without a window (tests). */
  initialHash?: string;
  historyStore?: HistoryStore;
}

/**
 * The server's status (read once, through the history store, and shared with the Live Explorer)
 * decides what the Live Explorer section may do: nothing starts there until the server has said
 * whether live requests are allowed. A server that refuses them (the synthetic demonstration) gets
 * an explanation instead of the explorer, and its start page is Stored History.
 */
export function Root({ api: injected, clock = Date.now, routeWindow = defaultRouteWindow(), initialHash, historyStore }: RootProps) {
  const api = useMemo(() => injected ?? createApiClient(), [injected]);
  const store = useMemo(() => historyStore ?? createHistoryStore(api, { now: clock }), [historyStore, api, clock]);
  const [state, setState] = useState<RootState>(() => {
    const hash = routeWindow?.location.hash ?? initialHash ?? "";
    return rootStateFor(parseRoute(hash), hash);
  });
  const history = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { status, statusError } = history;
  // Landing on the start page (no address) of a server without live requests opens Stored History
  // instead; a later visit to the Live Explorer (its link, Back) shows why it is disabled.
  const landing = useRef(state.route.section === "live" && state.route.marketId === null);

  useEffect(() => {
    if (!routeWindow) return undefined;
    let first = true; // the watcher reports the current route at once: that is still the landing
    return watchAppRoute(routeWindow, (route, hash) => {
      if (!first) landing.current = false;
      first = false;
      setState((previous) => rootStateFor(route, hash, previous));
    });
  }, [routeWindow]);
  useEffect(() => store.loadStatus(), [store]);

  const liveEnabled = status?.live.enabled ?? true;
  const live = state.route.section === "live";
  useEffect(() => {
    if (routeWindow && !liveEnabled && landing.current) {
      landing.current = false;
      replaceHash(routeWindow, historyHash(HISTORY_HOME));
    }
  }, [routeWindow, liveEnabled]);

  const nav = navFor(state, liveEnabled);
  const connection = status !== null ? "connected" : statusError !== null ? "unreachable" : "checking";
  return (
    <>
      {status?.stored.mode === "demo" && <DemoBanner />}
      {state.liveOpened && (
        <div hidden={!live}>
          {status === null && statusError === null ? (
            <LiveUnavailable nav={nav} reason="checking" connection={connection} />
          ) : !liveEnabled ? (
            <LiveUnavailable nav={nav} reason="disabled" connection={connection} />
          ) : (
            <App api={api} clock={clock} routeWindow={routeWindow} nav={nav} status={status} />
          )}
        </div>
      )}
      {state.historyOpened && (
        <div hidden={live}>
          <HistoryApp store={store} route={state.historyRoute} active={!live} nav={nav} clock={clock} routeWindow={routeWindow} />
        </div>
      )}
    </>
  );
}
