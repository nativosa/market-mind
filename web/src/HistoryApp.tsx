import { useEffect, useSyncExternalStore } from "react";
import type { Source } from "./api";
import { Header, type NavProps } from "./components/Header";
import { MarketHistory } from "./components/MarketHistory";
import { ErrorNotice, Notice } from "./components/Notice";
import { ResourceState } from "./components/ResourceState";
import { SourceFilter, SyntheticNotice } from "./components/SourceFilter";
import { RunsTable, StoredMarketTable } from "./components/StoredTables";
import type { Connection } from "./explorer";
import { effectiveSource, isDatabaseMissing, MARKETS_PAGE_SIZE, RUNS_MAX, type HistoryState } from "./history";
import type { HistoryStore } from "./historyStore";
import { formatCount } from "./format";
import { historyHash, navigateHistory, type HistoryRoute, type RouteWindow } from "./route";
import styles from "./HistoryApp.module.css";

export interface HistoryAppProps {
  store: HistoryStore;
  route: HistoryRoute;
  /** False while the Live Explorer is shown: nothing is requested for a hidden page. */
  active: boolean;
  nav: NavProps;
  clock?: () => number;
  routeWindow: RouteWindow | null;
}

/**
 * Stored History: the local database through the local server's read-only routes. Every request
 * follows from the route (or an explicit retry); nothing here reaches Polymarket or a model.
 */
export function HistoryApp({ store, route, active, nav, clock = Date.now, routeWindow }: HistoryAppProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useEffect(() => {
    store.attach();
    return () => store.detach();
  }, [store]);
  useEffect(() => {
    if (active) store.sync(route);
  }, [store, route, active]);

  const go = (next: HistoryRoute) => (routeWindow ? navigateHistory(routeWindow, next) : store.sync(next));
  const applied = appliedSource(state, route);
  const source = effectiveSource(route, applied, state.status);
  const onSource = (next: Source) => {
    if (next === source) return;
    store.resetPaging();
    go({ ...route, source: next });
  };
  const connection: Connection = state.status !== null ? "connected" : anyNetworkError(state) ? "unreachable" : "checking";
  const now = clock();

  return (
    <div className={styles.app}>
      <Header connection={connection} nav={nav} />
      <main className={styles.main}>
        <div className={styles.toolbar}>
          {route.page === "market" ? (
            <a className={styles.backLink} href={historyHash({ section: "history", page: "markets", source: route.source })}>
              <span aria-hidden="true">&larr; </span>Stored markets
            </a>
          ) : (
            <nav className={styles.tabs} aria-label="Stored data">
              <a href={historyHash({ section: "history", page: "markets", source: route.source })} aria-current={route.page === "markets" ? "page" : undefined}>
                Stored markets
              </a>
              <a href={historyHash({ section: "history", page: "runs", source: route.source })} aria-current={route.page === "runs" ? "page" : undefined}>
                Collection runs
              </a>
            </nav>
          )}
          <SourceFilter source={source} onSource={onSource} />
        </div>
        {source === "all" && <SyntheticNotice />}
        {route.page === "markets" && <MarketsPage state={state} route={route} now={now} onRetry={() => store.reload("markets")} onOffset={(offset) => store.setOffset(offset)} />}
        {route.page === "runs" && <RunsPage state={state} now={now} onRetry={() => store.reload("runs")} onMore={() => store.showMoreRuns()} />}
        {route.page === "market" && <MarketHistory state={state} route={route} now={now} onRetry={() => store.reload("history")} onRoute={go} onRetryObservation={() => store.reload("observation")} />}
      </main>
      <footer className={styles.footer}>
        <p>
          Stored History shows discrete observations that MarketMind&apos;s collect command saved on this computer. Nothing is known between observations, statistics count
          samples rather than time, and nothing here is fetched from Polymarket. Market questions and labels are third-party text.
        </p>
      </footer>
    </div>
  );
}

function appliedSource(state: HistoryState, route: HistoryRoute): Source | null {
  switch (route.page) {
    case "markets":
      return state.markets.data?.appliedLimits.source ?? null;
    case "runs":
      return state.runs.data?.appliedLimits.source ?? null;
    case "market":
      return state.history.data?.appliedLimits.source ?? null;
  }
}

