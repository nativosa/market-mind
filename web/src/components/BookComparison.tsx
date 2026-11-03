import type { Inspection } from "../api";
import {
  barPercent,
  barScale,
  depthChoices,
  formatShares,
  issueText,
  ladderNote,
  ladderOf,
  orUnknown,
  QUALITY_TEXT,
  roleText,
  SIZE_UNIT,
  STATE_TEXT,
  type Level,
  type Metrics,
  type Outcome,
} from "../book";
import { NOT_REPORTED } from "../format";
import styles from "./BookComparison.module.css";

export interface BookComparisonProps {
  inspection: Inspection;
  depth: number;
  onDepth: (depth: number) => void;
}

/**
 * The two outcome books of one inspection, side by side when there is room and stacked otherwise.
 * Bars share one scale across both books so their lengths compare; the numbers beside them are the
 * server's exact strings. Labels are third-party text and are rendered as plain text only.
 */
export function BookComparison({ inspection, depth, onDepth }: BookComparisonProps) {
  const depthId = "ladder-depth";
  const max = inspection.appliedLimits.levels;
  const shown = Math.min(depth, max);
  const scale = barScale(inspection.outcomes.flatMap((o) => (o.quality === "invalid" ? [] : [...ladderOf(o, shown).bids, ...ladderOf(o, shown).asks])));
  return (
    <section className={styles.comparison} aria-labelledby="order-books-title">
      <div className={styles.toolbar}>
        <h3 id="order-books-title" className={styles.title}>
          Order books
        </h3>
        <label className={styles.depth} htmlFor={depthId}>
          Levels per side
          <select id={depthId} value={shown} onChange={(e) => onDepth(Number(e.currentTarget.value))}>
            {depthChoices(max).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={styles.unitNote}>
        Sizes are {SIZE_UNIT} (outcome tokens) resting in the book at one instant: not dollars, and not a promise that an order of that size would fill.
      </p>
      <div className={styles.books}>
        {inspection.outcomes.map((outcome) => (
          <OutcomeBook key={outcome.index} outcome={outcome} depth={shown} scale={scale} />
        ))}
      </div>
    </section>
  );
}

export function OutcomeBook({ outcome: o, depth, scale }: { outcome: Outcome; depth: number; scale: number }) {
  // Ids only need to be unique on the page, which shows a single inspection.
  const headingId = `outcome-book-${o.index}`;
  const invalid = o.quality === "invalid";
  return (
    <article className={`${styles.book} ${invalid ? styles.invalidBook : ""}`} aria-labelledby={headingId}>
      <header className={styles.bookHeader}>
        <h4 id={headingId} className={styles.label}>
          {o.label}
        </h4>
        <span className={styles.meta}>
          Outcome {o.index + 1} · {roleText(o.role)}
        </span>
        <span className={styles.chips}>
          <span className={`${styles.chip} ${styles[o.quality]}`}>Quality: {QUALITY_TEXT[o.quality]}</span>
          {o.metrics && <span className={`${styles.chip} ${o.metrics.state === "two-sided" ? "" : styles.stateWarn}`}>{STATE_TEXT[o.metrics.state]}</span>}
        </span>
      </header>
      {o.issues.length > 0 && (
        <ul className={styles.issues} aria-label={`Quality issues for ${o.label}`}>
          {o.issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`}>
              <code className={styles.code}>{issue.code}</code> <span className={styles.severity}>({issue.severity})</span> {issueText(issue.code)}
            </li>
          ))}
        </ul>
      )}
      {o.metrics ? (
        <MetricsList metrics={o.metrics} />
      ) : (
        <p className={styles.withheld} role="note">
          Metrics withheld: this book failed validation, so no best prices, spread, midpoint, depth or ladder are derived from it.
        </p>
      )}
      <dl className={styles.facts}>
        <Fact term="Tick size" value={orUnknown(o.book.tickSize)} />
        <Fact term={`Minimum order size (${SIZE_UNIT})`} value={formatShares(o.book.minOrderSize)} />
        <Fact term="Last trade price" value={orUnknown(o.book.lastTradePrice)} />
      </dl>
      {!invalid && <Ladder outcome={o} depth={depth} scale={scale} />}
    </article>
  );
}

function Fact({ term, value, hint }: { term: string; value: string; hint?: string | undefined }) {
  return (
    <div className={styles.fact}>
      <dt>{term}</dt>
      <dd className={value === NOT_REPORTED || hint ? styles.muted : "mono"}>{hint ?? value}</dd>
    </div>
  );
}

function MetricsList({ metrics: m }: { metrics: Metrics }) {
  const band = m.depthBand === null ? null : `within ${m.depthBand} of best`;
  return (
    <>
      <dl className={styles.quote}>
        <div className={styles.side}>
          <dt>Best bid</dt>
          <dd className="mono">{m.bestBid ?? "No bids"}</dd>
          <dd className={styles.size}>{m.bestBidSize === null ? "" : `${formatShares(m.bestBidSize)} ${SIZE_UNIT}`}</dd>
        </div>
        <div className={styles.side}>
          <dt>Best ask</dt>
          <dd className="mono">{m.bestAsk ?? "No asks"}</dd>
          <dd className={styles.size}>{m.bestAskSize === null ? "" : `${formatShares(m.bestAskSize)} ${SIZE_UNIT}`}</dd>
        </div>
      </dl>
      {(m.crossed || m.locked) && (
        <p className={styles.alert} role="note">
          {m.crossed ? "Crossed book: the best bid is above the best ask." : "Locked book: the best bid equals the best ask."} Treat these quotes with caution.
        </p>
      )}
      <dl className={styles.facts}>
        <Fact term="Spread" value={m.spread ?? ""} hint={m.spread === null ? "Needs both a bid and an ask" : undefined} />
        <Fact term="Midpoint" value={m.midpoint ?? ""} hint={m.midpoint === null ? "Needs both a bid and an ask" : undefined} />
        <Fact term={`Total bid depth (${SIZE_UNIT})`} value={formatShares(m.bidDepth)} />
        <Fact term={`Total ask depth (${SIZE_UNIT})`} value={formatShares(m.askDepth)} />
        {band && <Fact term={`Bid depth ${band}`} value={m.bidDepthWithinBand === null ? "" : formatShares(m.bidDepthWithinBand)} hint={m.bidDepthWithinBand === null ? "No bids" : undefined} />}
        {band && <Fact term={`Ask depth ${band}`} value={m.askDepthWithinBand === null ? "" : formatShares(m.askDepthWithinBand)} hint={m.askDepthWithinBand === null ? "No asks" : undefined} />}
      </dl>
    </>
  );
}

export function Ladder({ outcome, depth, scale }: { outcome: Outcome; depth: number; scale: number }) {
  const ladder = ladderOf(outcome, depth);
  return (
    <div className={styles.ladder}>
      <p className={styles.ladderNote}>
        {ladderNote(outcome, depth)}. Best price first{outcome.levels.order === "aggregated_best_first" ? ", same-price orders added together" : ""}.
      </p>
      <div className={styles.sides}>
        <LadderSide side="bid" levels={ladder.bids} scale={scale} label={outcome.label} />
        <LadderSide side="ask" levels={ladder.asks} scale={scale} label={outcome.label} />
      </div>
    </div>
  );
}

function LadderSide({ side, levels, scale, label }: { side: "bid" | "ask"; levels: readonly Level[]; scale: number; label: string }) {
  const name = side === "bid" ? "Bids" : "Asks";
  if (levels.length === 0) {
    return (
      <div className={styles.sideTable}>
        <p className={styles.sideTitle}>{name}</p>
        <p className={styles.emptySide}>No {side === "bid" ? "bids" : "asks"} in this book.</p>
      </div>
    );
  }
  return (
    <table className={`${styles.sideTable} ${styles[side]}`}>
      <caption className={styles.sideTitle}>
        {name}
        <span className="visually-hidden"> for {label}, best price first</span>
      </caption>
      <thead>
        <tr>
          <th scope="col">Price</th>
          <th scope="col" className={styles.num}>
            Size ({SIZE_UNIT})
          </th>
        </tr>
      </thead>
      <tbody>
        {levels.map((level, i) => (
          <tr key={`${level.price}-${i}`}>
            <td className="mono">{level.price}</td>
            <td className={`mono ${styles.num} ${styles.barCell}`}>
              <span className={styles.bar} style={{ width: `${barPercent(level.size, scale)}%` }} aria-hidden="true" />
              <span className={styles.sizeText}>{formatShares(level.size)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
