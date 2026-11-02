import type { z } from "zod";
import { decimal } from "../domain/decimal.js";
import { MarketMindError } from "../domain/errors.js";
import { InspectInput, InspectOutput, MarketsInput, MarketsOutput, WebStatusOutput } from "../research/contracts.js";
import { untrusted } from "../research/envelope.js";
import type { LiveCallDeps } from "../research/liveCall.js";
import type { CooldownGate } from "../research/liveGate.js";
import { inspectLiveMarket } from "../research/liveInspection.js";
import { listMarketPage } from "../research/liveListing.js";
import { inspectView, marketsView, webStatusView } from "../research/views.js";

export interface RouteDeps extends LiveCallDeps {
  gate: CooldownGate;
  now: () => Date;
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

function status({ deps, query }: RouteContext): Promise<unknown> {
  queryOf(query, []);
  return Promise.resolve(WebStatusOutput.parse(webStatusView(deps.gate, deps.now())));
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

/** Every API route. Read-only GETs: nothing takes a URL, a file path, SQL or a command. */
export const ROUTES: readonly Route[] = [
  { name: "status", pattern: /^\/api\/status$/, live: false, handler: status },
  { name: "markets", pattern: /^\/api\/markets$/, live: true, handler: markets },
  { name: "inspect", pattern: /^\/api\/markets\/([^/]+)\/inspect$/, live: true, handler: inspect },
];

export function matchRoute(path: string): { route: Route; params: string[] } | null {
  for (const route of ROUTES) {
    const m = route.pattern.exec(path);
    if (m) return { route, params: m.slice(1) };
  }
  return null;
}
