import { parseArgs } from "node:util";
import { isStrictDecimalString } from "../domain/decimal.js";
import { MarketMindError } from "../domain/errors.js";
import { PROTOCOL_VERSIONS, type ProtocolVersion } from "../domain/market.js";
import { MAX_DB_MB_LIMIT } from "../app/collectMarkets.js";
import { SCAN_LIMITS, type DiscoverOrder } from "../app/scanMarkets.js";
import { ANALYTICS_VERSION } from "../analytics/version.js";
import { parseDbPath } from "../config/config.js";

export const MAX_LIMIT = 100;
export const MAX_LEVELS = 50;

export const SCAN_DEFAULTS = {
  discoverOrder: "volume24hr",
  maxMarkets: 10,
  top: 10,
  pageSize: 50,
  maxPages: 2,
  minSpread: "0",
  minTopSize: "10",
  maxRequests: 48,
  concurrency: 4,
  maxDurationMs: 60_000,
} as const;

export interface ScanCommand {
  kind: "scan";
  version: ProtocolVersion;
  discoverOrder: DiscoverOrder;
  maxMarkets: number;
  top: number;
  pageSize: number;
  maxPages: number;
  minSpread: string;
  minTopSize: string;
  includeSuspicious: boolean;
  depthBand: string | null;
  maxRequests: number;
  concurrency: number;
  maxDurationMs: number;
  json: boolean;
}

export const COLLECT_DEFAULTS = { maxDbMb: 1024 } as const;
export const HISTORY_DEFAULTS = { limit: 20, maxLimit: 500, spreadThreshold: "0.02" } as const;
export const RUNS_DEFAULTS = { limit: 10, maxLimit: 100 } as const;

export type CollectCommand = Omit<ScanCommand, "kind"> & { kind: "collect"; db: string | null; maxDbMb: number };

export interface HistoryCommand {
  kind: "history";
  marketId: string;
  /** Canonical ISO-8601 (UTC) evidence-availability boundary. */
  asOf: string | null;
  limit: number;
  spreadThreshold: string;
  analyticsVersion: number;
  includeSynthetic: boolean;
  db: string | null;
  json: boolean;
}

export interface RunsCommand {
  kind: "runs";
  limit: number;
  db: string | null;
  json: boolean;
}

export type Command =
  | { kind: "help" }
  | { kind: "markets"; limit: number; version: ProtocolVersion; cursor: string | null; json: boolean }
  | { kind: "inspect"; marketId: string; levels: number; depthBand: string | null; json: boolean }
  | ScanCommand
  | CollectCommand
  | HistoryCommand
  | RunsCommand;

export const USAGE = `Usage:
  npm run cli -- markets [--limit 1..${MAX_LIMIT}] [--version v1|v2] [--cursor <next_cursor>] [--json]
  npm run cli -- inspect --market-id <gamma id> [--levels 0..${MAX_LEVELS}] [--depth-band <0..1|none>] [--json]
  npm run cli -- scan [--version v1|v2] [--discover-order volume24hr|none]
                      [--max-markets 1..${SCAN_LIMITS.maxMarkets}] [--top 1..${SCAN_LIMITS.top}]
                      [--page-size 1..${SCAN_LIMITS.pageSize}] [--max-pages 1..${SCAN_LIMITS.maxPages}]
                      [--min-spread <0..1>] [--min-top-size <shares>] [--include-suspicious]
                      [--depth-band <0..1|none>] [--max-requests 1..${SCAN_LIMITS.maxRequests}]
                      [--concurrency 1..${SCAN_LIMITS.concurrency}] [--max-duration-ms ${SCAN_LIMITS.minDurationMs}..${SCAN_LIMITS.maxDurationMs}] [--json]
  npm run cli -- collect [scan options] [--db <path.sqlite>] [--max-db-mb 1..${MAX_DB_MB_LIMIT}] [--json]
  npm run cli -- history --market-id <gamma id> [--as-of <ISO-8601>] [--limit 1..${HISTORY_DEFAULTS.maxLimit}]
                         [--spread-threshold <0..1>] [--analytics-version <n>] [--include-synthetic] [--db <path>] [--json]
  npm run cli -- runs [--limit 1..${RUNS_DEFAULTS.maxLimit}] [--db <path>] [--json]

Defaults: --limit 5, --version v1, --levels 10, --depth-band 0.05
Scan defaults: --discover-order ${SCAN_DEFAULTS.discoverOrder}, --max-markets ${SCAN_DEFAULTS.maxMarkets}, --top ${SCAN_DEFAULTS.top}, --page-size ${SCAN_DEFAULTS.pageSize},
  --max-pages ${SCAN_DEFAULTS.maxPages}, --min-spread ${SCAN_DEFAULTS.minSpread}, --min-top-size ${SCAN_DEFAULTS.minTopSize}, --max-requests ${SCAN_DEFAULTS.maxRequests},
  --concurrency ${SCAN_DEFAULTS.concurrency}, --max-duration-ms ${SCAN_DEFAULTS.maxDurationMs}
Storage defaults: --db data/marketmind.sqlite (or MARKETMIND_DB), --max-db-mb ${COLLECT_DEFAULTS.maxDbMb} (soft admission limit),
  history --limit ${HISTORY_DEFAULTS.limit} --spread-threshold ${HISTORY_DEFAULTS.spreadThreshold} --analytics-version ${ANALYTICS_VERSION}, runs --limit ${RUNS_DEFAULTS.limit}`;

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  limit: { type: "string" },
  version: { type: "string" },
  cursor: { type: "string" },
  "market-id": { type: "string" },
  levels: { type: "string" },
  "depth-band": { type: "string" },
  "discover-order": { type: "string" },
  "max-markets": { type: "string" },
  top: { type: "string" },
  "page-size": { type: "string" },
  "max-pages": { type: "string" },
  "min-spread": { type: "string" },
  "min-top-size": { type: "string" },
  "include-suspicious": { type: "boolean" },
  "max-requests": { type: "string" },
  concurrency: { type: "string" },
  "max-duration-ms": { type: "string" },
  db: { type: "string" },
  "max-db-mb": { type: "string" },
  "as-of": { type: "string" },
  "spread-threshold": { type: "string" },
  "analytics-version": { type: "string" },
  "include-synthetic": { type: "boolean" },
} as const;

