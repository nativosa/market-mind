import type { ApiError } from "../api";
import { isDatabaseMissing } from "../history";
import { ErrorNotice, LoadingRows, Notice } from "./Notice";
import styles from "./Notice.module.css";

/** No database yet: what Stored History needs and how to get it. Nothing is created from here. */
export function MissingDatabase() {
  return (
    <Notice title="No local history database yet">
      <p className={styles.detail}>
        Stored History reads observations that MarketMind&apos;s <code>collect</code> command saved in a local database file. None exists yet, and this page never creates one.
      </p>
      <p className={styles.detail}>
        To record observations, run <code>npm run cli -- collect</code> (or <code>npm run cli -- collect --market-id &lt;id&gt;</code> for one market), then reload this page.
        Each run stores one observation per market; repeat it later to build a history.
      </p>
      <p className={styles.detail}>The Live Explorer works without a database.</p>
    </Notice>
  );
}

/** Loading, missing database, failure (with an explicit retry), or nothing. */
export function ResourceState({ loading, error, now, label, onRetry }: { loading: boolean; error: ApiError | null; now: number; label: string; onRetry: () => void }) {
  if (isDatabaseMissing(error)) return <MissingDatabase />;
  if (error !== null) return <ErrorNotice error={error} now={now} context={`Loading ${label} failed`} onRetry={onRetry} />;
  if (loading) return <LoadingRows label={`Loading ${label}`} />;
  return null;
}
