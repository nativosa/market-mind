import type { Source } from "../../src/research/contracts";

// The selected market lives in the URL hash (#/market/<gammaId>), so the browser's back button and
// the in-app back action close the detail view the same way. Reading the route only selects a
// market; it never starts an inspection, which always follows a click or key press in the app.
//
// Stage 3.2 adds the offline Stored History section under #/history. Its routes name what to read
// from the local database (a market, an observation, the runs list) and, optionally, the source
// filter; reading them never touches the Live Explorer.

const MARKET_ROUTE = /^#\/market\/([0-9]{1,20})$/;
const HISTORY_ROUTE = /^#\/history(?:\/(runs)|\/market\/([0-9]{1,20})(?:\/obs\/([1-9][0-9]{0,15}))?)?\/?$/;

export const marketIdFromHash = (hash: string): string | null => MARKET_ROUTE.exec(hash)?.[1] ?? null;

export const hashFor = (id: string | null): string => (id === null ? "#/" : `#/market/${id}`);

/** A route of the Stored History section. `source` null: the server's default filter applies. */
export type HistoryRoute =
  | { section: "history"; page: "markets"; source: Source | null }
  | { section: "history"; page: "runs"; source: Source | null }
  | { section: "history"; page: "market"; marketId: string; observationId: number | null; source: Source | null };

export type AppRoute = { section: "live"; marketId: string | null } | HistoryRoute;

/** Every hash the app knows. Anything else (including an empty hash) is the Live Explorer's list. */
export function parseRoute(hash: string): AppRoute {
  const [path = "", query = ""] = hash.split("?", 2);
  const m = HISTORY_ROUTE.exec(path);
  if (m === null) return { section: "live", marketId: marketIdFromHash(hash) };
  const raw = new URLSearchParams(query).get("source");
  const source: Source | null = raw === "live" || raw === "all" ? raw : null;
  if (m[1] === "runs") return { section: "history", page: "runs", source };
  if (m[2] !== undefined) return { section: "history", page: "market", marketId: m[2], observationId: m[3] === undefined ? null : Number(m[3]), source };
  return { section: "history", page: "markets", source };
}

export const isHistoryHash = (hash: string): boolean => parseRoute(hash).section === "history";

/** The hash of a history route; the source filter is kept only when chosen explicitly. */
export function historyHash(route: HistoryRoute): string {
  const path =
    route.page === "markets"
      ? "#/history"
      : route.page === "runs"
        ? "#/history/runs"
        : `#/history/market/${route.marketId}${route.observationId === null ? "" : `/obs/${route.observationId}`}`;
  return route.source === null ? path : `${path}?source=${route.source}`;
}

/** The parts of `window` the route needs, so tests can supply a fake. */
export interface RouteWindow {
  /** `replace` (a browser's location has it) changes the hash without adding a history entry. */
  location: { hash: string; replace?: (url: string) => void };
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

/**
 * Report the Live Explorer's market in the current hash now and after every change; returns the
 * unsubscribe. History hashes are not explorer routes and are not reported, so leaving the explorer
 * for Stored History keeps its selection (and inspection) for when the user comes back.
 */
export function watchRoute(win: RouteWindow, onRoute: (id: string | null) => void): () => void {
  const listener = () => {
    if (!isHistoryHash(win.location.hash)) onRoute(marketIdFromHash(win.location.hash));
  };
  win.addEventListener("hashchange", listener);
  listener();
  return () => win.removeEventListener("hashchange", listener);
}

/** Report the whole parsed route now and after every change; returns the unsubscribe. */
export function watchAppRoute(win: RouteWindow, onRoute: (route: AppRoute, hash: string) => void): () => void {
  const listener = () => onRoute(parseRoute(win.location.hash), win.location.hash);
  win.addEventListener("hashchange", listener);
  listener();
  return () => win.removeEventListener("hashchange", listener);
}

/** Point the hash at `id` (adds a history entry) unless it already does. */
export function navigate(win: Pick<RouteWindow, "location">, id: string | null): void {
  const target = hashFor(id);
  const current = marketIdFromHash(win.location.hash);
  if (current === id && (id !== null || win.location.hash === "" || win.location.hash === target)) return;
  win.location.hash = target;
}

/** Point the hash at a history route (adds a history entry) unless it already does. */
export function navigateHistory(win: Pick<RouteWindow, "location">, route: HistoryRoute): void {
  const target = historyHash(route);
  if (win.location.hash !== target) win.location.hash = target;
}

/** Point the hash at `hash` in place: Back does not return to the replaced address. */
export function replaceHash(win: Pick<RouteWindow, "location">, hash: string): void {
  if (win.location.hash === hash) return;
  if (win.location.replace) win.location.replace(hash);
  else win.location.hash = hash;
}

export const marketButtonId = (id: string): string => `market-${id}`;

/**
 * Move keyboard focus to an element once React has painted it (no-op outside a browser). After a
 * hash navigation the element may appear a few frames later, so a missing element is retried briefly.
 */
export function focusSoon(elementId: string, frames = 10): void {
  if (typeof document === "undefined" || typeof requestAnimationFrame === "undefined") return;
  requestAnimationFrame(() => {
    const element = document.getElementById(elementId);
    if (element) element.focus({ preventScroll: false });
    else if (frames > 1) focusSoon(elementId, frames - 1);
  });
}
