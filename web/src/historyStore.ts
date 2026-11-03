import type { ApiClient, ApiError, ApiResult, Source } from "./api";
import { DETAILS_LEVELS } from "./api";
import { historyReducer, initialHistoryState, keysFor, needsRequest, RUNS_MAX, RUNS_STEP, type HistoryAction, type HistoryState, type ResourceName } from "./history";
import type { HistoryRoute } from "./route";

/**
 * Stored History's request logic, free of React. Every request reads the local database through
 * the local server (no Polymarket request, no model call), and only because the route shows it:
 * `sync(route)` requests what the route needs and is not already loaded, loading or failed for the
 * same key, so calling it again (React StrictMode runs effects twice) sends nothing new.
 *
 * One AbortController per resource: a request for a different key (another market, page or source
 * filter) aborts the one it supersedes, and the reducer drops any answer for an older request id.
 * State is held here and updated synchronously, so a second call made before React re-renders
 * already sees the first request. Nothing polls or retries on its own.
 */
export interface HistoryStore {
  /** Properties, not methods: React's useSyncExternalStore calls them unbound. */
  getState: () => HistoryState;
  subscribe: (listener: () => void) => () => void;
  /** Load what `route` shows, aborting superseded requests. */
  sync(route: HistoryRoute): void;
  /** Request one resource of the current route again (explicit retry or refresh). */
  reload(resource: ResourceName): void;
  /** Show another stored-markets page (first market `offset`). */
  setOffset(offset: number): void;
  /** Ask for more recent runs (up to the API maximum). */
  showMoreRuns(): void;
  /** Start from the first stored-markets page and the default runs count, e.g. before the source filter changes. */
  resetPaging(): void;
  /** Read /api/status once (live allowed, demo mode, default source); again only after a failure. */
  loadStatus(): void;
  /** Mount and unmount. Unmounting aborts everything, unless the component mounts again at once (StrictMode). */
  attach(): void;
  detach(): void;
}

export interface StoreOptions {
  now?: () => number;
  /** Deferred unmount (tests run it synchronously). */
  defer?: (fn: () => void) => () => void;
}

const defaultDefer = (fn: () => void) => {
  const timer = setTimeout(fn, 0);
  return () => clearTimeout(timer);
};

/** The answer's own identity must match what was asked for; anything else is refused, never shown. */
function mismatch(resource: ResourceName, key: string, data: unknown): string | null {
  const parts = key.split("|");
  // Keys: "<id>|<source>" for a market's history or an observation, "<source>|<page>" for the lists.
  const sourcePart = resource === "history" || resource === "observation" ? parts[1] : parts[0];
  const explicit: Source | null = sourcePart === "live" || sourcePart === "all" ? sourcePart : null;
  switch (resource) {
    case "history": {
      const d = data as { appliedLimits: { marketId: string; source: Source } };
      if (d.appliedLimits.marketId !== parts[0]) return `appliedLimits.marketId: expected ${parts[0]}`;
      return explicit !== null && d.appliedLimits.source !== explicit ? `appliedLimits.source: expected ${explicit}` : null;
    }
    case "observation":
      return String((data as { observation: { observationId: number } }).observation.observationId) === parts[0] ? null : `observation.observationId: expected ${parts[0]}`;
    case "markets":
    case "runs": {
      const applied = (data as { appliedLimits: { source: Source } }).appliedLimits.source;
      return explicit !== null && applied !== explicit ? `appliedLimits.source: expected ${explicit}` : null;
    }
  }
}

