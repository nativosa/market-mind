import { SLOW_MS } from "./upstream.js";
import { back, book, detail, DEV, expect, isMobile, marketButton, openExplorer, select, switchTo, test } from "./support.js";

// Request discipline in a real browser: one inspection per selection, superseded and cancelled
// requests aborted, stale answers never shown, history navigation free, and no polling.

const slowBooks = (urls: string[]) => urls.filter((u) => u.includes("/book?") && u.includes("000000310005"));

test("one inspection per selection, even for a fast double click", async ({ page, net }) => {
  await openExplorer(page);
  await marketButton(page, "310001").dblclick();
  await expect(book(page, "Yes")).toBeVisible();
  expect(net.inspections()).toEqual(["/api/markets/310001/inspect?levels=20"]);
  // Afterwards only the local status is read (for the rolling-window figures); nothing else.
  expect(net.api().filter((p) => p === "/api/status")).toHaveLength(2);
});

test("switching markets mid-inspection aborts the old request and never shows its late answer", async ({ page, world, net }, info) => {
  await openExplorer(page);
  await select(page, "310005");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await switchTo(page, info, "310001");
  await expect(book(page, "Yes")).toContainText("Best bid0.47");
  expect(net.inspections()).toEqual(["/api/markets/310005/inspect?levels=20", "/api/markets/310001/inspect?levels=20"]);
  expect(net.failed).toContain("/api/markets/310005/inspect?levels=20");
  // Wait past the slow books' delay: the abandoned answer must not replace the new selection.
  await page.waitForTimeout(SLOW_MS + 500);
  await expect(page.locator("#market-detail-heading")).toHaveText("Will the valid V1 market resolve Yes?");
  await expect(detail(page)).not.toContainText("Slow market");
  // The aborted inspection may already have spent upstream budget; the server's count says so.
  const urls = await world.urls();
  expect(slowBooks(urls).length).toBeGreaterThanOrEqual(1);
  const status = (await (await page.request.get("/api/status")).json()) as { budget: { process: { used: number } } };
  expect(status.budget.process.used).toBe(urls.length);
});

test("cancel stops an inspection in flight and nothing follows on its own", async ({ page, net }) => {
  await openExplorer(page);
  await select(page, "310005");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Inspection cancelled")).toBeVisible();
  await expect(book(page, "Yes")).toHaveCount(0);
  await page.waitForTimeout(SLOW_MS + 500);
  expect(net.inspections()).toHaveLength(1);
  expect(net.failed).toContain("/api/markets/310005/inspect?levels=20");
  await expect(book(page, "Yes")).toHaveCount(0);
  // An explicit new inspection works.
  await page.getByRole("button", { name: "Inspect order books" }).click();
  await expect(book(page, "Yes")).toBeVisible({ timeout: SLOW_MS + 5_000 });
  expect(net.inspections()).toHaveLength(2);
});

test("browser back and forward move between selections without inspecting", async ({ page, net }) => {
  await openExplorer(page);
  await select(page, "310001");
  await expect(book(page, "Yes")).toBeVisible();
  await back(page);
  await select(page, "310004");
  await expect(book(page, "Yes")).toBeVisible();
  expect(net.inspections()).toHaveLength(2);

  await page.goBack(); // #/
  await expect(detail(page)).toContainText("Select a market");
  await page.goBack(); // #/market/310001
  await expect(page.locator("#market-detail-heading")).toHaveText("Will the valid V1 market resolve Yes?");
  await expect(page.getByText("Not inspected yet")).toBeVisible();
  await page.goForward(); // #/
  await page.goForward(); // #/market/310004
  await expect(page.locator("#market-detail-heading")).toHaveText("Is the empty book handled honestly?");
  await expect(page.getByText("Not inspected yet")).toBeVisible();
  expect(net.inspections()).toHaveLength(2);
});

test("opening a market address loads the list and the market, but does not inspect it", async ({ page, net }) => {
  await page.goto("/#/market/310001");
  // The heading shows the listing's question once the first page has loaded.
  await expect(page.locator("#market-detail-heading")).toHaveText("Will the valid V1 market resolve Yes?");
  await expect(page.getByText("Not inspected yet")).toBeVisible();
  expect(net.inspections()).toEqual([]);
  await page.getByRole("button", { name: "Inspect order books" }).click();
  await expect(book(page, "Yes")).toBeVisible();
  expect(net.inspections()).toHaveLength(1);
});

test("no polling: time passing only ages the data and marks it stale", async ({ page, net }) => {
  await page.clock.install();
  await openExplorer(page);
  await select(page, "310001");
  await expect(book(page, "Yes")).toBeVisible();
  await expect(page.getByText("Inspected just now.")).toBeVisible();
  const requests = net.requests.length;
  await page.clock.fastForward("10:00");
  await expect(page.getByText("Stale: inspected 10 min ago. Refresh to observe the books again.")).toBeVisible();
  await expect(page.getByText(/Stale: fetched 10 min ago/)).toHaveCount(1);
  expect(net.requests.length).toBe(requests);
});

test("development build (React StrictMode) sends one inspection per selection", async ({ page, net }, info) => {
  test.skip(isMobile(info), "one viewport is enough for the dev build");
  test.setTimeout(60_000);
  await page.goto(`${DEV}/`);
  await expect(page.getByText("Showing all 11 loaded V1 markets")).toBeVisible({ timeout: 30_000 });
  // StrictMode mounts effects twice: the first page may be requested twice (one aborted), never inspections.
  const listings = net.api().filter((p) => p.startsWith("/api/markets?"));
  expect(listings.length).toBeGreaterThanOrEqual(1);
  expect(listings.length).toBeLessThanOrEqual(2);
  await select(page, "310001");
  await expect(book(page, "Yes")).toBeVisible();
  await page.waitForTimeout(500);
  expect(net.inspections()).toEqual(["/api/markets/310001/inspect?levels=20"]);
  for (const url of net.requests.filter((u) => u.includes("/api/"))) expect(new URL(url).origin).toBe(DEV);
});
