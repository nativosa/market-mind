import type { MouseEvent } from "react";
import type { HistoryItem } from "../api";
import { formatTimestamp } from "../book";
import { CHART, depthBandOf, exactExtent, gapIntervals, isUsable, marks, nearestIndex, position, referenceLabels, segments, timeOf, timeScale, valueScale, type Shape } from "../chart";
import { groupDigits } from "../format";
import styles from "./HistoryCharts.module.css";

type Value = (item: HistoryItem) => string | null;

export interface Series {
  key: string;
  label: string;
  shape: Shape;
  value: Value;
  /** CSS module class giving the series its colour. */
  tone: "bid" | "ask" | "mid" | "spread";
}

export interface TimeChartProps {
  id: string;
  title: string;
  /** Plotted observations, oldest first (usable ones are charted, the others marked on the rug). */
  items: readonly HistoryItem[];
  series: readonly Series[];
  /** A vertical bar per observation (bid to ask). */
  span?: { from: Value; to: Value };
  threshold?: { value: string; label: string };
  /** Text values are shown as exact strings; this formats them (e.g. digit grouping for sizes). */
  format?: (value: string) => string;
  selectedId: number | null;
  onSelect: (observationId: number) => void;
  note?: string;
}

const ident = (v: string) => v;

/**
 * One time chart of discrete observations: x is each observation's actual availableAt, every mark
 * stands alone (no lines between observations), shaded bands are intervals the server flagged as
 * irregular gaps, and observations that cannot be used are crosses on the rug below the plot.
 * Synthetic observations are hollow. Clicking selects the nearest observation; the observation
 * table offers the same selection by keyboard.
 */
export function TimeChart({ id, title, items, series, span, threshold, format = ident, selectedId, onSelect, note }: TimeChartProps) {
  const x = timeScale(items);
  const usable = items.filter(isUsable);
  const values = usable.flatMap((i) => [...series.map((s) => s.value(i)), ...(span ? [span.from(i), span.to(i)] : [])]);
  const extent = exactExtent(values);
  const y = valueScale(threshold ? [...values, threshold.value] : values);
  const times = items.map((i) => timeOf(i.availableAt) ?? Number.NaN);
  const [lo, hi] = x.domain;
  const point = (i: HistoryItem, v: string | null) => {
    const t = timeOf(i.availableAt);
    const n = position(v);
    return t === null || n === null || y === null ? null : { x: x(t), y: y(n) };
  };
  const selected = items.find((i) => i.observationId === selectedId) ?? null;
  const selectedT = selected === null ? null : timeOf(selected.availableAt);

  const onClick = (e: MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (!(box.width > 0)) return;
    const fx = ((e.clientX - box.left) / box.width) * CHART.width;
    const t = lo + ((fx - CHART.left) / (CHART.width - CHART.left - CHART.right)) * (hi - lo);
    const index = nearestIndex(times, t);
    if (index >= 0) onSelect(items[index]!.observationId);
  };

  const usableCount = y === null ? 0 : usable.length;
  const describedBy = `${id}-summary`;
  return (
    <figure className={styles.chart} aria-labelledby={`${id}-title`}>
      <figcaption>
        <h3 id={`${id}-title`} className={styles.title}>
          {title}
        </h3>
        <p id={describedBy} className={styles.range}>
          {extent === null ? "No usable value to plot." : `Plotted values from ${format(extent.min)} to ${format(extent.max)}`}
          {threshold ? ` · ${threshold.label}: ${threshold.value}` : ""}
        </p>
      </figcaption>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-label={`${title}: ${usableCount} usable ${usableCount === 1 ? "observation" : "observations"} plotted, ${items.length - usable.length} not usable. The observation table lists the same values.`}
        aria-describedby={describedBy}
        preserveAspectRatio="xMidYMid meet"
      >
        <rect className={styles.plot} x={CHART.left} y={CHART.top} width={CHART.width - CHART.left - CHART.right} height={CHART.plotBottom - CHART.top} />
        {gapIntervals(items).map((g) => {
          const x0 = x(Math.max(g.from, lo));
          const x1 = x(g.to);
          return <rect key={g.id} className={styles.gap} x={Math.min(x0, x1)} y={CHART.top} width={Math.max(1, Math.abs(x1 - x0))} height={CHART.plotBottom - CHART.top} />;
        })}
        {threshold && y !== null && position(threshold.value) !== null && (
          <line className={styles.threshold} x1={CHART.left} x2={CHART.width - CHART.right} y1={y(position(threshold.value)!)} y2={y(position(threshold.value)!)} />
        )}
        {selectedT !== null && <line className={styles.selection} x1={x(selectedT)} x2={x(selectedT)} y1={CHART.top} y2={CHART.rugY + 6} />}
        {span &&
          (["live", "synthetic"] as const).map((source) => (
            <path
              key={`span-${source}`}
              className={`${styles.span} ${source === "synthetic" ? styles.hollow : ""}`}
              d={segments(
                usable
                  .filter((i) => i.sourceType === source)
                  .flatMap((i) => {
                    const a = point(i, span.from(i));
                    const b = point(i, span.to(i));
                    return a && b ? [{ x: a.x, y0: a.y, y1: b.y }] : [];
                  }),
              )}
            />
          ))}
        {series.map((s) =>
          (["live", "synthetic"] as const).map((source) => (
            <path
              key={`${s.key}-${source}`}
              className={`${styles.mark} ${styles[s.tone]} ${source === "synthetic" ? styles.hollow : ""} ${s.shape === "tick" ? styles.stroke : ""}`}
              d={marks(
                usable.filter((i) => i.sourceType === source).flatMap((i) => point(i, s.value(i)) ?? []),
                s.shape,
              )}
            />
          )),
        )}
        <path
          className={styles.rug}
          d={marks(
            items.filter((i) => !isUsable(i)).flatMap((i) => {
              const t = timeOf(i.availableAt);
              return t === null ? [] : [{ x: x(t), y: CHART.rugY }];
            }),
            "cross",
            3,
          )}
        />
        <rect className={styles.hit} x={0} y={0} width={CHART.width} height={CHART.height} onClick={onClick}>
          <title>Select the nearest observation</title>
        </rect>
      </svg>
      <div className={styles.axis} aria-hidden="true">
        <span>{items.length > 0 ? formatTimestamp(items[0]!.availableAt) : ""}</span>
        <span>{items.length > 1 ? formatTimestamp(items.at(-1)!.availableAt) : ""}</span>
      </div>
      <ul className={styles.legend} aria-label={`${title} legend`}>
        {series.map((s) => (
          <li key={s.key}>
            <Swatch shape={s.shape} tone={s.tone} /> {s.label}
          </li>
        ))}
        {span && (
          <li>
            <svg className={styles.swatch} viewBox="0 0 12 12" aria-hidden="true">
              <path className={styles.span} d="M6 1V11" />
            </svg>{" "}
            Bid to ask of one observation
          </li>
        )}
        <li>
          <Swatch shape="dot" tone="mid" hollow /> Synthetic observation
        </li>
        <li>
          <svg className={styles.swatch} viewBox="0 0 12 12" aria-hidden="true">
            <path className={styles.rug} d={marks([{ x: 6, y: 6 }], "cross", 3)} />
          </svg>{" "}
          Not usable (below the plot)
        </li>
        <li>
          <span className={styles.gapSwatch} aria-hidden="true" /> No observations: irregular gap
        </li>
      </ul>
      {note && <p className={styles.note}>{note}</p>}
    </figure>
  );
}

