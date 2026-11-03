import type { z } from "zod";
import type { Liveness } from "../adapters/storage/processLiveness.js";
import { collectionRuns, databasePresent, marketHistory, observationDetails, storedMarkets } from "../app/marketHistory.js";
import { decimal } from "../domain/decimal.js";
import { isMarketMindError, MarketMindError } from "../domain/errors.js";
import {
  DetailsOutput,
  InspectInput,
  InspectOutput,
  MarketsInput,
  MarketsOutput,
  StoredMarketsInput,
  StoredMarketsOutput,
  WEB_LIMITS,
  WebDetailsInput,
  WebHistoryInput,
  WebHistoryOutput,
  WebRunsInput,
  WebRunsOutput,
  WebStatusOutput,
  type Source,
} from "../research/contracts.js";
import { untrusted } from "../research/envelope.js";
import type { LiveCallDeps } from "../research/liveCall.js";
import type { CooldownGate } from "../research/liveGate.js";
import { inspectLiveMarket } from "../research/liveInspection.js";
import { listMarketPage } from "../research/liveListing.js";
import {
  detailsView,
  includesSynthetic,
  inspectView,
  marketsView,
  storedMarketsView,
  webHistoryView,
  webNoHistoryView,
  webRunsView,
  webStatusView,
  type WebHistoryQuery,
} from "../research/views.js";

/** The local database the stored-data routes read (read-only), and their default provenance filter. */
export interface StoredDeps {
  dbPath: string;
  /** Applied when a request names no `source`: "live" normally; "all" only for a synthetic demonstration database. */
  defaultSource: Source;
}

export interface RouteDeps extends LiveCallDeps {
  gate: CooldownGate;
  now: () => Date;
  /** False on a server that must never call Polymarket: every live route is refused before reaching the gate. */
  liveEnabled: boolean;
  stored: StoredDeps;
  /** Owner checks for running collection runs (read-only: signal 0 only). */
  liveness: Liveness;
}

export interface RouteContext {
  deps: RouteDeps;
  query: URLSearchParams;
  /** Aborted when the browser closes the connection or the server shuts down. */
  signal: AbortSignal;
}

export interface Route {
  name: string;
  pattern: RegExp;
  /** Live routes make upstream requests through the gate; the server tracks them for cancellation. */
  live: boolean;
  handler: (ctx: RouteContext, params: string[]) => Promise<unknown>;
}

