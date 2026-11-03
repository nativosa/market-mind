import { WEB_LIMITS } from "../../src/research/contracts";
import { DEFAULT_DEPTH } from "./book";
import type { ApiError, Inspection, MarketItem, Markets, Status, Version } from "./api";

// Explorer state as a pure reducer: every network result carries the id of the request that asked for
// it, and a result whose id is no longer the feed's current one is stale and ignored.

export const MAX_PAGES = WEB_LIMITS.list.maxPages;
export const VERSIONS: readonly Version[] = ["v1", "v2"];

export type FeedEnd = "last_page" | "page_cap" | "cursor_unsupported";

/** Markets loaded for one protocol version, page by page. */
export interface Feed {
  markets: MarketItem[];
  pages: number;
  nextCursor: string | null;
  /** Why no further page can be loaded; null while more is available. */
  end: FeedEnd | null;
  loading: "first" | "more" | null;
  /** The request whose answer this feed is waiting for (0: none yet). */
  requestId: number;
  /** The first page failed: nothing is loaded. */
  error: ApiError | null;
  /** A later page failed: earlier pages stay visible. */
  moreError: ApiError | null;
  /** When the first page arrived (ms); loaded pages are as old as this. */
  fetchedAt: number | null;
  /** Records Gamma returned that failed validation, and repeats dropped while appending. */
  skipped: number;
  duplicates: number;
}

export interface Filters {
  query: string;
  eligibility: "all" | "inspectable" | "not_inspectable";
  /** Only markets whose order book Gamma reports as enabled. */
  orderBookEnabled: boolean;
  /** Only markets Gamma reports as accepting orders. */
  acceptingOrders: boolean;
}

export type SortKey = "volume" | "question";

/**
 * The selected market's live inspection. Only one exists: selecting another market replaces it
 * (and aborts its request), and an answer for any other request id is stale and ignored.
 */
export interface InspectionState {
  marketId: string | null;
  requestId: number;
  loading: boolean;
  /** The latest answer for this market; kept while a refresh loads or after a refresh fails. */
  result: { data: Inspection; receivedAt: number } | null;
  /** The latest request failed or was cancelled; an earlier result, if any, stays visible. */
  error: ApiError | null;
}
export type Budget = Markets["budget"];
export type Connection = "checking" | "connected" | "unreachable";

export interface ExplorerState {
  version: Version;
  feeds: Record<Version, Feed>;
  filters: Filters;
  sort: SortKey;
  selectedId: string | null;
  inspection: InspectionState;
  /** Price levels shown per side in the ladders (a local choice; no request). */
  ladderDepth: number;
  /** The latest budget the server reported (status or a listing). */
  budget: { process: Budget["process"]; window: Budget["window"] } | null;
  status: Status | null;
  connection: Connection;
}

export type Action =
  | { type: "version"; version: Version }
  | { type: "request"; version: Version; mode: "first" | "more"; requestId: number }
  | { type: "loaded"; version: Version; requestId: number; page: Markets; receivedAt: number }
  | { type: "failed"; version: Version; requestId: number; error: ApiError }
  | { type: "status"; status: Status }
  | { type: "status_failed"; error: ApiError }
  | { type: "filters"; patch: Partial<Filters> }
  | { type: "sort"; sort: SortKey }
  | { type: "select"; id: string | null }
  | { type: "depth"; depth: number }
  | { type: "inspect_request"; id: string; requestId: number }
  | { type: "inspected"; requestId: number; data: Inspection; receivedAt: number }
  | { type: "inspect_failed"; requestId: number; error: ApiError };

export const emptyFeed = (): Feed => ({
  markets: [],
  pages: 0,
  nextCursor: null,
  end: null,
  loading: null,
  requestId: 0,
  error: null,
  moreError: null,
  fetchedAt: null,
  skipped: 0,
  duplicates: 0,
});

export const emptyInspection = (marketId: string | null = null): InspectionState => ({ marketId, requestId: 0, loading: false, result: null, error: null });

export const DEFAULT_FILTERS: Filters = { query: "", eligibility: "all", orderBookEnabled: false, acceptingOrders: false };

export function initialState(version: Version = "v1"): ExplorerState {
  return {
    version,
    feeds: { v1: emptyFeed(), v2: emptyFeed() },
    filters: DEFAULT_FILTERS,
    sort: "volume",
    selectedId: null,
    inspection: emptyInspection(),
    ladderDepth: DEFAULT_DEPTH,
    budget: null,
    status: null,
    connection: "checking",
  };
}

/** Load more only on request, one page at a time, while the server offers a cursor and the local cap allows. */
export const canLoadMore = (feed: Feed): boolean => feed.loading === null && feed.pages > 0 && feed.nextCursor !== null && feed.pages < MAX_PAGES;

