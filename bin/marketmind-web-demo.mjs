#!/usr/bin/env node
// MarketMind synthetic demonstration launcher (npm run web:demo): an offline web server over a
// freshly generated synthetic database in a new OS temporary directory, deleted on Ctrl+C. Like
// marketmind-web.mjs it resolves tsx from this repository and switches to the repository root.
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
register();
await import("../src/demo/main.ts");
