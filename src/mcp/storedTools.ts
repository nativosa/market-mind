import type { McpServer } from "@modelcontextprotocol/server";
import { collectionRuns, marketHistory, observationDetails } from "../app/marketHistory.js";
import { decimal } from "../domain/decimal.js";
import { isMarketMindError } from "../domain/errors.js";
import { DetailsInput, DetailsOutput, HistoryInput, HistoryOutput, RunsInput, RunsOutput } from "./contracts.js";
import { fitted, success } from "./results.js";
import { handle, type McpDeps } from "./server.js";
import { detailsSummary, detailsView, historySummary, historyView, noHistoryView, runsSummary, runsView, type HistoryQueryView } from "./views.js";

const halve = (n: number) => Math.floor(n / 2);
const STORED = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const utc = (iso: string | undefined) => (iso === undefined ? null : new Date(iso).toISOString());

/**
 * Offline tools: a read-only open of the configured database (never created, never migrated),
 * no HTTP dependencies at all. The database path comes from configuration, never from arguments.
 */
export function registerStoredTools(server: McpServer, deps: McpDeps): void {
  const dbPath = deps.config.dbPath;

  server.registerTool(
    "list_collection_runs",
    {
      title: "List stored collection runs",
      description:
        "List recent local collection runs (newest first) with status, accounting, versions, counts and source type. Offline: reads the local " +
        "database only. Runs recovered after a crash have accounting 'incomplete' (null counts are unknown); an unverifiable running run is reported, never changed.",
      inputSchema: RunsInput,
      outputSchema: RunsOutput,
      annotations: STORED,
    },
    (input) =>
      handle("list_collection_runs", deps, () => {
        const result = collectionRuns({ dbPath, limit: input.limit + 1, liveness: deps.liveness, now: deps.now });
        const now = deps.now();
        const host = deps.liveness.hostname();
        return fitted(
          input.limit,
          (limit) => {
            const view = runsView(result, limit, input.limit, host, now);
            return success(view, runsSummary(view));
          },
          (limit) => (limit > 1 ? halve(limit) : null),
          deps.maxResultChars,
        );
      }),
  );

  server.registerTool(
    "get_market_history",
    {
      title: "Get stored market history",
      description:
        "Stored observations of one market and sample-count statistics (spread min/median/max, current vs previous, threshold share, gaps). Offline. " +
        "asOf filters by evidence availability, so nothing observed later is used. Statistics use every usable sample in the analysis window; limit only " +
        "trims the listed rows. status 'no_history' means insufficient evidence. Use observationId with get_observation_details.",
      inputSchema: HistoryInput,
      outputSchema: HistoryOutput,
      annotations: STORED,
    },
    (input) =>
      handle("get_market_history", deps, () => {
        const query: HistoryQueryView = {
          marketId: input.marketId,
          asOf: utc(input.asOf),
          limit: input.limit,
          spreadThreshold: decimal(input.spreadThreshold),
          analyticsVersion: input.analyticsVersion,
          includeSynthetic: input.includeSynthetic,
        };
        const now = deps.now();
        let result;
        try {
          result = marketHistory({
            dbPath,
            gammaId: query.marketId,
            asOf: query.asOf,
            limit: query.limit,
            threshold: query.spreadThreshold,
            analyticsVersion: query.analyticsVersion,
            includeSynthetic: query.includeSynthetic,
          });
        } catch (error) {
          if (isMarketMindError(error) && error.details.code === "NO_OBSERVATIONS") {
            const view = noHistoryView(query, now);
            return success(view, historySummary(view));
          }
          throw error;
        }
        return fitted(
          input.limit,
          (rows) => {
            const view = historyView(result, query, rows, now);
            return success(view, historySummary(view));
          },
          (rows) => (rows > 1 ? halve(rows) : null),
          deps.maxResultChars,
        );
      }),
  );

  server.registerTool(
    "get_observation_details",
    {
      title: "Get stored observation evidence",
      description:
        "Full stored evidence for one observation: market and outcome identity, exact captured price levels (wire order), book quality and issues, " +
        "request timing and server timestamps, availability time and pair skew, and every stored metrics version. Offline. With asOf, the " +
        "observation must have been available by then and later facts are withheld.",
      inputSchema: DetailsInput,
      outputSchema: DetailsOutput,
      annotations: STORED,
    },
    (input) =>
      handle("get_observation_details", deps, () => {
        const result = observationDetails({ dbPath, observationId: input.observationId, asOf: utc(input.asOf) });
        const now = deps.now();
        return fitted(
          input.levels,
          (levels) => {
            const view = detailsView(result, levels, now);
            return success(view, detailsSummary(view));
          },
          (levels) => (levels > 0 ? halve(levels) : null),
          deps.maxResultChars,
        );
      }),
  );
}
