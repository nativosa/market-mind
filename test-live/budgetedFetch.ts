import type { FetchFn } from "../src/adapters/polymarket/httpClient.js";

/**
 * Real fetch with a hard request budget. Every HTTP request counts, including market-detail
 * lookups. Exceeding the budget is recorded (and the request refused) so the test can FAIL on it,
 * even though the HTTP client would otherwise surface the refusal as a network error.
 */
export function budgetedFetch(limit: number) {
  const urls: string[] = [];
  let exceeded = false;
  const fetch: FetchFn = (url, init) => {
    if (urls.length >= limit) {
      exceeded = true;
      return Promise.reject(new Error(`Live request budget of ${limit} exceeded at ${url}`));
    }
    urls.push(url);
    return globalThis.fetch(url, init);
  };
  return {
    fetch,
    urls,
    limit,
    get exceeded() {
      return exceeded;
    },
  };
}