const SCAN_OPTIONS = [
  "version",
  "depth-band",
  "discover-order",
  "max-markets",
  "top",
  "page-size",
  "max-pages",
  "min-spread",
  "min-top-size",
  "include-suspicious",
  "max-requests",
  "concurrency",
  "max-duration-ms",
] as const;

/** Options each command accepts (besides --help and --json); anything else is a usage error. */
const ALLOWED: Record<string, readonly string[]> = {
  markets: ["limit", "version", "cursor"],
  inspect: ["market-id", "levels", "depth-band"],
  scan: SCAN_OPTIONS,
  collect: [...SCAN_OPTIONS, "db", "max-db-mb"],
  history: ["market-id", "as-of", "limit", "spread-threshold", "analytics-version", "include-synthetic", "db"],
  runs: ["limit", "db"],
};

export function parseCli(argv: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw usage(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) return { kind: "help" };
  if (positionals.length > 1) throw usage(`Unexpected arguments: ${positionals.slice(1).join(" ")}`);

  const command = positionals[0]!;
  const json = values.json ?? false;
  const allowed = ALLOWED[command];
  if (!allowed) throw usage(`Unknown command ${JSON.stringify(command)}`);
  const extra = Object.keys(values).filter((k) => k !== "help" && k !== "json" && values[k as keyof typeof values] !== undefined && !allowed.includes(k));
  if (extra.length > 0) throw usage(`${extra.map((n) => `--${n}`).join(", ")} not valid for ${command}`);

  if (command === "markets") {
    const known = parseVersionOption(values.version);
    if (values.cursor !== undefined && values.cursor.trim() === "") throw usage("--cursor must not be empty");
    return {
      kind: "markets",
      limit: intInRange(values.limit, "--limit", 1, MAX_LIMIT, 5),
      version: known,
      cursor: values.cursor ?? null,
      json,
    };
  }
  if (command === "inspect") {
    return {
      kind: "inspect",
      marketId: parseMarketId(values["market-id"], "inspect"),
      levels: intInRange(values.levels, "--levels", 0, MAX_LEVELS, 10),
      depthBand: parseDepthBand(values["depth-band"]),
      json,
    };
  }
  if (command === "scan") return { kind: "scan", ...parseScanOptions(values, json) };
  if (command === "collect") {
    return {
      kind: "collect",
      ...parseScanOptions(values, json),
      db: values.db === undefined ? null : parseDbPath(values.db, "--db"),
      maxDbMb: intInRange(values["max-db-mb"], "--max-db-mb", 1, MAX_DB_MB_LIMIT, COLLECT_DEFAULTS.maxDbMb),
    };
  }
  if (command === "history") {
    return {
      kind: "history",
      marketId: parseMarketId(values["market-id"], "history"),
      asOf: parseAsOf(values["as-of"]),
      limit: intInRange(values.limit, "--limit", 1, HISTORY_DEFAULTS.maxLimit, HISTORY_DEFAULTS.limit),
      spreadThreshold: parseUnitDecimal(values["spread-threshold"], "--spread-threshold") ?? HISTORY_DEFAULTS.spreadThreshold,
      analyticsVersion: intInRange(values["analytics-version"], "--analytics-version", 1, 1_000_000, ANALYTICS_VERSION),
      includeSynthetic: values["include-synthetic"] ?? false,
      db: values.db === undefined ? null : parseDbPath(values.db, "--db"),
      json,
    };
  }
  return {
    kind: "runs",
    limit: intInRange(values.limit, "--limit", 1, RUNS_DEFAULTS.maxLimit, RUNS_DEFAULTS.limit),
    db: values.db === undefined ? null : parseDbPath(values.db, "--db"),
    json,
  };
}

