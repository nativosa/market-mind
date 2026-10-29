import { decimal, decimalToString, type Decimal } from "../domain/decimal.js";
import type { BookQuality, PriceLevel } from "../domain/orderbook.js";
import type {
  CandidateEvaluation,
  OutcomeObservation,
  Reason,
  ScanFilters,
  ScanMetrics,
  ScanWarning,
} from "../domain/scan.js";

const ONE = decimal("1");
const EXTREME_LOW = decimal("0.05");
const EXTREME_HIGH = decimal("0.95");
export const PAIR_SKEW_WARNING_MS = 5_000;

const QUALITY_RANK: Record<BookQuality, number> = { valid: 0, incomplete: 1, suspicious: 2, invalid: 3 };

export function worstQuality(a: BookQuality, b: BookQuality): BookQuality {
  return QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b;
}

function minDecimal(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}

function receivedMs(o: OutcomeObservation): number {
  return Date.parse(o.book.provenance.timing.responseReceivedAt);
}

/**
 * Market-level metrics from the reference outcome (index 0) only. The other outcome contributes
 * to quality and pair skew, never to prices or sizes: complementary liquidity is not double-counted.
 */
export function computeScanMetrics(ref: OutcomeObservation, other: OutcomeObservation): ScanMetrics {
  const m = ref.assessment.metrics;
  const bestBid = m?.bestBid ?? null;
  const bestAsk = m?.bestAsk ?? null;
  const skew = receivedMs(ref) - receivedMs(other);
  return {
    reference: { index: ref.outcome.index, label: ref.outcome.label, assetId: ref.outcome.assetId },
    bestBid,
    bestAsk,
    spread: m?.spread ?? null,
    midpoint: m?.midpoint ?? null,
    topSize: bestBid && bestAsk ? minDecimal(bestBid.size, bestAsk.size) : null,
    topNotional: bestBid && bestAsk ? minDecimal(bestBid.price.times(bestBid.size), bestAsk.price.times(bestAsk.size)) : null,
    bidDepthWithinBand: m?.bidDepthWithinBand ?? null,
    askDepthWithinBand: m?.askDepthWithinBand ?? null,
    depthBand: m?.depthBand ?? null,
    bidDepth: m?.bidDepth ?? null,
    askDepth: m?.askDepth ?? null,
    levelCounts: m?.levelCounts ?? null,
    state: m?.state ?? null,
    quality: worstQuality(ref.assessment.quality, other.assessment.quality),
    pairSkewMs: skew < 0 ? -skew : skew,
  };
}

/**
 * Advisory check that the two binary books look like complements (bid p on one side, ask 1-p of the
 * same size on the other). Mirroring is an undocumented assumption and the books are separate
 * observations, so a mismatch is only ever reported, never acted on.
 */
export function checkComplement(ref: OutcomeObservation, other: OutcomeObservation): string[] {
  const a = ref.assessment.metrics;
  const b = other.assessment.metrics;
  if (!a || !b) return [];
  const problems: string[] = [];
  const pair = (x: PriceLevel | null, y: PriceLevel | null, what: string) => {
    if (x === null && y === null) return;
    if (x === null || y === null) {
      problems.push(`${what}: present on one outcome only`);
      return;
    }
    const sum = x.price.plus(y.price);
    if (!sum.eq(ONE)) problems.push(`${what}: prices sum to ${decimalToString(sum)}`);
    if (!x.size.eq(y.size)) problems.push(`${what}: sizes ${decimalToString(x.size)} vs ${decimalToString(y.size)}`);
  };
  pair(a.bestBid, b.bestAsk, `${ref.outcome.label} best bid / ${other.outcome.label} best ask`);
  pair(a.bestAsk, b.bestBid, `${ref.outcome.label} best ask / ${other.outcome.label} best bid`);
  return problems;
}

/**
 * Classify one inspected market. Categories, in priority order: failed (invalid book), excluded
 * (structurally unsuitable book), filtered (quality policy and user filters), ranked.
 * All applicable reasons are collected so the report explains every problem, not just the first.
 */
