import type { RequestTiming } from "./provenance.js";

export type ErrorKind =
  | "Usage"
  | "Timeout"
  | "Network"
  | "RateLimited"
  | "Upstream5xx"
  | "HttpStatus"
  | "NotFound"
  | "Validation"
  | "Ineligible"
  | "AssociationMismatch"
  | "InvalidBook"
  /** The scan was stopped: deadline, user cancellation or rate-limit circuit. */
  | "Cancelled"
  /** The request budget refused a request's first attempt; nothing was sent. */
  | "BudgetExceeded";

export interface ErrorDetails {
  url?: string;
  status?: number;
  attempts?: number;
  timing?: RequestTiming;
  issues?: string[];
  /** On a real failure (e.g. Upstream5xx): a retry was refused because the request budget was exhausted. */
  budgetExhausted?: boolean;
}

export class MarketMindError extends Error {
  readonly kind: ErrorKind;
  readonly details: ErrorDetails;

  constructor(kind: ErrorKind, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "MarketMindError";
    this.kind = kind;
    this.details = details;
  }
}

export function isMarketMindError(value: unknown): value is MarketMindError {
  return value instanceof MarketMindError;
}