export function createHistoryStore(api: ApiClient, options: StoreOptions = {}): HistoryStore {
  const defer = options.defer ?? defaultDefer;
  let state = initialHistoryState();
  let route: HistoryRoute | null = null;
  const listeners = new Set<() => void>();
  const controllers: Partial<Record<ResourceName, AbortController>> = {};
  let statusController: AbortController | null = null;
  let cancelDispose: (() => void) | null = null;
  let nextRequest = 0;

  const dispatch = (action: HistoryAction) => {
    const next = historyReducer(state, action);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  function fetchOf(resource: ResourceName, r: HistoryRoute, signal: AbortSignal): Promise<ApiResult<unknown>> {
    const source = r.source;
    switch (resource) {
      case "markets":
        return api.storedMarkets({ source, offset: state.marketsOffset }, signal);
      case "runs":
        return api.storedRuns({ source, limit: state.runsLimit }, signal);
      case "history":
        return api.history((r as Extract<HistoryRoute, { page: "market" }>).marketId, { source }, signal);
      case "observation":
        return api.observation((r as Extract<HistoryRoute, { page: "market" }>).observationId!, { source, levels: DETAILS_LEVELS }, signal);
    }
  }

  function request(resource: ResourceName, key: string, r: HistoryRoute): void {
    controllers[resource]?.abort(); // superseded: its answer would be stale
    const controller = new AbortController();
    controllers[resource] = controller;
    const requestId = ++nextRequest;
    const previous = state[resource].key;
    // More runs of the same filter keep the shown runs until the longer list arrives.
    const keep = resource === "runs" && previous !== null && previous.split("|")[0] === key.split("|")[0];
    dispatch({ type: "request", resource, key, requestId, keep });
    void fetchOf(resource, r, controller.signal).then((result) => {
      if (controllers[resource] === controller) delete controllers[resource];
      if (!result.ok) return dispatch({ type: "failed", resource, requestId, error: result.error });
      const issue = mismatch(resource, key, result.data);
      if (issue !== null) {
        const error: ApiError = { kind: "invalid_response", httpStatus: 200, issues: [issue] };
        return dispatch({ type: "failed", resource, requestId, error });
      }
      dispatch({ type: "loaded", resource, requestId, data: result.data, receivedAt: result.receivedAt });
    });
  }

  function sync(r: HistoryRoute): void {
    route = r;
    const keys = keysFor(r, state);
    // A request the route no longer shows (an observation closed while loading, a list left for a
    // market) is cancelled; it is sent again if the route comes back. A request whose resource still
    // shows earlier rows (more runs) finishes, since its rows stand for the requested list.
    for (const resource of Object.keys(controllers) as ResourceName[]) {
      if (keys[resource] === undefined && state[resource].data === null) controllers[resource]?.abort();
    }
    for (const [resource, key] of Object.entries(keys) as [ResourceName, string][]) {
      if (needsRequest(state[resource], key)) request(resource, key, r);
    }
  }

  function loadStatus(): void {
    if (state.status !== null || statusController !== null) return;
    const controller = new AbortController();
    statusController = controller;
    void api.status(controller.signal).then((result) => {
      if (statusController === controller) statusController = null;
      dispatch(result.ok ? { type: "status", status: result.data } : { type: "status_failed", error: result.error });
    });
  }

  function dispose(): void {
    statusController?.abort();
    statusController = null;
    for (const resource of Object.keys(controllers) as ResourceName[]) controllers[resource]?.abort();
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync,
    reload(resource) {
      if (route === null) return;
      const key = keysFor(route, state)[resource];
      if (key !== undefined && !state[resource].loading) request(resource, key, route);
    },
    setOffset(offset) {
      dispatch({ type: "offset", offset });
      if (route !== null) sync(route);
    },
    showMoreRuns() {
      if (state.runsLimit >= RUNS_MAX || state.runs.loading) return;
      dispatch({ type: "runs_limit", limit: state.runsLimit + RUNS_STEP });
      if (route !== null) sync(route);
    },
    loadStatus,
    resetPaging() {
      dispatch({ type: "offset", offset: 0 });
      dispatch({ type: "runs_limit", limit: RUNS_STEP });
    },
    attach() {
      cancelDispose?.();
      cancelDispose = null;
      loadStatus();
    },
    detach() {
      cancelDispose?.();
      cancelDispose = defer(() => {
        cancelDispose = null;
        dispose();
      });
    },
  };
}
