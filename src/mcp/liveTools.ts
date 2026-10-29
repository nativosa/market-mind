import type { McpServer } from "@modelcontextprotocol/server";
import { createClobClient } from "../adapters/polymarket/clobClient.js";
import { createGammaClient } from "../adapters/polymarket/gammaClient.js";
import { createHttpClient } from "../adapters/polymarket/httpClient.js";
import { createRequestBudget } from "../adapters/polymarket/requestBudget.js";
import { inspectMarket } from "../app/inspectMarket.js";
import { scanMarkets, type ScanOptions } from "../app/scanMarkets.js";
import { decimal } from "../domain/decimal.js";
import { isMarketMindError, MarketMindError } from "../domain/errors.js";
import { InspectInput, InspectOutput, MCP_LIMITS, ScanInput, ScanOutput } from "./contracts.js";
import { fitted, success } from "./results.js";
import { handle, type McpDeps } from "./server.js";
import { inspectSummary, inspectView, scanSummary, scanView, type ScanCaps } from "./views.js";

const halve = (n: number) => Math.floor(n / 2);

export function registerLiveTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "scan_markets",
    {
      title: "Scan live markets",
      description:
        "Discover open Polymarket markets (ordered by 24h volume), inspect a bounded sample and rank them by quoted spread, then top-of-book size. " +
        "Live public GET requests only, capped by maxRequests and maxDurationMs. Returns ranked candidates, why the others were not ranked, " +
        "full accounting and whether the scan was partial. Candidates are research leads, not opportunities: a spread is not a profit.",
      inputSchema: ScanInput,
      outputSchema: ScanOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input, ctx) =>
      handle("scan_markets", deps, async () => {
        const options: ScanOptions = {
          version: input.version,
          discoverOrder: "volume24hr",
          maxMarkets: input.maxMarkets,
          top: input.top,
          pageSize: input.pageSize,
          maxPages: input.maxPages,
          filters: { minSpread: decimal(input.minSpread), minTopSize: decimal(input.minTopSize), includeSuspicious: input.includeSuspicious },
          depthBand: input.depthBand === null ? null : decimal(input.depthBand),
          maxRequests: input.maxRequests,
          concurrency: MCP_LIMITS.scan.concurrency,
          maxDurationMs: input.maxDurationMs,
        };
        const { result, usage } = await deps.gate.run(input.maxRequests, ctx.mcpReq.signal, async (http, usage) => ({
          result: await scanMarkets(options, {
            http,
            httpOptions: deps.config,
            gammaBaseUrl: deps.config.gammaBaseUrl,
            clobBaseUrl: deps.config.clobBaseUrl,
            signal: ctx.mcpReq.signal,
            ...(deps.deadline ? { deadline: deps.deadline } : {}),
          }),
          usage,
        }));
        const budget = { call: { ...usage }, process: deps.gate.process };
        const now = deps.now();
        return fitted<ScanCaps>(
          { ranked: input.top, notRanked: 10 },
          (caps) => {
            const view = scanView(result, caps, budget, now);
            return success(view, scanSummary(view));
          },
          (c) => (c.notRanked > 0 ? { ...c, notRanked: halve(c.notRanked) } : c.ranked > 0 ? { ...c, ranked: halve(c.ranked) } : null),
          deps.maxResultChars,
        );
      }),
  );

  server.registerTool(
    "inspect_market",
    {
      title: "Inspect one live market",
      description:
        "Fetch one market by Gamma id and both outcome order books (at most 4 public GET requests, 8 attempts with retries, 20 s). " +
        "Validates eligibility and the explicit outcome-to-asset association, then reports per-outcome book quality, metrics, best levels, " +
        "server timestamps and request provenance. status 'invalid_book' means a book failed validation; its evidence is still returned.",
      inputSchema: InspectInput,
      outputSchema: InspectOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input, ctx) =>
      handle("inspect_market", deps, async () => {
        const L = MCP_LIMITS.inspect;
        const depthBand = input.depthBand === null ? null : decimal(input.depthBand);
        const { result, usage } = await deps.gate.run(L.maxAttempts, ctx.mcpReq.signal, async (http, usage) => {
          // The deadline starts once the call runs, not while it waits for an earlier live call.
          const deadline = deps.deadline ? deps.deadline(L.deadlineMs) : AbortSignal.timeout(L.deadlineMs);
          const signal = AbortSignal.any([ctx.mcpReq.signal, deadline]);
          const client = createHttpClient({ ...deps.config, maxRetries: Math.min(deps.config.maxRetries, L.maxRetries) }, { ...http, budget: createRequestBudget(L.maxAttempts), signal });
          try {
            const result = await inspectMarket(
              { gamma: createGammaClient(client, deps.config.gammaBaseUrl), clob: createClobClient(client, deps.config.clobBaseUrl) },
              input.marketId,
              { depthBand },
            );
            return { result, usage };
          } catch (error) {
            if (isMarketMindError(error) && error.kind === "Cancelled" && deadline.aborted && !ctx.mcpReq.signal.aborted) {
              throw new MarketMindError("Cancelled", `Inspection exceeded its ${L.deadlineMs} ms deadline`, { ...error.details, code: "DEADLINE" });
            }
            throw error;
          }
        });
        const budget = { call: { ...usage }, process: deps.gate.process };
        const now = deps.now();
        return fitted(
          input.levels,
          (levels) => {
            const view = inspectView(result, levels, depthBand, budget, now);
            return success(view, inspectSummary(view));
          },
          (levels) => (levels > 0 ? halve(levels) : null),
          deps.maxResultChars,
        );
      }),
  );
}
