import { describe, expect, it } from "vitest";
import { PAIR_SKEW_WARNING_MS as ANALYTICS_SKEW_MS } from "../../src/analytics/scanMetrics";
import { DATA_NOTICE } from "../../src/research/envelope";
import { LIVE_EVIDENCE_NOTE } from "../../src/research/views";
import { barPercent, barScale, depthChoices, HUMAN_NOTES, humanNote, formatMs, formatShares, formatTimestamp, issueText, ladderNote, ladderOf, orUnknown, PAIR_SKEW_WARNING_MS, roleText } from "../src/book";
import { focusSoon, hashFor, marketButtonId, marketIdFromHash, navigate, watchRoute, type RouteWindow } from "../src/route";
import { deepLevels, INSPECT_V1, withOutcome } from "./fixtures";

describe("book display helpers", () => {
  it("keeps the server's best-first order and only slices to the chosen depth", () => {
    const deep = withOutcome(INSPECT_V1, 0, (o) => ({ ...o, levels: deepLevels(12) })).outcomes[0]!;
    const five = ladderOf(deep, 5);
    expect(five.bids.map((l) => l.price)).toEqual(["0.50", "0.49", "0.48", "0.47", "0.46"]);
    expect(five.asks.map((l) => l.price)).toEqual(["0.51", "0.52", "0.53", "0.54", "0.55"]);
    expect(ladderOf(deep, 20).bids).toHaveLength(12);
    expect(ladderNote(deep, 5)).toBe("Showing 5 of 15 bid levels and 5 of 15 ask levels");
    const single = withOutcome(INSPECT_V1, 0, (o) => ({ ...o, levels: { ...o.levels, bids: o.levels.bids.slice(0, 1), totalBids: 1, asks: [], totalAsks: 0 } })).outcomes[0]!;
    expect(ladderNote(single, 5)).toBe("Showing 1 of 1 bid level and 0 of 0 ask levels");
  });

  it("offers depths that fit the levels the server applied", () => {
    expect(depthChoices(20)).toEqual([5, 10, 20]);
    expect(depthChoices(7)).toEqual([5, 7]);
    expect(depthChoices(2)).toEqual([2]);
  });

  it("scales bars approximately but never changes the displayed strings", () => {
    const levels = [
      { price: "0.5", size: "200" },
      { price: "0.4", size: "50.5" },
      { price: "0.3", size: "not-a-number" },
    ];
    expect(barScale(levels)).toBe(200);
    expect(barPercent("200", 200)).toBe(100);
    expect(barPercent("50.5", 200)).toBe(25.3);
    expect(barPercent("0.0001", 200)).toBe(1); // still visible
    expect(barPercent("0", 200)).toBe(0);
    expect(barPercent("x", 200)).toBe(0);
    expect(barPercent("5", 0)).toBe(0);
    expect(barScale([])).toBe(0);
    expect(formatShares("10200582.31")).toBe("10,200,582.31");
    expect(formatShares("0.000000000000000001")).toBe("0.000000000000000001");
    expect(formatShares(null)).toBe("Not reported");
    expect(orUnknown("0.001")).toBe("0.001");
    expect(orUnknown(null)).toBe("Not reported");
  });

  it("labels roles, issues, timestamps and durations in plain language", () => {
    expect([roleText("YES"), roleText("NO"), roleText(null)]).toEqual(["Yes side", "No side", "No Yes/No role"]);
    expect(issueText("MALFORMED_PRICE")).toBe("A price level is not a valid decimal.");
    expect(issueText("SOMETHING_NEW")).toBe("Reported by the quality checks.");
    expect(formatTimestamp("2026-10-28T21:05:37.744Z")).toBe("2026-10-28 21:05:37.744 UTC");
    expect(formatTimestamp("yesterday")).toBe("yesterday");
    expect(formatTimestamp(null)).toBe("Not reported");
    expect(formatMs(12_345)).toBe("12,345 ms");
  });

  it("has plain wording for every note the live inspection sends, and passes unknown text through", () => {
    for (const note of [DATA_NOTICE, LIVE_EVIDENCE_NOTE, ...INSPECT_V1.limitations, INSPECT_V1.evidenceNote]) expect(HUMAN_NOTES[note], note).toBeDefined();
    expect(humanNote("Something new from the server.")).toBe("Something new from the server.");
  });

  it("uses the same pair-skew threshold as the analytics", () => {
    expect(PAIR_SKEW_WARNING_MS).toBe(ANALYTICS_SKEW_MS);
  });
});

describe("hash route", () => {
  function fakeWindow(hash = "") {
    const listeners = new Set<() => void>();
    const win: RouteWindow & { fire: () => void; listeners: Set<() => void> } = {
      location: { hash },
      addEventListener: (_type, l) => listeners.add(l),
      removeEventListener: (_type, l) => listeners.delete(l),
      fire: () => listeners.forEach((l) => l()),
      listeners,
    };
    return win;
  }

  it("parses only numeric market routes", () => {
    expect(marketIdFromHash("#/market/123")).toBe("123");
    expect(marketIdFromHash("#/market/12a")).toBeNull();
    expect(marketIdFromHash("#/market/123/x")).toBeNull();
    expect(marketIdFromHash("")).toBeNull();
    expect(hashFor("5")).toBe("#/market/5");
    expect(hashFor(null)).toBe("#/");
    expect(marketButtonId("5")).toBe("market-5");
  });

  it("reports the route at once and on every change, until unsubscribed", () => {
    const win = fakeWindow("#/market/7");
    const seen: (string | null)[] = [];
    const stop = watchRoute(win, (id) => seen.push(id));
    win.location.hash = "#/";
    win.fire();
    stop();
    expect(win.listeners.size).toBe(0);
    expect(seen).toEqual(["7", null]);
  });

  it("navigates by adding a hash only when it changes", () => {
    const win = fakeWindow("");
    navigate(win, null);
    expect(win.location.hash).toBe("");
    navigate(win, "9");
    expect(win.location.hash).toBe("#/market/9");
    navigate(win, "9");
    expect(win.location.hash).toBe("#/market/9");
    navigate(win, null);
    expect(win.location.hash).toBe("#/");
    win.location.hash = "#/elsewhere";
    navigate(win, null);
    expect(win.location.hash).toBe("#/");
  });

  it("focus moves only in a browser", () => {
    expect(() => focusSoon("x")).not.toThrow();
  });
});
