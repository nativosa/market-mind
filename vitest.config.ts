import { defineConfig } from "vitest/config";

// Offline suite: never touches the network (see test/setup.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "text-summary"],
      thresholds: {
        lines: 75,
        statements: 75,
        "src/domain/**": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/analytics/**": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/adapters/polymarket/normalize.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/adapters/polymarket/requestBudget.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/app/scanMarkets.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/adapters/storage/**": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/app/collectMarkets.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/app/marketHistory.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        // main.ts only runs in spawned processes (covered by test/unit/mcpStdio.test.ts, invisible to V8 coverage).
        "src/mcp/{contracts,liveBudget,liveTools,results,server,storedTools,views}.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
      },
    },
  },
});
