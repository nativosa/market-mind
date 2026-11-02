import type { z } from "zod";
import { InspectOutput, MarketsOutput, WebErrorOutput, WebStatusOutput } from "../../src/research/contracts";

// The browser's only network access: same-origin GETs to /api, every response checked against the
// server's own Zod contracts before anything is shown. Nothing is retried automatically.

export type Version = "v1" | "v2";
export type Markets = MarketsOutput;
export type MarketItem = MarketsOutput["markets"]["items"][number];
export type Status = WebStatusOutput;
export type Inspection = InspectOutput;
export type ServerError = WebErrorOutput["error"];

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
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const issuesOf = (error: z.ZodError) => error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "response"}: ${i.message}`);

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
  };
}
