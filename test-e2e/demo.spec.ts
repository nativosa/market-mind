import { DEMO, expect, expectNoHorizontalOverflow, isMobile, screenshot, test } from "./support.js";

// Stage 3.2 synthetic demonstration (npm run web:demo) in a real browser: test-e2e/server.ts starts
// it with startDemo, exactly as the launcher does, over an HTTP client that records any request.
// The shared fixtures check afterwards that it made none and that no database file changed.

const STEADY = "[SYNTHETIC DEMO] Will the synthetic demo index close above 100 on Friday?";
const IRREGULAR = "[SYNTHETIC DEMO] Will the synthetic weather station record rain this week?";
const SPARSE = "[SYNTHETIC DEMO] Will the synthetic sparse market ever trade?";
const marketLink = (question: string) => `tbody a:has-text("${question}")`;
const liveApi = (paths: string[]) => paths.filter((p) => p.startsWith("/api/markets"));

test("the demo opens Stored History offline: banner, charts, evidence, Back/Forward, Live Explorer disabled", async ({ page, net }, info) => {
  await page.goto(`${DEMO}/`);
  // The start page of a server without live requests is Stored History (replaced, not added).
  await expect(page).toHaveURL(`${DEMO}/#/history`);
  const banner = page.getByRole("complementary", { name: "Synthetic demonstration data" });
  await expect(banner).toContainText("not Polymarket market evidence");
  await expect(page.getByRole("radio", { name: "Live + synthetic" })).toBeChecked();
  await expect(page.getByText("Synthetic observations included")).toBeVisible();
  await expect(page.getByText("Markets 1 to 3 with stored observations")).toBeVisible();
  await expect(page.getByRole("link", { name: /Live Explorer/ })).toContainText("disabled on this server");
  await expectNoHorizontalOverflow(page);
  await screenshot(page, info, "demo-markets");

  await page.locator(marketLink(STEADY)).click();
  await expect(page.locator("#history-market-heading")).toContainText(STEADY);
  await expect(page.getByText("Charts and table show all 16 of those 16")).toBeVisible();
  const charts = page.locator("figure svg[role=img]");
  await expect(charts).toHaveCount(3);
  for (const name of ["Best bid and ask", "Spread", "Resting depth"]) await expect(page.locator("figure").filter({ hasText: name }).first()).toBeVisible();
  // Readable: each chart is at least most of the viewport's width on phones and tall enough to read.
  const width = page.viewportSize()!.width;
  for (const box of await Promise.all((await charts.all()).map((c) => c.boundingBox()))) {
    expect(box!.width).toBeGreaterThan(isMobile(info) ? width * 0.75 : 380);
    expect(box!.height).toBeGreaterThan(100);
  }
  await expect(banner).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await screenshot(page, info, "demo-market");

  // Select the newest observation from the table and inspect its complete evidence.
  const newest = page.locator("tbody button[id^=observation-]").first();
  const id = (await newest.getAttribute("id"))!.replace("observation-", "");
  await newest.click();
  await expect(page).toHaveURL(`${DEMO}/#/history/market/990000000000000001/obs/${id}`);
  const panel = page.getByRole("complementary", { name: `Observation #${id}` });
  await expect(panel).toContainText("Synthetic observation: test or demonstration data, not market evidence.");
  await expect(panel).toContainText("synthetic-demo-17");
  await expect(panel).toContainText("Both outcome books received");
  await expect(panel).toContainText("in the order Polymarket sent them, not re-sorted");
  await expect(panel).toContainText("At collection");
  await expect(page.locator("#observation-heading")).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await screenshot(page, info, "demo-observation");

  await page.goBack();
  await expect(page).toHaveURL(`${DEMO}/#/history/market/990000000000000001`);
  await expect(panel).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole("complementary", { name: `Observation #${id}` })).toContainText("At collection");

  // The Live Explorer is disabled: an explanation, no listing request.
  await page.getByRole("link", { name: /Live Explorer/ }).click();
  await expect(page.getByText("Live Explorer is disabled on this server")).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(banner).toBeVisible();
  await screenshot(page, info, "demo-live-disabled");
  // Back to Stored History where it was left, with nothing read again.
  await page.getByRole("link", { name: "Open Stored History" }).click();
  await expect(page).toHaveURL(`${DEMO}/#/history/market/990000000000000001/obs/${id}`);
  await expect(page.getByRole("complementary", { name: `Observation #${id}` })).toContainText("At collection");

  expect(liveApi(net.api())).toEqual([]);
  // One read of each thing shown: navigation reuses what is loaded.
  expect(net.api().filter((p) => p.startsWith("/api/stored/"))).toEqual([
    "/api/stored/markets?offset=0",
    "/api/stored/markets/990000000000000001/history",
    `/api/stored/observations/${id}?levels=50`,
  ]);
  const refused = await page.request.get(`${DEMO}/api/markets?version=v1`);
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ error: { code: "LIVE_DISABLED" } });
});

test("the demo dataset shows irregular sampling, unusable evidence, an interrupted run and insufficient evidence", async ({ page, net }, info) => {
  await page.goto(`${DEMO}/#/history/market/990000000000000002`);
  await expect(page.locator("#history-market-heading")).toContainText(IRREGULAR);
  const table = page.locator("#observation-table-title + div tbody");
  await expect(table).toContainText("Irregular gap");
  await expect(table).toContainText("One book missing");
  await expect(page.getByText("only one of the two books was received").first()).toBeVisible();
  await expect(page.getByText("a book failed validation").first()).toBeVisible();
  // The gap is shaded on every chart.
  await expect(page.getByText("No observations: irregular gap").first()).toBeVisible();

  await page.goto(`${DEMO}/#/history/market/990000000000000003`);
  await expect(page.locator("#history-market-heading")).toContainText(SPARSE);
  await expect(page.getByText("Insufficient evidence")).toBeVisible();
  await expect(page.getByText("No observation in the analysis window is usable")).toBeVisible();

  await page.goto(`${DEMO}/#/history/runs`);
  await expect(page.getByText("The 17 most recent collection runs")).toBeVisible();
  await expect(page.locator("tbody")).toContainText("Interrupted");
  await expect(page.locator("tbody")).toContainText("Partial");
  await expectNoHorizontalOverflow(page);
  await screenshot(page, info, "demo-runs");
  expect(liveApi(net.api())).toEqual([]);
});

test("a demo address of a live market shows the disabled explorer, not a request", async ({ page, net }) => {
  await page.goto(`${DEMO}/#/market/990000000000000001`);
  await expect(page.getByText("Live Explorer is disabled on this server")).toBeVisible();
  await expect(page).toHaveURL(`${DEMO}/#/market/990000000000000001`);
  expect(net.api()).toEqual(["/api/status"]);
});
