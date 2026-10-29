import { get, immediate, run, storageError, type Database } from "./sqlite.js";

// Ordered, append-only schema migrations. `PRAGMA user_version` records the applied level;
// `schema_migrations` keeps an audit trail. Never edit a released migration: add a new one.

/**
 * Strict non-negative decimal text (no sign, exponent, or bare dot), NULL allowed. STRICT TEXT
 * columns silently accept JS numbers (1.5 -> '1.5'), so this CHECK plus application validation
 * keeps floating-point renderings such as '1e-7' out of decimal columns.
 */
const dec = (col: string) =>
  `CHECK (${col} IS NULL OR (${col} GLOB '[0-9]*' AND ${col} NOT GLOB '*[^0-9.]*' AND ${col} NOT GLOB '*.*.*' AND ${col} NOT GLOB '*.'))`;

/** Spread may be negative for crossed books. */
const signedDec = (col: string) =>
  `CHECK (${col} IS NULL OR (ltrim(${col}, '-') GLOB '[0-9]*' AND ltrim(${col}, '-') NOT GLOB '*[^0-9.]*' AND ${col} NOT GLOB '*.*.*' AND ${col} NOT GLOB '*.' AND ${col} NOT GLOB '?*-*'))`;

const bool = (col: string) => `CHECK (${col} IS NULL OR ${col} IN (0, 1))`;

const V1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  description TEXT NOT NULL
) STRICT;

CREATE TABLE collection_run (
  run_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('live', 'synthetic')),
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'partial', 'interrupted', 'failed')),
  accounting TEXT NOT NULL CHECK (accounting IN ('pending', 'verified', 'incomplete')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  owner_pid INTEGER NOT NULL,
  owner_host TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  heartbeat_ms INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  build_id TEXT,
  schema_version INTEGER NOT NULL,
  analytics_version INTEGER NOT NULL,
  node_version TEXT NOT NULL,
  sqlite_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL CHECK (protocol_version IN ('v1', 'v2')),
  config_json TEXT NOT NULL,
  stop_reasons_json TEXT,
  scan_counts_json TEXT,
  persist_counts_json TEXT,
  budget_limit INTEGER NOT NULL,
  budget_used INTEGER,
  window_first TEXT,
  window_last TEXT,
  error_json TEXT,
  recovered_reason TEXT,
  CHECK ((status = 'running') = (finished_at IS NULL))
) STRICT;
CREATE INDEX collection_run_status ON collection_run (status);

CREATE TABLE market (
  gamma_id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL CHECK (protocol_version IN ('v1', 'v2')),
  first_seen_run TEXT NOT NULL REFERENCES collection_run (run_id)
) STRICT;

CREATE TABLE outcome (
  asset_id TEXT PRIMARY KEY,
  gamma_id TEXT NOT NULL REFERENCES market (gamma_id),
  outcome_index INTEGER NOT NULL CHECK (outcome_index >= 0),
  asset_id_kind TEXT NOT NULL CHECK (asset_id_kind IN ('tokenId', 'positionId')),
  UNIQUE (gamma_id, outcome_index)
) STRICT;

CREATE TABLE market_observation (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES collection_run (run_id),
  gamma_id TEXT NOT NULL REFERENCES market (gamma_id),
  discovery_position INTEGER NOT NULL CHECK (discovery_position >= 0),
  available_at TEXT NOT NULL,
  available_at_ms INTEGER NOT NULL,
  availability_basis TEXT NOT NULL CHECK (availability_basis IN ('paired_books', 'single_book', 'association', 'discovery')),
  persisted_at TEXT NOT NULL,
  pairing TEXT NOT NULL CHECK (pairing IN ('paired', 'incomplete', 'none')),
  association TEXT NOT NULL CHECK (association IN ('confirmed', 'mismatch', 'failed', 'not_attempted')),
  bucket TEXT NOT NULL CHECK (bucket IN ('ranked', 'filtered', 'excluded', 'failed', 'notScanned')),
  reasons_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  question TEXT NOT NULL,
  slug TEXT NOT NULL,
  outcome_labels_json TEXT NOT NULL,
  active INTEGER NOT NULL ${bool("active")},
  closed INTEGER NOT NULL ${bool("closed")},
  accepting_orders INTEGER ${bool("accepting_orders")},
  enable_order_book INTEGER ${bool("enable_order_book")},
  neg_risk INTEGER ${bool("neg_risk")},
  end_date TEXT,
  gamma_volume24hr TEXT,
  UNIQUE (run_id, gamma_id)
) STRICT;
CREATE INDEX market_observation_history ON market_observation (gamma_id, available_at_ms, id);

CREATE TABLE book_content (
  content_hash TEXT PRIMARY KEY CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  bids_json TEXT NOT NULL,
  asks_json TEXT NOT NULL,
  bid_levels INTEGER NOT NULL CHECK (bid_levels >= 0),
  ask_levels INTEGER NOT NULL CHECK (ask_levels >= 0)
) STRICT;

