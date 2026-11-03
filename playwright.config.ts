import { defineConfig, devices } from "@playwright/test";
import { E2E_PORTS } from "./test-e2e/ports.js";

// Real-browser E2E suite (npm run e2e), separate from npm run verify. Everything runs on 127.0.0.1
// against test-e2e/server.ts: the real web server and built UI over a fixture upstream. One worker,
// because every test resets the shared server (budgets, cooldown, upstream log) before it starts.

const { web: WEB_PORT, control: CONTROL_PORT, dev: DEV_PORT, demo: DEMO_PORT } = E2E_PORTS;

export default defineConfig({
  testDir: "test-e2e",
  outputDir: "test-results/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "off",
    screenshot: "off",
    video: "off",
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: "node node_modules/tsx/dist/cli.mjs test-e2e/server.ts",
    url: `http://127.0.0.1:${CONTROL_PORT}/health`,
    env: { E2E_WEB_PORT: String(WEB_PORT), E2E_CONTROL_PORT: String(CONTROL_PORT), E2E_DEV_PORT: String(DEV_PORT), E2E_DEMO_PORT: String(DEMO_PORT) },
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