/** A feed that has never loaded (or whose first page was abandoned) and is not loading or failed. */
export const needsFirstPage = (feed: Feed): boolean => feed.pages === 0 && feed.loading === null && feed.error === null;

function endOf(page: Markets, pages: number): FeedEnd | null {
  const { nextCursor, stoppedReason } = page.pagination;
  if (nextCursor === null) return stoppedReason === "CURSOR_UNSUPPORTED" ? "cursor_unsupported" : "last_page";
  return pages >= MAX_PAGES ? "page_cap" : null;
}

const connectionAfter = (error: ApiError, current: Connection): Connection =>
  error.kind === "network" ? "unreachable" : error.kind === "aborted" ? current : "connected";

type ExplorerBudget = NonNullable<ExplorerState["budget"]>;

/**
 * Budget snapshots arrive out of order (status, listings, inspections). The lifetime count only
 * grows within a server process, so a snapshot with fewer attempts used is older and is ignored.
 */
export function newerBudget(current: ExplorerState["budget"], incoming: { process: ExplorerBudget["process"]; window?: ExplorerBudget["window"] }): ExplorerBudget {
  if (current !== null && incoming.process.limit === current.process.limit && incoming.process.used < current.process.used) return current;
  return { process: incoming.process, window: incoming.window === undefined ? (current?.window ?? null) : incoming.window };
}

function updateFeed(state: ExplorerState, version: Version, feed: Feed): ExplorerState {
  return { ...state, feeds: { ...state.feeds, [version]: feed } };
}

export function reducer(state: ExplorerState, action: Action): ExplorerState {
  switch (action.type) {
    case "version":
      return { ...state, version: action.version };
    case "request": {
      const feed = state.feeds[action.version];
      if (action.mode === "first") return updateFeed(state, action.version, { ...emptyFeed(), loading: "first", requestId: action.requestId });
      if (!canLoadMore(feed)) return state;
      return updateFeed(state, action.version, { ...feed, loading: "more", requestId: action.requestId, moreError: null });
    }
    case "loaded": {
      const feed = state.feeds[action.version];
      // Stale: superseded by a newer request, or an answer for another version.
      if (action.requestId !== feed.requestId || feed.loading === null || action.page.appliedLimits.version !== action.version) return state;
      const first = feed.loading === "first";
      const base = first ? [] : feed.markets;
      const seen = new Set(base.map((m) => m.gammaId));
      const added: MarketItem[] = [];
      for (const market of action.page.markets.items) {
        if (seen.has(market.gammaId)) continue;
        seen.add(market.gammaId);
        added.push(market);
      }
      const pages = (first ? 0 : feed.pages) + 1;
      const next: Feed = {
        ...feed,
        markets: [...base, ...added],
        pages,
        nextCursor: action.page.pagination.nextCursor,
        end: endOf(action.page, pages),
        loading: null,
        error: null,
        moreError: null,
        fetchedAt: first ? action.receivedAt : feed.fetchedAt,
        skipped: (first ? 0 : feed.skipped) + action.page.skipped.totalCount,
        duplicates: (first ? 0 : feed.duplicates) + action.page.markets.items.length - added.length,
      };
      return { ...updateFeed(state, action.version, next), budget: newerBudget(state.budget, action.page.budget), connection: "connected" };
    }
    case "failed": {
      const feed = state.feeds[action.version];
      if (action.requestId !== feed.requestId || feed.loading === null) return state;
      const settled: Feed =
        action.error.kind === "aborted"
          ? { ...feed, loading: null }
          : feed.loading === "first"
            ? { ...feed, loading: null, error: action.error }
            : { ...feed, loading: null, moreError: action.error };
      return { ...updateFeed(state, action.version, settled), connection: connectionAfter(action.error, state.connection) };
    }
    case "status":
      return { ...state, status: action.status, budget: newerBudget(state.budget, action.status.budget), connection: "connected" };
    case "status_failed":
      return { ...state, connection: connectionAfter(action.error, state.connection) };
    case "filters":
      return { ...state, filters: { ...state.filters, ...action.patch } };
    case "sort":
      return { ...state, sort: action.sort };
    case "select":
      // A new selection releases the previous market's inspection entirely.
      return action.id === state.selectedId ? state : { ...state, selectedId: action.id, inspection: emptyInspection(action.id) };
    case "depth":
      return { ...state, ladderDepth: action.depth };
    case "inspect_request":
      if (action.id !== state.selectedId) return state;
      return { ...state, inspection: { ...state.inspection, marketId: action.id, requestId: action.requestId, loading: true, error: null } };
    case "inspected": {
      const current = state.inspection;
      if (action.requestId !== current.requestId || !current.loading) return state;
      if (action.data.market.gammaId !== current.marketId) {
        const error: ApiError = { kind: "invalid_response", httpStatus: 200, issues: [`market.gammaId: expected ${current.marketId}`] };
        return { ...state, inspection: { ...current, loading: false, error } };
      }
      return {
        ...state,
        inspection: { ...current, loading: false, error: null, result: { data: action.data, receivedAt: action.receivedAt } },
        budget: newerBudget(state.budget, action.data.budget),
        connection: "connected",
      };
    }
    case "inspect_failed": {
      const current = state.inspection;
      if (action.requestId !== current.requestId || !current.loading) return state;
      return { ...state, inspection: { ...current, loading: false, error: action.error }, connection: connectionAfter(action.error, state.connection) };
    }
  }
}

