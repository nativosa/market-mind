import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The browser bundle: what it may import (whole static import graph) and what the production build
// actually contains. Everything runs offline into a temporary directory.

const WEB = resolve(import.meta.dirname, "..");
const ROOT = resolve(WEB, "..");
const IMPORT = /^\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm;

function resolveLocal(from: string, spec: string): string {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try the next extension
    }
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

function graph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    if (extname(file) === ".css") return;
    for (const [, from, bare] of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = (from ?? bare)!;
      if (spec.startsWith(".")) visit(resolveLocal(file, spec));
      else packages.add(spec);
    }
  };
  visit(entry);
  return { files: [...files].map((f) => relative(ROOT, f).replaceAll("\\", "/")).sort(), packages: [...packages].sort() };
}

describe("browser import boundary", () => {
  it("main.tsx reaches only React, Zod, its own files and the shared contracts", () => {
    const { files, packages } = graph(resolve(WEB, "src/main.tsx"));
    expect(packages).toEqual(["react", "react-dom/client", "zod"]);
    expect(files.filter((f) => !f.startsWith("web/src/"))).toEqual(["src/analytics/version.ts", "src/research/contracts.ts"]);
  });
});

describe("production build", () => {
  const out = mkdtempSync(join(tmpdir(), "marketmind-web-build-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("builds to static files the server will serve, with no inline script and nothing server-side inside", { timeout: 60_000 }, () => {
    // A separate process, exactly as `npm run web:build` runs it: inside Vitest (NODE_ENV=test) Vite
    // would bundle React's development build instead.
    const vite = resolve(ROOT, "node_modules/vite/bin/vite.js");
    const result = spawnSync(process.execPath, [vite, "build", "--config", resolve(WEB, "vite.config.ts"), "--outDir", out, "--emptyOutDir", "--logLevel", "error"], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const list = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(join(dir, e.name)) : [join(dir, e.name)]));
    const built = list(out).map((f) => relative(out, f).replaceAll("\\", "/"));
    expect(built).toContain("index.html");
    // Only types the static server allows; no source maps or source files.
    expect(built.filter((f) => ![".html", ".js", ".css"].includes(extname(f)))).toEqual([]);

    const index = readFileSync(join(out, "index.html"), "utf8");
    expect([...index.matchAll(/<script\b[^>]*>/g)].every(([tag]) => /\ssrc="\/assets\/[^"]+\.js"/.test(tag))).toBe(true);
    expect(index).not.toMatch(/<script\b[^>]*>[^<\s]/);

    const code = built.filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    const backslash = String.fromCharCode(92);
    expect(code, "React's production build").not.toContain("is deprecated in plain JavaScript");
    for (const forbidden of [/["'`]node:[a-z]/, /@modelcontextprotocol/, /@anthropic-ai/, /MARKETMIND_/, /sqlite/i, /child_process/, /process\.env/, /gamma-api\.polymarket/, /clob\.polymarket/]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    for (const local of [ROOT, ROOT.replaceAll(backslash, "/"), "/Users/", "/home/"]) expect(code).not.toContain(local);
    // The only absolute URLs are library constants (React's error-decoder link and SVG/MathML
    // namespaces, Zod's JSON Schema identifiers), never fetched: no upstream or third-party host.
    const urls = new Set([...code.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)].map(([u]) => u));
    expect([...urls].filter((u) => !["https://react.dev", "http://www.w3.org", "http://json-schema.org", "https://json-schema.org"].includes(u))).toEqual([]);
  });
});
