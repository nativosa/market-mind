#!/usr/bin/env node
// Development: start the MarketMind API server and the Vite dev server together, with no shell and no
// extra dependency, so it behaves the same on Windows and Linux. Vite (http://127.0.0.1:5173) proxies
// /api to the API server, which is told to accept that one dev origin. Stopping either stops both.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const DEV_ORIGIN = "http://127.0.0.1:5173";
const run = (script, args, env) => spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { cwd: root, stdio: "inherit", env });

const children = [
  run("./marketmind-web.mjs", [], { ...process.env, MARKETMIND_WEB_DEV_ORIGIN: DEV_ORIGIN }),
  run("../node_modules/vite/bin/vite.js", ["--config", "web/vite.config.ts"], process.env),
];

let stopping = false;
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill();
};
for (const child of children) child.on("exit", (code) => stop(code ?? 0));
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
console.log(`MarketMind dev: open ${DEV_ORIGIN} (API on 127.0.0.1:${process.env.MARKETMIND_WEB_PORT ?? "4317"})`);
