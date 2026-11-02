import type { Version } from "../api";
import type { Filters, SortKey } from "../explorer";
import styles from "./Controls.module.css";

export interface ControlsProps {
  version: Version;
  filters: Filters;
  sort: SortKey;
  onVersion: (version: Version) => void;
  onFilters: (patch: Partial<Filters>) => void;
  onSort: (sort: SortKey) => void;
}

/** Search, filters and sort apply to loaded markets only; the version switch loads that version's first page. */
export function Controls({ version, filters, sort, onVersion, onFilters, onSort }: ControlsProps) {
  return (
    <form className={styles.controls} role="search" onSubmit={(e) => e.preventDefault()}>
      <label className={`${styles.field} ${styles.search}`}>
        <span className={styles.label}>Search loaded markets</span>
        <input
          type="search"
          value={filters.query}
          placeholder="Question or slug"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          onChange={(e) => onFilters({ query: e.target.value })}
        />
      </label>
      <div className={styles.field}>
        <span className={styles.label} id="version-label">
          Protocol
        </span>
        <fieldset className={styles.versions} aria-labelledby="version-label">
          <legend>Protocol version</legend>
          {(["v1", "v2"] as const).map((v) => (
            <label key={v} className={styles.version}>
              <input type="radio" name="version" value={v} checked={version === v} onChange={() => onVersion(v)} />
              {v.toUpperCase()}
            </label>
          ))}
        </fieldset>
      </div>
      <label className={styles.field}>
        <span className={styles.label}>Eligibility</span>
        <select value={filters.eligibility} onChange={(e) => onFilters({ eligibility: e.target.value as Filters["eligibility"] })}>
          <option value="all">All markets</option>
          <option value="inspectable">Inspectable only</option>
          <option value="not_inspectable">Not inspectable only</option>
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Sort loaded markets</span>
        <select value={sort} onChange={(e) => onSort(e.target.value as SortKey)}>
          <option value="volume">Gamma 24h volume</option>
          <option value="question">Question (A to Z)</option>
        </select>
      </label>
      <div className={styles.toggles}>
        <label>
          <input type="checkbox" checked={filters.orderBookEnabled} onChange={(e) => onFilters({ orderBookEnabled: e.target.checked })} />
          Order book enabled
        </label>
        <label>
          <input type="checkbox" checked={filters.acceptingOrders} onChange={(e) => onFilters({ acceptingOrders: e.target.checked })} />
          Accepting orders
        </label>
      </div>
    </form>
  );
}
