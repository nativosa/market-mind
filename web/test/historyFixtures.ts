import { closeAllWeb, get, startWeb } from "../../test/webFixtures";
import { cleanupTemp } from "../../test/storageFixtures";
import { createApiClient, type ApiClient, type ApiResult, type FetchLike, type History, type ObservationDetails, type Runs, type StoredMarkets } from "../src/api";
import { NO_STORED_READS, NOW, status } from "./fixtures";

// Stored History fixtures: a real temporary database written through the collect code path, read by
// the real web server over HTTP, so every response a test renders is exactly what the API sends.
// Upstream (Polymarket) URLs the server requests are recorded; history tests expect none.

import { seedHistory } from "../../test/historySeed";
export { EXACT_SIZE, MINUTE, seedEmpty, seedHistory, UNTRUSTED_QUESTION, type Seeded } from "../../test/historySeed";

/** Seeding writes and fsyncs a real database: generous under a loaded parallel suite. */
export const SEED_TIMEOUT_MS = 60_000;

let shared: { path: string; ids: Record<string, number> } | null = null;
/** The history fixture database, written once per test file (cleanupHistory removes it). */
export function sharedHistory() {
  shared ??= seedHistory();
  return shared;
}

export async function cleanupHistory(): Promise<void> {
  shared = null;
  await closeAllWeb();
  cleanupTemp();
}

/** The real web server on `dbPath`, and an ApiClient that reaches it over HTTP (recording each path). */
export async function storedServer(dbPath: string, options: { defaultSource?: "live" | "all" } = {}) {
  const s = await startWeb({ dbPath, ...options });
  const paths: string[] = [];
  const viaHttp: FetchLike = async (url) => {
    paths.push(url);
    const r = await get(s.port, url);
    return new Response(r.text, { status: r.status, headers: { "content-type": String(r.headers["content-type"]) } });
  };
  return { ...s, paths, api: createApiClient(viaHttp, () => NOW) };
}

/** Data of a successful answer (throws otherwise). */
export function ok<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result.error)}`);
  return result.data;
}

export interface Pending {
  method: "storedMarkets" | "storedRuns" | "history" | "observation";
  args: unknown[];
  signal: AbortSignal;
  answer: (result: ApiResult<unknown>) => void;
}

/**
 * An ApiClient whose stored reads stay pending until a test answers them (aborts resolve them as
 * aborted, like the real client). Live reads (markets, inspect) are recorded and never answered:
 * the history tests expect none.
 */
export function pendingApi() {
  const pending: Pending[] = [];
  const live: string[] = [];
  let statusCalls = 0;
  const hold =
    (method: Pending["method"]) =>
    (...args: unknown[]): Promise<ApiResult<unknown>> =>
      new Promise<ApiResult<unknown>>((resolve) => {
        const signal = args.at(-1) as AbortSignal;
        pending.push({ method, args: args.slice(0, -1), signal, answer: resolve });
        signal.addEventListener("abort", () => resolve({ ok: false, error: { kind: "aborted" } }));
      });
  const api: ApiClient = {
    ...NO_STORED_READS,
    status: () => {
      statusCalls++;
      return Promise.resolve({ ok: true, data: status, receivedAt: NOW });
    },
    markets: (query) => {
      live.push(`markets ${JSON.stringify(query)}`);
      return new Promise(() => undefined);
    },
    inspect: (id) => {
      live.push(`inspect ${id}`);
      return new Promise(() => undefined);
    },
    storedMarkets: hold("storedMarkets") as ApiClient["storedMarkets"],
    storedRuns: hold("storedRuns") as ApiClient["storedRuns"],
    history: hold("history") as ApiClient["history"],
    observation: hold("observation") as ApiClient["observation"],
  };
  return { api, pending, live, statusCalls: () => statusCalls };
}

/** Let promise callbacks run. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait (bounded) until `condition` holds, e.g. for answers over real local HTTP. */
export async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export type { History, ObservationDetails, Runs, StoredMarkets };
