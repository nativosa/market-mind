import type { Decimal } from "../domain/decimal.js";

export interface Rankable {
  gammaId: string;
  spread: Decimal | null;
  topSize: Decimal | null;
}

const INTEGER = /^\d+$/;

/** Numeric order for canonical integer strings ("99" < "100"); plain string order otherwise. */
export function compareIntegerStrings(a: string, b: string): number {
  if (INTEGER.test(a) && INTEGER.test(b)) {
    const ta = a.replace(/^0+(?=\d)/, "");
    const tb = b.replace(/^0+(?=\d)/, "");
    if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
    if (ta !== tb) return ta < tb ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Descending by value; null sorts last. */
function desc(a: Decimal | null, b: Decimal | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return b.cmp(a);
}

/**
 * Total, deterministic order: spread desc, then top-of-book size desc, then market id asc.
 * It orders market conditions worth investigating; it says nothing about returns.
 */
export function compareCandidates(a: Rankable, b: Rankable): number {
  return desc(a.spread, b.spread) || desc(a.topSize, b.topSize) || compareIntegerStrings(a.gammaId, b.gammaId);
}

export function rankCandidates<T>(items: readonly T[], key: (item: T) => Rankable): T[] {
  return [...items].sort((x, y) => compareCandidates(key(x), key(y)));
}
