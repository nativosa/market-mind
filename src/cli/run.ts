import { createClobClient } from "../adapters/polymarket/clobClient.js";
import { createGammaClient } from "../adapters/polymarket/gammaClient.js";
import { createHttpClient, type HttpDeps } from "../adapters/polymarket/httpClient.js";
import { hasInvalidBook, inspectMarket } from "../app/inspectMarket.js";
import { listMarkets } from "../app/listMarkets.js";
import { loadConfig } from "../config/config.js";
import { decimal } from "../domain/decimal.js";
import { isMarketMindError, MarketMindError, type ErrorKind } from "../domain/errors.js";
import { parseCli, USAGE } from "./args.js";
import { formatError, formatInspect, formatMarkets } from "./format.js";
import { errorJson, inspectJson, marketsJson } from "./jsonView.js";

export const EXIT = { ok: 0, unexpected: 1, usage: 2, notFound: 3, upstream: 4, invalidData: 5 } as const;

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
  }
}

export interface CliDeps {
  http: HttpDeps;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
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
    const http = createHttpClient(config, deps.http);
    const gamma = createGammaClient(http, config.gammaBaseUrl);

    if (command.kind === "markets") {
      const query = { limit: command.limit, version: command.version, ...(command.cursor ? { cursor: command.cursor } : {}) };
      const result = await listMarkets(gamma, query);
      deps.stdout(json ? JSON.stringify(marketsJson(result), null, 2) : formatMarkets(result));
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
