import { runDemo } from "./cli.js";

// Entry point of bin/marketmind-web-demo.mjs (npm run web:demo). See cli.ts.

const running = await runDemo({ env: process.env, signals: process, log: (line) => process.stderr.write(`[marketmind-demo] ${line}\n`) });
if (running === null) process.exitCode = 1;
