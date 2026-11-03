import { finalizeRun, persistObservation } from "../src/adapters/storage/snapshotStore.js";
import type { Database } from "../src/adapters/storage/sqlite.js";
import { ANALYTICS_VERSION } from "../src/analytics/version.js";
import { META, openMigrated, record, startRun, T0, tempDbPath, type RecordSpec } from "./storageFixtures.js";

// Stored History fixture databases (Stage 3.2), written through the collect code path. Shared by
// the web unit tests and the Playwright server; nothing here touches the network.

export const MINUTE = 60_000;
/** Market 1's question, with markup that must stay text. */
export const UNTRUSTED_QUESTION = `<img src=x onerror="alert(1)"> Will market 1 resolve Yes?`;
/** An 18-place size that floating point cannot represent. */
export const EXACT_SIZE = "100.000000000000000001";

let runs = 0;
type ObserveSpec = RecordSpec & { source?: "live" | "synthetic"; atMs: number; finish?: "complete" | "partial" | null };

/** One observation in its own run, finished as `finish` (default complete; null leaves it running). */
function observe(db: Database, spec: ObserveSpec): number {
  const runId = startRun(db, { runId: `run-${String(++runs).padStart(3, "0")}-${spec.source ?? "live"}`, sourceType: spec.source ?? "live", startedAt: new Date(T0 + spec.atMs) });
  const { source: _s, atMs, finish = "complete", ...rest } = spec;
  const id = persistObservation(db, runId, record({ receivedAt: [atMs + 100, atMs + 110], ...rest }), META, ANALYTICS_VERSION).observationId;
  if (finish !== null) {
    finalizeRun(db, runId, {
      status: finish,
      accounting: finish === "complete" ? "verified" : "incomplete",
      finishedAt: new Date(T0 + atMs + 500),
      stopReasons: finish === "complete" ? [] : ["DEADLINE"],
      scanCounts: null,
      persistCounts: { discovered: 1, notSelected: 0, selected: 1, persistedObservations: 1, booksWritten: rest.other === null ? 1 : 2, persistenceFailures: 0 },
      budgetUsed: 4,
      window: { first: new Date(T0 + atMs).toISOString(), last: new Date(T0 + atMs + 110).toISOString() },
      error: null,
    });
  }
  return id;
}

export interface Seeded {
  path: string;
  /** Observation ids by name. */
  ids: Record<string, number>;
}

/**
 * Market 1 (live, plus one synthetic sample): regular one-minute samples, an exact 18-place size, an
 * unpaired sample, an invalid book, a one-sided book, a 30-minute gap. Market 2: synthetic only.
 * Market 3: a single live observation.
 */
export function seedHistory(): Seeded {
  const path = tempDbPath("history.sqlite");
  const db = openMigrated(path);
  const ids: Record<string, number> = {};
  const gamma = { question: UNTRUSTED_QUESTION };
  ids.first = observe(db, { atMs: 0, gamma, ref: { bids: [["0.40", EXACT_SIZE]], asks: [["0.45", "100"]] } });
  ids.second = observe(db, { atMs: MINUTE, gamma, ref: { bids: [["0.41", "120"]], asks: [["0.44", "80"]] } });
  ids.unpaired = observe(db, { atMs: 90_000, gamma, other: null, finish: "partial" });
  ids.invalid = observe(db, { atMs: 2 * MINUTE, gamma, ref: { bids: [["0.40", "100"]], asks: [["0.45", "100"]], raw: { asset_id: "999" } } });
  ids.oneSided = observe(db, { atMs: 3 * MINUTE, gamma, ref: { bids: [["0.39", "50"]], asks: [] } });
  ids.regular = observe(db, { atMs: 4 * MINUTE, gamma, ref: { bids: [["0.42", "90"]], asks: [["0.47", "70"]] } });
  ids.afterGap = observe(db, { atMs: 34 * MINUTE, gamma, ref: { bids: [["0.40", "100"]], asks: [["0.43", "60"]] } });
  ids.synthetic = observe(db, { atMs: 35 * MINUTE, gamma, source: "synthetic", ref: { bids: [["0.10", "5"]], asks: [["0.90", "5"]] } });
  ids.syntheticOnly = observe(db, { id: "2", atMs: 36 * MINUTE, source: "synthetic" });
  ids.single = observe(db, { id: "3", atMs: 37 * MINUTE, finish: null });
  db.close();
  return { path, ids };
}

/** A migrated database with nothing stored. */
export function seedEmpty(): string {
  const path = tempDbPath("empty.sqlite");
  openMigrated(path).close();
  return path;
}
