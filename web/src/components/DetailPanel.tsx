import type { MarketItem } from "../api";
import { formatDate, formatFlag, formatVolume, NOT_REPORTED } from "../format";
import styles from "./DetailPanel.module.css";

const VOLUME_NOTE = "Gamma's reported 24h traded volume orders the list. It is not liquidity or order-book depth.";

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd className={value === NOT_REPORTED ? styles.unknown : undefined}>{value}</dd>
    </>
  );
}

/** Listing metadata for the selected market. No request is made here: inspection comes in the next step. */
export function DetailPanel({ market, selectedId, onClose }: { market: MarketItem | null; selectedId: string | null; onClose: () => void }) {
  if (selectedId === null) {
    return (
      <aside className={styles.panel} aria-label="Market details">
        <p className={styles.heading}>Market details</p>
        <p className={styles.note}>Select a market to see its listing metadata.</p>
      </aside>
    );
  }
  if (market === null) {
    return (
      <aside className={styles.panel} aria-label="Market details">
        <p className={styles.heading}>Market {selectedId}</p>
        <p className={styles.note}>This market is not among the loaded markets any more (the list was refreshed).</p>
        <button type="button" className={styles.close} onClick={onClose}>
          Clear selection
        </button>
      </aside>
    );
  }
  const m = market;
  return (
    <aside className={styles.panel} aria-label="Market details">
      <p className={styles.heading}>Selected market</p>
      <h2 className={styles.question}>{m.question}</h2>
      <dl className={styles.facts}>
        <Fact term="Gamma ID" value={m.gammaId} />
        <Fact term="Condition ID" value={m.conditionId} />
        <Fact term="Slug" value={m.slug} />
        <Fact term="Protocol" value={m.protocolVersion.toUpperCase()} />
        <Fact term="Outcomes" value={`${m.outcomeLabels.join(" / ")}${m.outcomeCount > m.outcomeLabels.length ? ` (+${m.outcomeCount - m.outcomeLabels.length} more)` : ""}`} />
        <Fact term="Active" value={formatFlag(m.active)} />
        <Fact term="Closed" value={formatFlag(m.closed)} />
        <Fact term="Accepting orders" value={formatFlag(m.acceptingOrders)} />
        <Fact term="Order book enabled" value={formatFlag(m.enableOrderBook)} />
        <Fact term="Neg-risk" value={formatFlag(m.negRisk)} />
        <Fact term="Ends" value={formatDate(m.endDate)} />
        <Fact term="Gamma 24h volume" value={formatVolume(m.gammaVolume24hr)} />
        <Fact term="Inspectable" value={formatFlag(m.eligibility.inspectable)} />
      </dl>
      <p className={styles.note}>{VOLUME_NOTE}</p>
      {m.eligibility.reasons.length > 0 && (
        <div>
          <p className={styles.heading}>Why it cannot be inspected</p>
          <ul className={styles.list}>
            {m.eligibility.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {m.eligibility.warnings.length > 0 && (
        <div>
          <p className={styles.heading}>Eligibility warnings</p>
          <ul className={styles.list}>
            {m.eligibility.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={styles.placeholder}>
        Order books, spreads and quality checks will appear here in the next step. Nothing has been requested from Polymarket for this market yet.
      </div>
      <button type="button" className={styles.close} onClick={onClose}>
        Close details
      </button>
    </aside>
  );
}
