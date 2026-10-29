import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { realHttpDeps } from "../adapters/polymarket/httpClient.js";
import { realLiveness } from "../adapters/storage/processLiveness.js";
import { APP_VERSION } from "../config/config.js";
import { isMarketMindError } from "../domain/errors.js";
import { createLiveGate } from "./liveBudget.js";
import { MAX_RESULT_CHARS } from "./results.js";
import { createMarketMindServer, mcpSettings } from "./server.js";

// stdout carries JSON-RPC only: every diagnostic goes to stderr.
const log = (line: string) => process.stderr.write(`[marketmind-mcp] ${line}\n`);

try {
  const { config, processRequestLimit } = mcpSettings(process.env);
  const gate = createLiveGate(realHttpDeps, processRequestLimit);
  const handle = serveStdio(() =>
    createMarketMindServer({ http: realHttpDeps, config, gate, liveness: realLiveness, now: () => new Date(), log, maxResultChars: MAX_RESULT_CHARS }),
  );
  const stop = () => void handle.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log(`v${APP_VERSION} ready on stdio; live request ceiling ${processRequestLimit}; database ${process.env.MARKETMIND_DB ? "from MARKETMIND_DB" : "default"}`);
} catch (error) {
  log(`startup failed: ${isMarketMindError(error) ? `${error.message} ${(error.details.issues ?? []).join("; ")}` : String(error)}`);
  process.exitCode = 1;
}
