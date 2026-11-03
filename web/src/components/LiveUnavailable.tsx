import type { Connection } from "../explorer";
import { Header, type NavProps } from "./Header";
import { Notice } from "./Notice";
import styles from "./LiveUnavailable.module.css";

export interface LiveUnavailableProps {
  nav: NavProps;
  /** "checking": the server's status is not known yet, so nothing that could reach Polymarket starts. */
  reason: "checking" | "disabled";
  connection: Connection;
}

/** The Live Explorer section when it must not run: while the server is asked whether it may, or when it may not. */
export function LiveUnavailable({ nav, reason, connection }: LiveUnavailableProps) {
  return (
    <div className={styles.app}>
      <Header connection={connection} nav={nav} />
      <main className={styles.main}>
        {reason === "checking" ? (
          <p className={styles.checking} role="status">
            Checking what the local server allows&hellip;
          </p>
        ) : (
          <Notice tone="warning" title="Live Explorer is disabled on this server">
            <p className={styles.text}>
              This server never contacts Polymarket, so markets cannot be listed or inspected here. Nothing was requested. Stored data is still available offline.
            </p>
            <p className={styles.text}>
              <a href={nav.historyHref}>Open Stored History</a>
            </p>
          </Notice>
        )}
      </main>
    </div>
  );
}
