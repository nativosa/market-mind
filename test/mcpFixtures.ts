import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { z } from "zod";
import type { FetchFn } from "../src/adapters/polymarket/httpClient.js";
import type { Liveness } from "../src/adapters/storage/processLiveness.js";
import { finalizeRun, insertRecomputedMetrics, loadEvidence, persistObservation } from "../src/adapters/storage/snapshotStore.js";
import { recomputeMetrics } from "../src/analytics/recompute.js";
import { ANALYTICS_VERSION } from "../src/analytics/version.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { DetailsOutput, HistoryOutput, InspectOutput, RunsOutput, ScanOutput } from "../src/mcp/contracts.js";
import { createLiveGate, type LiveGate } from "../src/mcp/liveBudget.js";
import { MAX_RESULT_CHARS } from "../src/mcp/results.js";
import { createMarketMindServer } from "../src/mcp/server.js";
import { fakeFetch, TEST_HTTP_OPTIONS, testDeps, type Reply } from "./helpers.js";
import { evidence, fakeLiveness, iso, META, openMigrated, record, startRun, T0, type RecordSpec } from "./storageFixtures.js";

export const GAMMA = "https://gamma.example";
export const CLOB = "https://clob.example";

export interface ConnectOptions {
  routes?: Record<string, Reply | Reply[]>;
  /** Wraps the fake fetch (e.g. to observe aborts). */
  wrap?: (inner: FetchFn) => FetchFn;
  dbPath?: string;
  processLimit?: number;
  maxResultChars?: number;
  deadline?: (ms: number) => AbortSignal;
  liveness?: Liveness;
  gate?: LiveGate;
}

/** A real MCP client connected to a real MarketMind server over the SDK's in-memory transport. */
export async function connect(options: ConnectOptions = {}) {
  const fake = fakeFetch(options.routes ?? {});
  const fetch = options.wrap ? options.wrap(fake.fetch) : fake.fetch;
  const http = testDeps(fetch).deps;
  const gate = options.gate ?? createLiveGate(http, options.processLimit ?? 200);
  const logs: string[] = [];
  const server = createMarketMindServer({
    http,
    config: { ...DEFAULT_CONFIG, ...TEST_HTTP_OPTIONS, gammaBaseUrl: GAMMA, clobBaseUrl: CLOB, dbPath: options.dbPath ?? "missing.sqlite", buildId: null },
    gate,
    liveness: options.liveness ?? fakeLiveness({}, "test-host"),
    now: () => new Date("2026-10-29T12:00:00.000Z"),
    log: (line) => logs.push(line),
    maxResultChars: options.maxResultChars ?? MAX_RESULT_CHARS,
    ...(options.deadline ? { deadline: options.deadline } : {}),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "marketmind-test", version: "0.0.0" });
  await client.connect(clientSide);
  // Listing tools gives the client the output schemas: every later callTool result is validated against them.
  const tools = await client.listTools();
  return { client, tools: tools.tools, calls: fake.calls, logs, gate, close: () => client.close() };
}

export type Connected = Awaited<ReturnType<typeof connect>>;

const OUTPUTS = {
  scan_markets: ScanOutput,
  inspect_market: InspectOutput,
  list_collection_runs: RunsOutput,
  get_market_history: HistoryOutput,
  get_observation_details: DetailsOutput,
} as const;
export type ToolName = keyof typeof OUTPUTS;

export interface CallResult<N extends string = string> {
  tool: N;
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

export async function call<N extends string>(c: Connected, name: N, args: Record<string, unknown> = {}, opts: { signal?: AbortSignal } = {}): Promise<CallResult<N>> {
  const result = (await c.client.callTool({ name, arguments: args }, opts.signal ? { signal: opts.signal } : undefined)) as Omit<CallResult<N>, "tool">;
  return { ...result, tool: name };
}

/** structuredContent of a successful call, re-validated against the tool's output schema (typed). */
export function ok<N extends ToolName>(result: CallResult<N>): z.infer<(typeof OUTPUTS)[N]> {
  if (result.isError) throw new Error(`expected success, got error: ${result.content[0]?.text}`);
  return OUTPUTS[result.tool].parse(result.structuredContent) as z.infer<(typeof OUTPUTS)[N]>;
}

export function errorOf(result: CallResult): { category: string; code: string | null; message: string; retryable: boolean; details: Record<string, unknown> } {
  if (!result.isError) throw new Error("expected an error result");
  return (JSON.parse(result.content[0]!.text!) as { error: ReturnType<typeof errorOf> }).error;
}

let runSeq = 0;

/** Store one observation of market `id` in its own live run; returns the observation id. */
export function seedObservation(path: string, spec: RecordSpec & { runId?: string; source?: "live" | "synthetic"; persistedAtMs?: number } = {}): number {
  const db = openMigrated(path);
  try {
    const runId = startRun(db, { runId: spec.runId ?? `run-${++runSeq}`, sourceType: spec.source ?? "live", startedAt: new Date(T0 + (spec.receivedAt?.[0] ?? 0) - 1_000) });
    return persistObservation(db, runId, record(spec), { ...META, now: new Date(T0 + (spec.persistedAtMs ?? 1_000)) }, ANALYTICS_VERSION).observationId;
  } finally {
    db.close();
  }
}

/**
 * Look-ahead fixture for market 1, with the as-of boundary at T0 + 2 s:
 * - observation A (run "early"): books at +100/+110 ms, persisted at +150 ms, BUT the same run made a
 *   later request for this market that completed at +5 s, finished at +10 s, and A got a version-2
 *   metrics recompute at +1 h;
 * - observation B (run "late"): available at +60 s.
 * Before the boundary only A exists, without its late request, run outcome or recompute as facts.
 */
export const ASOF = iso(2_000);
export function seedLookAhead(path: string): { early: number; late: number } {
  const db = openMigrated(path);
  try {
    startRun(db, { runId: "early", sourceType: "live", startedAt: new Date(T0) });
    const early = persistObservation(
      db,
      "early",
      record({ id: "1", receivedAt: [100, 110], requests: [evidence("market 1 late retry", "/book?late", 5_000, "Upstream5xx")] }),
      { ...META, now: new Date(T0 + 150) },
      ANALYTICS_VERSION,
    ).observationId;
    finalizeRun(db, "early", {
      status: "complete",
      accounting: "verified",
      finishedAt: new Date(T0 + 10_000),
      stopReasons: [],
      scanCounts: null,
      persistCounts: {},
      budgetUsed: 4,
      window: null,
      error: null,
    });
    const { metrics } = recomputeMetrics(loadEvidence(db, early));
    insertRecomputedMetrics(db, early, metrics!, { analyticsVersion: 2, computedAt: new Date(T0 + 3_600_000), appVersion: "next", buildId: null });
    startRun(db, { runId: "late", sourceType: "live", startedAt: new Date(T0 + 59_000) });
    const late = persistObservation(db, "late", record({ id: "1", receivedAt: [60_000, 60_010], ref: { bids: [["0.30", "10"]], asks: [["0.50", "10"]] } }), { ...META, now: new Date(T0 + 60_100) }, ANALYTICS_VERSION).observationId;
    return { early, late };
  } finally {
    db.close();
  }
}