const anyNetworkError = (state: HistoryState) => [state.markets, state.runs, state.history, state.observation].some((r) => r.error?.kind === "network");

interface MarketsPageProps {
  state: HistoryState;
  route: HistoryRoute;
  now: number;
  onRetry: () => void;
  onOffset: (offset: number) => void;
}

export function MarketsPage({ state, route, now, onRetry, onOffset }: MarketsPageProps) {
  const { data, loading, error } = state.markets;
  if (data === null || error !== null) return <ResourceState loading={loading} error={error} now={now} label="stored markets" onRetry={onRetry} />;
  const { items, hasMore, nextOffset } = data.markets;
  const offset = data.appliedLimits.offset;
  if (items.length === 0) {
    return (
      <Notice title={offset > 0 ? "No more stored markets" : "No stored markets"}>
        {offset > 0 ? (
          <button type="button" onClick={() => onOffset(0)}>
            Back to the first page
          </button>
        ) : data.appliedLimits.source === "live" ? (
          <p className={styles.note}>
            The database holds no live observations yet. Run <code>npm run cli -- collect</code> to record some. Synthetic (test or demonstration) observations, if any, appear
            only with Live + synthetic.
          </p>
        ) : (
          <p className={styles.note}>
            The database holds no observations yet. Run <code>npm run cli -- collect</code> to record some.
          </p>
        )}
      </Notice>
    );
  }
  return (
    <section className={styles.section} aria-label="Stored markets" aria-busy={loading}>
      <p className={styles.scope}>
        Markets {formatCount(offset + 1)} to {formatCount(offset + items.length)} with stored observations, most recently observed first. Counts are stored observations, not
        market activity.
      </p>
      <StoredMarketTable markets={items} source={route.source} />
      <div className={styles.pager}>
        <button type="button" onClick={() => onOffset(Math.max(0, offset - MARKETS_PAGE_SIZE))} disabled={offset === 0 || loading}>
          Previous page
        </button>
        <span>{hasMore ? "More stored markets exist." : "End of stored markets."}</span>
        <button type="button" onClick={() => nextOffset !== null && onOffset(nextOffset)} disabled={!hasMore || loading}>
          Next page
        </button>
      </div>
    </section>
  );
}

export function RunsPage({ state, now, onRetry, onMore }: { state: HistoryState; now: number; onRetry: () => void; onMore: () => void }) {
  const { data, loading, error } = state.runs;
  if (data === null || (error !== null && isDatabaseMissing(error))) return <ResourceState loading={loading} error={error} now={now} label="collection runs" onRetry={onRetry} />;
  const { items, hasMore } = data.runs;
  return (
    <section className={styles.section} aria-label="Collection runs" aria-busy={loading}>
      {error !== null && <ErrorNotice error={error} now={now} context="Loading more runs failed" onRetry={onRetry} />}
      {items.length === 0 ? (
        <Notice title="No collection runs recorded">
          <p className={styles.note}>
            {data.appliedLimits.source === "live"
              ? "No live collection run is stored. Synthetic runs, if any, appear only with Live + synthetic."
              : "The database holds no collection runs yet."}{" "}
            Run <code>npm run cli -- collect</code> to record one.
          </p>
        </Notice>
      ) : (
        <>
          <p className={styles.scope}>
            The {formatCount(items.length)} most recent collection {items.length === 1 ? "run" : "runs"}, newest first. A run still marked running may have stopped without
            finishing; nothing here changes it.
          </p>
          <RunsTable runs={items} />
          <div className={styles.pager}>
            {hasMore && data.appliedLimits.limit < RUNS_MAX ? (
              <button type="button" onClick={onMore} disabled={loading}>
                {loading ? "Loading more runs…" : "Show more runs"}
              </button>
            ) : (
              <span>{hasMore ? `Showing the ${RUNS_MAX} most recent runs, the most this page lists. npm run cli -- runs lists older ones.` : "End of collection runs."}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
