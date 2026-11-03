import type { Budget, Connection } from "../explorer";
import { formatCount, formatDuration } from "../format";
import styles from "./Header.module.css";

const CONNECTION_TEXT: Record<Connection, string> = {
  checking: "Connecting to local server",
  connected: "Local server connected",
  unreachable: "Local server unreachable",
};

/** The two sections. Hrefs return to where the user left each section; live may be disabled by the server. */
export interface NavProps {
  section: "live" | "history";
  liveHref: string;
  historyHref: string;
  liveEnabled: boolean;
}

export const DEFAULT_NAV: NavProps = { section: "live", liveHref: "#/", historyHref: "#/history", liveEnabled: true };

export interface HeaderProps {
  connection: Connection;
  /** The live request budget; shown only in the Live Explorer, whose requests spend it. */
  budget?: { process: Budget["process"]; window: Budget["window"] } | null;
  nav?: NavProps;
}

export function Header({ connection, budget = null, nav = DEFAULT_NAV }: HeaderProps) {
  const live = nav.section === "live";
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <h1 className={styles.name}>MarketMind</h1>
        <span className={styles.sub}>{live ? "Live Explorer" : "Stored History"}</span>
        <span className={styles.badge}>Research only · no trading</span>
      </div>
      <nav className={styles.nav} aria-label="Sections">
        <a
          href={nav.liveHref}
          className={`${styles.link} ${nav.liveEnabled ? "" : styles.unavailable}`}
          aria-current={live ? "page" : undefined}
          title={nav.liveEnabled ? "Browses Polymarket: listing and inspecting send live requests" : "This server makes no Polymarket requests"}
        >
          Live Explorer
          <span className={styles.linkNote}>{nav.liveEnabled ? "requests Polymarket" : "disabled on this server"}</span>
        </a>
        <a href={nav.historyHref} className={styles.link} aria-current={live ? undefined : "page"} title="Reads the local database only: no Polymarket requests">
          Stored History
          <span className={styles.linkNote}>offline, local database</span>
        </a>
      </nav>
      <div className={styles.meta}>
        <span className={`${styles.connection} ${styles[connection] ?? ""}`} role="status">
          <span className={styles.dot} aria-hidden="true" />
          {CONNECTION_TEXT[connection]}
        </span>
        {live ? <BudgetText budget={budget} /> : <span className={styles.offline}>Offline: reads the local database, never Polymarket</span>}
      </div>
    </header>
  );
}

function BudgetText({ budget }: { budget: HeaderProps["budget"] }) {
  if (budget === null || budget === undefined) return <span>Request budget: not known yet</span>;
  const { process, window } = budget;
  return (
    <span title="Upstream request attempts the local server may still send to Polymarket">
      Requests left: {formatCount(process.remaining)} of {formatCount(process.limit)}
      {window ? ` · ${formatCount(window.remaining)} of ${formatCount(window.limit)} per ${formatDuration(window.windowMs)}` : ""}
    </span>
  );
}
