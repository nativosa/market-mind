import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MarketsOutput } from "../../src/research/contracts";
import { fixture, json } from "../../test/helpers";
import { V1_ROUTES, V2_ROUTES } from "../../test/routes";
import { closeAllWeb, get, startWeb } from "../../test/webFixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { createApiClient, type FetchLike } from "../src/api";
import { BookComparison } from "../src/components/BookComparison";
import { INSPECT_LEVELS } from "../src/controller";
import { item, NOW, page, response, serverError, status } from "./fixtures";

afterEach(closeAllWeb);

function recording(reply: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return reply(url);
  };
  return { calls, client: createApiClient(fetchFn, () => NOW) };
}

describe("api client", () => {
  it("calls only same-origin /api paths with GET and encodes the cursor as one query value", async () => {
    const r = recording(() => response(page([item("1")])));
    await r.client.markets({ version: "v2", cursor: "a&b=c/d?e#f" });
    await r.client.markets({ version: "v1", cursor: null });
    await r.client.status();
    await r.client.inspect("123", { levels: 2 });
    expect(r.calls.map((c) => c.url)).toEqual(["/api/markets?version=v2&cursor=a%26b%3Dc%2Fd%3Fe%23f", "/api/markets?version=v1", "/api/status", "/api/markets/123/inspect?levels=2"]);
    expect(r.calls.every((c) => c.init.method === "GET" && c.init.credentials === "same-origin" && c.init.redirect === "error" && c.init.cache === "no-store")).toBe(true);
  });

  it("returns a validated page with exact decimal strings", async () => {
    const r = recording(() => response(page([item("1", { gammaVolume24hr: "1234567.890000001" })])));
    const result = await r.client.markets({ version: "v1" });
    expect(result).toMatchObject({ ok: true, receivedAt: NOW });
    expect(result.ok && result.data.markets.items[0]!.gammaVolume24hr).toBe("1234567.890000001");
  });

  it("maps the structured error contract and keeps retry guidance", async () => {
    const r = recording(() => response(serverError("budget_exhausted", "WINDOW_BUDGET_EXHAUSTED", { attempts: 0, retryAfterMs: 120_000 }), 429));
    const result = await r.client.markets({ version: "v1" });
    expect(result).toEqual({
      ok: false,
      error: { kind: "server", httpStatus: 429, receivedAt: NOW, error: { category: "budget_exhausted", code: "WINDOW_BUDGET_EXHAUSTED", message: "fixture", retryable: true, details: { attempts: 0, retryAfterMs: 120_000 } } },
    });
    expect(r.calls).toHaveLength(1); // never retried automatically
  });

  it.each([
    ["a 200 that breaks the contract", () => response({ ...page([item("1")]), markets: { returnedCount: 1, items: [{ gammaId: 1 }] } })],
    ["a 200 with an unknown contract field", () => response({ ...page([item("1")]), injected: "<script>" })],
    ["an error body without the error contract", () => response({ message: "boom" }, 500)],
    ["a body that is not JSON", () => new Response("<html>proxy error</html>", { status: 502 })],
  ])("rejects %s as invalid_response", async (_name, reply) => {
    const r = recording(reply);
    const result = await r.client.markets({ version: "v1" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it("reports a network failure, and an abort as aborted", async () => {
    const down = createApiClient(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await down.status()).toEqual({ ok: false, error: { kind: "network" } });
    const controller = new AbortController();
    const pending = createApiClient(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ).markets({ version: "v1" }, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { kind: "aborted" } });
  });

  it("treats an answer that arrives after its abort as aborted", async () => {
    const controller = new AbortController();
    const client = createApiClient(() => {
      controller.abort();
      return Promise.resolve(response(page([item("1")])));
    });
    expect(await client.markets({ version: "v1" }, controller.signal)).toEqual({ ok: false, error: { kind: "aborted" } });
  });

  it("validates status", async () => {
    const r = recording(() => response(status));
    expect(await r.client.status()).toMatchObject({ ok: true, data: { readOnly: true } });
  });
});

describe("api client against the real local server (fixture upstream)", () => {
  it("lists, pages and reports budget errors exactly as the server sends them", async () => {
    const s = await startWeb({
      routes: { after_cursor: json({ markets: [], next_cursor: null }), "/markets/keyset": json(fixture("gamma/keyset-v1.json")) },
      window: { limit: 10, windowMs: 300_000 },
    });
    const viaHttp: FetchLike = async (url) => {
      const r = await get(s.port, url);
      return new Response(r.text, { status: r.status, headers: { "content-type": String(r.headers["content-type"]) } });
    };
    const client = createApiClient(viaHttp, () => NOW);
    const first = await client.markets({ version: "v1" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(MarketsOutput.parse(first.data).markets.items.map((m) => m.gammaId)).toEqual(["100001", "100002"]);
    expect(first.data.pagination.nextCursor).toBe("cursor-page-2");
    const second = await client.markets({ version: "v1", cursor: first.data.pagination.nextCursor });
    expect(second).toMatchObject({ ok: true, data: { status: "empty", query: { cursor: "cursor-page-2" } } });
    expect(new URL(s.urls[1]!).searchParams.get("after_cursor")).toBe("cursor-page-2");
    expect((await client.status()).ok).toBe(true);
    const refused = await client.inspect("abc", {});
    expect(refused).toMatchObject({ ok: false, error: { kind: "server", httpStatus: 400, error: { category: "invalid_arguments" } } });
  });
});

describe("inspection through the real local server (fixture upstream)", () => {
  async function inspectVia(routes: typeof V1_ROUTES, id: string) {
    const s = await startWeb({ routes });
    const paths: string[] = [];
    const viaHttp: FetchLike = async (url) => {
      paths.push(url);
      const r = await get(s.port, url);
      return new Response(r.text, { status: r.status, headers: { "content-type": String(r.headers["content-type"]) } });
    };
    const result = await createApiClient(viaHttp, () => NOW).inspect(id, { levels: INSPECT_LEVELS });
    return { s, paths, result };
  }

  it("V1: the browser asks only /api; the server's best-first ladder and exact strings reach the screen", async () => {
    const { s, paths, result } = await inspectVia(V1_ROUTES, "100001");
    expect(paths).toEqual([`/api/markets/100001/inspect?levels=${INSPECT_LEVELS}`]);
    expect(s.urls.every((u) => u.startsWith("https://gamma.example/") || u.startsWith("https://clob.example/"))).toBe(true);
    expect(s.urls).toHaveLength(4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.appliedLimits.levels).toBe(20);
    const markup = renderToStaticMarkup(createElement(BookComparison, { inspection: result.data, depth: 20, onDepth: () => {} }));
    const yes = markup.slice(markup.indexOf(">Yes</h4>"), markup.indexOf("</article>"));
    const cells = (side: string) => {
      const start = yes.indexOf(`>${side}<`);
      return [...yes.slice(start, yes.indexOf("</table>", start)).matchAll(/<td class="mono">([^<]+)<\/td>/g)].map((m) => m[1]);
    };
    // Upstream sends bids worst-first and asks worst-first; the server's analytics order them best first.
    expect(cells("Bids")).toEqual(["0.036", "0.035", "0.02", "0.001"]);
    expect(cells("Asks")).toEqual(["0.037", "0.04", "0.5", "0.999"]);
    expect(yes).toContain("10,198,713.84");
    expect(yes).toContain("250.5");
  });

  it("V2: team-name outcomes arrive without a Yes/No role", async () => {
    const { result } = await inspectVia(V2_ROUTES, "200002");
    expect(result.ok && result.data.outcomes.map((o) => [o.label, o.role, o.metrics?.state])).toEqual([
      ["Team Alpha", null, "empty"],
      ["Team Beta", null, "two-sided"],
    ]);
  });

  it("an unknown market is a 404 market_not_found", async () => {
    const { result } = await inspectVia({ "/markets/555": json({ error: "not found" }, 404) }, "555");
    expect(result).toMatchObject({ ok: false, error: { kind: "server", httpStatus: 404, error: { category: "market_not_found", retryable: false } } });
  });
});
