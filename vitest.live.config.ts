import { defineConfig } from "vitest/config";

// Opt-in live smoke tests against public Polymarket endpoints.
// Run only via `npm run smoke`; never part of `npm test` or `npm run verify`.
export default defineConfig({
  test: {
    include: ["test-live/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    fileParallelism: false,
    reporters: ["verbose"],
    silent: false,
  },
});
