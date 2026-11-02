import type { IncomingHttpHeaders } from "node:http";

/** The browser origins (and so the Host values) this server answers to. */
export interface Allowed {
  origins: ReadonlySet<string>;
  hosts: ReadonlySet<string>;
}

/** The server's own two loopback origins, plus any explicitly configured dev-server origins. Never a wildcard. */
export function allowedFor(port: number, devOrigins: readonly string[]): Allowed {
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...devOrigins]);
  return { origins, hosts: new Set([...origins].map((o) => o.slice("http://".length))) };
}

export interface Refusal {
  code: "HOST_NOT_ALLOWED" | "ORIGIN_NOT_ALLOWED" | "CROSS_SITE_REQUEST";
  message: string;
}

/**
 * Checks run on every request before routing, so a refused request never reaches a live call:
 * - Host must name this server (blocks DNS rebinding: a foreign name that resolves to 127.0.0.1);
 * - an Origin header, when present, must be one of ours (no CORS, so foreign pages get nothing);
 * - Fetch Metadata: cross-site requests are refused, and same-site ones need an allowed Origin.
 * The one exception is a top-level navigation to a static page (someone following a link to the
 * app); API routes never accept it.
 */
export function checkRequest(headers: IncomingHttpHeaders, allowed: Allowed, kind: "api" | "static"): Refusal | null {
  const host = headers.host?.toLowerCase();
  if (host === undefined || !allowed.hosts.has(host)) {
    return { code: "HOST_NOT_ALLOWED", message: "The Host header does not name this local server." };
  }
  const origin = headers.origin;
  if (origin !== undefined && !allowed.origins.has(origin)) {
    return { code: "ORIGIN_NOT_ALLOWED", message: "Requests from other origins are not allowed." };
  }
  const site = headers["sec-fetch-site"];
  const crossSite = site === "cross-site" || (site === "same-site" && origin === undefined);
  const navigation = kind === "static" && headers["sec-fetch-mode"] === "navigate" && origin === undefined;
  if (crossSite && !navigation) {
    return { code: "CROSS_SITE_REQUEST", message: "Cross-site requests are not allowed." };
  }
  return null;
}

/** Sent with every response. No Access-Control-* header is ever sent. */
export const COMMON_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

export const API_CSP = "default-src 'none'; frame-ancestors 'none'";
/** The SPA loads only its own files: no inline script, no third-party origins, no framing. */
export const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
