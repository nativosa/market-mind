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
  { ignores: ["node_modules/", "coverage/", "dist/", "web/dist/", "test-results/", "playwright-report/"] },
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
  // Research: transport-neutral contracts, views, envelopes and the live gate, shared by MCP and the
  // future web server. No transport (MCP SDK, sockets), no Node I/O, no CLI, no storage, no writes.
  {
    files: ["src/research/**/*.ts"],
    ignores: ["src/research/contracts.ts"],
    rules: restrict(
      [SQLITE],
      [
        { group: ["node:*"], message: "src/research must stay free of Node I/O." },
        { group: ["**/cli/**", "**/mcp/**"], message: "src/research must not depend on the CLI or a transport." },
        { group: ["**/adapters/storage/**", "**/app/collectMarkets*"], message: "src/research never touches storage or collects." },
        MCP_SDK,
      ],
    ),
  },
  // Contracts are the one research module browser code may import: zod schemas and constants only.
  {
    files: ["src/research/contracts.ts"],
    rules: restrict(
      [SQLITE],
      [
        { group: [...outerLayers, "**/mcp/**", "**/research/**", "./*", "!./contracts*", "node:*"], message: "contracts.ts is browser-safe: zod and analytics/version only." },
        MCP_SDK,
      ],
    ),
  },
  // Web: the local HTTP API over the research layer. A loopback socket and read-only static files
  // only: no SQLite, storage, collection, processes, agents, MCP or CLI.
  {
    files: ["src/web/**/*.ts"],
    rules: restrict(
      [
        SQLITE,
        ...["node:child_process", "node:net", "node:https", "node:fs", "node:worker_threads"].map((name) => ({
          name,
          message: "The web server must not spawn processes, open other sockets or write files.",
        })),
        { name: "node:fs/promises", allowImportNames: ["readFile", "realpath", "stat"], message: "The web server only reads its built static files." },
      ],
      [
        { group: ["**/cli/**", "**/mcp/**"], message: "The web server must not depend on the CLI or MCP." },
        { group: ["**/adapters/storage/**", "**/app/collectMarkets*", "**/agent-sdk/**", "**/test-agent/**"], message: "The web server never touches storage, collects or runs agents." },
        MCP_SDK,
      ],
    ),
  },
  // Browser code (web/src): DOM only. Its one link to the server code is src/research/contracts.ts
  // (Zod schemas, no Node). No Node globals, no raw HTML, and network access only through api.ts.
  {
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    rules: {
      ...restrict(
        [],
        [
          { group: ["node:*"], message: "Browser code must not import Node built-ins." },
          { regex: "^(\\.\\./)+(src|agent-sdk|test|test-agent|bin)/(?!research/contracts(\\.js)?$)", message: "Browser code may import only src/research/contracts from the server code." },
          { group: ["@modelcontextprotocol/*", "@anthropic-ai/*", "big.js"], message: "Browser code must not depend on MCP, agent or server-only packages." },
        ],
      ),
      "no-restricted-syntax": [
        "error",
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Render third-party text as plain text only." },
        { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]", message: "Render third-party text as plain text only." },
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: "Render third-party text as plain text only." },
      ],
    },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    ignores: ["web/src/api.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["process", "Buffer", "require", "global", "__dirname", "__filename"].map((name) => ({ name, message: "Browser code must not use Node globals." })),
        ...["fetch", "XMLHttpRequest", "WebSocket", "EventSource"].map((name) => ({ name, message: "Network access belongs in web/src/api.ts (same-origin /api only)." })),
      ],
    },
  },
  {
    files: ["web/src/api.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["process", "Buffer", "require", "global", "__dirname", "__filename"].map((name) => ({ name, message: "Browser code must not use Node globals." })),
        ...["XMLHttpRequest", "WebSocket", "EventSource"].map((name) => ({ name, message: "The API client uses fetch to same-origin /api only." })),
      ],
    },
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
