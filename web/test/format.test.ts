import { describe, expect, it } from "vitest";
import type { ApiError } from "../src/api";
import { describeApiError, formatAge, formatCount, formatDate, formatDuration, formatFlag, formatVolume, groupDigits, isStale, NOT_REPORTED } from "../src/format";
import { NOW, serverError } from "./fixtures";

describe("decimal display", () => {
  it.each([
    ["0", "0"],
    ["999", "999"],
    ["1000", "1,000"],
    ["1234567.890000001", "1,234,567.890000001"],
    ["123456789012345678901234567890", "123,456,789,012,345,678,901,234,567,890"],
    ["0.000000000000000001", "0.000000000000000001"],
  ])("groups %s as %s without changing a digit", (raw, shown) => {
    expect(groupDigits(raw)).toBe(shown);
    expect(groupDigits(raw).replaceAll(",", "")).toBe(raw);
  });

  it("shows non-plain values verbatim and unknown values as not reported", () => {
    expect(groupDigits("1e+21")).toBe("1e+21");
    expect(formatVolume(null)).toBe(NOT_REPORTED);
    expect(formatVolume("1500.25")).toBe("1,500.25");
    expect(formatCount(2_000)).toBe("2,000");
  });

  it("formats dates, flags, durations and ages", () => {
    expect(formatDate("2026-12-31T23:59:59Z")).toBe("2026-12-31");
    expect(formatDate(null)).toBe(NOT_REPORTED);
    expect(formatDate("soon")).toBe("soon");
    expect(formatFlag(null)).toBe(NOT_REPORTED);
    expect(formatFlag(false)).toBe("No");
    expect(formatFlag(true, "on", "off")).toBe("on");
    expect([formatDuration(0), formatDuration(45_000), formatDuration(300_000), formatDuration(7_200_000)]).toEqual(["0 s", "45 s", "5 min", "2 h"]);
    expect([formatAge(3_000), formatAge(42_000), formatAge(180_000), formatAge(7_200_000)]).toEqual(["just now", "42 s ago", "3 min ago", "2 h ago"]);
    expect([isStale(null, NOW), isStale(NOW - 120_000, NOW), isStale(NOW - 120_001, NOW)]).toEqual([false, false, true]);
  });
});

describe("describeApiError", () => {
  const server = (category: string, code: string | null, details: Record<string, unknown> = {}, retryable = true): ApiError => ({
    kind: "server",
    httpStatus: 503,
    error: serverError(category, code, details, retryable).error,
    receivedAt: NOW,
  });

  it("distinguishes cooldown, upstream rate limit, window and lifetime budgets", () => {
    expect(describeApiError(server("rate_limited", "LOCAL_COOLDOWN", { retryAfterMs: 45_000 }), NOW + 15_000)).toMatchObject({ title: "Pausing after a Polymarket rate limit", retryInMs: 30_000 });
    expect(describeApiError(server("rate_limited", null, { retryAfterMs: 60_000 }), NOW).title).toBe("Polymarket rate-limited the request");
    expect(describeApiError(server("budget_exhausted", "WINDOW_BUDGET_EXHAUSTED", { retryAfterMs: 1_000 }), NOW + 5_000)).toMatchObject({ title: "Request budget for the last 5 minutes is used up", retryInMs: 0 });
    expect(describeApiError(server("budget_exhausted", "PROCESS_BUDGET_EXHAUSTED", {}, false), NOW)).toMatchObject({ title: "This server's request budget is used up", retryInMs: null, retryable: false });
  });

  it.each([
    ["upstream_unavailable", null, { kind: "Timeout" }, "Polymarket did not answer in time"],
    ["upstream_unavailable", null, { kind: "Upstream5xx" }, "Polymarket is unavailable"],
    ["upstream_invalid_data", null, {}, "Polymarket returned unusable data"],
    ["deadline_exceeded", "DEADLINE", {}, "The request took too long"],
    ["invalid_arguments", null, {}, "The request was rejected"],
    ["forbidden", "ORIGIN_NOT_ALLOWED", {}, "The server refused this page's origin"],
    ["cancelled", "SHUTTING_DOWN", {}, "The request was cancelled"],
    ["internal_error", null, {}, "Server error"],
  ])("%s / %s", (category, code, details, title) => {
    expect(describeApiError(server(category, code, details), NOW).title).toBe(title);
  });

  it("covers network, invalid and aborted responses", () => {
    expect(describeApiError({ kind: "network" }, NOW).title).toBe("Cannot reach the MarketMind server");
    expect(describeApiError({ kind: "invalid_response", httpStatus: 200, issues: [] }, NOW).title).toBe("Unexpected response");
    expect(describeApiError({ kind: "aborted" }, NOW).title).toBe("Request cancelled");
  });
});
