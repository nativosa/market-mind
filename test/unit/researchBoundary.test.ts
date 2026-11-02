import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Stage 3.1: src/research/contracts.ts is the one module browser code may import. Lint checks direct
// imports only, so this walks the whole static import graph and checks every module it reaches.

const ROOT = resolve(import.meta.dirname, "../..");
// Type-only imports are erased at compile time, so they never reach a bundle.
const IMPORT = /^\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+"([^"]+)"/gm;

function graph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (spec!.startsWith(".")) visit(resolve(dirname(file), spec!.replace(/\.js$/, ".ts")));
      else packages.add(spec!);
    }
  };
  visit(resolve(ROOT, entry));
  return { files: [...files].map((f) => relative(ROOT, f).replaceAll("\\", "/")).sort(), packages: [...packages].sort() };
}

describe("research layer boundary", () => {
  it("contracts.ts reaches only zod and pure analytics constants", () => {
    const { files, packages } = graph("src/research/contracts.ts");
    expect(packages).toEqual(["zod"]);
    expect(files).toEqual(["src/analytics/version.ts", "src/research/contracts.ts"]);
  });

  it("no research module imports Node built-ins or the MCP SDK", () => {
    for (const entry of ["src/research/views.ts", "src/research/envelope.ts", "src/research/liveGate.ts"]) {
      const { files, packages } = graph(entry);
      expect(packages.filter((p) => p.startsWith("node:") || p.startsWith("@modelcontextprotocol/")), entry).toEqual([]);
      expect(files.filter((f) => /^src\/(mcp|cli|adapters\/storage)\//.test(f) && !f.endsWith("processLiveness.ts")), entry).toEqual([]);
    }
  });
});
