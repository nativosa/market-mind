#!/usr/bin/env node
// Launcher for the synthetic-fixture MCP server (test-agent/scenarioServer.ts), mirroring
// bin/marketmind-mcp.mjs: resolve tsx from this repository and run from the repository root.
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
register();
await import("./scenarioServer.ts");
