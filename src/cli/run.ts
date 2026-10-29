import { createClobClient } from "../adapters/polymarket/clobClient.js";
import { createGammaClient } from "../adapters/polymarket/gammaClient.js";
import { createHttpClient, type HttpDeps } from "../adapters/polymarket/httpClient.js";
import { hasInvalidBook, inspectMarket } from "../app/inspectMarket.js";
import { listMarkets } from "../app/listMarkets.js";
import { randomUUID } from "node:crypto";
import { realLiveness, type Liveness } from "../adapters/storage/processLiveness.js";
import { collectMarkets } from "../app/collectMarkets.js";
import { collectionRuns, marketHistory } from "../app/marketHistory.js";
import { scanMarkets, type ScanOptions } from "../app/scanMarkets.js";
import { DEFAULT_DB_PATH, loadConfig } from "../config/config.js";
import { decimal } from "../domain/decimal.js";
import { isMarketMindError, MarketMindError, type ErrorKind } from "../domain/errors.js";
import { parseCli, USAGE, type ScanCommand } from "./args.js";
import { formatCollect, formatError, formatHistory, formatInspect, formatMarkets, formatRuns, formatScan } from "./format.js";
import { collectJson, errorJson, historyJson, inspectJson, marketsJson, runsJson, scanJson } from "./jsonView.js";

export const EXIT = { ok: 0, unexpected: 1, usage: 2, notFound: 3, upstream: 4, invalidData: 5, partial: 6, storage: 7 } as const;

export function exitCodeFor(kind: ErrorKind): number {
  switch (kind) {
    case "Usage":
      return EXIT.usage;
    case "NotFound":
    case "Ineligible":
      return EXIT.notFound;
    case "Timeout":
    case "Network":
    case "RateLimited":
    case "Upstream5xx":
    case "HttpStatus":
      return EXIT.upstream;
    case "Validation":
    case "AssociationMismatch":
    case "InvalidBook":
      return EXIT.invalidData;
    case "Cancelled":
    case "BudgetExceeded":
      return EXIT.partial;
    case "Storage":
      return EXIT.storage;
  }
}

export interface CliDeps {
  http: HttpDeps;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** User cancellation (Ctrl+C), used by `scan`. */
  signal?: AbortSignal;
  /** Scan deadline signal factory, injectable for tests. */
  deadline?: (ms: number) => AbortSignal;
  /** Process liveness checks for safe run recovery (injectable for tests). */
  liveness?: Liveness;
  pid?: number;
  newRunId?: () => string;
}

function scanOptionsOf(c: Omit<ScanCommand, "kind" | "json">): ScanOptions {
  return {
    version: c.version,
    discoverOrder: c.discoverOrder,
    maxMarkets: c.maxMarkets,
    top: c.top,
    pageSize: c.pageSize,
    maxPages: c.maxPages,
    filters: { minSpread: decimal(c.minSpread), minTopSize: decimal(c.minTopSize), includeSuspicious: c.includeSuspicious },
    depthBand: c.depthBand === null ? null : decimal(c.depthBand),
    maxRequests: c.maxRequests,
    concurrency: c.concurrency,
    maxDurationMs: c.maxDurationMs,
  };
}