// ---- local search, filters and sorting (loaded markets only) ----

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Compare two non-negative decimal strings exactly, without converting to floating point. Values
 * that are not plain decimals (e.g. exponent form) sort after every plain one.
 */
export function compareDecimals(a: string, b: string): number {
  const okA = PLAIN_DECIMAL.test(a);
  const okB = PLAIN_DECIMAL.test(b);
  if (!okA || !okB) return okA === okB ? 0 : okA ? -1 : 1;
  const [intA = "", fracA = ""] = a.split(".");
  const [intB = "", fracB = ""] = b.split(".");
  const ia = intA.replace(/^0+(?=\d)/, "");
  const ib = intB.replace(/^0+(?=\d)/, "");
  if (ia.length !== ib.length) return ia.length < ib.length ? -1 : 1;
  if (ia !== ib) return ia < ib ? -1 : 1;
  const width = Math.max(fracA.length, fracB.length);
  const fa = fracA.padEnd(width, "0");
  const fb = fracB.padEnd(width, "0");
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

export function matchesFilters(market: MarketItem, filters: Filters): boolean {
  const q = filters.query.trim().toLowerCase();
  if (q !== "" && !market.question.toLowerCase().includes(q) && !market.slug.toLowerCase().includes(q)) return false;
  if (filters.eligibility === "inspectable" && !market.eligibility.inspectable) return false;
  if (filters.eligibility === "not_inspectable" && market.eligibility.inspectable) return false;
  if (filters.orderBookEnabled && market.enableOrderBook !== true) return false;
  if (filters.acceptingOrders && market.acceptingOrders !== true) return false;
  return true;
}

const byQuestion = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Highest Gamma 24h volume first (unknown last), or question A to Z; ties keep the loaded order. */
export function sortMarkets(markets: readonly MarketItem[], sort: SortKey): MarketItem[] {
  const copy = [...markets];
  if (sort === "question") return copy.sort((a, b) => byQuestion.compare(a.question, b.question));
  return copy.sort((a, b) => {
    if (a.gammaVolume24hr === null || b.gammaVolume24hr === null) return a.gammaVolume24hr === b.gammaVolume24hr ? 0 : a.gammaVolume24hr === null ? 1 : -1;
    return compareDecimals(b.gammaVolume24hr, a.gammaVolume24hr);
  });
}

export function visibleMarkets(state: ExplorerState): MarketItem[] {
  const feed = state.feeds[state.version];
  return sortMarkets(
    feed.markets.filter((m) => matchesFilters(m, state.filters)),
    state.sort,
  );
}

export const filtersActive = (filters: Filters): boolean =>
  filters.query.trim() !== "" || filters.eligibility !== "all" || filters.orderBookEnabled || filters.acceptingOrders;

/** Always states the scope: only loaded markets are searched, never all of Polymarket. */
export function scopeText(matches: number, loaded: number, version: Version, filtered: boolean): string {
  const markets = `${loaded} loaded ${version.toUpperCase()} ${loaded === 1 ? "market" : "markets"}`;
  return filtered ? `${matches} ${matches === 1 ? "match" : "matches"} among ${markets}` : `Showing all ${markets}`;
}

/** A loaded market by id, looked up in every loaded feed (it may belong to the other version). */
export function marketById(state: ExplorerState, id: string): MarketItem | null {
  for (const version of [state.version, ...VERSIONS.filter((v) => v !== state.version)]) {
    const found = state.feeds[version].markets.find((m) => m.gammaId === id);
    if (found) return found;
  }
  return null;
}

/** The selected market, if it is among the loaded ones. */
export const selectedMarket = (state: ExplorerState): MarketItem | null => (state.selectedId === null ? null : marketById(state, state.selectedId));
