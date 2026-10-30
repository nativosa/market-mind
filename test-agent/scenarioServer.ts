// The real MarketMind MCP server over stdio, serving the synthetic universe of fixtures.ts through fake
// HTTP (no network). Started by Claude Code from the generated --mcp-config under the server name
// "marketmind", so tool names match production. Stored tools read MARKETMIND_DB read-only (a missing
// file gives database_missing). Time comes from the fixed evaluation clock, so live evidence is reproducible.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { realLiveness } from "../src/adapters/storage/processLiveness.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { createLiveGate } from "../src/mcp/liveBudget.js";
import { MAX_RESULT_CHARS } from "../src/mcp/results.js";
import { createMarketMindServer } from "../src/mcp/server.js";
import { fakeFetch, testDeps } from "../test/helpers.js";
import { agentRoutes, evalClock } from "./fixtures.js";

const fake = fakeFetch(agentRoutes());
const clock = evalClock();
const http = testDeps(fake.fetch, clock).deps;
const gate = createLiveGate(http, 64);
const log = (line: string) => process.stderr.write(`[scenario-mcp] ${line}\n`);
const handle = serveStdio(() =>
  createMarketMindServer({
    http,
    config: { ...DEFAULT_CONFIG, gammaBaseUrl: "https://gamma.example", clobBaseUrl: "https://clob.example", dbPath: process.env.MARKETMIND_DB ?? "missing.sqlite" },
    gate,
    liveness: realLiveness,
    now: clock,
    log,
    maxResultChars: MAX_RESULT_CHARS,
  }),
);
process.once("SIGTERM", () => void handle.close());
log("ready (synthetic fixtures, no network)");
