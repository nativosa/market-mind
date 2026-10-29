import type { Decimal } from "../domain/decimal.js";
import type { Outcome } from "../domain/market.js";
import type { OrderBook } from "../domain/orderbook.js";
import type { OutcomeObservation, ScanMetrics } from "../domain/scan.js";
import { assessBook } from "./bookQuality.js";
import { computeScanMetrics } from "./scanMetrics.js";

export interface RecomputeInput {
  conditionId: string;
  depthBand: Decimal | null;
  books: { outcome: Outcome; book: OrderBook }[];
}

/**
 * Re-run the current analytics over stored captured books. Deterministic: the same books always
 * yield the same assessments and metrics. Metrics exist only for two non-invalid books, exactly
 * as at collection time.
 */
export function recomputeMetrics(input: RecomputeInput): { observations: OutcomeObservation[]; metrics: ScanMetrics | null } {
  const observations = [...input.books]
    .sort((a, b) => a.outcome.index - b.outcome.index)
    .map(({ outcome, book }) => ({
      outcome,
      book,
      assessment: assessBook(book, { depthBand: input.depthBand, expectedConditionId: input.conditionId }),
    }));
  const valid = observations.length === 2 && observations.every((o) => o.assessment.quality !== "invalid");
  return { observations, metrics: valid ? computeScanMetrics(observations[0]!, observations[1]!) : null };
}
