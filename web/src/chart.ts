import type { HistoryItem } from "./api";
import { compareDecimals } from "./explorer";

// Geometry for the history charts. Every value shown as text stays the server's exact decimal
// string; Number() is used only here, to place a mark on the SVG, and a value that is not a finite
// number is simply not placed. Nothing is interpolated: each observation is drawn on its own.

export const CHART = { width: 640, height: 220, left: 10, right: 10, top: 12, plotBottom: 186, rugY: 204 } as const;

/** A finite number for positioning, or null (missing, malformed, infinite). */
export function position(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface Scale {
  (value: number): number;
  domain: readonly [number, number];
}

/**
 * Map [d0, d1] onto [r0, r1]. A degenerate domain (one value, a constant series) is padded so its
 * marks sit mid-range; results are clamped to the range, so an extreme value can never leave the plot.
 */
export function linearScale(d0: number, d1: number, r0: number, r1: number): Scale {
  let lo = Math.min(d0, d1);
  let hi = Math.max(d0, d1);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi - lo <= Math.abs(hi) * 1e-12 || hi === lo) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.5;
    lo -= pad;
    hi += pad;
  }
  const span = hi - lo;
  const scale = ((value: number) => {
    const t = (value - lo) / span;
    const out = r0 + (Number.isFinite(t) ? t : 0.5) * (r1 - r0);
    return Math.min(Math.max(out, Math.min(r0, r1)), Math.max(r0, r1));
  }) as Scale;
  scale.domain = [lo, hi];
  return scale;
}

/** Milliseconds of an ISO time, or null. */
export const timeOf = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The x scale over the plotted observations' actual times (a single time is centred). */
export function timeScale(items: readonly HistoryItem[]): Scale {
  const times = items.map((i) => timeOf(i.availableAt)).filter((t): t is number => t !== null);
  const lo = times.length === 0 ? 0 : Math.min(...times);
  const hi = times.length === 0 ? 1 : Math.max(...times);
  return linearScale(lo, hi, CHART.left, CHART.width - CHART.right);
}

/** The smallest and largest of exact decimal strings, compared exactly (labels for the y range). */
export function exactExtent(values: readonly (string | null)[]): { min: string; max: string } | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const v of values) {
    if (v === null || position(v) === null) continue;
    if (min === null || compareDecimals(v, min) < 0) min = v;
    if (max === null || compareDecimals(v, max) > 0) max = v;
  }
  return min === null || max === null ? null : { min, max };
}

/** The y scale for exact values (positions only); null when nothing can be placed. */
export function valueScale(values: readonly (string | null)[]): Scale | null {
  const nums = values.map(position).filter((n): n is number => n !== null);
  if (nums.length === 0) return null;
  return linearScale(Math.min(...nums), Math.max(...nums), CHART.plotBottom, CHART.top);
}

export const isUsable = (item: HistoryItem): boolean => item.flags.notUsable === null;

/**
 * Intervals with no usable observation that the server flagged as irregular: from the previous
 * usable observation to this one (gapMs), clipped to the plotted time range.
 */
export function gapIntervals(items: readonly HistoryItem[]): { from: number; to: number; id: number }[] {
  const out: { from: number; to: number; id: number }[] = [];
  for (const item of items) {
    const t = timeOf(item.availableAt);
    if (!item.flags.irregularGap || item.flags.gapMs === null || t === null) continue;
    out.push({ from: t - item.flags.gapMs, to: t, id: item.observationId });
  }
  return out;
}

/**
 * Whether band depths can be charted: every usable observation records the same depth band. Band
 * depths measured with different bands (a per-run setting) are not comparable.
 */
export function depthBandOf(items: readonly HistoryItem[]): { band: string | null; bands: string[] } {
  const bands = new Set<string>();
  let missing = false;
  for (const item of items) {
    if (!isUsable(item) || item.metrics === null) continue;
    if (item.metrics.depthBand === null) missing = true;
    else bands.add(item.metrics.depthBand);
  }
  const list = [...bands].sort(compareDecimals);
  return { band: !missing && list.length === 1 ? list[0]! : null, bands: missing ? [...list, "none"] : list };
}

/** The reference outcome labels among plotted observations (metrics are for this outcome only). */
export function referenceLabels(items: readonly HistoryItem[]): string[] {
  const labels = new Set<string>();
  for (const item of items) {
    if (item.metrics === null) continue;
    const label = item.outcomeLabels[item.metrics.referenceIndex];
    labels.add(label === undefined ? `outcome ${item.metrics.referenceIndex + 1}` : label);
  }
  return [...labels];
}

/** Index of the time nearest to `t` in ascending `times` (binary search); -1 when empty. */
export function nearestIndex(times: readonly number[], t: number): number {
  if (times.length === 0) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(times[lo - 1]! - t) <= Math.abs(times[lo]! - t) ? lo - 1 : lo;
}

export type Shape = "dot" | "square" | "tick" | "cross" | "diamond";

const r1 = (n: number) => Math.round(n * 10) / 10;

/** One SVG path holding a separate mark per point (sub-paths never join, so nothing is interpolated). */
export function marks(points: readonly { x: number; y: number }[], shape: Shape, size = 4.5): string {
  const s = size;
  return points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map(({ x: px, y: py }) => {
      const x = r1(px);
      const y = r1(py);
      switch (shape) {
        case "dot":
          return `M${r1(x - s)} ${y}a${s} ${s} 0 1 0 ${r1(2 * s)} 0a${s} ${s} 0 1 0 ${r1(-2 * s)} 0`;
        case "square":
          return `M${r1(x - s)} ${r1(y - s)}h${r1(2 * s)}v${r1(2 * s)}h${r1(-2 * s)}z`;
        case "diamond":
          return `M${x} ${r1(y - s)}l${s} ${s}l${-s} ${s}l${-s} ${-s}z`;
        case "tick":
          return `M${r1(x - s)} ${y}h${r1(2 * s)}`;
        case "cross":
          return `M${r1(x - s)} ${r1(y - s)}l${r1(2 * s)} ${r1(2 * s)}m0 ${r1(-2 * s)}l${r1(-2 * s)} ${r1(2 * s)}`;
      }
    })
    .join("");
}

/** Vertical segments (e.g. bid to ask of one observation), each separate. */
export function segments(spans: readonly { x: number; y0: number; y1: number }[]): string {
  return spans
    .filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y0) && Number.isFinite(s.y1))
    .map((s) => `M${r1(s.x)} ${r1(s.y0)}V${r1(s.y1)}`)
    .join("");
}
