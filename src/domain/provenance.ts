export type DataSource = "gamma" | "clob";

/** Timing of one HTTP exchange. Never shared between requests. All instants are ISO-8601 (local clock). */
export interface RequestTiming {
  firstAttemptStartedAt: string;
  finalAttemptStartedAt: string;
  /** Response headers and body fully read for the final attempt. */
  responseReceivedAt: string;
  /** Duration of the final attempt only. */
  durationMs: number;
  attempts: number;
  /** Raw HTTP `Date` response header, if the server sent one. */
  serverDateHeader: string | null;
}

export interface Provenance {
  source: DataSource;
  /** Logical endpoint, e.g. "/book". */
  endpoint: string;
  url: string;
  httpStatus: number;
  timing: RequestTiming;
}

/** Timestamp reported inside a response body (e.g. CLOB /book `timestamp`). */
export interface ServerTimestamp {
  raw: string | null;
  epochMs: number | null;
  iso: string | null;
}
