#!/usr/bin/env node
// Portable MarketMind web server launcher (http://127.0.0.1 only). Runs from any working directory
// and needs no shell wrapper on Windows: it resolves tsx from this repository, switches to the
// repository root (so the built UI in web/dist resolves) and loads the TypeScript entry point.
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
register();
await import("../src/web/main.ts");
