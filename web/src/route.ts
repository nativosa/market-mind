// The selected market lives in the URL hash (#/market/<gammaId>), so the browser's back button and
// the in-app back action close the detail view the same way. Reading the route only selects a
// market; it never starts an inspection, which always follows a click or key press in the app.

const MARKET_ROUTE = /^#\/market\/([0-9]{1,20})$/;

export const marketIdFromHash = (hash: string): string | null => MARKET_ROUTE.exec(hash)?.[1] ?? null;

export const hashFor = (id: string | null): string => (id === null ? "#/" : `#/market/${id}`);

/** The parts of `window` the route needs, so tests can supply a fake. */
export interface RouteWindow {
  location: { hash: string };
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

/** Report the market in the current hash now and after every change; returns the unsubscribe. */
export function watchRoute(win: RouteWindow, onRoute: (id: string | null) => void): () => void {
  const listener = () => onRoute(marketIdFromHash(win.location.hash));
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

export const marketButtonId = (id: string): string => `market-${id}`;

/** Move keyboard focus to an element once React has painted it (no-op outside a browser). */
export function focusSoon(elementId: string): void {
  if (typeof document === "undefined" || typeof requestAnimationFrame === "undefined") return;
  requestAnimationFrame(() => document.getElementById(elementId)?.focus({ preventScroll: false }));
}