function Swatch({ shape, tone, hollow = false }: { shape: Shape; tone: Series["tone"]; hollow?: boolean }) {
  return (
    <svg className={styles.swatch} viewBox="0 0 12 12" aria-hidden="true">
      <path className={`${styles.mark} ${styles[tone]} ${hollow ? styles.hollow : ""} ${shape === "tick" ? styles.stroke : ""}`} d={marks([{ x: 6, y: 6 }], shape, 3.5)} />
    </svg>
  );
}

const m = (pick: (metrics: NonNullable<HistoryItem["metrics"]>) => string | null): Value => (i) => (i.metrics === null ? null : pick(i.metrics));

export interface HistoryChartsProps {
  /** The series as the server sends it: newest first. */
  items: readonly HistoryItem[];
  spreadThreshold: string;
  selectedId: number | null;
  onSelect: (observationId: number) => void;
}

/** Price, spread and depth of the reference outcome over the plotted observations. */
export function HistoryCharts({ items: newestFirst, spreadThreshold, selectedId, onSelect }: HistoryChartsProps) {
  const items = [...newestFirst].reverse();
  const reference = referenceLabels(items);
  const outcome = reference.length === 1 ? `reference outcome: ${reference[0]}` : reference.length === 0 ? "reference outcome" : `reference outcomes: ${reference.join(", ")}`;
  const band = depthBandOf(items);
  const shares = (v: string) => groupDigits(v);
  const depthSeries: Series[] = [
    { key: "bidDepth", label: "Total bid depth", shape: "dot", value: m((x) => x.bidDepth), tone: "bid" },
    { key: "askDepth", label: "Total ask depth", shape: "square", value: m((x) => x.askDepth), tone: "ask" },
    ...(band.band === null
      ? []
      : ([
          { key: "bidBand", label: `Bid depth within ${band.band} of best`, shape: "diamond", value: m((x) => x.bidBandDepth), tone: "mid" },
          { key: "askBand", label: `Ask depth within ${band.band} of best`, shape: "tick", value: m((x) => x.askBandDepth), tone: "spread" },
        ] satisfies Series[])),
  ];
  const bandNote =
    band.band !== null
      ? ""
      : band.bands.length > 1
        ? ` Band depth is not charted: these observations used different depth bands (${band.bands.join(", ")}), so their band depths are not comparable.`
        : "";
  return (
    <section className={styles.charts} aria-label="Charts">
      <TimeChart
        id="chart-price"
        title={`Best bid and ask, with midpoint (${outcome})`}
        items={items}
        series={[
          { key: "bid", label: "Best bid", shape: "tick", value: m((x) => x.bestBid), tone: "bid" },
          { key: "ask", label: "Best ask", shape: "tick", value: m((x) => x.bestAsk), tone: "ask" },
          { key: "mid", label: "Midpoint", shape: "dot", value: m((x) => x.midpoint), tone: "mid" },
        ]}
        span={{ from: m((x) => x.bestBid), to: m((x) => x.bestAsk) }}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <TimeChart
        id="chart-spread"
        title={`Spread (${outcome})`}
        items={items}
        series={[{ key: "spread", label: "Spread", shape: "dot", value: m((x) => x.spread), tone: "spread" }]}
        threshold={{ value: spreadThreshold, label: "Dashed line: threshold" }}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <TimeChart
        id="chart-depth"
        title={`Resting depth in shares (${outcome})`}
        items={items}
        series={depthSeries}
        format={shares}
        selectedId={selectedId}
        onSelect={onSelect}
        note={`Depth is the size resting in the book at each observation instant: not executable liquidity, and not a promise that an order would fill.${bandNote}`}
      />
    </section>
  );
}
