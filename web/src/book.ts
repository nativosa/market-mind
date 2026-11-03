import type { Inspection } from "./api";
import { groupDigits, NOT_REPORTED } from "./format";

// Display helpers for one inspection. Prices, sizes and metrics are the server's exact decimal
// strings and are shown unchanged (sizes only gain thousands separators). Number() is used in one
// place only: the approximate width of a depth bar, which never feeds a displayed value.

export type Outcome = Inspection["outcomes"][number];
export type Metrics = NonNullable<Outcome["metrics"]>;
export type Level = Outcome["levels"]["bids"][number];
export type Quality = Outcome["quality"];
export type BookState = Metrics["state"];

/** Ladder depths offered locally; every inspection already holds the API maximum per side. */
export const DEPTH_CHOICES = [5, 10, 20] as const;
export const DEFAULT_DEPTH = 5;

/** The depths that fit within the levels the server applied, ending with that maximum. */
export const depthChoices = (max: number): number[] => [...DEPTH_CHOICES.filter((n) => n < max), max];

/** The scan's skew warning threshold (analytics PAIR_SKEW_WARNING_MS); the web bundle may not import analytics. */
export const PAIR_SKEW_WARNING_MS = 5_000;

export const SIZE_UNIT = "shares";

export const QUALITY_TEXT: Record<Quality, string> = {
  valid: "Valid",
  incomplete: "Incomplete metadata",
  suspicious: "Suspicious",
  invalid: "Invalid",
};

export const STATE_TEXT: Record<BookState, string> = {
  "two-sided": "Two-sided",
  "bid-only": "One-sided: bids only",
  "ask-only": "One-sided: asks only",
  empty: "Empty: no bids or asks",
};

/** Plain-language meaning of the quality issue codes the analytics can report. */
export const ISSUE_TEXT: Readonly<Record<string, string>> = {
  ASSET_ID_MISMATCH: "The book is for a different token than the one requested.",
  CONDITION_ID_MISMATCH: "The book belongs to a different market (condition ID).",
  MALFORMED_PRICE: "A price level is not a valid decimal.",
  PRICE_OUT_OF_RANGE: "A price lies outside 0 to 1.",
  MALFORMED_SIZE: "A size is not a valid decimal.",
  CROSSED_BOOK: "The best bid is above the best ask.",
  LOCKED_BOOK: "The best bid equals the best ask.",
  OFF_TICK_PRICE: "Some prices are not multiples of the tick size.",
  DUPLICATE_PRICE_LEVELS: "Repeated price levels were added together.",
  ZERO_SIZE_LEVELS: "Levels with zero size were ignored.",
  UNEXPECTED_LEVEL_ORDER: "Levels arrived out of the documented order and were sorted locally.",
  MISSING_TICK_SIZE: "Tick size is missing.",
  MISSING_MIN_ORDER_SIZE: "Minimum order size is missing.",
  MISSING_LAST_TRADE_PRICE: "Last trade price is missing.",
  MISSING_HASH: "The book hash is missing.",
  MISSING_SERVER_TIMESTAMP: "Polymarket's book timestamp is missing.",
};

export const issueText = (code: string): string => ISSUE_TEXT[code] ?? "Reported by the quality checks.";

export const ASSOCIATION_TEXT: Readonly<Record<string, string>> = {
  "clob-markets-explicit": "Tokens paired from Polymarket's CLOB market record",
};
export const CROSS_CHECK_TEXT: Readonly<Record<string, string>> = {
  match: "Gamma's outcome order agrees",
};

export function roleText(role: Outcome["role"]): string {
  return role === "YES" ? "Yes side" : role === "NO" ? "No side" : "No Yes/No role";
}

/** A missing or unparseable optional value is shown as not reported, never as zero. */
export const orUnknown = (value: string | null): string => (value === null ? NOT_REPORTED : value);
export const formatShares = (value: string | null): string => (value === null ? NOT_REPORTED : groupDigits(value));

/** Up to `depth` levels per side, in the server's best-first order (never re-sorted here). */
export function ladderOf(outcome: Outcome, depth: number) {
  const { bids, asks, totalBids, totalAsks } = outcome.levels;
  return { bids: bids.slice(0, depth), asks: asks.slice(0, depth), totalBids, totalAsks };
}

/** The largest size among the shown levels, as an approximate number for bar widths only. */
export function barScale(levels: readonly Level[]): number {
  let max = 0;
  for (const level of levels) {
    const n = Number(level.size);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** Approximate bar width in percent; 0 when nothing can be scaled. */
export function barPercent(size: string, scale: number): number {
  const n = Number(size);
  if (!(scale > 0) || !Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.min(100, Math.round((n / scale) * 1000) / 10));
}

/** ISO time as "YYYY-MM-DD HH:MM:SS.mmm UTC"; other text is shown as received. */
export function formatTimestamp(iso: string | null): string {
  if (iso === null) return NOT_REPORTED;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return `${new Date(t).toISOString().replace("T", " ").replace("Z", "")} UTC`;
}

export const formatMs = (ms: number): string => `${groupDigits(String(ms))} ms`;

/** Whether the shown depth hides levels the server returned or the book holds. */
export function ladderNote(outcome: Outcome, depth: number): string {
  const { totalBids, totalAsks } = outcome.levels;
  const shownBids = Math.min(depth, outcome.levels.bids.length);
  const shownAsks = Math.min(depth, outcome.levels.asks.length);
  return `Showing ${shownBids} of ${totalBids} bid ${totalBids === 1 ? "level" : "levels"} and ${shownAsks} of ${totalAsks} ask ${totalAsks === 1 ? "level" : "levels"}`;
}
