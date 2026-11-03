import { APP, book, expect, isMobile, marketButton, openExplorer, rawGet, screenshot, select, test } from "./support.js";

// The browser talks only to its own origin; the local API keeps its Host, Origin and method rules;
// keyboard users can do the whole journey.

test("the browser only ever requests its own origin, never Polymarket", async ({ page, net, world }) => {
  await openExplorer(page);
  await select(page, "310001");
  await expect(book(page, "Yes")).toBeVisible();
  await page.getByRole("button", { name: "Refresh inspection" }).click();
  await expect(page.getByRole("button", { name: "Refresh inspection" })).toBeEnabled();
  const external = net.requests.filter((u) => !u.startsWith(`${APP}/`) && !u.startsWith("data:"));
  expect(external).toEqual([]);
  expect(net.requests.some((u) => /polymarket|gamma|clob/i.test(new URL(u).host))).toBe(false);
  // Upstream requests happened only on the server, and only to the fixture hosts.
  expect((await world.urls()).length).toBe(1 + 4 + 4);
});

test("the local API keeps its Host, Origin, Fetch-Metadata and method restrictions", async ({ page }) => {
  const host = `127.0.0.1:${new URL(APP).port}`;
  expect(await rawGet("/api/status", { host })).toBe(200);
  expect(await rawGet("/api/status", { host: `evil.example:${new URL(APP).port}` })).toBe(403);
  expect(await rawGet("/api/status", { host, origin: "http://evil.example" })).toBe(403);
  expect(await rawGet("/api/status", { host, "sec-fetch-site": "cross-site" })).toBe(403);
  expect(await rawGet("/api/status", { host }, "POST")).toBe(405);
  const response = await page.request.get("/api/status");
  expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  const index = await page.request.get("/");
  expect(index.headers()["content-security-policy"]).toContain("default-src 'self'");
});

test("keyboard: select with Enter, focus moves to the details, Back returns focus to the market", async ({ page }) => {
  await openExplorer(page);
  await marketButton(page, "310001").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#market-detail-heading")).toBeFocused();
  await expect(book(page, "Yes")).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Back to markets" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(marketButton(page, "310001")).toBeFocused();
  // Space activates too.
  await page.keyboard.press("Space");
  await expect(page.locator("#market-detail-heading")).toBeFocused();
});

test("every button and form control has an accessible name; states are written, not only coloured", async ({ page }, info) => {
  await openExplorer(page);
  await select(page, "310003");
  await expect(book(page, "Yes")).toBeVisible();
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll("button, select, input")]
      .filter((e) => {
        const el = e as HTMLElement;
        if (el.offsetParent === null && !(el instanceof HTMLInputElement && el.type === "radio")) return false;
        const labelled = (el as HTMLInputElement).labels?.length ?? 0;
        return !(el.textContent?.trim() || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || labelled > 0);
      })
      .map((e) => e.outerHTML.slice(0, 80)),
  );
  expect(unnamed).toEqual([]);
  // Quality and state are words; the invalid banner is an alert with text.
  await expect(book(page, "No")).toContainText("Quality: Invalid");
  await expect(book(page, "Yes")).toContainText("Quality: Valid");
  await expect(page.getByRole("alert")).toContainText("At least one order book is invalid");
  await expect(page.getByRole("status").filter({ hasText: "Local server connected" })).toBeVisible();
  if (!isMobile(info)) await screenshot(page, info, "invalid-detail-keyboard");
});