export function evaluateCandidate(
  ref: OutcomeObservation,
  other: OutcomeObservation,
  metrics: ScanMetrics,
  filters: ScanFilters,
  endDate: string | null,
): CandidateEvaluation {
  const failed: Reason[] = [];
  const excluded: Reason[] = [];
  const filtered: Reason[] = [];
  const warnings: ScanWarning[] = [];

  for (const o of [ref, other]) {
    const label = o.outcome.label;
    if (o.assessment.quality === "invalid") {
      const codes = o.assessment.issues.map((i) => i.code).join(", ");
      failed.push({ code: "INVALID_BOOK", detail: `${label}: ${codes}` });
      continue;
    }
    const bm = o.assessment.metrics!;
    if (bm.crossed) excluded.push({ code: "CROSSED_BOOK", detail: `${label}: best bid above best ask` });
    if (bm.locked) excluded.push({ code: "LOCKED_BOOK", detail: `${label}: best bid equals best ask` });
    for (const issue of o.assessment.issues) {
      if (issue.code === "CROSSED_BOOK" || issue.code === "LOCKED_BOOK") continue;
      warnings.push({ code: "BOOK_QUALITY_ISSUE", detail: `${label}: [${issue.category}] ${issue.code}: ${issue.detail}` });
    }
  }

  const refLabel = ref.outcome.label;
  if (metrics.state === "empty") excluded.push({ code: "EMPTY_BOOK", detail: `${refLabel}: no bids or asks` });
  else if (metrics.state === "bid-only" || metrics.state === "ask-only") {
    excluded.push({ code: "ONE_SIDED_BOOK", detail: `${refLabel}: ${metrics.state}` });
  }

  const suspicious = [ref, other].filter((o) => o.assessment.quality === "suspicious").map((o) => o.outcome.label);
  if (suspicious.length > 0) {
    if (filters.includeSuspicious) {
      warnings.push({ code: "SUSPICIOUS_BOOK_ADMITTED", detail: `suspicious book admitted: ${suspicious.join(", ")}` });
    } else {
      filtered.push({ code: "SUSPICIOUS_BOOK", detail: `suspicious book: ${suspicious.join(", ")}` });
    }
  }
  const spread = metrics.spread;
  const topSize = metrics.topSize;
  if (spread !== null && spread.lt(filters.minSpread)) {
    filtered.push({ code: "SPREAD_BELOW_MIN", detail: `spread ${decimalToString(spread)} < min ${decimalToString(filters.minSpread)}` });
  }
  if (topSize !== null && topSize.lt(filters.minTopSize)) {
    filtered.push({
      code: "TOP_SIZE_BELOW_MIN",
      detail: `top size ${decimalToString(topSize)} shares < min ${decimalToString(filters.minTopSize)}`,
    });
  }

  if (failed.length === 0) {
    for (const problem of checkComplement(ref, other)) warnings.push({ code: "COMPLEMENT_MISMATCH", detail: problem });
  }
  if (metrics.pairSkewMs > PAIR_SKEW_WARNING_MS) {
    warnings.push({ code: "PAIR_OBSERVATION_SKEW", detail: `outcome books observed ${metrics.pairSkewMs} ms apart` });
  }
  const mid = metrics.midpoint;
  if (mid !== null && (mid.lt(EXTREME_LOW) || mid.gt(EXTREME_HIGH))) {
    warnings.push({
      code: "EXTREME_PRICE",
      detail: `${refLabel} midpoint ${decimalToString(mid)}: tick size dominates the spread`,
    });
  }
  // An unparseable endDate yields NaN, which compares false: no warning, never a guess.
  if (endDate !== null && Date.parse(endDate) < Date.parse(ref.book.provenance.timing.responseReceivedAt)) {
    warnings.push({ code: "END_DATE_PASSED", detail: `endDate ${endDate} is before the observation` });
  }

  const reasons = [...failed, ...excluded, ...filtered];
  const bucket = failed.length > 0 ? "failed" : excluded.length > 0 ? "excluded" : filtered.length > 0 ? "filtered" : "ranked";
  const explanation =
    bucket === "ranked" && spread !== null && topSize !== null
      ? [
          `reference outcome "${refLabel}" (index ${metrics.reference.index})`,
          `spread ${decimalToString(spread)} >= min ${decimalToString(filters.minSpread)}`,
          `top-of-book size ${decimalToString(topSize)} shares >= min ${decimalToString(filters.minTopSize)}`,
          `book quality ${metrics.quality}`,
        ]
      : [];
  return { bucket, reasons, warnings, explanation };
}
