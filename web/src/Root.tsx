import { useEffect, useMemo, useState } from "react";
import { createApiClient, type ApiClient } from "./api";
import { App, defaultRouteWindow } from "./App";
import type { NavProps } from "./components/Header";
import { HistoryApp } from "./HistoryApp";
import { createHistoryStore, type HistoryStore } from "./historyStore";
import { historyHash, parseRoute, watchAppRoute, type AppRoute, type HistoryRoute, type RouteWindow } from "./route";

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

export function Root({ api: injected, clock = Date.now, routeWindow = defaultRouteWindow(), initialHash, historyStore }: RootProps) {
  const api = useMemo(() => injected ?? createApiClient(), [injected]);
  const store = useMemo(() => historyStore ?? createHistoryStore(api, { now: clock }), [historyStore, api, clock]);
  const [state, setState] = useState<RootState>(() => {
    const hash = routeWindow?.location.hash ?? initialHash ?? "";
    return rootStateFor(parseRoute(hash), hash);
  });

  useEffect(() => (routeWindow ? watchAppRoute(routeWindow, (route, hash) => setState((previous) => rootStateFor(route, hash, previous))) : undefined), [routeWindow]);

  const liveEnabled = useLiveEnabled(store);
  const nav = navFor(state, liveEnabled);
  const live = state.route.section === "live";
  return (
    <>
      {state.liveOpened && (
        <div hidden={!live}>
          <App api={api} clock={clock} routeWindow={routeWindow} nav={nav} />
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

/** Whether the server allows live requests, as the history store learned from /api/status (assumed until known). */
function useLiveEnabled(store: HistoryStore): boolean {
  const [enabled, setEnabled] = useState(() => store.getState().status?.live.enabled ?? true);
  useEffect(() => {
    const update = () => setEnabled(store.getState().status?.live.enabled ?? true);
    update();
    return store.subscribe(update);
  }, [store]);
  return enabled;
}
