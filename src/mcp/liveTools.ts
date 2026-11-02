import type { McpServer } from "@modelcontextprotocol/server";
import { scanMarkets, type ScanOptions } from "../app/scanMarkets.js";
import { decimal } from "../domain/decimal.js";
import { InspectInput, InspectOutput, MCP_LIMITS, ScanInput, ScanOutput } from "../research/contracts.js";
import { inspectLiveMarket } from "../research/liveInspection.js";
import { fitted, success } from "./results.js";
import { handle, type McpDeps } from "./server.js";
import { inspectSummary, inspectView, scanSummary, scanView, type ScanCaps } from "../research/views.js";

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
        const depthBand = input.depthBand === null ? null : decimal(input.depthBand);
        const { result, usage } = await inspectLiveMarket(deps, input.marketId, depthBand, ctx.mcpReq.signal);
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
