import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const noFloatMath = {
  "no-restricted-globals": [
    "error",
    { name: "parseFloat", message: "Use big.js via src/domain/decimal.ts for prices and sizes." },
    { name: "parseInt", message: "Use big.js via src/domain/decimal.ts for prices and sizes." },
    { name: "Number", message: "Use big.js via src/domain/decimal.ts for prices and sizes." },
    { name: "fetch", message: "Network access belongs in adapters/polymarket/httpClient.ts." },
  ],
  "no-restricted-syntax": [
    "error",
    { selector: "MemberExpression[object.name='Math']", message: "No floating-point Math in domain/analytics." },
  ],
};

const outerLayers = ["**/adapters/**", "**/app/**", "**/cli/**", "**/config/**"];

// Import boundaries. Flat config replaces a rule's whole value for a file when several blocks match,
// so every file group gets exactly ONE no-restricted-imports entry combining all of its restrictions.
const SQLITE = { name: "node:sqlite", message: "Only src/adapters/storage/sqlite.ts may import node:sqlite." };
const MCP_SDK = { group: ["@modelcontextprotocol/*"], message: "Only src/mcp may depend on the MCP SDK." };
const MCP_LAYER = { group: ["**/mcp/**"], message: "Only the MCP entry points may depend on src/mcp." };
const restrict = (paths, patterns) => ({ "no-restricted-imports": ["error", { paths, patterns }] });

export default tseslint.config(
  { ignores: ["node_modules/", "coverage/", "dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  // Only the HTTP client may perform network I/O.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/adapters/polymarket/httpClient.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: "Network access belongs in adapters/polymarket/httpClient.ts." }],
    },
  },
  // Domain: pure types and helpers. No I/O, no outer layers, no float math.
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      ...noFloatMath,
      ...restrict([], [{ group: [...outerLayers, "**/analytics/**", "**/mcp/**", "node:*", "@modelcontextprotocol/*"], message: "domain must not depend on outer layers or Node I/O." }]),
    },
  },
  // Analytics: deterministic calculations over domain types only.
  {
    files: ["src/analytics/**/*.ts"],
    rules: {
      ...noFloatMath,
      ...restrict([], [{ group: [...outerLayers, "**/mcp/**", "node:*", "@modelcontextprotocol/*"], message: "analytics may depend on domain only." }]),
    },
  },
  // Polymarket adapters must not reach up into application, CLI or MCP code, nor into storage.
  {
    files: ["src/adapters/polymarket/**/*.ts"],
    rules: restrict([SQLITE], [{ group: ["**/app/**", "**/cli/**", "**/storage/**", "**/mcp/**"], message: "polymarket adapters must not depend on app, cli, mcp or storage." }, MCP_SDK]),
  },
  // Storage knows nothing about HTTP, the scanner, the CLI or MCP. node:sqlite (a release candidate in Node 24) is confined to one file.
  {
    files: ["src/adapters/storage/**/*.ts"],
    ignores: ["src/adapters/storage/sqlite.ts"],
    rules: restrict([SQLITE], [{ group: ["**/app/**", "**/cli/**", "**/polymarket/**", "**/mcp/**"], message: "storage must not depend on app, cli, mcp or polymarket adapters." }, MCP_SDK]),
  },
  {
    files: ["src/adapters/storage/sqlite.ts"],
    rules: restrict([], [{ group: ["**/app/**", "**/cli/**", "**/polymarket/**", "**/mcp/**"], message: "storage must not depend on app, cli, mcp or polymarket adapters." }, MCP_SDK]),
  },
  {
    files: ["src/app/**/*.ts"],
    rules: restrict([SQLITE], [{ group: ["**/cli/**"], message: "app must not depend on cli." }, MCP_LAYER, MCP_SDK]),
  },
  {
    files: ["src/cli/**/*.ts", "src/config/**/*.ts"],
    rules: restrict([SQLITE], [MCP_LAYER, MCP_SDK]),
  },
  // MCP: an integration boundary over application services. Read-only by construction: no SQLite,
  // no storage writes, no collection, no processes, sockets or file system, and no CLI internals.
  {
    files: ["src/mcp/**/*.ts"],
    rules: restrict(
      [
        SQLITE,
        ...["node:child_process", "node:net", "node:http", "node:https", "node:fs", "node:fs/promises", "node:worker_threads"].map((name) => ({
          name,
          message: "The MCP server must not spawn processes, open sockets or touch files.",
        })),
      ],
      [
        { group: ["**/cli/**"], message: "MCP must not depend on the CLI." },
        { group: ["**/adapters/storage/*", "!**/adapters/storage/processLiveness.js"], message: "MCP reads storage only through app/marketHistory (read-only)." },
        { group: ["**/app/collectMarkets*"], message: "MCP never collects or writes to the database." },
      ],
    ),
  },
);
