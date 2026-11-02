import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

/** Only these file types are ever served; source, maps, data, databases and dotfiles are not among them. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const MAX_STATIC_BYTES = 10 * 1024 * 1024;
/** Plain segments only: no empty, dot-leading (".env", ".."), encoded or Windows-special names. */
const SAFE_PATH = /^(\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127})+$/;

export type StaticFile = { ok: true; body: Buffer; contentType: string } | { ok: false; status: 400 | 404; code: "PATH_NOT_ALLOWED" | "FILE_NOT_FOUND" };

const NOT_FOUND = { ok: false, status: 404, code: "FILE_NOT_FOUND" } as const;

/** The real path of the built SPA directory, or null when it does not exist (UI not built yet). */
export async function staticRootOf(dir: string): Promise<string | null> {
  try {
    const real = await realpath(dir);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a raw request path (never URL-normalized, so "/a/../b" and "%2e%2e" are seen as sent)
 * inside `root`, which must be a real path. Containment is checked twice: lexically, and again after
 * resolving symlinks and junctions, so a link inside the build directory cannot point out of it.
 */
export async function readStatic(root: string, rawPath: string): Promise<StaticFile> {
  if (/[%\\]|\/\.\.?(\/|$)/.test(rawPath)) return { ok: false, status: 400, code: "PATH_NOT_ALLOWED" };
  const path = rawPath === "/" ? "/index.html" : rawPath;
  const ext = extname(path).toLowerCase();
  const contentType = Object.hasOwn(CONTENT_TYPES, ext) ? CONTENT_TYPES[ext] : undefined;
  if (!SAFE_PATH.test(path) || contentType === undefined) return NOT_FOUND;
  const inside = (p: string) => p.startsWith(root + sep);
  const candidate = resolve(root, `.${path}`);
  if (!inside(candidate)) return NOT_FOUND;
  try {
    const real = await realpath(candidate);
    if (!inside(real)) return NOT_FOUND;
    const info = await stat(real);
    if (!info.isFile() || info.size > MAX_STATIC_BYTES) return NOT_FOUND;
    return { ok: true, body: await readFile(real), contentType };
  } catch {
    return NOT_FOUND;
  }
}