/** Query parameters as a plain record: unknown or repeated parameters are refused, never ignored. */
function queryOf(query: URLSearchParams, allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const issues: string[] = [];
  for (const [key, value] of query) {
    if (!allowed.includes(key)) issues.push(`unknown query parameter "${untrusted(key, 40)}"`);
    else if (Object.hasOwn(out, key)) issues.push(`repeated query parameter "${key}"`);
    else out[key] = value;
  }
  if (issues.length > 0) throw new MarketMindError("Usage", "Invalid query", { issues });
  return out;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MarketMindError("Usage", "Invalid request", { issues: parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`) });
  return parsed.data;
}

/** Values for Zod: digit strings of the numeric parameters become numbers; anything else stays a string, so Zod reports it. */
function withNumbers(values: Record<string, string>, numeric: readonly string[]): Record<string, string | number> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, numeric.includes(k) && /^[0-9]{1,16}$/.test(v) ? Number(v) : v]));
}
const utc = (iso: string | undefined) => (iso === undefined ? null : new Date(iso).toISOString());

function status({ deps, query }: RouteContext): Promise<unknown> {
  queryOf(query, []);
  // Only whether the file exists: no path, and the database is not opened here.
  const facts = { liveEnabled: deps.liveEnabled, defaultSource: deps.stored.defaultSource, databasePresent: databasePresent(deps.stored.dbPath) };
  return Promise.resolve(WebStatusOutput.parse(webStatusView(deps.gate, facts, deps.now())));
}

async function markets({ deps, query, signal }: RouteContext): Promise<unknown> {
  const input = parse(MarketsInput, queryOf(query, ["version", "cursor"]));
  const { result, usage } = await listMarketPage(deps, input, signal);
  return MarketsOutput.parse(marketsView(result, { call: { ...usage }, process: deps.gate.process, window: deps.gate.window }, deps.now()));
}

async function inspect({ deps, query, signal }: RouteContext, [marketId]: string[]): Promise<unknown> {
  const q = queryOf(query, ["levels", "depthBand"]);
  const input = parse(InspectInput, {
    marketId,
    ...(q.levels === undefined ? {} : { levels: /^[0-9]{1,3}$/.test(q.levels) ? Number(q.levels) : q.levels }),
    ...(q.depthBand === undefined ? {} : { depthBand: q.depthBand === "none" ? null : q.depthBand }),
  });
  const depthBand = input.depthBand === null ? null : decimal(input.depthBand);
  const { result, usage } = await inspectLiveMarket(deps, input.marketId, depthBand, signal);
  return InspectOutput.parse(inspectView(result, input.levels, depthBand, { call: { ...usage }, process: deps.gate.process }, deps.now()));
}

// ---- stored data: read-only, offline (no gate, no budget, no upstream request) ----

function storedRuns({ deps, query }: RouteContext): unknown {
  const q = queryOf(query, ["source", "limit"]);
  const input = parse(WebRunsInput, withNumbers(q, ["limit"]));
  const source = input.source ?? deps.stored.defaultSource;
  const now = deps.now();
  // One extra run tells whether more exist; synthetic runs are filtered in SQL, so the limit counts what is shown.
  const result = collectionRuns({ dbPath: deps.stored.dbPath, limit: input.limit + 1, liveness: deps.liveness, now: () => now, includeSynthetic: includesSynthetic(source) });
  return WebRunsOutput.parse(webRunsView(result, { source, limit: input.limit }, deps.liveness.hostname(), now));
}

function storedMarketList({ deps, query }: RouteContext): unknown {
  const q = queryOf(query, ["source", "limit", "offset"]);
  const input = parse(StoredMarketsInput, withNumbers(q, ["limit", "offset"]));
  const source = input.source ?? deps.stored.defaultSource;
  const result = storedMarkets({ dbPath: deps.stored.dbPath, includeSynthetic: includesSynthetic(source), limit: input.limit, offset: input.offset });
  return StoredMarketsOutput.parse(storedMarketsView(result, { source, limit: input.limit, offset: input.offset }, deps.now()));
}

function storedHistory({ deps, query }: RouteContext, [marketId]: string[]): unknown {
  const q = queryOf(query, ["source", "asOf", "spreadThreshold", "analyticsVersion"]);
  const input = parse(WebHistoryInput, { ...withNumbers(q, ["analyticsVersion"]), marketId });
  const hq: WebHistoryQuery = {
    marketId: input.marketId,
    source: input.source ?? deps.stored.defaultSource,
    asOf: utc(input.asOf),
    spreadThreshold: decimal(input.spreadThreshold),
    analyticsVersion: input.analyticsVersion,
  };
  const now = deps.now();
  try {
    const result = marketHistory({
      dbPath: deps.stored.dbPath,
      gammaId: hq.marketId,
      asOf: hq.asOf,
      limit: WEB_LIMITS.history.seriesMax,
      threshold: hq.spreadThreshold,
      analyticsVersion: hq.analyticsVersion,
      includeSynthetic: includesSynthetic(hq.source),
    });
    return WebHistoryOutput.parse(webHistoryView(result, hq, now));
  } catch (error) {
    if (isMarketMindError(error) && error.details.code === "NO_OBSERVATIONS") return WebHistoryOutput.parse(webNoHistoryView(hq, now));
    throw error;
  }
}

function storedObservation({ deps, query }: RouteContext, [observationId]: string[]): unknown {
  const q = queryOf(query, ["source", "asOf", "levels"]);
  const input = parse(WebDetailsInput, withNumbers({ ...q, observationId: observationId! }, ["observationId", "levels"]));
  const source = input.source ?? deps.stored.defaultSource;
  const result = observationDetails({ dbPath: deps.stored.dbPath, observationId: input.observationId, asOf: utc(input.asOf) });
  // The same provenance rule as the history: with source "live", a synthetic observation does not exist.
  if (!includesSynthetic(source) && result.run.sourceType !== "live") {
    throw new MarketMindError("NotFound", `No live observation ${input.observationId}`, { code: "OBSERVATION_NOT_FOUND" });
  }
  return DetailsOutput.parse(detailsView(result, input.levels, deps.now()));
}

/** A synchronous stored-data handler as a route handler (node:sqlite reads are synchronous). */
const offline =
  (fn: (ctx: RouteContext, params: string[]) => unknown): Route["handler"] =>
  (ctx, params) =>
    // A throw inside the executor rejects the promise, so errors keep their normal mapping.
    new Promise((resolve) => resolve(fn(ctx, params)));

/**
 * Every API route. Read-only GETs: nothing takes a URL, a file path, SQL or a command. Live routes
 * go through the gate; stored routes read the configured local database only and never the network.
 */
export const ROUTES: readonly Route[] = [
  { name: "status", pattern: /^\/api\/status$/, live: false, handler: status },
  { name: "markets", pattern: /^\/api\/markets$/, live: true, handler: markets },
  { name: "inspect", pattern: /^\/api\/markets\/([^/]+)\/inspect$/, live: true, handler: inspect },
  { name: "stored-runs", pattern: /^\/api\/stored\/runs$/, live: false, handler: offline(storedRuns) },
  { name: "stored-markets", pattern: /^\/api\/stored\/markets$/, live: false, handler: offline(storedMarketList) },
  { name: "stored-history", pattern: /^\/api\/stored\/markets\/([^/]+)\/history$/, live: false, handler: offline(storedHistory) },
  { name: "stored-observation", pattern: /^\/api\/stored\/observations\/([^/]+)$/, live: false, handler: offline(storedObservation) },
];

export function matchRoute(path: string): { route: Route; params: string[] } | null {
  for (const route of ROUTES) {
    const m = route.pattern.exec(path);
    if (m) return { route, params: m.slice(1) };
  }
  return null;
}
