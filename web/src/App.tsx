import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createApiClient, type ApiClient } from "./api";
import { Controls } from "./components/Controls";
import { DETAIL_HEADING_ID, DetailPanel } from "./components/DetailPanel";
import { Header } from "./components/Header";
import { MarketTable } from "./components/MarketTable";
import { ErrorNotice, LoadingRows, Notice } from "./components/Notice";
import { Pager } from "./components/Pager";
import { createController } from "./controller";
import { DEFAULT_FILTERS, filtersActive, initialState, reducer, scopeText, selectedMarket, visibleMarkets, type ExplorerState } from "./explorer";
import { formatAge, isStale } from "./format";
import { focusSoon, marketButtonId, navigate, watchRoute, type RouteWindow } from "./route";
import styles from "./App.module.css";

export interface AppProps {
  /** Injectable for tests; defaults to same-origin fetch of /api. */
  api?: ApiClient;
  clock?: () => number;
  initial?: ExplorerState;
  /** The window whose hash holds the selected market; null disables routing (tests without a DOM). */
  routeWindow?: RouteWindow | null;
}

const defaultRouteWindow = (): RouteWindow | null => (typeof window === "undefined" ? null : window);

/** A local clock for ages and countdowns. It re-renders; it never makes requests. */
function useNow(clock: () => number, intervalMs: number): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const timer = setInterval(() => setNow(clock()), intervalMs);
    return () => clearInterval(timer);
  }, [clock, intervalMs]);
  return now;
}

export function App({ api: injected, clock = Date.now, initial, routeWindow = defaultRouteWindow() }: AppProps) {
  const api = useMemo(() => injected ?? createApiClient(), [injected]);
  const [state, dispatch] = useReducer(reducer, initial ?? initialState());
  const now = useNow(clock, 1_000);
  const latest = useRef(state);
  latest.current = state;
  const controller = useMemo(() => createController(api, dispatch, () => latest.current), [api]);

  useEffect(() => {
    controller.loadStatus();
    return () => controller.dispose();
  }, [controller]);

  // The hash route selects (or deselects) a market but never inspects it: back/forward cost nothing.
  useEffect(() => (routeWindow ? watchRoute(routeWindow, (id) => controller.select(id, { inspect: false })) : undefined), [controller, routeWindow]);

  // The shown version's first page loads once (again only after an abort); a failure waits for an explicit retry.
  const feed = state.feeds[state.version];
  useEffect(() => controller.ensureFirstPage(), [controller, feed]);

  const visible = useMemo(() => visibleMarkets(state), [state]);
  const filtered = filtersActive(state.filters);
  const selected = selectedMarket(state);
  // A click or Enter on a market selects and inspects it, from the handler itself (not an effect).
  const onSelect = useCallback(
    (id: string) => {
      controller.select(id);
      if (routeWindow) navigate(routeWindow, id);
      focusSoon(DETAIL_HEADING_ID);
    },
    [controller, routeWindow],
  );
  const onClose = () => {
    const previous = state.selectedId;
    controller.select(null);
    if (routeWindow) navigate(routeWindow, null);
    if (previous !== null) focusSoon(marketButtonId(previous));
  };
  const stale = isStale(feed.fetchedAt, now);

  return (
    <div className={`${styles.app} ${state.selectedId !== null ? styles.selecting : ""}`}>
      <Header connection={state.connection} budget={state.budget} />
      <main className={styles.main}>
        <section className={styles.listColumn} aria-label="Markets">
          <Controls
            version={state.version}
            filters={state.filters}
            sort={state.sort}
            onVersion={(version) => controller.switchVersion(version)}
            onFilters={(patch) => dispatch({ type: "filters", patch })}
            onSort={(sort) => dispatch({ type: "sort", sort })}
          />
          {feed.pages > 0 && (
            <div className={styles.bar}>
              <span className={styles.scope} aria-live="polite">
                {scopeText(visible.length, feed.markets.length, state.version, filtered)}
                <span className={styles.scopeNote}> · search covers loaded markets only, not all of Polymarket</span>
              </span>
              <span className={styles.fresh}>
                {feed.fetchedAt !== null && (
                  <span className={stale ? styles.stale : undefined}>{stale ? `Stale: fetched ${formatAge(now - feed.fetchedAt)}` : `Fetched ${formatAge(now - feed.fetchedAt)}`}</span>
                )}
                <button type="button" onClick={() => controller.load(state.version, "first")} disabled={feed.loading !== null} title="Fetch the first page again (loaded pages are replaced)">
                  Refresh
                </button>
              </span>
            </div>
          )}
          <ListBody
            state={state}
            visible={visible}
            now={now}
            onRetry={() => controller.load(state.version, "first")}
            onSelect={onSelect}
            onClear={() => dispatch({ type: "filters", patch: DEFAULT_FILTERS })}
          />
          {feed.moreError && <ErrorNotice error={feed.moreError} now={now} context="Loading the next page failed" retryLabel="Retry next page" onRetry={() => controller.load(state.version, "more")} />}
          {feed.pages > 0 && <Pager feed={feed} onLoadMore={() => controller.load(state.version, "more")} />}
        </section>
        <div className={styles.detailColumn}>
          <DetailPanel
            market={selected}
            selectedId={state.selectedId}
            inspection={state.inspection}
            depth={state.ladderDepth}
            now={now}
            onInspect={() => controller.inspect()}
            onCancel={() => controller.cancelInspection()}
            onDepth={(depth) => dispatch({ type: "depth", depth })}
            onClose={onClose}
          />
        </div>
      </main>
      <footer className={styles.footer}>
        <p>
          MarketMind is an educational, read-only research tool. It cannot place trades. Market questions and labels are third-party text. Gamma 24h volume is not
          liquidity, and a quoted spread is not a profit.
        </p>
      </footer>
    </div>
  );
}

interface ListBodyProps {
  state: ExplorerState;
  visible: ReturnType<typeof visibleMarkets>;
  now: number;
  onRetry: () => void;
  onSelect: (id: string) => void;
  onClear: () => void;
}

export function ListBody({ state, visible, now, onRetry, onSelect, onClear }: ListBodyProps) {
  const feed = state.feeds[state.version];
  const label = state.version.toUpperCase();
  if (feed.error) return <ErrorNotice error={feed.error} now={now} context={`Loading ${label} markets failed`} onRetry={onRetry} />;
  if (feed.pages === 0) return <LoadingRows label={`Loading ${label} markets`} />;
  if (feed.markets.length === 0) {
    return (
      <Notice title={`No open ${label} markets returned`}>
        <p>Polymarket returned an empty page for this version.</p>
      </Notice>
    );
  }
  if (visible.length === 0) {
    return (
      <Notice title="No loaded markets match">
        <p>Only the {feed.markets.length} loaded markets were searched. Load more pages or change the filters.</p>
        <button type="button" onClick={onClear}>
          Clear search and filters
        </button>
      </Notice>
    );
  }
  return <MarketTable markets={visible} selectedId={state.selectedId} onSelect={onSelect} />;
}
