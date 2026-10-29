#!/usr/bin/env node
// Portable MarketMind MCP server launcher (stdio). Runs from any working directory and needs no shell
// wrapper on Windows: it resolves tsx from this repository, switches to the repository root (so the
// default data/marketmind.sqlite resolves like the CLI's) and loads the TypeScript entry point.
// Nothing here writes to stdout, which is reserved for the MCP protocol.
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
register();
await import("../src/mcp/main.ts");
