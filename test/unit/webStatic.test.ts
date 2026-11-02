import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebErrorOutput } from "../../src/research/contracts.js";
import { readStatic, staticRootOf } from "../../src/web/static.js";
import { closeAllWeb, startWeb } from "../webFixtures.js";

// Stage 3.1: the built SPA is served from one directory only, by allowlisted type, with containment
// checked before and after resolving links.

afterEach(closeAllWeb);

let base: string;
let root: string;
let fileLink = false;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "marketmind-static-"));
  const dist = join(base, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>MarketMind</title>");
  writeFileSync(join(dist, "assets", "app-1a2b.js"), "console.log('app')");
  writeFileSync(join(dist, "assets", "app-1a2b.css"), "body{}");
  writeFileSync(join(dist, "assets", "app-1a2b.js.map"), "{\"sources\":[\"../src/secret.ts\"]}");
  writeFileSync(join(dist, ".env"), "TOKEN=leak");
  writeFileSync(join(dist, "marketmind.sqlite"), "SQLite format 3");
  writeFileSync(join(dist, "main.ts"), "export const source = 1;");
  mkdirSync(join(dist, "folder.js"));
  mkdirSync(join(base, "outside"));
  writeFileSync(join(base, "outside", "secret.js"), "OUTSIDE");
  writeFileSync(join(base, "secret.txt"), "OUTSIDE");
  // A directory junction needs no privileges on Windows; a file symlink may (skipped then).
  symlinkSync(join(base, "outside"), join(dist, "linked"), "junction");
  try {
    symlinkSync(join(base, "outside", "secret.js"), join(dist, "escape.js"), "file");
    fileLink = true;
  } catch {
    fileLink = false;
  }
  root = (await staticRootOf(dist))!;
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("readStatic", () => {
  it("serves allowlisted types with correct content types", async () => {
    expect(await readStatic(root, "/")).toMatchObject({ ok: true, contentType: "text/html; charset=utf-8" });
    expect(await readStatic(root, "/index.html")).toMatchObject({ ok: true, contentType: "text/html; charset=utf-8" });
    const js = await readStatic(root, "/assets/app-1a2b.js");
    expect(js).toMatchObject({ ok: true, contentType: "text/javascript; charset=utf-8" });
    expect(js.ok && js.body.toString()).toBe("console.log('app')");
    expect(await readStatic(root, "/assets/app-1a2b.css")).toMatchObject({ ok: true, contentType: "text/css; charset=utf-8" });
  });

  it.each([
    "/../secret.txt",
    "/assets/../../secret.txt",
    "/assets/./app-1a2b.js",
    "/%2e%2e/secret.txt",
    "/%2E%2E%2Fsecret.txt",
    "/assets%2f..%2f..%2fsecret.txt",
    "/..%5csecret.txt",
    "/..\\secret.txt",
    "/assets/app-1a2b.js%00.html",
    "/%252e%252e/secret.txt",
  ])("refuses traversal %s with 400", async (path) => {
    expect(await readStatic(root, path)).toEqual({ ok: false, status: 400, code: "PATH_NOT_ALLOWED" });
  });

  it.each([
    "/.env",
    "/marketmind.sqlite",
    "/main.ts",
    "/assets/app-1a2b.js.map",
    "/folder.js",
    "/missing.js",
    "/linked/secret.js",
    "/C:/Windows/win.ini",
    "/index.html.",
    "/index.html::$DATA",
    "/INDEX~1.HTM",
    "//etc/passwd",
    "/assets/",
  ])("does not serve %s", async (path) => {
    expect(await readStatic(root, path)).toEqual({ ok: false, status: 404, code: "FILE_NOT_FOUND" });
  });

  it("does not follow a file symlink out of the build directory", async (ctx) => {
    if (!fileLink) ctx.skip();
    expect(await readStatic(root, "/escape.js")).toEqual({ ok: false, status: 404, code: "FILE_NOT_FOUND" });
  });

  it("treats a missing build directory as not built", async () => {
    expect(await staticRootOf(join(base, "nope"))).toBeNull();
    expect(await staticRootOf(join(base, "secret.txt"))).toBeNull();
  });
});

describe("static files over HTTP", () => {
  it("serves the SPA with a strict CSP and security headers", async () => {
    const s = await startWeb({ staticRoot: root });
    const r = await s.get("/");
    expect(r.status).toBe(200);
    expect(r.text).toContain("<title>MarketMind</title>");
    expect(r.headers).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cache-control": "no-cache",
    });
    expect(r.headers["content-security-policy"]).toMatch(/^default-src 'self'; script-src 'self';.*frame-ancestors 'none'$/);
    expect(r.headers["content-security-policy"]).not.toContain("unsafe-inline");
  });

  it.each(["/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/..%5csecret.txt", "/linked/secret.js", "/.env", "/marketmind.sqlite"])(
    "never returns content from outside the build directory or a forbidden file: %s",
    async (path) => {
      const s = await startWeb({ staticRoot: root });
      const r = await s.get(path);
      expect([400, 404]).toContain(r.status);
      expect(r.text).not.toMatch(/OUTSIDE|TOKEN|SQLite format/);
      expect(r.text).not.toContain(base);
      WebErrorOutput.parse(r.json());
    },
  );

  it("allows a cross-site top-level navigation to the page, but not a cross-site subresource", async () => {
    const s = await startWeb({ staticRoot: root });
    expect((await s.get("/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } })).status).toBe(200);
    expect((await s.get("/assets/app-1a2b.js", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } })).status).toBe(403);
    expect((await s.get("/", { headers: { host: "evil.example" } })).status).toBe(403);
  });

  it("explains that the UI is not built when there is no build directory", async () => {
    const s = await startWeb({ staticRoot: null });
    const r = await s.get("/");
    expect(r.status).toBe(404);
    expect(WebErrorOutput.parse(r.json()).error.code).toBe("UI_NOT_BUILT");
  });
});
