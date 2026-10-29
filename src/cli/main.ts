import { realHttpDeps } from "../adapters/polymarket/httpClient.js";
import { run } from "./run.js";

// For `scan` and `collect`, the first Ctrl+C cancels gracefully (the partial report is still printed) and a
// second one exits immediately. Other commands keep the default SIGINT behaviour.
const interrupt = new AbortController();
if (process.argv[2] === "scan" || process.argv[2] === "collect") process.once("SIGINT", () => interrupt.abort(new Error("cancelled by user (SIGINT)")));

process.exitCode = await run(process.argv.slice(2), {
  http: realHttpDeps,
  env: process.env,
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  signal: interrupt.signal,
});
