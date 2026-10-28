import { parseArgs } from "node:util";
import { isStrictDecimalString } from "../domain/decimal.js";
import { MarketMindError } from "../domain/errors.js";
import { PROTOCOL_VERSIONS, type ProtocolVersion } from "../domain/market.js";

export const MAX_LIMIT = 100;
export const MAX_LEVELS = 50;

export type Command =
  | { kind: "help" }
  | { kind: "markets"; limit: number; version: ProtocolVersion; cursor: string | null; json: boolean }
  | { kind: "inspect"; marketId: string; levels: number; depthBand: string | null; json: boolean };

export const USAGE = `Usage:
  npm run cli -- markets [--limit 1..${MAX_LIMIT}] [--version v1|v2] [--cursor <next_cursor>] [--json]
  npm run cli -- inspect --market-id <gamma id> [--levels 0..${MAX_LEVELS}] [--depth-band <0..1|none>] [--json]

Defaults: --limit 5, --version v1, --levels 10, --depth-band 0.05`;

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  limit: { type: "string" },
  version: { type: "string" },
  cursor: { type: "string" },
  "market-id": { type: "string" },
  levels: { type: "string" },
  "depth-band": { type: "string" },
} as const;

const MARKETS_ONLY = ["limit", "version", "cursor"] as const;
const INSPECT_ONLY = ["market-id", "levels", "depth-band"] as const;

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
    rejectOptions(values, INSPECT_ONLY, "markets");
    const version = values.version ?? "v1";
    const known = PROTOCOL_VERSIONS.find((v) => v === version);
    if (!known) throw usage(`--version must be one of ${PROTOCOL_VERSIONS.join(", ")}`);
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
    rejectOptions(values, MARKETS_ONLY, "inspect");
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
  throw usage(`Unknown command ${JSON.stringify(command)}`);
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
