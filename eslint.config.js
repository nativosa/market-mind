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
    files: ["**/*.js"],
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
      "no-restricted-imports": ["error", { patterns: [{ group: [...outerLayers, "**/analytics/**", "node:*"], message: "domain must not depend on outer layers or Node I/O." }] }],
    },
  },
  // Analytics: deterministic calculations over domain types only.
  {
    files: ["src/analytics/**/*.ts"],
    rules: {
      ...noFloatMath,
      "no-restricted-imports": ["error", { patterns: [{ group: [...outerLayers, "node:*"], message: "analytics may depend on domain only." }] }],
    },
  },
  // Adapters must not reach up into application or CLI code.
  {
    files: ["src/adapters/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/app/**", "**/cli/**"], message: "adapters must not depend on app or cli." }] }],
    },
  },
  {
    files: ["src/app/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/cli/**"], message: "app must not depend on cli." }] }],
    },
  },
);
