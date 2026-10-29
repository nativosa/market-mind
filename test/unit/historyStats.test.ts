import { describe, expect, it } from "vitest";
import { annotateRows, computeHistoryStats, notUsableReason } from "../../src/analytics/history.js";
import { decimal, decimalToString, type Decimal } from "../../src/domain/decimal.js";
import { availabilityOf, type HistoryPoint } from "../../src/domain/snapshot.js";
import { evidence, iso, record, T0 } from "../storageFixtures.js";

let nextId = 1;
function point(spec: {
  at: number;
  spread?: string | null;
  topSize?: string | null;
  pairing?: HistoryPoint["pairing"];
  metrics?: boolean;
  quality?: "valid" | "invalid";
  state?: "two-sided" | "bid-only";
  hashes?: [string, string];
  labels?: [string, string];
  question?: string;
  acceptingOrders?: boolean;
  endDate?: string | null;
}): HistoryPoint {
  const spread = spec.spread === undefined ? "0.05" : spec.spread;
  const topSize = spec.topSize === undefined ? "100" : spec.topSize;
  const labels = spec.labels ?? ["Yes", "No"];
  const hashes = spec.hashes ?? [`h${nextId}a`, `h${nextId}b`];
  return {
    observationId: nextId++,
    runId: "r",
    runStatus: "complete",
    sourceType: "live",
    availableAt: iso(spec.at),
    availableAtMs: T0 + spec.at,
    availabilityBasis: "paired_books",
    pairing: spec.pairing ?? "paired",
    association: "confirmed",
    bucket: "ranked",
    reasonCodes: [],
    question: spec.question ?? "Q?",
    outcomeLabels: labels,
    active: true,
    closed: false,
    acceptingOrders: spec.acceptingOrders ?? true,
    endDate: spec.endDate ?? null,
    books: labels.map((label, i) => ({
      outcomeIndex: i,
      label,
      quality: i === 1 && spec.quality === "invalid" ? "invalid" : "valid",
      contentHash: hashes[i]!,
      responseReceivedAt: iso(spec.at),
      serverTimestampIso: null,
    })),
    metrics:
      spec.metrics === false
        ? null
        : {
            analyticsVersion: 1,
            referenceIndex: 0,
            bestBid: decimal("0.4"),
            bestAsk: decimal("0.45"),
            spread: spread === null ? null : decimal(spread),
            midpoint: decimal("0.425"),
            topSize: topSize === null ? null : decimal(topSize),
            state: spec.state ?? "two-sided",
            quality: "valid",
            pairSkewMs: 0,
          },
  };
}

const s = (d: Decimal | null) => (d === null ? null : decimalToString(d));
const T = decimal("0.02");

