import { expect, expectNoHorizontalOverflow, screenshot, test } from "./support.js";

// Stage 3.2 Stored History, beyond the Batch 2 workflows (history.spec.ts): data quality and
// usability, sampling gaps, exact decimals, the analysis-window and chart-series limits, deep-link
// reloads, explicit retry, superseded and cancelled requests, and keyboard access. Every test also
// passes the shared checks (support.ts): database files unchanged, no CSP violation, local requests only.

const storedApi = (paths: string[]) => paths.filter((p) => p.startsWith("/api/stored/"));
const liveApi = (paths: string[]) => paths.filter((p) => p.startsWith("/api/markets"));
const tableBody = "#observation-table-title + div tbody";
const row = (id: number) => `${tableBody} tr:has(#observation-${id})`;
const BUSY = {
  status: 503,
  contentType: "application/json",
  body: JSON.stringify({
    contract: "marketmind.web.error/1",
    error: { category: "storage_error", code: "DATABASE_BUSY", message: "The database is busy.", retryable: true, details: {} },
  }),
};

test.describe("with the history fixture database", () => {
  test.use({ limits: { db: "history" } });

  test("quality and usability, missing books and depth, gaps and exact decimals, as stored", async ({ page }) => {
    await page.goto("/#/history/market/1");
    await expect(page.getByText("Statistics (sample counts, not time)")).toBeVisible();
    // Observation ids follow test/historySeed.ts: 3 unpaired, 4 invalid book, 5 one-sided, 7 after a 30-minute gap.
    await expect(page.locator(row(1))).toContainText("100.000000000000000001");
    await expect(page.locator(row(1))).toContainText("Usable");
    await expect(page.locator(row(3))).toContainText("Not usable");
    await expect(page.locator(row(3))).toContainText("only one of the two books was received");
    await expect(page.locator(row(3))).toContainText("One book missing");
    await expect(page.locator(row(3))).toContainText("Not reported"); // no metrics, so no prices or depth
    await expect(page.locator(row(4))).toContainText("a book failed validation");
    await expect(page.locator(row(5))).toContainText("the reference book was one-sided or empty");
    await expect(page.locator(row(7))).toContainText("Irregular gap");
    // Unusable samples are listed but never charted as values: crosses on each chart's rug.
    const depth = page.locator("figure").filter({ hasText: "Resting depth" });
    await expect(depth).toContainText("not executable liquidity");
    await expect(page.getByText("No observations: irregular gap").first()).toBeVisible();
    await expect(page.locator("figure svg[role=img]").first()).toHaveAttribute("aria-label", /4 usable observations plotted, 3 not usable/);
  });

  test("an observation deep link survives a reload and reads only that market's history and that observation", async ({ page, net }) => {
    await page.goto("/#/history/market/1/obs/4");
    const panel = page.getByRole("complementary", { name: "Observation #4" });
    await expect(panel).toContainText("ASSET_ID_MISMATCH");
    await page.reload();
    await expect(page.getByRole("complementary", { name: "Observation #4" })).toContainText("The book is for a different token than the one requested.");
    await expect(page.locator(`${tableBody} tr[aria-selected=true]`)).toHaveCount(1);
    const once = ["/api/stored/markets/1/history", "/api/stored/observations/4?levels=50"];
    expect(storedApi(net.api())).toEqual([...once, ...once]);
    expect(liveApi(net.api())).toEqual([]);
  });

  test("a busy database is an error with an explicit retry; one click sends one request", async ({ page, net }) => {
    let refuse = true;
    await page.route("**/api/stored/markets/1/history", (route) => (refuse ? route.fulfill(BUSY) : route.continue()));
    await page.goto("/#/history/market/1");
    await expect(page.getByText("The local database is busy")).toBeVisible();
    await page.waitForTimeout(500);
    expect(storedApi(net.api())).toEqual(["/api/stored/markets/1/history"]); // no automatic retry
    refuse = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Statistics (sample counts, not time)")).toBeVisible();
    expect(storedApi(net.api())).toEqual(["/api/stored/markets/1/history", "/api/stored/markets/1/history"]);
  });

  test("a superseded history request is aborted and its late answer never shown", async ({ page, net }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/stored/markets/1/history", async (route) => {
      await held;
      await route.continue().catch(() => undefined); // the browser has already aborted it
    });
    await page.goto("/#/history/market/1");
    await expect(page.getByText("Loading this market's stored history")).toBeVisible();
    await page.goto("/#/history/market/3");
    await expect(page.locator("#history-market-heading")).toContainText("Synthetic market 3?");
    expect(net.failed).toContain("/api/stored/markets/1/history");
    release();
    await page.waitForTimeout(500);
    await expect(page.locator("#history-market-heading")).toContainText("Synthetic market 3?");
    await expect(page.getByText("Will market 1 resolve Yes?")).toHaveCount(0);
  });

  test("leaving an observation while it loads cancels it; closing the panel cancels nothing else", async ({ page, net }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/stored/observations/2*", async (route) => {
      await held;
      await route.continue().catch(() => undefined);
    });
    await page.goto("/#/history/market/1");
    await expect(page.getByText("Statistics (sample counts, not time)")).toBeVisible();
    await page.locator("#observation-2").click();
    await expect(page.getByText("Loading this observation")).toBeVisible();
    await page.getByRole("button", { name: "Close observation" }).click();
    await expect(page).toHaveURL(/#\/history\/market\/1$/);
    release();
    await expect.poll(() => net.failed).toContain("/api/stored/observations/2?levels=50");
    await expect(page.getByRole("complementary", { name: "Observation #2" })).toHaveCount(0);
    await expect(page.getByText("Statistics (sample counts, not time)")).toBeVisible();
    expect(storedApi(net.api())).toEqual(["/api/stored/markets/1/history", "/api/stored/observations/2?levels=50"]);
  });

  test("keyboard: the observation table opens evidence with Enter, focus moves to it and returns on close", async ({ page }) => {
    await page.goto("/#/history/market/1");
    await expect(page.getByText("Statistics (sample counts, not time)")).toBeVisible();
    const button = page.locator("#observation-6");
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/history\/market\/1\/obs\/6$/);
    await expect(page.locator("#observation-heading")).toBeFocused();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Close observation" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/history\/market\/1$/);
    await expect(button).toBeFocused();
    // Every chart has a text alternative and points to the table.
    for (const svg of await page.locator("figure svg[role=img]").all()) await expect(svg).toHaveAttribute("aria-label", /The observation table lists the same values/);
  });
});

