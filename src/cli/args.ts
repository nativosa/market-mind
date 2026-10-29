import { parseArgs } from "node:util";
import { isStrictDecimalString } from "../domain/decimal.js";
import { MarketMindError } from "../domain/errors.js";
import { PROTOCOL_VERSIONS, type ProtocolVersion } from "../domain/market.js";
import { SCAN_LIMITS, type DiscoverOrder } from "../app/scanMarkets.js";

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

export type Command =
  | { kind: "help" }
  | { kind: "markets"; limit: number; version: ProtocolVersion; cursor: string | null; json: boolean }
  | { kind: "inspect"; marketId: string; levels: number; depthBand: string | null; json: boolean }
  | ScanCommand;

export const USAGE = `Usage:
  npm run cli -- markets [--limit 1..${MAX_LIMIT}] [--version v1|v2] [--cursor <next_cursor>] [--json]
  npm run cli -- inspect --market-id <gamma id> [--levels 0..${MAX_LEVELS}] [--depth-band <0..1|none>] [--json]
  npm run cli -- scan [--version v1|v2] [--discover-order volume24hr|none]
                      [--max-markets 1..${SCAN_LIMITS.maxMarkets}] [--top 1..${SCAN_LIMITS.top}]
                      [--page-size 1..${SCAN_LIMITS.pageSize}] [--max-pages 1..${SCAN_LIMITS.maxPages}]
                      [--min-spread <0..1>] [--min-top-size <shares>] [--include-suspicious]
                      [--depth-band <0..1|none>] [--max-requests 1..${SCAN_LIMITS.maxRequests}]
                      [--concurrency 1..${SCAN_LIMITS.concurrency}] [--max-duration-ms ${SCAN_LIMITS.minDurationMs}..${SCAN_LIMITS.maxDurationMs}] [--json]

Defaults: --limit 5, --version v1, --levels 10, --depth-band 0.05
Scan defaults: --discover-order ${SCAN_DEFAULTS.discoverOrder}, --max-markets ${SCAN_DEFAULTS.maxMarkets}, --top ${SCAN_DEFAULTS.top}, --page-size ${SCAN_DEFAULTS.pageSize},
  --max-pages ${SCAN_DEFAULTS.maxPages}, --min-spread ${SCAN_DEFAULTS.minSpread}, --min-top-size ${SCAN_DEFAULTS.minTopSize}, --max-requests ${SCAN_DEFAULTS.maxRequests},
  --concurrency ${SCAN_DEFAULTS.concurrency}, --max-duration-ms ${SCAN_DEFAULTS.maxDurationMs}`;

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
} as const;

const MARKETS_ONLY = ["limit", "version", "cursor"] as const;
const INSPECT_ONLY = ["market-id", "levels", "depth-band"] as const;
const SCAN_ONLY = [
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

  const command = positionals[0];
  const json = values.json ?? false;
  if (command === "markets") {
    rejectOptions(values, [...INSPECT_ONLY, ...SCAN_ONLY], "markets");
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
    rejectOptions(values, [...MARKETS_ONLY, ...SCAN_ONLY], "inspect");
    const marketId = values["market-id"];
    if (marketId === undefined) throw usage("inspect requires --market-id <gamma id>");
    if (!/^\d+$/.test(marketId)) throw usage("--market-id must be a numeric Gamma market id");
    return {
      kind: "inspect",
      marketId,
      levels: intInRange(values.levels, "--levels", 0, MAX_LEVELS, 10),
      depthBand: parseDepthBand(values["depth-band"]),
      json,
    };
  }
  if (command === "scan") {
    rejectOptions(values, ["limit", "cursor", "market-id", "levels"], "scan");
    const order = values["discover-order"] ?? SCAN_DEFAULTS.discoverOrder;
    if (order !== "volume24hr" && order !== "none") throw usage("--discover-order must be volume24hr or none");
    const minTopSize = values["min-top-size"] ?? SCAN_DEFAULTS.minTopSize;
    if (!isStrictDecimalString(minTopSize)) throw usage("--min-top-size must be a non-negative decimal number of shares");
    return {
      kind: "scan",
      version: parseVersionOption(values.version),
      discoverOrder: order,
      maxMarkets: intInRange(values["max-markets"], "--max-markets", 1, SCAN_LIMITS.maxMarkets, SCAN_DEFAULTS.maxMarkets),
      top: intInRange(values.top, "--top", 1, SCAN_LIMITS.top, SCAN_DEFAULTS.top),
      pageSize: intInRange(values["page-size"], "--page-size", 1, SCAN_LIMITS.pageSize, SCAN_DEFAULTS.pageSize),
      maxPages: intInRange(values["max-pages"], "--max-pages", 1, SCAN_LIMITS.maxPages, SCAN_DEFAULTS.maxPages),
      minSpread: parseUnitDecimal(values["min-spread"], "--min-spread") ?? SCAN_DEFAULTS.minSpread,
      minTopSize,
      includeSuspicious: values["include-suspicious"] ?? false,
      depthBand: parseDepthBand(values["depth-band"]),
      maxRequests: intInRange(values["max-requests"], "--max-requests", 1, SCAN_LIMITS.maxRequests, SCAN_DEFAULTS.maxRequests),
      concurrency: intInRange(values.concurrency, "--concurrency", 1, SCAN_LIMITS.concurrency, SCAN_DEFAULTS.concurrency),
      maxDurationMs: intInRange(
        values["max-duration-ms"],
        "--max-duration-ms",
        SCAN_LIMITS.minDurationMs,
        SCAN_LIMITS.maxDurationMs,
        SCAN_DEFAULTS.maxDurationMs,
      ),
      json,
    };
  }
  throw usage(`Unknown command ${JSON.stringify(command)}`);
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

function rejectOptions(values: Record<string, unknown>, names: readonly string[], command: string): void {
  const present = names.filter((n) => values[n] !== undefined);
  if (present.length > 0) throw usage(`${present.map((n) => `--${n}`).join(", ")} not valid for ${command}`);
}

function usage(message: string): MarketMindError {
  return new MarketMindError("Usage", message);
}
