import { decimal, half, type Decimal } from "../domain/decimal.js";
import type { HistoryPoint } from "../domain/snapshot.js";

/** Printed with every history result. */
export const HISTORY_LIMITATIONS: readonly string[] = [
  "Statistics count samples, not time: a value seen in X% of samples was not necessarily present X% of the time.",
  "Nothing is known between samples: a spread may have closed and reopened any number of times.",
  "Repeated identical samples (same book contents) are not independent market events.",
  "Snapshots say nothing about fills, queue position, execution probability, latency, hidden liquidity or cancellations.",
  "The two outcome books of a market are separate requests; local timestamps depend on the local clock.",
  "Volume-ordered selection samples markets irregularly; gaps and survivorship bias are expected.",
];

export type NotUsableReason = "NOT_PAIRED" | "INVALID_BOOK" | "NO_METRICS_FOR_VERSION" | "NOT_TWO_SIDED";

/** A sample contributes to statistics only with two valid books, metrics for the selected version and a two-sided reference book. */
export function notUsableReason(p: HistoryPoint): NotUsableReason | null {
  if (p.pairing !== "paired") return "NOT_PAIRED";
  if (p.books.some((b) => b.quality === "invalid")) return "INVALID_BOOK";
  if (p.metrics === null) return "NO_METRICS_FOR_VERSION";
  if (p.metrics.state !== "two-sided" || p.metrics.spread === null || p.metrics.topSize === null) return "NOT_TWO_SIDED";
  return null;
}

export interface HistoryStats {
  eligible: number;
  usable: number;
  notUsable: Record<NotUsableReason, number>;
  firstUsableAt: string | null;
  lastUsableAt: string | null;
  spread: {
    n: number;
    min: Decimal | null;
    max: Decimal | null;
    median: Decimal | null;
    current: Decimal | null;
    previous: Decimal | null;
    /** current - previous; n = 2 when both exist. */
    change: Decimal | null;
  };
  topSize: { n: number; current: Decimal | null; previous: Decimal | null; change: Decimal | null };
  threshold: { n: number; threshold: Decimal; atOrAbove: number; percentOfSamples: Decimal | null };
  gaps: { n: number; minMs: number | null; medianMs: number | null; maxMs: number | null; irregular: number };
  states: { n: number; distinct: number };
}

export type MetadataChange = "LABEL_CHANGED" | "QUESTION_CHANGED" | "STATUS_CHANGED" | "END_DATE_CHANGED";

export interface RowAnnotation {
  notUsable: NotUsableReason | null;
  /** Same book contents as the previous usable sample (null for the first usable sample or unusable rows). */
  unchanged: boolean | null;
  /** Ms since the previous usable sample (usable rows only). */
  gapMs: number | null;
  changes: MetadataChange[];
}

const median = (sorted: readonly Decimal[]): Decimal | null => {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : half(sorted[mid - 1]!.plus(sorted[mid]!));
};

const medianNumber = (sorted: readonly number[]): number | null => {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const stateKey = (p: HistoryPoint) => p.books.map((b) => `${b.outcomeIndex}:${b.contentHash}`).join("|");

/** Sample-count statistics over every usable sample of an ascending (oldest first) series. */
export function computeHistoryStats(points: readonly HistoryPoint[], threshold: Decimal): HistoryStats {
  const notUsable: Record<NotUsableReason, number> = { NOT_PAIRED: 0, INVALID_BOOK: 0, NO_METRICS_FOR_VERSION: 0, NOT_TWO_SIDED: 0 };
  const usable: HistoryPoint[] = [];
  for (const p of points) {
    const reason = notUsableReason(p);
    if (reason) notUsable[reason]++;
    else usable.push(p);
  }
  const spreads = usable.map((p) => p.metrics!.spread!);
  const sorted = [...spreads].sort((a, b) => a.cmp(b));
  const last = usable.at(-1) ?? null;
  const prev = usable.length >= 2 ? usable[usable.length - 2]! : null;

  const gaps: number[] = [];
  for (let i = 1; i < usable.length; i++) gaps.push(usable[i]!.availableAtMs - usable[i - 1]!.availableAtMs);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap = medianNumber(sortedGaps);

  let distinct = 0;
  usable.forEach((p, i) => {
    if (i === 0 || stateKey(p) !== stateKey(usable[i - 1]!)) distinct++;
  });

  const atOrAbove = spreads.filter((s) => s.gte(threshold)).length;
  return {
    eligible: points.length,
    usable: usable.length,
    notUsable,
    firstUsableAt: usable[0]?.availableAt ?? null,
    lastUsableAt: last?.availableAt ?? null,
    spread: {
      n: usable.length,
      min: sorted[0] ?? null,
      max: sorted.at(-1) ?? null,
      median: median(sorted),
      current: last?.metrics!.spread ?? null,
      previous: prev?.metrics!.spread ?? null,
      change: last && prev ? last.metrics!.spread!.minus(prev.metrics!.spread!) : null,
    },
    topSize: {
      n: pairCount(usable.length),
      current: last?.metrics!.topSize ?? null,
      previous: prev?.metrics!.topSize ?? null,
      change: last && prev ? last.metrics!.topSize!.minus(prev.metrics!.topSize!) : null,
    },
    threshold: {
      n: usable.length,
      threshold,
      atOrAbove,
      percentOfSamples: usable.length === 0 ? null : decimal(String(atOrAbove)).times(decimal("100")).div(decimal(String(usable.length))).round(2),
    },
    gaps: {
      n: gaps.length,
      minMs: sortedGaps[0] ?? null,
      medianMs: medianGap,
      maxMs: sortedGaps.at(-1) ?? null,
      irregular: medianGap === null ? 0 : gaps.filter((g) => g > 2 * medianGap).length,
    },
    states: { n: usable.length, distinct },
  };
}

/** Number of samples behind a current/previous comparison: min(usable, 2). */
function pairCount(n: number): number {
  return n < 2 ? n : 2;
}

/** Per-row flags for an ascending series, keyed by observation id. */
export function annotateRows(points: readonly HistoryPoint[]): Map<number, RowAnnotation> {
  const out = new Map<number, RowAnnotation>();
  let previousUsable: HistoryPoint | null = null;
  let previous: HistoryPoint | null = null;
  for (const p of points) {
    const reason = notUsableReason(p);
    const changes: MetadataChange[] = [];
    if (previous) {
      if (JSON.stringify(previous.outcomeLabels) !== JSON.stringify(p.outcomeLabels) || bookLabelsDiffer(previous, p)) changes.push("LABEL_CHANGED");
      if (previous.question !== p.question) changes.push("QUESTION_CHANGED");
      if (previous.active !== p.active || previous.closed !== p.closed || previous.acceptingOrders !== p.acceptingOrders) changes.push("STATUS_CHANGED");
      if (previous.endDate !== p.endDate) changes.push("END_DATE_CHANGED");
    }
    out.set(p.observationId, {
      notUsable: reason,
      unchanged: reason === null && previousUsable ? stateKey(previousUsable) === stateKey(p) : null,
      gapMs: reason === null && previousUsable ? p.availableAtMs - previousUsable.availableAtMs : null,
      changes,
    });
    if (reason === null) previousUsable = p;
    previous = p;
  }
  return out;
}

function bookLabelsDiffer(a: HistoryPoint, b: HistoryPoint): boolean {
  for (const x of a.books) {
    const y = b.books.find((z) => z.outcomeIndex === x.outcomeIndex);
    if (y && y.label !== x.label) return true;
  }
  return false;
}
