// The real MarketMind MCP server over real stdio, with fixture HTTP instead of the network. Spawned by
// test/unit/mcpStdio.test.ts (node --import tsx). FIXTURE_HANG=1 makes every request hang until aborted.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { realLiveness } from "../../src/adapters/storage/processLiveness.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { createLiveGate } from "../../src/mcp/liveBudget.js";
import { MAX_RESULT_CHARS } from "../../src/mcp/results.js";
import { createMarketMindServer } from "../../src/mcp/server.js";
import { fakeFetch, testDeps } from "../helpers.js";
import { V1_ROUTES } from "../routes.js";
import { scanRoutes } from "../scanFixtures.js";

const fake = fakeFetch({ ...scanRoutes([[{ id: "91", book: { bids: [["0.40", "100"]], asks: [["0.46", "100"]] } }, { id: "92" }]]), ...V1_ROUTES });
const hang = process.env.FIXTURE_HANG === "1";
const http = testDeps((url, init) =>
  hang ? new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error))) : fake.fetch(url, init),
).deps;
const gate = createLiveGate(http, 50);
const log = (line: string) => process.stderr.write(`[fixture-mcp] ${line}\n`);
const handle = serveStdio(() =>
  createMarketMindServer({
    http,
    config: { ...DEFAULT_CONFIG, gammaBaseUrl: "https://gamma.example", clobBaseUrl: "https://clob.example", dbPath: process.env.MARKETMIND_DB ?? "missing.sqlite" },
    gate,
    liveness: realLiveness,
    now: () => new Date(),
    log,
    maxResultChars: MAX_RESULT_CHARS,
  }),
);
process.once("SIGTERM", () => void handle.close());
log("ready");