CREATE TABLE book_observation (
  id INTEGER PRIMARY KEY,
  market_observation_id INTEGER NOT NULL REFERENCES market_observation (id),
  asset_id TEXT NOT NULL REFERENCES outcome (asset_id),
  outcome_index INTEGER NOT NULL CHECK (outcome_index >= 0),
  label_observed TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES book_content (content_hash),
  reported_asset_id TEXT NOT NULL,
  reported_condition_id TEXT NOT NULL,
  upstream_hash TEXT,
  server_ts_raw TEXT,
  server_ts_ms INTEGER,
  tick_size TEXT,
  min_order_size TEXT,
  last_trade_price TEXT,
  neg_risk INTEGER ${bool("neg_risk")},
  request_url TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  first_attempt_started_at TEXT NOT NULL,
  final_attempt_started_at TEXT NOT NULL,
  response_received_at TEXT NOT NULL,
  response_received_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  server_date_header TEXT,
  quality TEXT NOT NULL CHECK (quality IN ('valid', 'incomplete', 'suspicious', 'invalid')),
  issues_json TEXT NOT NULL,
  UNIQUE (market_observation_id, outcome_index)
) STRICT;
CREATE INDEX book_observation_by_asset ON book_observation (asset_id, response_received_ms);

CREATE TABLE market_metrics (
  market_observation_id INTEGER NOT NULL REFERENCES market_observation (id),
  analytics_version INTEGER NOT NULL CHECK (analytics_version >= 1),
  computed_at TEXT NOT NULL,
  computed_by TEXT NOT NULL CHECK (computed_by IN ('collect', 'recompute')),
  app_version TEXT NOT NULL,
  build_id TEXT,
  depth_band TEXT ${dec("depth_band")},
  reference_index INTEGER NOT NULL,
  reference_asset_id TEXT NOT NULL,
  best_bid TEXT ${dec("best_bid")},
  best_bid_size TEXT ${dec("best_bid_size")},
  best_ask TEXT ${dec("best_ask")},
  best_ask_size TEXT ${dec("best_ask_size")},
  spread TEXT ${signedDec("spread")},
  midpoint TEXT ${dec("midpoint")},
  top_size TEXT ${dec("top_size")},
  top_notional TEXT ${dec("top_notional")},
  bid_depth TEXT ${dec("bid_depth")},
  ask_depth TEXT ${dec("ask_depth")},
  bid_band_depth TEXT ${dec("bid_band_depth")},
  ask_band_depth TEXT ${dec("ask_band_depth")},
  bid_levels INTEGER,
  ask_levels INTEGER,
  book_state TEXT CHECK (book_state IS NULL OR book_state IN ('two-sided', 'bid-only', 'ask-only', 'empty')),
  quality TEXT NOT NULL CHECK (quality IN ('valid', 'incomplete', 'suspicious', 'invalid')),
  pair_skew_ms INTEGER NOT NULL,
  PRIMARY KEY (market_observation_id, analytics_version)
) STRICT;

CREATE TABLE persistence_failure (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES collection_run (run_id),
  gamma_id TEXT,
  discovery_position INTEGER NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (run_id, discovery_position)
) STRICT;

CREATE TABLE request_log (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES collection_run (run_id),
  scope TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('gamma', 'clob')),
  endpoint TEXT NOT NULL,
  url TEXT NOT NULL,
  http_status INTEGER,
  attempts INTEGER NOT NULL,
  started_at TEXT,
  received_at TEXT,
  error_kind TEXT,
  -- One row per logical request (retries are its attempts). A discovery page shared by several
  -- markets is stored once; distinct requests may share a scope label (duplicate outcome labels).
  UNIQUE (run_id, scope, url)
) STRICT;
`;

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, description: "initial snapshot schema", sql: V1 }];
export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

export function userVersion(db: Database): number {
  return (get(db, "PRAGMA user_version") as { user_version: number }).user_version;
}

/** Apply pending migrations, each in its own IMMEDIATE transaction. */
export function migrate(db: Database, now: () => Date, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  const target = migrations.at(-1)?.version ?? 0;
  const from = userVersion(db);
  if (from > target) {
    throw storageError("SCHEMA_TOO_NEW", `Database schema version ${from} is newer than this MarketMind (${target}); refusing to use it`);
  }
  for (const m of migrations.filter((x) => x.version > from)) {
    immediate(db, () => {
      // Re-check inside the write lock: another process may have migrated meanwhile.
      if (userVersion(db) >= m.version) return;
      db.exec(m.sql);
      run(db, "INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)", m.version, now().toISOString(), m.description);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return { from, to: userVersion(db) };
}

/** Readers cannot migrate: require exactly the schema this code understands. */
export function assertSchemaCurrent(db: Database, path: string): void {
  const v = userVersion(db);
  if (v > SCHEMA_VERSION) throw storageError("SCHEMA_TOO_NEW", `Database ${path} has schema ${v}, newer than supported ${SCHEMA_VERSION}`);
  if (v < SCHEMA_VERSION) {
    throw storageError("SCHEMA_OUTDATED", `Database ${path} has schema ${v}; run \`collect\` once to migrate it to ${SCHEMA_VERSION}`);
  }
}
