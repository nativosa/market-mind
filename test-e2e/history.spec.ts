import { DEV, expect, expectNoHorizontalOverflow, screenshot, test } from "./support.js";

// Stage 3.2 Stored History in a real browser: offline reads of a fixture database through the real
// server. No history workflow may reach Polymarket, or even start the Live Explorer.

const liveApi = (paths: string[]) => paths.filter((p) => p.startsWith("/api/markets"));
const storedApi = (paths: string[]) => paths.filter((p) => p.startsWith("/api/stored/"));
const marketRow = (name: string) => `tbody a:has-text("${name}")`;

test.describe("with the history fixture database", () => {
  test.use({ limits: { db: "history" } });

  test("a deep link into Stored History starts nothing live and requests nothing upstream", async ({ page, net, world }) => {
    await page.goto("/#/history/market/1");
    await expect(page.locator("#history-market-heading")).toContainText("Will market 1 resolve Yes?");
    await expect(page.getByText("Offline: reads the local database, never Polymarket")).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0); // the explorer was never mounted
    expect(liveApi(net.api())).toEqual([]);
    expect(storedApi(net.api())).toEqual(["/api/stored/markets/1/history"]);
    expect(await world.urls()).toEqual([]);
  });

  test("development build (StrictMode) sends each stored read once", async ({ page, net, world }) => {
    await page.goto(`${DEV}/#/history`);
    await expect(page.locator(marketRow("Will market 1 resolve Yes?"))).toBeVisible();
    await page.locator(marketRow("Will market 1 resolve Yes?")).click();
    await expect(page.locator("#history-market-heading")).toContainText("Will market 1 resolve Yes?");
    expect(storedApi(net.api())).toEqual(["/api/stored/markets?offset=0", "/api/stored/markets/1/history"]);
    expect(liveApi(net.api())).toEqual([]);
    expect(await world.urls()).toEqual([]);
  });

  test("stored markets and runs, with the source filter applied by the server", async ({ page, net }, info) => {
    await page.goto("/#/history");
    await expect(page.getByText("Markets 1 to 2 with stored observations")).toBeVisible();
    await expect(page.locator(marketRow("Synthetic market 2?"))).toHaveCount(0);
    await expect(page.getByText("Synthetic observations included")).toHaveCount(0);
    // Third-party markup in a question stays text.
    await expect(page.locator(marketRow("Will market 1 resolve Yes?"))).toContainText('<img src=x onerror="alert(1)">');
    await expectNoHorizontalOverflow(page);
    await screenshot(page, info, "history-markets");

    await page.getByText("Live + synthetic").click();
    await expect(page).toHaveURL(/#\/history\?source=all$/);
    await expect(page.getByText("Synthetic observations included")).toBeVisible();
    await expect(page.locator(marketRow("Synthetic market 2?"))).toBeVisible();
    await expect(page.getByText("Markets 1 to 3 with stored observations")).toBeVisible();

    await page.getByRole("link", { name: "Collection runs" }).click();
    await expect(page).toHaveURL(/#\/history\/runs\?source=all$/);
    await expect(page.getByText("The 10 most recent collection runs")).toBeVisible();
    await page.getByText("Live only").click();
    await expect(page.getByText("The 8 most recent collection runs")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await screenshot(page, info, "history-runs");
    expect(storedApi(net.api())).toEqual([
      "/api/stored/markets?offset=0",
      "/api/stored/markets?source=all&offset=0",
      "/api/stored/runs?source=all&limit=20",
      "/api/stored/runs?source=live&limit=20",
    ]);
    expect(liveApi(net.api())).toEqual([]);
  });

  test("market dashboard: statistics, three charts and the observation table, all offline", async ({ page, net, world }, info) => {
    await page.goto("/#/history/market/1?source=all");
    await expect(page.getByText("Statistics (sample counts, not time)")).toBeVisible();
    await expect(page.getByText("Synthetic observations included")).toBeVisible();
    await expect(page.locator("figure svg[role=img]")).toHaveCount(3);
    await expect(page.getByText("Plotted values from 0.03 to 0.8")).toBeVisible();
    await expect(page.getByText("Charts and table show all 8 of those 8")).toBeVisible();
    const rows = page.locator("#observation-table-title + div tbody tr");
    await expect(rows).toHaveCount(8);
    await expect(rows.first()).toContainText("Synthetic");
    await expect(page.locator("tbody")).toContainText("100.000000000000000001");
    await expectNoHorizontalOverflow(page);
    await screenshot(page, info, "history-market");

    // A table row and a chart click select observations by address; nothing new is fetched for the history.
    await page.locator("tbody button[id^=observation-]").nth(2).click();
    await expect(page).toHaveURL(/#\/history\/market\/1\/obs\/\d+\?source=all$/);
    await expect(page.locator("tbody tr[aria-selected=true]")).toHaveCount(1);
    // The chart's click target spans the whole SVG; its right edge is the newest observation.
    const hit = page.locator("figure svg[role=img]").first().locator("rect").last();
    const box = (await hit.boundingBox())!;
    await hit.click({ position: { x: box.width - 2, y: box.height / 2 } });
    await expect(page).toHaveURL(/#\/history\/market\/1\/obs\/8\?source=all$/);
    expect(storedApi(net.api()).filter((p) => p.includes("/history"))).toEqual(["/api/stored/markets/1/history?source=all"]);
    expect(liveApi(net.api())).toEqual([]);
    expect(await world.urls()).toEqual([]);
  });

  test("observation evidence: opened from the table, kept across Back and Forward, never fetched live", async ({ page, net, world }, info) => {
    await page.goto("/#/history/market/1");
    await expect(page.getByText("Statistics (sample counts, not time)")).toBeVisible();
    await page.locator("#observation-1").click();
    await expect(page).toHaveURL(/#\/history\/market\/1\/obs\/1$/);
    const panel = page.getByRole("complementary", { name: "Observation #1" });
    await expect(panel).toContainText("Stored evidence exactly as recorded by collect");
    await expect(panel).toContainText("100.000000000000000001");
    await expect(panel).toContainText("in the order Polymarket sent them, not re-sorted");
    await expect(panel).toContainText("At collection");
    await expect(page.locator("#observation-heading")).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await screenshot(page, info, "history-observation");

    await page.goBack();
    await expect(page).toHaveURL(/#\/history\/market\/1$/);
    await expect(panel).toHaveCount(0);
    await expect(page.getByText("Statistics (sample counts, not time)")).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("complementary", { name: "Observation #1" })).toContainText("At collection");
    await page.getByRole("button", { name: "Close observation" }).click();
    await expect(page).toHaveURL(/#\/history\/market\/1$/);

    // One history read and one observation read in all: navigation reuses what is loaded.
    expect(storedApi(net.api())).toEqual(["/api/stored/markets/1/history", "/api/stored/observations/1?levels=50"]);
    expect(liveApi(net.api())).toEqual([]);
    expect(await world.urls()).toEqual([]);
  });

  test("a synthetic observation is hidden under Live only and shown, marked, with Live + synthetic", async ({ page }) => {
    await page.goto("/#/history/market/1/obs/8");
    await expect(page.getByText("This observation is not available")).toBeVisible();
    await page.getByRole("radio", { name: "Live + synthetic" }).click();
    await expect(page).toHaveURL(/#\/history\/market\/1\/obs\/8\?source=all$/);
    await expect(page.getByText("Synthetic observation: test or demonstration data, not market evidence.")).toBeVisible();
  });

  test("opening the Live Explorer starts live listing; returning to history reloads nothing", async ({ page, net }) => {
    await page.goto("/#/history");
    await expect(page.getByText("Markets 1 to 2 with stored observations")).toBeVisible();
    await page.getByRole("link", { name: /Live Explorer/ }).click();
    await expect(page.getByText("Showing all 11 loaded V1 markets")).toBeVisible();
    expect(liveApi(net.api())).toEqual(["/api/markets?version=v1"]);
    await page.getByRole("link", { name: /Stored History/ }).click();
    await expect(page.getByText("Markets 1 to 2 with stored observations")).toBeVisible();
    await page.getByRole("link", { name: /Live Explorer/ }).click();
    await expect(page.getByText("Showing all 11 loaded V1 markets")).toBeVisible();
    expect(storedApi(net.api())).toEqual(["/api/stored/markets?offset=0"]);
    expect(liveApi(net.api())).toEqual(["/api/markets?version=v1"]);
  });
});

test("without a database, Stored History explains how to create one and creates nothing", async ({ page, world }) => {
  await page.goto("/#/history");
  await expect(page.getByText("No local history database yet")).toBeVisible();
  await expect(page.getByText("npm run cli -- collect").first()).toBeVisible();
  await page.goto("/#/history/runs");
  await expect(page.getByText("No local history database yet")).toBeVisible();
  const status = (await (await page.request.get("/api/status")).json()) as { stored: { database: string } };
  expect(status.stored.database).toBe("missing");
  expect(await world.urls()).toEqual([]);
});

test.describe("with an empty database", () => {
  test.use({ limits: { db: "empty" } });

  test("no markets and no runs are empty states, not errors", async ({ page }) => {
    await page.goto("/#/history");
    await expect(page.getByText("No stored markets")).toBeVisible();
    await page.getByRole("link", { name: "Collection runs" }).click();
    await expect(page.getByText("No collection runs recorded")).toBeVisible();
  });
});
