import type { ApiError } from "./api";

// Pure display transforms. Decimal values arrive as exact strings and are only regrouped, never
// converted to numbers; a missing value is shown as unknown, never as zero or false.

export const NOT_REPORTED = "Not reported";
export const STALE_AFTER_MS = 2 * 60_000;

/** Insert thousands separators into a plain decimal string without changing a single digit. */
export function groupDigits(value: string): string {
  const m = /^(\d+)(\.\d+)?$/.exec(value);
  if (!m) return value;
  return m[1]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (m[2] ?? "");
}

/** Gamma's reported 24h traded volume: an ordering signal, not liquidity. */
export const formatVolume = (value: string | null): string => (value === null ? NOT_REPORTED : groupDigits(value));

/** The calendar date of an ISO timestamp (UTC), or the raw text if it is not ISO-like. */
export function formatDate(value: string | null): string {
  if (value === null) return NOT_REPORTED;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1]! : value;
}

export const formatFlag = (value: boolean | null, yes = "Yes", no = "No"): string => (value === null ? NOT_REPORTED : value ? yes : no);

export const formatCount = (n: number): string => groupDigits(String(n));

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.ceil(s / 60);
  return min < 60 ? `${min} min` : `${Math.ceil(min / 60)} h`;
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const min = Math.floor(s / 60);
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}

export const isStale = (fetchedAt: number | null, now: number): boolean => fetchedAt !== null && now - fetchedAt > STALE_AFTER_MS;

export interface ErrorView {
  title: string;
  detail: string;
  /** Milliseconds left before a retry can help, when the server said so. */
  retryInMs: number | null;
  /** Whether trying again (explicitly) can help at all. */
  retryable: boolean;
}

/** Plain-language copy for every failure class the API distinguishes. */
export function describeApiError(error: ApiError, now: number): ErrorView {
  switch (error.kind) {
    case "aborted":
      return { title: "Request cancelled", detail: "A newer request replaced it.", retryInMs: null, retryable: true };
    case "network":
      return {
        title: "Cannot reach the MarketMind server",
        detail: "The local API did not answer. Check that the server is running (npm run web), then try again.",
        retryInMs: null,
        retryable: true,
      };
    case "invalid_response":
      return {
        title: "Unexpected response",
        detail: "The server's answer did not match the expected format, so it is not shown.",
        retryInMs: null,
        retryable: true,
      };
    case "server":
      break;
  }
  const e = error.error;
  const after = e.details.retryAfterMs;
  const retryInMs = typeof after === "number" ? Math.max(0, error.receivedAt + after - now) : null;
  const base = { retryInMs, retryable: e.retryable };
  switch (e.category) {
    case "rate_limited":
      return e.code === "LOCAL_COOLDOWN"
        ? { ...base, title: "Pausing after a Polymarket rate limit", detail: "Polymarket rate-limited an earlier request, so the server is holding back all requests for a while." }
        : { ...base, title: "Polymarket rate-limited the request", detail: "The server now pauses all requests to Polymarket for a minute." };
    case "budget_exhausted":
      return e.code === "WINDOW_BUDGET_EXHAUSTED"
        ? { ...base, title: "Request budget for the last 5 minutes is used up", detail: "The server limits how many requests it sends to Polymarket in any five minutes." }
        : { ...base, title: "This server's request budget is used up", detail: "The server's lifetime request limit is spent. Restart the MarketMind web server to reset it." };
    case "upstream_unavailable":
      return e.details.kind === "Timeout"
        ? { ...base, title: "Polymarket did not answer in time", detail: "The request timed out after its retry." }
        : { ...base, title: "Polymarket is unavailable", detail: "Polymarket answered with an error after its retry." };
    case "upstream_invalid_data":
      return { ...base, title: "Polymarket returned unusable data", detail: "The response failed validation, so it is not shown." };
    case "deadline_exceeded":
      return { ...base, title: "The request took too long", detail: "It exceeded the server's deadline and was stopped." };
    case "market_not_found":
      return { ...base, title: "Polymarket has no market with this ID", detail: "Gamma did not find it. It may have been removed; refresh the market list." };
    case "market_ineligible":
      return { ...base, title: "This market cannot be inspected", detail: "It is not a binary market with an enabled order book, so no order books were requested." };
    case "invalid_arguments":
      return { ...base, title: "The request was rejected", detail: "The server considered the request invalid." };
    case "forbidden":
      return e.code === "LIVE_DISABLED"
        ? { ...base, title: "Live requests are disabled on this server", detail: "This MarketMind server never contacts Polymarket. Stored History still works." }
        : { ...base, title: "The server refused this page's origin", detail: "Open the explorer at the address the MarketMind server prints (or the dev address that npm run web:dev prints)." };
    case "database_missing":
      return { ...base, title: "No local history database yet", detail: "Stored History reads observations saved by MarketMind's collect command. Run npm run cli -- collect to create them." };
    case "observation_not_found":
      return { ...base, title: "This observation is not available", detail: "No stored observation has this ID under the selected source filter. Synthetic observations appear only with Live + synthetic." };
    case "observation_not_available_as_of":
      return { ...base, title: "This observation was not available yet", detail: "It became available after the time asked for." };
    case "storage_error":
      return e.code === "DATABASE_BUSY"
        ? { ...base, title: "The local database is busy", detail: "Another process (for example a running collect) is holding it. Try again in a moment." }
        : e.code === "SCHEMA_OUTDATED"
          ? { ...base, title: "The local database needs an upgrade", detail: "It was created by an older MarketMind. Running collect once migrates it; this page never changes it." }
          : e.code === "SCHEMA_TOO_NEW"
            ? { ...base, title: "The local database is from a newer MarketMind", detail: "This version cannot read it safely. Update MarketMind to view it." }
            : { ...base, title: "The local database could not be read", detail: "The server reported a storage error. Nothing was changed." };
    case "cancelled":
      return { ...base, title: "The request was cancelled", detail: e.code === "SHUTTING_DOWN" ? "The server is shutting down." : "It was stopped before it finished." };
    default:
      return { ...base, title: "Server error", detail: "The server could not complete the request." };
  }
}
