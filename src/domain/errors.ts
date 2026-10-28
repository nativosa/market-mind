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
  | "InvalidBook";

export interface ErrorDetails {
  url?: string;
  status?: number;
  attempts?: number;
  timing?: RequestTiming;
  issues?: string[];
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