type Values = Record<string, string | boolean | undefined>;

function parseScanOptions(values: Values, json: boolean): Omit<ScanCommand, "kind"> {
  const str = (k: string) => values[k] as string | undefined;
  const order = str("discover-order") ?? SCAN_DEFAULTS.discoverOrder;
  if (order !== "volume24hr" && order !== "none") throw usage("--discover-order must be volume24hr or none");
  const minTopSize = str("min-top-size") ?? SCAN_DEFAULTS.minTopSize;
  if (!isStrictDecimalString(minTopSize)) throw usage("--min-top-size must be a non-negative decimal number of shares");
  return {
    version: parseVersionOption(str("version")),
    discoverOrder: order,
    maxMarkets: intInRange(str("max-markets"), "--max-markets", 1, SCAN_LIMITS.maxMarkets, SCAN_DEFAULTS.maxMarkets),
    top: intInRange(str("top"), "--top", 1, SCAN_LIMITS.top, SCAN_DEFAULTS.top),
    pageSize: intInRange(str("page-size"), "--page-size", 1, SCAN_LIMITS.pageSize, SCAN_DEFAULTS.pageSize),
    maxPages: intInRange(str("max-pages"), "--max-pages", 1, SCAN_LIMITS.maxPages, SCAN_DEFAULTS.maxPages),
    minSpread: parseUnitDecimal(str("min-spread"), "--min-spread") ?? SCAN_DEFAULTS.minSpread,
    minTopSize,
    includeSuspicious: values["include-suspicious"] === true,
    depthBand: parseDepthBand(str("depth-band")),
    maxRequests: intInRange(str("max-requests"), "--max-requests", 1, SCAN_LIMITS.maxRequests, SCAN_DEFAULTS.maxRequests),
    concurrency: intInRange(str("concurrency"), "--concurrency", 1, SCAN_LIMITS.concurrency, SCAN_DEFAULTS.concurrency),
    maxDurationMs: intInRange(str("max-duration-ms"), "--max-duration-ms", SCAN_LIMITS.minDurationMs, SCAN_LIMITS.maxDurationMs, SCAN_DEFAULTS.maxDurationMs),
    json,
  };
}

function parseMarketId(value: string | undefined, command: string): string {
  if (value === undefined) throw usage(`${command} requires --market-id <gamma id>`);
  if (!/^\d+$/.test(value)) throw usage("--market-id must be a numeric Gamma market id");
  return value;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** An explicit ISO-8601 instant with a time zone, normalized to UTC; local-time ambiguity is rejected. */
function parseAsOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  if (!ISO_INSTANT.test(value) || Number.isNaN(ms)) {
    throw usage("--as-of must be an ISO-8601 instant with a time zone, e.g. 2026-10-29T08:00:00Z");
  }
  return new Date(ms).toISOString();
}

function parseVersionOption(value: string | undefined): ProtocolVersion {
  const version = value ?? "v1";
  const known = PROTOCOL_VERSIONS.find((v) => v === version);
  if (!known) throw usage(`--version must be one of ${PROTOCOL_VERSIONS.join(", ")}`);
  return known;
}

/** A strict decimal in [0, 1], or undefined when the option is absent. */
function parseUnitDecimal(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isStrictDecimalString(value) || !/^(0(\.\d+)?|1(\.0+)?)$/.test(value)) {
    throw usage(`${name} must be a decimal between 0 and 1`);
  }
  return value;
}

function parseDepthBand(value: string | undefined): string | null {
  if (value === undefined) return "0.05";
  if (value === "none") return null;
  if (!isStrictDecimalString(value) || !/^(0(\.\d+)?|1(\.0+)?)$/.test(value)) {
    throw usage("--depth-band must be a decimal between 0 and 1, or 'none'");
  }
  return value;
}

function intInRange(value: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw usage(`${name} must be an integer between ${min} and ${max}`);
  const n = Number(value);
  if (n < min || n > max) throw usage(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function usage(message: string): MarketMindError {
  return new MarketMindError("Usage", message);
}
