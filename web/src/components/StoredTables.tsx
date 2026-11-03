import type { Run, Source, StoredMarket } from "../api";
import { formatTimestamp } from "../book";
import { ACCOUNTING_TEXT, OWNER_TEXT, RUN_STATUS_TEXT, runCount, shortRunId } from "../history";
import { formatCount, NOT_REPORTED } from "../format";
import { historyHash } from "../route";
import styles from "./StoredTables.module.css";

export function SourceChip({ sourceType }: { sourceType: "live" | "synthetic" }) {
  return <span className={`${styles.chip} ${sourceType === "synthetic" ? styles.synthetic : styles.live}`}>{sourceType === "synthetic" ? "Synthetic" : "Live"}</span>;
}

/** Markets with stored observations. Question and labels are third-party text, rendered as text only. */
export function StoredMarketTable({ markets, source }: { markets: readonly StoredMarket[]; source: Source | null }) {
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className="visually-hidden">Markets with stored observations, most recently observed first. Select a question to open its stored history.</caption>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">ID</th>
            <th scope="col">Version</th>
            <th scope="col" className={styles.num}>
              Observations
            </th>
            <th scope="col">First observed</th>
            <th scope="col">Last observed</th>
            <th scope="col">Latest run</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => (
            <tr key={m.gammaId} className={styles.row}>
              <td>
                <a className={styles.question} href={historyHash({ section: "history", page: "market", marketId: m.gammaId, observationId: null, source })}>
                  {m.latest.question}
                </a>
                <span className={styles.sub}>
                  {m.latest.outcomeLabels.join(" / ")}
                  {m.latest.outcomeCount > m.latest.outcomeLabels.length ? ` (+${m.latest.outcomeCount - m.latest.outcomeLabels.length} more)` : ""}
                  {" · "}
                  {m.latest.closed ? "Closed" : m.latest.active ? "Active" : "Inactive"} when last observed
                </span>
              </td>
              <td className={`mono ${styles.nowrap}`} data-label="ID">
                {m.gammaId}
              </td>
              <td data-label="Version">{m.protocolVersion.toUpperCase()}</td>
              <td className={styles.num} data-label="Observations">
                {formatCount(m.observations)}
                <span className={styles.sub}>
                  {formatCount(m.liveObservations)} live{m.syntheticObservations > 0 ? ` · ${formatCount(m.syntheticObservations)} synthetic` : ""}
                </span>
              </td>
              <td className={`mono ${styles.nowrap}`} data-label="First observed">
                {formatTimestamp(m.firstAvailableAt)}
              </td>
              <td className={`mono ${styles.nowrap}`} data-label="Last observed">
                {formatTimestamp(m.lastAvailableAt)}
              </td>
              <td data-label="Latest run">
                <span className="mono" title={m.latest.runId}>
                  {shortRunId(m.latest.runId)}
                </span>{" "}
                <SourceChip sourceType={m.latest.sourceType} />
                <span className={styles.sub}>{RUN_STATUS_TEXT[m.latest.runStatus]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const count = (n: number | null) => (n === null ? NOT_REPORTED : formatCount(n));

/** Collection runs, newest first. Counts the run did not record are shown as not reported, never as zero. */
export function RunsTable({ runs }: { runs: readonly Run[] }) {
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className="visually-hidden">Collection runs, most recent first.</caption>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Status</th>
            <th scope="col">Started</th>
            <th scope="col">Finished</th>
            <th scope="col" className={styles.num}>
              Selected
            </th>
            <th scope="col" className={styles.num}>
              Stored
            </th>
            <th scope="col" className={styles.num}>
              Not stored
            </th>
            <th scope="col" className={styles.num}>
              Books
            </th>
            <th scope="col" className={styles.num}>
              Requests
            </th>
            <th scope="col">Notes</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.runId} className={styles.row}>
              <td data-label="Run">
                <span className={`mono ${styles.runId}`}>{r.runId}</span>
                <span className={styles.sub}>
                  <SourceChip sourceType={r.sourceType} /> {r.protocolVersion.toUpperCase()} · app {r.appVersion} · analytics v{r.analyticsVersion}
                </span>
              </td>
              <td data-label="Status">
                <span className={`${styles.chip} ${r.status === "complete" ? styles.ok : r.status === "running" ? "" : styles.warn}`}>{RUN_STATUS_TEXT[r.status]}</span>
                <span className={styles.sub}>{ACCOUNTING_TEXT[r.accounting]}</span>
              </td>
              <td className={`mono ${styles.nowrap}`} data-label="Started">
                {formatTimestamp(r.startedAt)}
              </td>
              <td className={`mono ${styles.nowrap}`} data-label="Finished">
                {r.finishedAt === null ? <span className={styles.unknown}>{r.status === "running" ? "Not finished" : NOT_REPORTED}</span> : formatTimestamp(r.finishedAt)}
              </td>
              <td className={styles.num} data-label="Selected">
                {count(runCount(r, "selected"))}
              </td>
              <td className={styles.num} data-label="Stored">
                {count(runCount(r, "persistedObservations"))}
              </td>
              <td className={styles.num} data-label="Not stored">
                {count(runCount(r, "persistenceFailures"))}
              </td>
              <td className={styles.num} data-label="Books">
                {count(runCount(r, "booksWritten"))}
              </td>
              <td className={styles.num} data-label="Requests">
                {r.budget.used === null ? NOT_REPORTED : formatCount(r.budget.used)} of {formatCount(r.budget.limit)}
              </td>
              <td data-label="Notes">
                <RunNotes run={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunNotes({ run: r }: { run: Run }) {
  const notes: string[] = [];
  if (r.recoveredReason !== null) notes.push(`Recovered: ${r.recoveredReason}`);
  if (r.errorCode !== null) notes.push(`Error: ${r.errorCode}`);
  if (r.stopReasons !== null && r.stopReasons.length > 0) notes.push(`Stopped: ${r.stopReasons.join(", ")}`);
  if (r.owner !== null) notes.push(OWNER_TEXT[r.owner.assessment] ?? r.owner.note);
  if (notes.length === 0) return <span className={styles.unknown}>None</span>;
  return (
    <ul className={styles.notes}>
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}
