import styles from "./DemoBanner.module.css";

/** Shown on every page of a synthetic demonstration server (npm run web:demo); it cannot be dismissed. */
export function DemoBanner() {
  return (
    <aside className={styles.banner} aria-label="Synthetic demonstration data">
      <p className={styles.title}>Synthetic demonstration data</p>
      <p className={styles.text}>
        Every market, run and observation here was generated for this demonstration and is not Polymarket market evidence. This server is offline: it never
        contacts Polymarket, and its temporary database is deleted when it stops.
      </p>
    </aside>
  );
}
