import type { z } from "zod";
import {
  DetailsOutput,
  InspectOutput,
  MarketsOutput,
  MCP_LIMITS,
  StoredMarketsOutput,
  WebErrorOutput,
  WebHistoryOutput,
  WebRunsOutput,
  WebStatusOutput,
  type Source,
} from "../../src/research/contracts";

// The browser's only network access: same-origin GETs to /api, every response checked against the
// server's own Zod contracts before anything is shown. Nothing is retried automatically.

export type Version = "v1" | "v2";
export type Markets = MarketsOutput;
export type MarketItem = MarketsOutput["markets"]["items"][number];
export type Status = WebStatusOutput;
export type Inspection = InspectOutput;
export type ServerError = WebErrorOutput["error"];
export type StoredMarkets = StoredMarketsOutput;
export type StoredMarket = StoredMarketsOutput["markets"]["items"][number];
export type Runs = WebRunsOutput;
export type Run = WebRunsOutput["runs"]["items"][number];
export type History = WebHistoryOutput;
export type HistoryItem = WebHistoryOutput["series"]["items"][number];
export type ObservationDetails = DetailsOutput;
export type { Source };

/** Stored observations always ask for the most captured levels the API returns. */
export const DETAILS_LEVELS = MCP_LIMITS.details.levels.max;

export type ApiError =
  /** The server answered with its structured error contract. */
  | { kind: "server"; httpStatus: number; error: ServerError; receivedAt: number }
  /** No answer at all: the local server is not running or the connection broke. */
  | { kind: "network" }
  /** An answer that does not match the contract (it is never shown). */
  | { kind: "invalid_response"; httpStatus: number; issues: string[] }
  /** Superseded by a newer request; callers ignore it. */
  | { kind: "aborted" };

export type ApiResult<T> = { ok: true; data: T; receivedAt: number } | { ok: false; error: ApiError };

export interface ApiClient {
  status(signal?: AbortSignal): Promise<ApiResult<Status>>;
  markets(query: { version: Version; cursor?: string | null }, signal?: AbortSignal): Promise<ApiResult<Markets>>;
  /** For the detail view (Commit 5); unused by the explorer list. */
  inspect(marketId: string, query: { levels?: number }, signal?: AbortSignal): Promise<ApiResult<Inspection>>;
  // Stored History (Stage 3.2): offline reads of the local database. `source` omitted: the server's default.
  storedMarkets(query: { source?: Source | null; limit?: number; offset?: number }, signal?: AbortSignal): Promise<ApiResult<StoredMarkets>>;
  storedRuns(query: { source?: Source | null; limit?: number }, signal?: AbortSignal): Promise<ApiResult<Runs>>;
  history(marketId: string, query: { source?: Source | null }, signal?: AbortSignal): Promise<ApiResult<History>>;
  observation(observationId: number, query: { source?: Source | null; levels?: number }, signal?: AbortSignal): Promise<ApiResult<ObservationDetails>>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const issuesOf = (error: z.ZodError) => error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "response"}: ${i.message}`);

/** "?a=1&b=2" from the defined values, or "" when there are none. */
function queryString(values: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) query.set(key, String(value));
  return query.size > 0 ? `?${query.toString()}` : "";
}

export function createApiClient(fetchFn: FetchLike = (input, init) => fetch(input, init), now: () => number = Date.now): ApiClient {
  async function get<S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal): Promise<ApiResult<z.infer<S>>> {
    let response: Response;
    try {
      response = await fetchFn(path, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
    } catch {
      return { ok: false, error: signal?.aborted ? { kind: "aborted" } : { kind: "network" } };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (signal?.aborted) return { ok: false, error: { kind: "aborted" } };
      return { ok: false, error: { kind: "invalid_response", httpStatus: response.status, issues: ["the response is not JSON"] } };
    }
    if (signal?.aborted) return { ok: false, error: { kind: "aborted" } };
    const receivedAt = now();
    if (response.ok) {
      const parsed = schema.safeParse(body);
      return parsed.success
        ? { ok: true, data: parsed.data, receivedAt }
        : { ok: false, error: { kind: "invalid_response", httpStatus: response.status, issues: issuesOf(parsed.error) } };
    }
    const failure = WebErrorOutput.safeParse(body);
    return failure.success
      ? { ok: false, error: { kind: "server", httpStatus: response.status, error: failure.data.error, receivedAt } }
      : { ok: false, error: { kind: "invalid_response", httpStatus: response.status, issues: issuesOf(failure.error) } };
  }

  return {
    status: (signal) => get("/api/status", WebStatusOutput, signal),
    markets: ({ version, cursor }, signal) => {
      const query = new URLSearchParams({ version });
      if (cursor) query.set("cursor", cursor);
      return get(`/api/markets?${query.toString()}`, MarketsOutput, signal);
    },
    inspect: (marketId, { levels }, signal) => {
      const query = new URLSearchParams();
      if (levels !== undefined) query.set("levels", String(levels));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return get(`/api/markets/${encodeURIComponent(marketId)}/inspect${suffix}`, InspectOutput, signal);
    },
    storedMarkets: ({ source, limit, offset }, signal) => get(`/api/stored/markets${queryString({ source, limit, offset })}`, StoredMarketsOutput, signal),
    storedRuns: ({ source, limit }, signal) => get(`/api/stored/runs${queryString({ source, limit })}`, WebRunsOutput, signal),
    history: (marketId, { source }, signal) => get(`/api/stored/markets/${encodeURIComponent(marketId)}/history${queryString({ source })}`, WebHistoryOutput, signal),
    observation: (observationId, { source, levels }, signal) =>
      get(`/api/stored/observations/${encodeURIComponent(String(observationId))}${queryString({ source, levels })}`, DetailsOutput, signal),
  };
}
