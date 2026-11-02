import { memo } from "react";
import type { MarketItem } from "../api";
import { formatDate, formatFlag, formatVolume, NOT_REPORTED } from "../format";
import styles from "./MarketTable.module.css";

export interface MarketTableProps {
  markets: readonly MarketItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** Third-party text (question, slug) is rendered as React text children only, never as HTML. */
export const MarketTable = memo(function MarketTable({ markets, selectedId, onSelect }: MarketTableProps) {
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className="visually-hidden">Loaded markets. Select a question to see its details.</caption>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">ID</th>
            <th scope="col">Version</th>
            <th scope="col">Status</th>
            <th scope="col" className={styles.num} title="Gamma-reported traded volume over 24 hours. Not liquidity or order-book depth.">
              Gamma 24h volume
            </th>
            <th scope="col">Ends</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => (
            <MarketRow key={m.gammaId} market={m} selected={m.gammaId === selectedId} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </div>
  );
});

function MarketRow({ market: m, selected, onSelect }: { market: MarketItem; selected: boolean; onSelect: (id: string) => void }) {
  const volume = formatVolume(m.gammaVolume24hr);
  const end = formatDate(m.endDate);
  return (
    <tr className={`${styles.row} ${selected ? styles.selected : ""}`} aria-selected={selected}>
      <td>
        <button type="button" className={styles.question} aria-pressed={selected} onClick={() => onSelect(m.gammaId)}>
          {m.question}
        </button>
        <span className={styles.slug}>{m.slug}</span>
      </td>
      <td className={`mono ${styles.nowrap}`} data-label="ID">
        {m.gammaId}
      </td>
      <td data-label="Version">{m.protocolVersion.toUpperCase()}</td>
      <td data-label="Status">
        <span className={`${styles.chip} ${m.eligibility.inspectable ? styles.ok : styles.warn}`}>{m.eligibility.inspectable ? "Inspectable" : "Not inspectable"}</span>
        <span className={styles.flags}>
          {m.closed ? "Closed" : m.active ? "Active" : "Inactive"} · Order book {formatFlag(m.enableOrderBook, "on", "off").toLowerCase()} · Orders{" "}
          {formatFlag(m.acceptingOrders, "accepted", "not accepted").toLowerCase()}
        </span>
      </td>
      <td className={`${styles.num} ${volume === NOT_REPORTED ? styles.unknown : ""}`} data-label="Gamma 24h volume">
        {volume}
      </td>
      <td className={`${styles.nowrap} ${end === NOT_REPORTED ? styles.unknown : ""}`} data-label="Ends">
        {end}
      </td>
    </tr>
  );
}
