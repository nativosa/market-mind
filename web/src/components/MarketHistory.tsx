import type { History } from "../api";
import { formatTimestamp } from "../book";
import { formatCount } from "../format";
import type { HistoryState } from "../history";
import { ResourceState } from "./ResourceState";
import type { HistoryRoute } from "../route";
import { HistoryCharts } from "./HistoryCharts";
import { AnalysisWindowNote, HistoryStats } from "./HistoryStats";
import { Notice } from "./Notice";
import { ObservationTable } from "./ObservationTable";
import styles from "./MarketHistory.module.css";

export const HISTORY_HEADING_ID = "history-market-heading";

export interface MarketHistoryProps {
  state: HistoryState;
  route: Extract<HistoryRoute, { page: "market" }>;
  now: number;
  onRetry: () => void;
  onRetryObservation: () => void;
  onRoute: (route: HistoryRoute) => void;
}

/** The newest stored question of the market, else a stored-markets row, else its ID. Third-party text. */
export function marketTitle(state: HistoryState, marketId: string): string {
  const fromHistory = state.history.data?.appliedLimits.marketId === marketId ? state.history.data.series.items[0]?.question : undefined;
  const fromList = state.markets.data?.markets.items.find((m) => m.gammaId === marketId)?.latest.question;
  return fromHistory ?? fromList ?? `Market ${marketId}`;
}

/** One market's stored history: what was observed, when, and from which sources. */
export function MarketHistory({ state, route, now, onRetry, onRoute }: MarketHistoryProps) {
  const { data, loading, error } = state.history;
  const onSelect = (observationId: number) => onRoute({ ...route, observationId });
  return (
    <section className={styles.market} aria-labelledby={HISTORY_HEADING_ID}>
      <h2 id={HISTORY_HEADING_ID} className={styles.question} tabIndex={-1}>
        {marketTitle(state, route.marketId)}
      </h2>
      {data === null || error !== null ? (
        <ResourceState loading={loading} error={error} now={now} label="this market's stored history" onRetry={onRetry} />
      ) : (
        <HistoryBody history={data} selectedId={route.observationId} onSelect={onSelect} />
      )}
    </section>
  );
}

function HistoryBody({ history: h, selectedId, onSelect }: { history: History; selectedId: number | null; onSelect: (observationId: number) => void }) {
  if (h.status === "no_history") {
    return (
      <Notice title="No stored observations of this market">
        <p className={styles.note}>
          Nothing stored matches {h.appliedLimits.source === "live" ? "the Live only filter" : "this market"}. This is insufficient evidence, not evidence that nothing happened.
          {h.appliedLimits.source === "live" ? " Synthetic observations, if any, appear only with Live + synthetic." : ""}
        </p>
      </Notice>
    );
  }
  const s = h.series;
  return (
    <>
      <dl className={styles.facts}>
        <dt>Market ID</dt>
        <dd className="mono">{h.appliedLimits.marketId}</dd>
        <dt>Observations shown</dt>
        <dd>
          {formatCount(s.returnedCount)} ({formatCount(s.sourceCounts.live)} live
          {s.sourceCounts.synthetic > 0 ? `, ${formatCount(s.sourceCounts.synthetic)} synthetic` : ""})
        </dd>
        <dt>Shown from</dt>
        <dd className="mono">{formatTimestamp(s.oldestAvailableAt)}</dd>
        <dt>Shown to</dt>
        <dd className="mono">{formatTimestamp(s.newestAvailableAt)}</dd>
        <dt>Analytics version</dt>
        <dd>v{h.appliedLimits.analyticsVersion} (metrics of other versions are never mixed in)</dd>
      </dl>
      <AnalysisWindowNote history={h} />
      {h.evidence === "insufficient" && (
        <Notice tone="warning" title="Insufficient evidence">
          <p className={styles.note}>No observation in the analysis window is usable, so there are no statistics. The table still lists what was stored.</p>
        </Notice>
      )}
      {h.stats !== null && h.analysisWindow !== null && h.stats.usable > 0 && <HistoryStats stats={h.stats} window={h.analysisWindow} threshold={h.appliedLimits.spreadThreshold} />}
      <HistoryCharts items={s.items} spreadThreshold={h.appliedLimits.spreadThreshold} selectedId={selectedId} onSelect={onSelect} />
      <ObservationTable items={s.items} selectedId={selectedId} onSelect={onSelect} />
      <section className={styles.limitations} aria-label="Limitations">
        <h3 className={styles.limitationsTitle}>What this history cannot tell you</h3>
        <ul>
          {h.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