describe("computeHistoryStats", () => {
  it("odd series: exact min / median / max, current, previous and change", () => {
    const pts = [point({ at: 0, spread: "0.03" }), point({ at: 60_000, spread: "0.01" }), point({ at: 120_000, spread: "0.02", topSize: "150" })];
    const st = computeHistoryStats(pts, T);
    expect(st.usable).toBe(3);
    expect([s(st.spread.min), s(st.spread.median), s(st.spread.max)]).toEqual(["0.01", "0.02", "0.03"]);
    expect([s(st.spread.current), s(st.spread.previous), s(st.spread.change)]).toEqual(["0.02", "0.01", "0.01"]);
    expect([st.topSize.n, s(st.topSize.current), s(st.topSize.previous), s(st.topSize.change)]).toEqual([2, "150", "100", "50"]);
    expect([st.firstUsableAt, st.lastUsableAt]).toEqual([iso(0), iso(120_000)]);
  });

  it("even series: median is the exact average of the two middle values; change can be negative", () => {
    const pts = ["0.04", "0.01", "0.03", "0.02"].map((spread, i) => point({ at: i * 1000, spread }));
    const st = computeHistoryStats(pts, T);
    expect(s(st.spread.median)).toBe("0.025");
    expect(s(st.spread.change)).toBe("-0.01");
  });

  it("threshold share counts samples (inclusive) and rounds half-even to 2 dp", () => {
    const pts = ["0.02", "0.01", "0.05"].map((spread, i) => point({ at: i, spread }));
    const st = computeHistoryStats(pts, T);
    expect(st.threshold).toMatchObject({ n: 3, atOrAbove: 2 });
    expect(s(st.threshold.percentOfSamples)).toBe("66.67");
  });

  it("gaps: min / median / max and irregular count", () => {
    const at = [0, 60_000, 120_000, 180_000, 600_000];
    const st = computeHistoryStats(at.map((a) => point({ at: a })), T);
    expect(st.gaps).toEqual({ n: 4, minMs: 60_000, medianMs: 60_000, maxMs: 420_000, irregular: 1 });
  });

  it("distinct book states ignore repeated identical contents", () => {
    const same: [string, string] = ["A", "B"];
    const pts = [point({ at: 0, hashes: same }), point({ at: 1, hashes: same }), point({ at: 2, hashes: ["A", "C"] }), point({ at: 3, hashes: same })];
    expect(computeHistoryStats(pts, T).states).toEqual({ n: 4, distinct: 3 });
  });

  it("no usable samples: nulls, never zeros", () => {
    const st = computeHistoryStats([point({ at: 0, pairing: "incomplete" })], T);
    expect(st.usable).toBe(0);
    expect([st.spread.min, st.spread.median, st.spread.current, st.spread.change, st.threshold.percentOfSamples, st.gaps.medianMs]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(st.topSize.n).toBe(0);
  });

  it("one usable sample: current only, no previous or change", () => {
    const st = computeHistoryStats([point({ at: 0, spread: "0.07" })], T);
    expect([s(st.spread.current), st.spread.previous, st.spread.change, st.topSize.n, st.gaps.n]).toEqual(["0.07", null, null, 1, 0]);
  });

  it("excludes but counts every kind of unusable observation", () => {
    const pts = [
      point({ at: 0 }),
      point({ at: 1, pairing: "incomplete", metrics: false }),
      point({ at: 2, pairing: "none", metrics: false }),
      point({ at: 3, quality: "invalid", metrics: false }),
      point({ at: 4, metrics: false }),
      point({ at: 5, state: "bid-only", spread: null, topSize: null }),
      point({ at: 6, spread: "0.09" }),
    ];
    const st = computeHistoryStats(pts, T);
    expect(st.eligible).toBe(7);
    expect(st.usable).toBe(2);
    expect(st.notUsable).toEqual({ NOT_PAIRED: 2, INVALID_BOOK: 1, NO_METRICS_FOR_VERSION: 1, NOT_TWO_SIDED: 1 });
    expect(s(st.spread.previous)).toBe("0.05");
    expect(s(st.spread.current)).toBe("0.09");
  });
});

describe("annotateRows", () => {
  it("flags unchanged contents, gaps since the previous usable sample, and metadata changes", () => {
    const a = point({ at: 0, hashes: ["A", "B"] });
    const b = point({ at: 60_000, hashes: ["A", "B"], labels: ["Yes!", "No"], question: "Q2?" });
    const c = point({ at: 90_000, pairing: "incomplete", metrics: false, acceptingOrders: false, labels: ["Yes!", "No"], question: "Q2?" });
    const d = point({ at: 180_000, hashes: ["A", "X"], endDate: "2027-01-01T00:00:00Z", acceptingOrders: false, labels: ["Yes!", "No"], question: "Q2?" });
    const flags = annotateRows([a, b, c, d]);
    expect(flags.get(a.observationId)).toEqual({ notUsable: null, unchanged: null, gapMs: null, changes: [] });
    expect(flags.get(b.observationId)).toEqual({ notUsable: null, unchanged: true, gapMs: 60_000, changes: ["LABEL_CHANGED", "QUESTION_CHANGED"] });
    expect(flags.get(c.observationId)).toEqual({ notUsable: "NOT_PAIRED", unchanged: null, gapMs: null, changes: ["STATUS_CHANGED"] });
    expect(flags.get(d.observationId)).toEqual({ notUsable: null, unchanged: false, gapMs: 120_000, changes: ["END_DATE_CHANGED"] });
  });

  it("detects a stored book label change even when Gamma labels match", () => {
    const a = point({ at: 0 });
    const b = point({ at: 1 });
    b.books[1] = { ...b.books[1]!, label: "Nope" };
    expect(annotateRows([a, b]).get(b.observationId)!.changes).toEqual(["LABEL_CHANGED"]);
  });

  it("notUsableReason", () => {
    expect(notUsableReason(point({ at: 0 }))).toBeNull();
    expect(notUsableReason(point({ at: 0, spread: null }))).toBe("NOT_TWO_SIDED");
  });
});

describe("availabilityOf (evidence availability)", () => {
  it("paired: the later of the two books, even when the reference book arrived first", () => {
    const a = availabilityOf(record({ receivedAt: [100, 900] }))!;
    expect(a).toEqual({ availableAt: iso(900), availableAtMs: T0 + 900, basis: "paired_books" });
    const b = availabilityOf(record({ receivedAt: [900, 100] }))!;
    expect(b.availableAt).toBe(iso(900));
  });

  it("ignores failed requests and responses without timing", () => {
    const rec = record({ other: null, receivedAt: [100, 0], requests: [evidence("x", "/book", 5_000, "Timeout"), evidence("y", "/book", null)] });
    expect(availabilityOf(rec)).toMatchObject({ availableAt: iso(100), basis: "single_book" });
  });

  it("falls back to association, then discovery, with an explicit basis", () => {
    const assoc = record({ ref: null, other: null });
    expect(availabilityOf(assoc)).toMatchObject({ availableAt: iso(50), basis: "association" });
    const disc = { ...assoc, requests: assoc.requests.filter((r) => r.endpoint === "/markets/keyset") };
    expect(availabilityOf(disc)).toMatchObject({ availableAt: iso(0), basis: "discovery" });
  });
});
