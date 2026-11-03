import { defineConfig } from "vitest/config";

// Offline suite: never touches the network (see test/setup.ts).
export default defineConfig({
  // The React explorer's tests render components with the automatic JSX runtime (as Vite builds them).
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    include: ["test/**/*.test.ts", "web/test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "agent-sdk/**/*.ts", "web/src/**/*.{ts,tsx}"],
      reporter: ["text", "text-summary"],
      thresholds: {
        lines: 75,
        statements: 75,
        // Stage 2.6 SDK application (cli.ts main block and real-process wiring are exercised only partly offline).
        "agent-sdk/**": { lines: 85, statements: 85, functions: 85, branches: 70 },
        "src/domain/**": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/analytics/**": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/adapters/polymarket/normalize.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/adapters/polymarket/requestBudget.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/app/scanMarkets.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/adapters/storage/**": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/app/collectMarkets.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "src/app/marketHistory.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        // main.ts only runs in spawned processes (covered by test/unit/mcpStdio.test.ts, invisible to V8 coverage).
        // One group: the same code the v0.8.0 MCP threshold covered, now split across src/mcp and src/research.
        "{src/mcp/{liveTools,results,server,storedTools}.ts,src/research/**}": { lines: 90, statements: 90, functions: 90, branches: 85 },
        // Stage 3.1 web API (main.ts runs only in the spawned-launcher test, invisible to V8 coverage).
        "src/web/{routes,security,server,settings,static}.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        // Stage 3.1 explorer UI (main.tsx only mounts the app in a browser).
        "web/src/{api,book,controller,explorer,format,route}.ts": { lines: 90, statements: 90, functions: 90, branches: 85 },
        "web/src/{App,components/*}.tsx": { lines: 85, statements: 85, functions: 80, branches: 75 },
      },
    },
  },
});
