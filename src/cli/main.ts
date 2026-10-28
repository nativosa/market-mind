import { realHttpDeps } from "../adapters/polymarket/httpClient.js";
import { run } from "./run.js";

process.exitCode = await run(process.argv.slice(2), {
  http: realHttpDeps,
  env: process.env,
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
});
