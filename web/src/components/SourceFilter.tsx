import type { Source } from "../api";
import { Notice } from "./Notice";
import styles from "./SourceFilter.module.css";

/** The provenance filter. The server applies it: synthetic observations are never filtered here. */
export function SourceFilter({ source, onSource }: { source: Source; onSource: (source: Source) => void }) {
  return (
    <fieldset className={styles.filter}>
      <legend className={styles.legend}>Observations</legend>
      <div className={styles.options}>
        {(
          [
            ["live", "Live only"],
            ["all", "Live + synthetic"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className={styles.option}>
            <input type="radio" name="history-source" value={value} checked={source === value} onChange={() => onSource(value)} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SyntheticNotice() {
  return (
    <Notice tone="warning" title="Synthetic observations included">
      <p className={styles.note}>
        Live + synthetic adds test or demonstration observations, each marked Synthetic. They are not market evidence. Statistics computed with this filter may mix simulated
        and real observations.
      </p>
    </Notice>
  );
}
