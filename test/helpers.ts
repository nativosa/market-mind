import { readFileSync } from "node:fs";
import type { FetchFn, HttpDeps, HttpOptions } from "../src/adapters/polymarket/httpClient.js";

export function fixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8")) as unknown;
}

export function fixtureText(path: string): string {
  return readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");
}

export const TEST_HTTP_OPTIONS: HttpOptions = {
  timeoutMs: 1_000,
  maxRetries: 2,
  baseBackoffMs: 100,
  maxRetryAfterMs: 2_000,
  userAgent: "market-mind-test",
};

/** Clock that advances by `stepMs` on every read, starting at a fixed instant. */
export function steppingClock(startIso = "2026-10-28T21:05:12.000Z", stepMs = 10): () => Date {
  let t = Date.parse(startIso);
  return () => {
    const now = new Date(t);
    t += stepMs;
    return now;
  };
}

export type Reply = Response | Error | (() => Response | Error | Promise<Response | Error>);

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", date: "Wed, 28 Oct 2026 21:05:12 GMT", ...headers },
  });
}

export function timeoutError(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/**
 * Fake fetch routed by URL substring (first match wins). Each route may hold a queue of replies,
 * consumed in order; the last reply repeats. Records every call.
 */
export function fakeFetch(routes: Record<string, Reply | Reply[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const entry = [...queues.entries()].find(([k]) => url.includes(k));
    if (!entry) throw new Error(`No fake route for ${url}`);
    const queue = entry[1];
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    const value = typeof reply === "function" ? await reply() : reply;
    if (value instanceof Error) throw value;
    return value.clone();
  };
  return { fetch, calls };
}

export function testDeps(fetch: FetchFn, now = steppingClock()) {
  const sleeps: number[] = [];
  const deps: HttpDeps = {
    fetch,
    now,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  return { deps, sleeps };
}
