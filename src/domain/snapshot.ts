import type { Decimal } from "./decimal.js";
import type { Market, Outcome, ProtocolVersion } from "./market.js";
import type { BookQuality, BookState } from "./orderbook.js";
import type { DataSource, RequestTiming } from "./provenance.js";
import type { Bucket, OutcomeObservation, Reason, ScanMetrics, ScanWarning } from "./scan.js";

export type SourceType = "live" | "synthetic";
export type RunStatus = "running" | "complete" | "partial" | "interrupted" | "failed";
/** verified: selected = persisted + failures was checked at finalization. incomplete: recovered run, totals unknown. */
export type AccountingStatus = "pending" | "verified" | "incomplete";
export type Pairing = "paired" | "incomplete" | "none";
export type AssociationStatus = "confirmed" | "mismatch" | "failed" | "not_attempted";
/** Which evidence determines when an observation became fully available. */
export type AvailabilityBasis = "paired_books" | "single_book" | "association" | "discovery";

/** One HTTP exchange used as evidence for an observation. */
export interface RequestEvidence {
  scope: string;
  source: DataSource;
  endpoint: string;
  url: string;
  httpStatus: number | null;
  attempts: number;
  timing: RequestTiming | null;
  errorKind: string | null;
}

/** Everything persisted for one selected market in one run. */
export interface ObservationRecord {
  market: Market;
  /** Outcome identities (index order); empty only if they could not be derived. */
  outcomes: Outcome[];
  discoveryPosition: number;
  bucket: Bucket;
  reasons: Reason[];
  warnings: ScanWarning[];
  association: AssociationStatus;
  /** Schema-valid books actually received (0-2), including books whose sibling request failed. */
  books: OutcomeObservation[];
  metrics: ScanMetrics | null;
  depthBand: Decimal | null;
  /** Requests for this market plus its discovery page. */
  requests: RequestEvidence[];
}

export interface Availability {
  availableAt: string;
  availableAtMs: number;
  basis: AvailabilityBasis;
}

export function pairingOf(books: readonly OutcomeObservation[]): Pairing {
  return books.length >= 2 ? "paired" : books.length === 1 ? "incomplete" : "none";
}

/**
 * When the observation's evidence was complete: the latest successful response it depends on.
 * Books dominate; without books, the association response; without that, the discovery page.
 * Never invented: a record without any timed successful response has no availability.
 */
export function availabilityOf(record: ObservationRecord): Availability | null {
  const latest = (times: readonly string[]): string | null =>
    times.length === 0 ? null : times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  const ok = record.requests.filter((r) => r.errorKind === null && r.timing !== null);
  const all = ok.map((r) => r.timing!.responseReceivedAt);
  const bookTimes = record.books.map((b) => b.book.provenance.timing.responseReceivedAt);
  let basis: AvailabilityBasis;
  if (record.books.length >= 2) basis = "paired_books";
  else if (record.books.length === 1) basis = "single_book";
  else if (ok.some((r) => r.endpoint === "/clob-markets/{condition_id}")) basis = "association";
  else basis = "discovery";
  const at = latest([...all, ...bookTimes]);
  return at === null ? null : { availableAt: at, availableAtMs: Date.parse(at), basis };
}

// ---- History (read side) ----

export interface StoredBookSummary {
  outcomeIndex: number;
  label: string;
  quality: BookQuality;
  contentHash: string;
  responseReceivedAt: string;
  serverTimestampIso: string | null;
}

export interface StoredMetrics {
  analyticsVersion: number;
  referenceIndex: number;
  bestBid: Decimal | null;
  bestAsk: Decimal | null;
  spread: Decimal | null;
  midpoint: Decimal | null;
  topSize: Decimal | null;
  state: BookState | null;
  quality: BookQuality;
  pairSkewMs: number;
}

/** One stored market observation as seen by history queries. */
export interface HistoryPoint {
  observationId: number;
  runId: string;
  runStatus: RunStatus;
  sourceType: SourceType;
  availableAt: string;
  availableAtMs: number;
  availabilityBasis: AvailabilityBasis;
  pairing: Pairing;
  association: AssociationStatus;
  bucket: Bucket;
  reasonCodes: string[];
  question: string;
  outcomeLabels: string[];
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean | null;
  endDate: string | null;
  books: StoredBookSummary[];
  metrics: StoredMetrics | null;
}

export interface RunRecord {
  runId: string;
  sourceType: SourceType;
  status: RunStatus;
  accounting: AccountingStatus;
  startedAt: string;
  finishedAt: string | null;
  ownerPid: number;
  ownerHost: string;
  heartbeatAt: string;
  heartbeatMs: number;
  appVersion: string;
  buildId: string | null;
  schemaVersion: number;
  analyticsVersion: number;
  nodeVersion: string;
  sqliteVersion: string;
  protocolVersion: ProtocolVersion;
  stopReasons: string[] | null;
  scanCounts: Record<string, unknown> | null;
  persistCounts: Record<string, unknown> | null;
  budgetLimit: number;
  budgetUsed: number | null;
  windowFirst: string | null;
  windowLast: string | null;
  error: Record<string, unknown> | null;
  recoveredReason: string | null;
}
