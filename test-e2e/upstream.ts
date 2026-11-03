import type { FetchFn } from "../src/adapters/polymarket/httpClient.js";
import { json } from "../test/helpers.js";
import { assetId, bookBody, conditionId, gammaRecord, mirror, type BookSpec, type MarketSpec } from "../test/scanFixtures.js";

// A deterministic, offline Polymarket for the E2E suite. Every upstream URL is recorded; a URL this
// world does not know is recorded as unexpected and fails like a network error, so a test can
// assert that nothing outside the fixtures was ever requested.

export const GAMMA = "https://gamma.example";
export const CLOB = "https://clob.example";

/** How long the "slow" market's books take, so a test can act while an inspection is in flight. */
export const SLOW_MS = 1_500;

interface WorldMarket extends MarketSpec {
  /** Replaces the default book replies (index 0, 1). */
  bookReply?: (index: number) => Response;
  /** Gamma's single-market answer (default: the listing record). */
  detail?: "not_found";
  slow?: boolean;
}

const ladder = (from: number, count: number, step: 1 | -1): [string, string][] =>
  Array.from({ length: count }, (_, i) => [`0.${String(from + step * i).padStart(2, "0")}`, `${(i + 1) * 125}.25`]);

const DEEP: BookSpec = { bids: ladder(47, 12, -1), asks: ladder(49, 12, 1) };

const v1 = (id: string, question: string, volume24hr: number | null, extra: Partial<WorldMarket> = {}): WorldMarket => ({
  ...extra,
  id,
  volume24hr,
  gamma: { question, endDate: "2027-03-31T12:00:00Z", ...extra.gamma },
});

/** V1 listing pages: page 2 repeats one market of page 1 (deduplicated by the explorer). */
export const V1_PAGES: WorldMarket[][] = [
  [
    v1("310001", "Will the valid V1 market resolve Yes?", 5000.75, { book: DEEP }),
    v1("310002", "Will the one-sided market find a seller?", 4000, { book: { bids: [["0.30", "40"]], asks: [] } }),
    v1("310003", "Will the invalid book be caught?", 3000, { other: { bids: [["0.55", "10"]], asks: [["0.60", "10"]], raw: { bids: [{ price: "abc", size: "10" }] } } }),
    v1("310004", "Is the empty book handled honestly?", 2000, { book: { bids: [], asks: [] } }),
    v1("310005", "Slow market: will the answer be late?", 1500.5, { slow: true }),
    v1("310006", "Ineligible: is the order book disabled?", 1000, { gamma: { enableOrderBook: false } }),
    v1("310007", "Missing metadata: are gaps shown?", 900, {
      book: { bids: [["0.20", "15"]], asks: [["0.25", "15"]], raw: { timestamp: undefined, tick_size: undefined, last_trade_price: undefined } },
      other: { bids: [["0.75", "15"]], asks: [["0.80", "15"]], raw: { timestamp: "4102444800000" } },
    }),
    v1("310008", "Rate limited: will Polymarket refuse?", 800, { bookReply: () => json({ error: "rate limited" }, 429, { "retry-after": "1" }) }),
    v1("310009", `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> Untrusted text?`, 700),
    v1("310010", "Removed upstream: is it gone?", 600, { detail: "not_found" }),
    v1("310011", "Upstream outage: does the book fail?", null, { bookReply: () => json({ error: "unavailable" }, 503) }),
  ],
  [v1("310005", "Slow market: will the answer be late?", 1500.5, { slow: true }), v1("310012", "Second page market A?", 300), v1("310013", "Second page market B?", 200)],
  [v1("310014", "Last page market?", 100)],
];

export const V2_PAGES: WorldMarket[][] = [
  [
    { id: "320001", version: "v2", labels: ["Team Alpha", "Team Beta"], volume24hr: 2500, gamma: { question: "Team Alpha vs. Team Beta?" }, book: { bids: [["0.45", "20"]], asks: [["0.55", "30"]] } },
    { id: "320002", version: "v2", labels: ["Over", "Under"], volume24hr: 1200, gamma: { question: "Over or under the fixture line?" } },
  ],
];

const markets = new Map<string, WorldMarket>();
for (const m of [...V1_PAGES.flat(), ...V2_PAGES.flat()]) markets.set(m.id, m);

const cursorOf = (pages: unknown[], i: number) => (i + 1 < pages.length ? `c${i + 2}` : null);

function keyset(url: URL): Response | null {
  const pages = url.searchParams.get("version") === "v2" ? V2_PAGES : V1_PAGES;
  const after = url.searchParams.get("after_cursor");
  const index = after === null ? 0 : Number(/^c(\d+)$/.exec(after)?.[1] ?? NaN) - 1;
  const page = pages[index];
  if (page === undefined) return null;
  return json({ markets: page.map(gammaRecord), next_cursor: cursorOf(pages, index) });
}

function book(m: WorldMarket, index: number): Response {
  if (m.bookReply) return m.bookReply(index);
  const ref = m.book ?? { bids: [["0.40", "100"]], asks: [["0.45", "100"]] };
  const spec = index === 0 ? ref : (m.other ?? mirror(ref));
  const body = bookBody(m, index, spec);
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  return json(body);
}

function route(url: URL): { reply: Response; slow: boolean } | null {
  if (url.origin === GAMMA) {
    if (url.pathname === "/markets/keyset") {
      const reply = keyset(url);
      return reply && { reply, slow: false };
    }
    const id = /^\/markets\/(\d+)$/.exec(url.pathname)?.[1];
    if (id === undefined) return null;
    const m = markets.get(id);
    // Gamma answers unknown ids with 422 (observed live).
    if (m === undefined || m.detail === "not_found") return { reply: json({ error: "id is invalid" }, 422), slow: false };
    return { reply: json(gammaRecord(m)), slow: false };
  }
  if (url.origin === CLOB) {
    const condition = /^\/clob-markets\/(0x[0-9a-c]+)$/.exec(url.pathname)?.[1];
    if (condition !== undefined) {
      const m = [...markets.values()].find((x) => conditionId(x.id) === condition);
      const labels = m?.labels ?? ["Yes", "No"];
      return m ? { reply: json({ t: labels.map((o, i) => ({ t: assetId(m.id, i), o })) }), slow: false } : null;
    }
    if (url.pathname === "/book") {
      const token = url.searchParams.get("token_id");
      for (const m of markets.values()) {
        for (const index of [0, 1]) if (assetId(m.id, index) === token) return { reply: book(m, index), slow: m.slow === true };
      }
    }
  }
  return null;
}

export interface Upstream {
  fetch: FetchFn;
  urls: string[];
  unexpected: string[];
}

export function createUpstream(): Upstream {
  const urls: string[] = [];
  const unexpected: string[] = [];
  const fetch: FetchFn = async (input, init) => {
    urls.push(input);
    const found = route(new URL(input));
    if (found === null) {
      unexpected.push(input);
      throw new TypeError(`fetch failed: no fixture for ${input}`);
    }
    if (found.slow) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, SLOW_MS);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason instanceof Error ? init.signal.reason : new DOMException("aborted", "AbortError"));
        });
      });
    }
    return found.reply;
  };
  return { fetch, urls, unexpected };
}
