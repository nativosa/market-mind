import { MarketMindError, type ErrorKind } from "../../domain/errors.js";
import type { DataSource, Provenance, RequestTiming } from "../../domain/provenance.js";

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpDeps {
  fetch: FetchFn;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export interface HttpOptions {
  timeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxRetryAfterMs: number;
  userAgent: string;
}

export interface JsonResponse {
  body: unknown;
  provenance: Provenance;
}

export interface HttpClient {
  /** Read-only GET returning parsed JSON. The only network entry point in the codebase. */
  getJson(source: DataSource, endpoint: string, url: string): Promise<JsonResponse>;
}

export const realHttpDeps: HttpDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

interface AttemptFailure {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}

export function createHttpClient(options: HttpOptions, deps: HttpDeps): HttpClient {
  return {
    async getJson(source, endpoint, url) {
      const maxAttempts = 1 + options.maxRetries;
      let firstAttemptStartedAt: Date | null = null;
      let failure: AttemptFailure | null = null;
      let timing: RequestTiming | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const startedAt = deps.now();
        firstAttemptStartedAt ??= startedAt;
        const stamp = (receivedAt: Date, response: Response | null): RequestTiming => ({
          firstAttemptStartedAt: firstAttemptStartedAt!.toISOString(),
          finalAttemptStartedAt: startedAt.toISOString(),
          responseReceivedAt: receivedAt.toISOString(),
          durationMs: receivedAt.getTime() - startedAt.getTime(),
          attempts: attempt,
          serverDateHeader: response?.headers.get("date") ?? null,
        });

        let response: Response;
        let text: string;
        try {
          response = await deps.fetch(url, {
            method: "GET",
            headers: { accept: "application/json", "user-agent": options.userAgent },
            signal: AbortSignal.timeout(options.timeoutMs),
          });
          text = await response.text();
        } catch (error) {
          timing = stamp(deps.now(), null);
          failure = isTimeout(error)
            ? { kind: "Timeout", message: `Request timed out after ${options.timeoutMs} ms`, retryable: true }
            : { kind: "Network", message: `Network error: ${describe(error)}`, retryable: true };
          if (attempt < maxAttempts) await deps.sleep(backoff(options, attempt));
          continue;
        }

        timing = stamp(deps.now(), response);
        if (response.ok) {
          const provenance: Provenance = { source, endpoint, url, httpStatus: response.status, timing };
          try {
            return { body: JSON.parse(text) as unknown, provenance };
          } catch {
            throw new MarketMindError("Validation", `Response from ${endpoint} is not valid JSON`, {
              url,
              status: response.status,
              attempts: attempt,
              timing,
            });
          }
        }

        failure = classifyStatus(response, text, options);
        if (!failure.retryable || attempt === maxAttempts) break;
        await deps.sleep(failure.retryAfterMs ?? backoff(options, attempt));
      }

      const f = failure!;
      throw new MarketMindError(f.kind, f.message, {
        url,
        ...(f.status !== undefined ? { status: f.status } : {}),
        attempts: timing!.attempts,
        timing: timing!,
      });
    },
  };
}

function classifyStatus(response: Response, text: string, options: HttpOptions): AttemptFailure {
  const status = response.status;
  const detail = upstreamMessage(text);
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), options.maxRetryAfterMs);
    return {
      kind: "RateLimited",
      message: `Rate limited (HTTP 429)${detail}`,
      retryable: true,
      status,
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    };
  }
  if (status >= 500) return { kind: "Upstream5xx", message: `Upstream error (HTTP ${status})${detail}`, retryable: true, status };
  if (status === 404) return { kind: "NotFound", message: `Not found (HTTP 404)${detail}`, retryable: false, status };
  return { kind: "HttpStatus", message: `Unexpected HTTP ${status}${detail}`, retryable: false, status };
}

/** Retry-After in seconds (delta form only), capped. Returns null if absent or unparseable. */
export function parseRetryAfter(header: string | null, capMs: number): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  return Math.min(Number(header.trim()) * 1000, capMs);
}

function backoff(options: HttpOptions, attempt: number): number {
  return options.baseBackoffMs * 2 ** (attempt - 1);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function upstreamMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return `: ${parsed.error}`;
    }
  } catch {
    // Non-JSON error body: fall through.
  }
  const trimmed = text.trim().slice(0, 200);
  return trimmed ? `: ${trimmed}` : "";
}
