import type { History } from "../api";
import { formatMs, formatTimestamp } from "../book";
import { formatCount, formatDuration, NOT_REPORTED } from "../format";
import styles from "./HistoryStats.module.css";

type Stats = NonNullable<History["stats"]>;
type Window = NonNullable<History["analysisWindow"]>;

export const NOT_USABLE_TEXT: Readonly<Record<string, string>> = {
  NOT_PAIRED: "only one of the two books was received",
  INVALID_BOOK: "a book failed validation",
  NO_METRICS_FOR_VERSION: "no metrics stored for this analytics version",
  NOT_TWO_SIDED: "the reference book was one-sided or empty",
};

const samples = (n: number) => `${formatCount(n)} usable ${n === 1 ? "sample" : "samples"}`;
const ms = (value: number | null) => (value === null ? NOT_REPORTED : `${formatMs(value)} (about ${formatDuration(value)})`);
const dec = (value: string | null) => value ?? NOT_REPORTED;

/**
 * Which observations the statistics and the charts use. Statistics: every observation of the
 * analysis window (the newest up to 20,000). Charts and table: the newest of those, at most 2,000.
 */
export function AnalysisWindowNote({ history: h }: { history: History }) {
  const w = h.analysisWindow;
  const s = h.series;
  if (w === null) return null;
  const seriesMax = h.appliedLimits.seriesMax;
  return (
    <section className={styles.window} aria-label="Observations used">
      <p>
        <strong>Statistics</strong> use all {formatCount(w.observations)} {w.observations === 1 ? "observation" : "observations"} of the analysis window (the newest up to{" "}
        {formatCount(w.maxObservations)}), available from <span className="mono">{formatTimestamp(w.oldestAvailableAt)}</span> to{" "}
        <span className="mono">{formatTimestamp(w.newestAvailableAt)}</span>
        {h.appliedLimits.asOf === null ? "" : `, as known at ${formatTimestamp(h.appliedLimits.asOf)}`}.
        {w.truncated ? ` Older stored observations exist and are not included.` : ""}
      </p>
      <p>
        <strong>Charts and table</strong> show {s.truncated ? "the newest " : "all "}
        {formatCount(s.returnedCount)} of those {formatCount(s.windowObservations)} (at most {formatCount(seriesMax)} are plotted)
        {s.sourceCounts.synthetic > 0 ? `: ${formatCount(s.sourceCounts.live)} live and ${formatCount(s.sourceCounts.synthetic)} synthetic` : ""}.
      </p>
      {s.truncated && (
        <p className={styles.truncated} role="note">
          Plotted: {formatCount(s.returnedCount)} observations · Analysed: {formatCount(s.windowObservations)} observations. Statistics cover observations the charts do not show.
        </p>
      )}
    </section>
  );
}

/** The server's statistics, exactly as computed. Every figure states how many samples it rests on. */
export function HistoryStats({ stats: st, window: w, threshold }: { stats: Stats; window: Window; threshold: string }) {
  const excluded = Object.entries(st.notUsable).filter(([, n]) => n > 0);
  return (
    <section className={styles.stats} aria-labelledby="history-stats-title">
      <h3 id="history-stats-title" className={styles.heading}>
        Statistics (sample counts, not time)
      </h3>
      <dl className={styles.tiles}>
        <div className={styles.tile}>
          <dt>Usable observations</dt>
          <dd className={styles.big}>
            {formatCount(st.usable)} of {formatCount(st.eligible)}
          </dd>
          <dd className={styles.sub}>
            {excluded.length === 0
              ? "Every observation in the window is usable."
              : `Not usable: ${excluded.map(([reason, n]) => `${formatCount(n)} because ${NOT_USABLE_TEXT[reason] ?? reason}`).join("; ")}.`}
          </dd>
        </div>
        <div className={styles.tile}>
          <dt>Latest spread</dt>
          <dd className={`mono ${styles.big}`}>{dec(st.spread.current)}</dd>
          <dd className={styles.sub}>
            Previous <span className="mono">{dec(st.spread.previous)}</span> · change <span className="mono">{dec(st.spread.change)}</span> (latest two usable samples)
          </dd>
        </div>
        <div className={styles.tile}>
          <dt>Spread range</dt>
          <dd className={`mono ${styles.big}`}>
            {dec(st.spread.min)} to {dec(st.spread.max)}
          </dd>
          <dd className={styles.sub}>
            Median <span className="mono">{dec(st.spread.median)}</span> over {samples(st.spread.n)}
          </dd>
        </div>
        <div className={styles.tile}>
          <dt>Spread at or above {threshold}</dt>
          <dd className={styles.big}>
            {formatCount(st.threshold.atOrAbove)} of {samples(st.threshold.n)}
          </dd>
          <dd className={styles.sub}>{st.threshold.percentOfSamples === null ? NOT_REPORTED : `${st.threshold.percentOfSamples}% of samples, not of time`}</dd>
        </div>
        <div className={styles.tile}>
          <dt>Top size (smaller of best bid and ask size)</dt>
          <dd className={`mono ${styles.big}`}>{dec(st.topSize.current)}</dd>
          <dd className={styles.sub}>
            Previous <span className="mono">{dec(st.topSize.previous)}</span> · change <span className="mono">{dec(st.topSize.change)}</span> ({samples(st.topSize.n)})
          </dd>
        </div>
        <div className={styles.tile}>
          <dt>Observed book states</dt>
          <dd className={styles.big}>{formatCount(st.states.distinct)}</dd>
          <dd className={styles.sub}>Changes of book contents between consecutive samples, counted over {samples(st.states.n)}; identical repeats count once.</dd>
        </div>
        <div className={styles.tile}>
          <dt>Sampling gaps</dt>
          <dd className={styles.big}>{st.gaps.medianMs === null ? NOT_REPORTED : `Median ${ms(st.gaps.medianMs)}`}</dd>
          <dd className={styles.sub}>
            Shortest {ms(st.gaps.minMs)} · longest {ms(st.gaps.maxMs)} over {formatCount(st.gaps.n)} {st.gaps.n === 1 ? "gap" : "gaps"} between usable samples.{" "}
            {formatCount(st.gaps.irregular)} irregular (longer than twice the median): nothing was observed during them.
          </dd>
        </div>
        <div className={styles.tile}>
          <dt>First and last usable sample</dt>
          <dd className={`mono ${styles.time}`}>{formatTimestamp(st.firstUsableAt)}</dd>
          <dd className={`mono ${styles.time}`}>{formatTimestamp(st.lastUsableAt)}</dd>
          <dd className={styles.sub}>Within an analysis window of {formatCount(w.observations)} observations.</dd>
        </div>
      </dl>
    </section>
  );
}
