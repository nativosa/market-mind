import { canLoadMore, MAX_PAGES, type Feed } from "../explorer";
import { formatCount } from "../format";
import styles from "./Pager.module.css";

export const END_TEXT = {
  last_page: "End of results: Polymarket has no further pages for this version.",
  page_cap: `Local limit reached: ${MAX_PAGES} pages are loaded, the most this explorer keeps. More markets exist upstream; narrow the list with search instead.`,
  cursor_unsupported: "Paging stopped: Polymarket returned a continuation cursor this explorer cannot use.",
} as const;

/** Explicit "load more" only; the button is disabled while any page of this version is loading. */
export function Pager({ feed, onLoadMore }: { feed: Feed; onLoadMore: () => void }) {
  return (
    <div className={styles.pager}>
      <span>
        {formatCount(feed.markets.length)} markets in {feed.pages} of at most {MAX_PAGES} pages
        {feed.duplicates > 0 ? ` · ${feed.duplicates} repeated ${feed.duplicates === 1 ? "market" : "markets"} skipped` : ""}
        {feed.skipped > 0 ? ` · ${feed.skipped} invalid upstream ${feed.skipped === 1 ? "record" : "records"} not shown` : ""}
      </span>
      {feed.end !== null ? (
        <span className={styles.end}>{END_TEXT[feed.end]}</span>
      ) : (
        <button type="button" className={styles.more} onClick={onLoadMore} disabled={!canLoadMore(feed)} aria-busy={feed.loading === "more"}>
          {feed.loading === "more" ? "Loading next page..." : "Load more"}
        </button>
      )}
    </div>
  );
}
