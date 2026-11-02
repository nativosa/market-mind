import type { Budget, Connection } from "../explorer";
import { formatCount, formatDuration } from "../format";
import styles from "./Header.module.css";

const CONNECTION_TEXT: Record<Connection, string> = {
  checking: "Connecting to local server",
  connected: "Local server connected",
  unreachable: "Local server unreachable",
};

export interface HeaderProps {
  connection: Connection;
  budget: { process: Budget["process"]; window: Budget["window"] } | null;
}

export function Header({ connection, budget }: HeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <h1 className={styles.name}>MarketMind</h1>
        <span className={styles.sub}>Market Explorer</span>
        <span className={styles.badge}>Research only · no trading</span>
      </div>
      <div className={styles.meta}>
        <span className={`${styles.connection} ${styles[connection] ?? ""}`} role="status">
          <span className={styles.dot} aria-hidden="true" />
          {CONNECTION_TEXT[connection]}
        </span>
        <BudgetText budget={budget} />
      </div>
    </header>
  );
}

function BudgetText({ budget }: Pick<HeaderProps, "budget">) {
  if (budget === null) return <span>Request budget: not known yet</span>;
  const { process, window } = budget;
  return (
    <span title="Upstream request attempts the local server may still send to Polymarket">
      Requests left: {formatCount(process.remaining)} of {formatCount(process.limit)}
      {window ? ` · ${formatCount(window.remaining)} of ${formatCount(window.limit)} per ${formatDuration(window.windowMs)}` : ""}
    </span>
  );
}
