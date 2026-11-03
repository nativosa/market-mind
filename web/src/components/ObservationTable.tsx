import { useState } from "react";
import type { HistoryItem } from "../api";
import { formatMs, formatShares, formatTimestamp, QUALITY_TEXT } from "../book";
import { formatCount, NOT_REPORTED } from "../format";
import { RUN_STATUS_TEXT, shortRunId } from "../history";
import { NOT_USABLE_TEXT } from "./HistoryStats";
import { SourceChip } from "./StoredTables";
import styles from "./ObservationTable.module.css";

export const TABLE_PAGE_SIZE = 50;

const CHANGE_TEXT: Readonly<Record<string, string>> = {
  LABEL_CHANGED: "Outcome labels changed",
  QUESTION_CHANGED: "Question changed",
  STATUS_CHANGED: "Market status changed",
  END_DATE_CHANGED: "End date changed",
};

export const observationButtonId = (id: number) => `observation-${id}`;

/** The table page (0-based) holding observation `id`, or null when it is not in the series. */
export function pageOf(items: readonly HistoryItem[], id: number | null): number | null {
  if (id === null) return null;
  const index = items.findIndex((i) => i.observationId === id);
  return index < 0 ? null : Math.floor(index / TABLE_PAGE_SIZE);
}

/** The flags the server set on one row, in words. */
export function flagTexts(item: HistoryItem): string[] {
  const f = item.flags;
  const out: string[] = [];
  if (item.pairing !== "paired") out.push(item.pairing === "incomplete" ? "One book missing" : "No books");
  if (item.association !== "confirmed") out.push(`Token pairing ${item.association.replace("_", " ")}`);
  if (f.unchanged === true) out.push("Same books as the previous usable sample");
  if (f.gapMs !== null) out.push(`${f.irregularGap ? "Irregular gap" : "Gap"} ${formatMs(f.gapMs)}`);
  for (const c of f.changes) out.push(CHANGE_TEXT[c] ?? c);
  return out;
}

const cell = (value: string | null, format: (v: string) => string = (v) => v) => (value === null ? <span className={styles.unknown}>{NOT_REPORTED}</span> : format(value));

export interface ObservationTableProps {
  /** Newest first, as the server sends the series. */
  items: readonly HistoryItem[];
  selectedId: number | null;
  onSelect: (observationId: number) => void;
}

/**
 * Every plotted observation as text, newest first, paged locally within the bounded series: the
 * accessible equivalent of the charts. Values are the stored exact strings.
 */
export function ObservationTable({ items, selectedId, onSelect }: ObservationTableProps) {
  const pages = Math.max(1, Math.ceil(items.length / TABLE_PAGE_SIZE));
  const [page, setPage] = useState(() => pageOf(items, selectedId) ?? 0);
  const [shownFor, setShownFor] = useState(selectedId);
  // A selection made elsewhere (a chart, the address) brings its row into view.
  if (shownFor !== selectedId) {
    setShownFor(selectedId);
    const target = pageOf(items, selectedId);
    if (target !== null && target !== page) setPage(target);
  }
  const current = Math.min(page, pages - 1);
  const rows = items.slice(current * TABLE_PAGE_SIZE, (current + 1) * TABLE_PAGE_SIZE);
  const first = current * TABLE_PAGE_SIZE + 1;
  return (
    <section className={styles.section} aria-labelledby="observation-table-title">
      <h3 id="observation-table-title" className={styles.heading}>
        Observations, newest first
      </h3>
      <div className={styles.wrap}>
        <table className={styles.table}>
          <caption className="visually-hidden">
            Plotted observations, newest first, rows {first} to {first + rows.length - 1} of {items.length}. Prices, spread and depth are for the reference outcome.
          </caption>
          <thead>
            <tr>
              <th scope="col">Observed</th>
              <th scope="col">Run</th>
              <th scope="col" className={styles.num}>
                Bid
              </th>
              <th scope="col" className={styles.num}>
                Ask
              </th>
              <th scope="col" className={styles.num}>
                Midpoint
              </th>
              <th scope="col" className={styles.num}>
                Spread
              </th>
              <th scope="col" className={styles.num}>
                Bid depth
              </th>
              <th scope="col" className={styles.num}>
                Ask depth
              </th>
              <th scope="col">Quality</th>
              <th scope="col">Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <Row key={item.observationId} item={item} selected={item.observationId === selectedId} onSelect={onSelect} />
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.pager}>
        <button type="button" onClick={() => setPage(current - 1)} disabled={current === 0}>
          Newer
        </button>
        <span aria-live="polite">
          Rows {formatCount(first)} to {formatCount(first + rows.length - 1)} of {formatCount(items.length)} · page {current + 1} of {pages}
        </span>
        <button type="button" onClick={() => setPage(current + 1)} disabled={current >= pages - 1}>
          Older
        </button>
      </div>
    </section>
  );
}

function Row({ item, selected, onSelect }: { item: HistoryItem; selected: boolean; onSelect: (id: number) => void }) {
  const m = item.metrics;
  const usable = item.flags.notUsable === null;
  const flags = flagTexts(item);
  return (
    <tr className={`${styles.row} ${selected ? styles.selected : ""} ${usable ? "" : styles.notUsable}`} aria-selected={selected}>
      <td>
        <button
          type="button"
          id={observationButtonId(item.observationId)}
          className={styles.open}
          aria-pressed={selected}
          aria-label={`Observation ${item.observationId} at ${formatTimestamp(item.availableAt)}: show stored evidence`}
          onClick={() => onSelect(item.observationId)}
        >
          {formatTimestamp(item.availableAt)}
        </button>
        <span className={styles.sub}>#{item.observationId}</span>
      </td>
      <td data-label="Run">
        <span className="mono" title={item.runId}>
          {shortRunId(item.runId)}
        </span>{" "}
        {item.sourceType === "synthetic" && <SourceChip sourceType="synthetic" />}
        {item.runStatus !== undefined && <span className={styles.sub}>{RUN_STATUS_TEXT[item.runStatus]}</span>}
      </td>
      <td className={`mono ${styles.num}`} data-label="Bid">
        {cell(m?.bestBid ?? null)}
      </td>
      <td className={`mono ${styles.num}`} data-label="Ask">
        {cell(m?.bestAsk ?? null)}
      </td>
      <td className={`mono ${styles.num}`} data-label="Midpoint">
        {cell(m?.midpoint ?? null)}
      </td>
      <td className={`mono ${styles.num}`} data-label="Spread">
        {cell(m?.spread ?? null)}
      </td>
      <td className={`mono ${styles.num}`} data-label="Bid depth">
        {cell(m?.bidDepth ?? null, formatShares)}
      </td>
      <td className={`mono ${styles.num}`} data-label="Ask depth">
        {cell(m?.askDepth ?? null, formatShares)}
      </td>
      <td data-label="Quality">
        <span className={`${styles.chip} ${usable ? styles.ok : styles.warn}`}>{usable ? "Usable" : "Not usable"}</span>
        {!usable && <span className={styles.sub}>{NOT_USABLE_TEXT[item.flags.notUsable!] ?? item.flags.notUsable}</span>}
        <span className={styles.sub}>{item.books.length === 0 ? "No books stored" : item.books.map((b) => `${b.label}: ${QUALITY_TEXT[b.quality]}`).join(" · ")}</span>
      </td>
      <td data-label="Flags">{flags.length === 0 ? <span className={styles.unknown}>None</span> : <span className={styles.flags}>{flags.join(" · ")}</span>}</td>
    </tr>
  );
}