/** Run one CLI invocation and return its exit code. Never calls process.exit. */
export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  let json = argv.includes("--json");
  try {
    const command = parseCli(argv);
    if (command.kind === "help") {
      deps.stdout(USAGE);
      return EXIT.ok;
    }
    json = command.json;
    const config = loadConfig(deps.env);
    const liveness = deps.liveness ?? realLiveness;

    // Offline commands: no HTTP client is ever constructed.
    if (command.kind === "history") {
      const result = marketHistory({
        dbPath: command.db ?? config.dbPath,
        gammaId: command.marketId,
        asOf: command.asOf,
        limit: command.limit,
        threshold: decimal(command.spreadThreshold),
        analyticsVersion: command.analyticsVersion,
        includeSynthetic: command.includeSynthetic,
      });
      deps.stdout(json ? JSON.stringify(historyJson(result), null, 2) : formatHistory(result));
      return EXIT.ok;
    }
    if (command.kind === "runs") {
      const result = collectionRuns({ dbPath: command.db ?? config.dbPath, limit: command.limit, liveness, now: deps.http.now });
      deps.stdout(json ? JSON.stringify(runsJson(result), null, 2) : formatRuns(result));
      return EXIT.ok;
    }

    if (command.kind === "collect") {
      const dbPath = command.db ?? config.dbPath;
      const result = await collectMarkets(
        {
          scan: scanOptionsOf(command),
          dbPath,
          createParentDir: dbPath === DEFAULT_DB_PATH,
          maxDbBytes: command.maxDbMb * 1024 * 1024,
          buildId: config.buildId,
          sourceType: "live",
        },
        {
          http: deps.http,
          httpOptions: config,
          gammaBaseUrl: config.gammaBaseUrl,
          clobBaseUrl: config.clobBaseUrl,
          ...(deps.signal ? { signal: deps.signal } : {}),
          ...(deps.deadline ? { deadline: deps.deadline } : {}),
          liveness,
          now: deps.http.now,
          pid: deps.pid ?? process.pid,
          nodeVersion: process.version,
          newRunId: deps.newRunId ?? randomUUID,
        },
      );
      deps.stdout(json ? JSON.stringify(collectJson(result), null, 2) : formatCollect(result));
      if (result.scanError) {
        deps.stderr(formatError(result.scanError));
        return exitCodeFor(result.scanError.kind);
      }
      if (result.storageError) {
        deps.stderr(formatError(result.storageError));
        return EXIT.storage;
      }
      if (result.status !== "complete") {
        deps.stderr(`collection ${result.status} (run ${result.runId}, exit ${EXIT.partial})`);
        return EXIT.partial;
      }
      return EXIT.ok;
    }

    const http = createHttpClient(config, deps.http);
    const gamma = createGammaClient(http, config.gammaBaseUrl);

    if (command.kind === "markets") {
      const query = { limit: command.limit, version: command.version, ...(command.cursor ? { cursor: command.cursor } : {}) };
      const result = await listMarkets(gamma, query);
      deps.stdout(json ? JSON.stringify(marketsJson(result), null, 2) : formatMarkets(result));
      return EXIT.ok;
    }

    if (command.kind === "scan") {
      const result = await scanMarkets(
        scanOptionsOf(command),
        {
          http: deps.http,
          httpOptions: config,
          gammaBaseUrl: config.gammaBaseUrl,
          clobBaseUrl: config.clobBaseUrl,
          ...(deps.signal ? { signal: deps.signal } : {}),
          ...(deps.deadline ? { deadline: deps.deadline } : {}),
        },
      );
      deps.stdout(json ? JSON.stringify(scanJson(result), null, 2) : formatScan(result));
      if (result.status === "partial") {
        deps.stderr(`scan incomplete: ${result.stopReasons.join(", ") || "one or more candidates failed"} (exit ${EXIT.partial})`);
        return EXIT.partial;
      }
      return EXIT.ok;
    }

    const clob = createClobClient(http, config.clobBaseUrl);
    const result = await inspectMarket({ gamma, clob }, command.marketId, {
      depthBand: command.depthBand === null ? null : decimal(command.depthBand),
    });
    deps.stdout(json ? JSON.stringify(inspectJson(result, command.levels), null, 2) : formatInspect(result));
    if (hasInvalidBook(result)) {
      const error = new MarketMindError("InvalidBook", "One or more order books are invalid; metrics withheld");
      deps.stderr(formatError(error));
      return exitCodeFor(error.kind);
    }
    return EXIT.ok;
  } catch (error) {
    if (isMarketMindError(error)) {
      if (json && error.kind !== "Usage") deps.stdout(JSON.stringify(errorJson(error), null, 2));
      deps.stderr(formatError(error));
      if (error.kind === "Usage") deps.stderr(USAGE);
      return exitCodeFor(error.kind);
    }
    deps.stderr(`unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return EXIT.unexpected;
  }
}
