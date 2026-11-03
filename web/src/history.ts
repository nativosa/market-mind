import { WEB_LIMITS } from "../../src/research/contracts";
import type { ApiError, History, ObservationDetails, Runs, Source, Status, StoredMarkets } from "./api";
import type { HistoryRoute } from "./route";

// Stored History state as a pure reducer. Each resource remembers the key it was requested for
// (what to read and with which source filter) and the id of its latest request; an answer for any
// other request id is stale and ignored, so superseded responses can never replace newer ones.

export const MARKETS_PAGE_SIZE = WEB_LIMITS.storedMarkets.limit.default;
export const RUNS_STEP = WEB_LIMITS.storedRuns.limit.default;
export const RUNS_MAX = WEB_LIMITS.storedRuns.limit.max;

export interface Resource<T> {
  /** What the data (or the request in flight) is for; null before the first request. */
  key: string | null;
  requestId: number;
  loading: boolean;
  data: T | null;
  /** When the browser received `data` (local clock). */
  receivedAt: number | null;
  error: ApiError | null;
}

export interface Resources {
  markets: Resource<StoredMarkets>;
  runs: Resource<Runs>;
  history: Resource<History>;
  observation: Resource<ObservationDetails>;
}
export type ResourceName = keyof Resources;

export interface HistoryState extends Resources {
  /** First market of the shown stored-markets page. */
  marketsOffset: number;
  /** Most recent runs requested (grows by "Show more runs", up to the API maximum). */
  runsLimit: number;
  status: Status | null;
}

export type HistoryAction =
  | { type: "request"; resource: ResourceName; key: string; requestId: number; keep: boolean }
  | { type: "loaded"; resource: ResourceName; requestId: number; data: unknown; receivedAt: number }
  | { type: "failed"; resource: ResourceName; requestId: number; error: ApiError }
  | { type: "offset"; offset: number }
  | { type: "runs_limit"; limit: number }
  | { type: "status"; status: Status };

export const emptyResource = <T>(): Resource<T> => ({ key: null, requestId: 0, loading: false, data: null, receivedAt: null, error: null });

export function initialHistoryState(): HistoryState {
  return { markets: emptyResource(), runs: emptyResource(), history: emptyResource(), observation: emptyResource(), marketsOffset: 0, runsLimit: RUNS_STEP, status: null };
}

const sourceKey = (source: Source | null) => source ?? "default";

/** The key of each resource a route shows (and so needs loaded). */
export function keysFor(route: HistoryRoute, state: Pick<HistoryState, "marketsOffset" | "runsLimit">): Partial<Record<ResourceName, string>> {
  const s = sourceKey(route.source);
  switch (route.page) {
    case "markets":
      return { markets: `${s}|${state.marketsOffset}` };
    case "runs":
      return { runs: `${s}|${state.runsLimit}` };
    case "market":
      return route.observationId === null ? { history: `${route.marketId}|${s}` } : { history: `${route.marketId}|${s}`, observation: `${route.observationId}|${s}` };
  }
}

/** Whether `resource` must be requested to show `key`: another key, or nothing loaded, loading or failed for it. */
export const needsRequest = (resource: Resource<unknown>, key: string): boolean =>
  resource.key !== key || (!resource.loading && resource.data === null && resource.error === null);

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case "request": {
      const current = state[action.resource];
      // A different key never shows the previous key's data, except when explicitly kept (more runs of the same filter).
      const keep = action.keep || current.key === action.key;
      return { ...state, [action.resource]: { ...current, key: action.key, requestId: action.requestId, loading: true, error: null, ...(keep ? {} : { data: null, receivedAt: null }) } };
    }
    case "loaded": {
      const current = state[action.resource];
      if (action.requestId !== current.requestId || !current.loading) return state;
      return { ...state, [action.resource]: { ...current, loading: false, error: null, data: action.data, receivedAt: action.receivedAt } };
    }
    case "failed": {
      const current = state[action.resource];
      if (action.requestId !== current.requestId || !current.loading) return state;
      // Aborted: nothing to show and nothing failed; the next sync requests it again if still wanted.
      return { ...state, [action.resource]: { ...current, loading: false, error: action.error.kind === "aborted" ? null : action.error } };
    }
    case "offset":
      return { ...state, marketsOffset: Math.max(0, action.offset) };
    case "runs_limit":
      return { ...state, runsLimit: Math.min(RUNS_MAX, Math.max(1, action.limit)) };
    case "status":
      return { ...state, status: action.status };
  }
}

/**
 * The source filter in effect: the route's explicit choice, else what the server applied to the
 * shown answer, else the server's announced default. Live only until anything says otherwise.
 */
export function effectiveSource(route: HistoryRoute, applied: Source | null | undefined, status: Status | null): Source {
  return route.source ?? applied ?? status?.stored.defaultSource ?? "live";
}

/** Whether a failure means there is no local database (an empty state, not an error). */
export const isDatabaseMissing = (error: ApiError | null): boolean => error?.kind === "server" && error.error.category === "database_missing";

// ---- display text ----

export const RUN_STATUS_TEXT: Record<Runs["runs"]["items"][number]["status"], string> = {
  running: "Running",
  complete: "Complete",
  partial: "Partial",
  interrupted: "Interrupted",
  failed: "Failed",
};

export const ACCOUNTING_TEXT: Record<Runs["runs"]["items"][number]["accounting"], string> = {
  pending: "Request accounting pending",
  verified: "Request accounting verified",
  incomplete: "Request accounting incomplete",
};

export const OWNER_TEXT: Readonly<Record<string, string>> = {
  RECOVERABLE: "Its process is gone; the next collect marks it interrupted.",
  OTHER_HOST: "Started on another computer; its state cannot be checked here.",
  OWNER_ALIVE: "Its process is still running.",
  OWNER_UNKNOWN: "Whether its process is still running cannot be determined.",
  HEARTBEAT_FRESH: "Its heartbeat is recent; it is probably still collecting.",
};

/** One persist count of a run (as the CLI's runs table shows them); null when unknown, never zero. */
export function runCount(run: Runs["runs"]["items"][number], key: "selected" | "persistedObservations" | "persistenceFailures" | "booksWritten"): number | null {
  const value = run.persistCounts?.[key];
  return typeof value === "number" ? value : null;
}

/** Run ids are long; the table shows their start, the full id stays available as a title and in details. */
export const shortRunId = (runId: string): string => (runId.length > 13 ? `${runId.slice(0, 12)}…` : runId);
