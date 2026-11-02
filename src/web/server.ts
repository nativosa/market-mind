import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WEB_CONTRACT, type WebErrorCategory, type WebErrorOutput } from "../research/contracts.js";
import { describeError } from "../research/envelope.js";
import { matchRoute, type RouteDeps } from "./routes.js";
import { allowedFor, API_CSP, checkRequest, COMMON_HEADERS, PAGE_CSP, type Allowed } from "./security.js";
import { WEB_HOST } from "./settings.js";
import { readStatic } from "./static.js";

export interface WebDeps extends RouteDeps {
  /** Extra allowed browser origins (a local dev server proxying /api). */
  devOrigins: readonly string[];
  /** Real path of the built SPA directory, or null when the UI has not been built. */
  staticRoot: string | null;
  /** Diagnostics (stderr in production). Never receives query strings, cursors or request bodies. */
  log: (line: string) => void;
}

export interface WebServer {
  readonly server: Server;
  /** Bind to 127.0.0.1 only; resolves with the bound port. */
  listen(port: number): Promise<number>;
  /** Stop accepting, cancel every live call (queued or in flight), answer them 503, then close all sockets. */
  close(): Promise<void>;
}

/** Longest request target accepted (path and query). A cursor is at most 512 characters. */
const MAX_TARGET_CHARS = 2_048;

type ErrorBody = WebErrorOutput["error"];

/** HTTP status for an error body: distinct statuses for client errors, budget, rate limits, upstream and timeouts. */
export function httpStatusOf(error: ErrorBody): number {
  switch (error.category) {
    case "invalid_arguments":
      return 400;
    case "forbidden":
      return 403;
    case "market_not_found":
    case "route_not_found":
      return 404;
    case "method_not_allowed":
      return 405;
    case "market_ineligible":
      return 422;
    case "budget_exhausted":
      // The rolling window recovers (429 + Retry-After); the lifetime ceiling does not until restart.
      return error.code === "WINDOW_BUDGET_EXHAUSTED" ? 429 : 503;
    case "rate_limited":
    case "cancelled":
      return 503;
    case "upstream_unavailable":
      return error.details.kind === "Timeout" ? 504 : 502;
    case "upstream_invalid_data":
      return 502;
    case "deadline_exceeded":
      return 504;
    default:
      return 500;
  }
}

const refusal = (category: WebErrorCategory, code: string, message: string): ErrorBody => ({ category, code, message, retryable: false, details: {} });

export function createWebServer(deps: WebDeps): WebServer {
  let allowed: Allowed | null = null;
  let closing = false;
  const live = new Set<AbortController>();
  const pending = new Set<Promise<void>>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    let label = "-";

    const send = (status: number, headers: Record<string, string>, body: string | Buffer) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { ...COMMON_HEADERS, "cache-control": "no-store", ...headers, "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
    };
    const sendJson = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      send(status, { "content-type": "application/json; charset=utf-8", "content-security-policy": API_CSP, ...headers }, JSON.stringify(value));
    const sendError = (error: ErrorBody, headers: Record<string, string> = {}) => {
      const retryAfterMs = error.details.retryAfterMs;
      const retry = typeof retryAfterMs === "number" ? { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } : {};
      const body: WebErrorOutput = { contract: WEB_CONTRACT.error, error };
      sendJson(httpStatusOf(error), body, { ...retry, ...headers });
    };

    try {
      if (closing) return sendError(refusal("cancelled", "SHUTTING_DOWN", "The server is shutting down."));
      const target = req.url ?? "";
      if (target.length > MAX_TARGET_CHARS) return sendError(refusal("invalid_arguments", "URL_TOO_LONG", "The request URL is too long."));
      // Origin-form only: no absolute-form ("GET http://host/...") or protocol-relative targets.
      if (!target.startsWith("/") || target.startsWith("//")) return sendError(refusal("invalid_arguments", "BAD_REQUEST_TARGET", "Malformed request target."));
      const q = target.indexOf("?");
      const path = q === -1 ? target : target.slice(0, q);
      const api = path === "/api" || path.startsWith("/api/");

      // Security checks come first: a refused request never reaches routing, let alone a live call.
      const refused = checkRequest(req.headers, allowed!, api ? "api" : "static");
      if (refused) return sendError(refusal("forbidden", refused.code, refused.message));
      if (req.method !== "GET") return sendError(refusal("method_not_allowed", "METHOD_NOT_ALLOWED", "Only GET is supported: this server is read-only."), { allow: "GET" });
      const contentLength = req.headers["content-length"];
      if (req.headers["transfer-encoding"] !== undefined || (contentLength !== undefined && contentLength !== "0")) {
        return sendError(refusal("invalid_arguments", "BODY_NOT_ALLOWED", "Requests must not carry a body."));
      }

      if (!api) {
        label = "static";
        if (deps.staticRoot === null) return sendError(refusal("route_not_found", "UI_NOT_BUILT", "The web UI has not been built yet."));
        const file = await readStatic(deps.staticRoot, path);
        if (!file.ok) {
          return sendError(refusal(file.status === 400 ? "invalid_arguments" : "route_not_found", file.code, file.status === 400 ? "Path not allowed." : "Not found."));
        }
        return send(200, { "content-type": file.contentType, "content-security-policy": PAGE_CSP, "cache-control": "no-cache" }, file.body);
      }

      const match = matchRoute(path);
      if (!match) return sendError(refusal("route_not_found", "ROUTE_NOT_FOUND", "No such API route."));
      label = match.route.name;
      const query = new URLSearchParams(q === -1 ? "" : target.slice(q + 1));
      const controller = new AbortController();
      if (match.route.live) {
        // The response's close, not the request's: a GET's request stream closes as soon as it has
        // been read, while the response closes early only when the browser goes away.
        res.on("close", () => {
          if (!res.writableFinished) controller.abort(new Error("client disconnected"));
        });
        live.add(controller);
      }
      try {
        sendJson(200, await match.route.handler({ deps, query, signal: controller.signal }, match.params));
      } finally {
        live.delete(controller);
      }
    } catch (error) {
      const described = describeError(error, "web server");
      if (described.category === "internal_error") deps.log(`internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (closing && described.category === "cancelled") return sendError(refusal("cancelled", "SHUTTING_DOWN", "The server is shutting down."));
      sendError(described);
    } finally {
      deps.log(`${req.method ?? "-"} ${label} ${res.headersSent ? res.statusCode : "closed"} ${Date.now() - started} ms`);
    }
  }

  const server = createServer((req, res) => {
    const task = handle(req, res).finally(() => pending.delete(task));
    pending.add(task);
  });

  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, WEB_HOST, () => {
          server.off("error", reject);
          const address = server.address();
          const bound = typeof address === "object" && address !== null ? address.port : port;
          allowed = allowedFor(bound, deps.devOrigins);
          resolve(bound);
        });
      });
    },
    async close() {
      closing = true;
      const stopped = new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
      for (const controller of live) controller.abort(new Error("server shutting down"));
      await Promise.allSettled([...pending]);
      server.closeAllConnections();
      await stopped;
    },
  };
}