test.describe("with a market of 2,050 observations", () => {
  test.use({ limits: { db: "large" } });

  test("statistics use the whole analysis window; charts and table show the newest 2,000, and say so", async ({ page, net }, info) => {
    await page.goto("/#/history/market/4");
    await expect(page.getByText("Plotted: 2,000 observations · Analysed: 2,050 observations")).toBeVisible();
    await expect(page.getByText("Charts and table show the newest 2,000 of those 2,050")).toBeVisible();
    await expect(page.getByText("Statistics use all 2,050 observations of the analysis window")).toBeVisible();
    await expect(page.getByText("Rows 1 to 50 of 2,000")).toBeVisible();
    await page.getByRole("button", { name: "Older" }).click();
    await expect(page.getByText("Rows 51 to 100 of 2,000")).toBeVisible();
    await expect(page.locator("figure svg[role=img]").first()).toHaveAttribute("aria-label", /2,000 usable observations plotted|2000 usable observations plotted/);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, info, "history-large");
    expect(storedApi(net.api())).toEqual(["/api/stored/markets/4/history"]);
  });
});

test.describe("with an empty database", () => {
  test.use({ limits: { db: "empty" } });

  test("an empty database fits the viewport and says how history is created", async ({ page }, info) => {
    await page.goto("/#/history");
    await expect(page.getByText("No stored markets")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await screenshot(page, info, "history-empty");
  });
});
