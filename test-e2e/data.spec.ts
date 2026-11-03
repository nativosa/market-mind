import { book, detail, expect, isMobile, openExplorer, screenshot, select, switchTo, test, versionLabel } from "./support.js";

// What each kind of market and failure looks like in the browser, from fixture data only.

test.describe("order books", () => {
  test("V2 market with team-name outcomes", async ({ page }) => {
    await openExplorer(page);
    await versionLabel(page, "V2").click();
    await expect(page.getByText("Showing all 2 loaded V2 markets")).toBeVisible();
    await select(page, "320001");
    await expect(detail(page)).toContainText("OutcomesTeam Alpha (No Yes/No role) / Team Beta (No Yes/No role)");
    await expect(detail(page)).toContainText("ProtocolV2");
    const alpha = book(page, "Team Alpha");
    await expect(alpha).toContainText("Outcome 1 · No Yes/No role");
    await expect(alpha).toContainText("Best bid0.4520 shares");
    await expect(alpha).toContainText("Best ask0.5530 shares");
    await expect(alpha.locator("dl div", { hasText: "Spread" })).toHaveText("Spread0.1");
    await expect(book(page, "Team Beta")).toContainText("Best bid0.4530 shares");
    await expect(detail(page)).not.toContainText("Yes side");
  });

  test("one-sided book: the missing side is shown as missing, not as zero", async ({ page }) => {
    await openExplorer(page);
    await select(page, "310002");
    const yes = book(page, "Yes");
    await expect(yes).toContainText("One-sided: bids only");
    // The server's analytics write decimals canonically: Polymarket's "0.30" is shown as "0.3".
    await expect(yes.locator("dl div", { hasText: "Best bid" })).toHaveText("Best bid0.340 shares");
    await expect(yes).toContainText("Best askNo asks");
    await expect(yes.locator("dl div", { hasText: "Spread" })).toHaveText("SpreadNeeds both a bid and an ask");
    await expect(yes.locator("dl div", { hasText: "Midpoint" })).toHaveText("MidpointNeeds both a bid and an ask");
    await expect(yes).toContainText("No asks in this book.");
    await expect(book(page, "No")).toContainText("One-sided: asks only");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("empty books are a valid state, not a failure", async ({ page }) => {
    await openExplorer(page);
    await select(page, "310004");
    for (const label of ["Yes", "No"]) {
      await expect(book(page, label)).toContainText("Quality: Valid");
      await expect(book(page, label)).toContainText("Empty: no bids or asks");
      await expect(book(page, label)).toContainText("No bids in this book.");
    }
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(detail(page)).not.toContainText("failed");
  });

  test("an invalid book withholds every derived metric", async ({ page }, info) => {
    await openExplorer(page);
    await select(page, "310003");
    await expect(page.getByRole("alert").filter({ hasText: "At least one order book is invalid" })).toBeVisible();
    const no = book(page, "No");
    await expect(no).toContainText("Quality: Invalid");
    await expect(no).toContainText("MALFORMED_PRICE (error) A price level is not a valid decimal.");
    await expect(no).toContainText("Metrics withheld");
    for (const metric of ["Best bid", "Best ask", "Spread", "Midpoint", "Total bid depth", "Bids"]) await expect(no).not.toContainText(metric);
    await expect(no.locator("table")).toHaveCount(0);
    await expect(book(page, "Yes").locator("dl div", { hasText: "Best bid" })).toHaveText("Best bid0.4100 shares");
    await screenshot(page, info, "invalid-book");
  });

  test("missing metadata and odd upstream timestamps are shown as reported", async ({ page }) => {
    await openExplorer(page);
    await select(page, "310007");
    const yes = book(page, "Yes");
    await expect(yes).toContainText("Quality: Incomplete metadata");
    await expect(yes).toContainText("MISSING_SERVER_TIMESTAMP");
    await expect(yes.locator("dl div", { hasText: "Tick size" })).toHaveText("Tick sizeNot reported");
    await expect(yes.locator("dl div", { hasText: "Last trade price" })).toHaveText("Last trade priceNot reported");
    const provenance = page.getByRole("region", { name: "Freshness and provenance" });
    await expect(provenance).toContainText("Yes book: Polymarket timestampNot reported");
    // A timestamp far in the future is shown exactly as reported, never "corrected".
    await expect(provenance).toContainText("No book: Polymarket timestamp2100-01-01 00:00:00.000 UTC");
    await expect(provenance).toContainText("an old timestamp alone does not prove a book is stale");
  });

  test("untrusted market text is rendered as text, never as markup", async ({ page }) => {
    let dialogs = 0;
    page.on("dialog", (d) => {
      dialogs++;
      void d.dismiss();
    });
    await openExplorer(page);
    const question = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> Untrusted text?`;
    await expect(page.locator("#market-310009")).toHaveText(question);
    await select(page, "310009");
    await expect(page.locator("#market-detail-heading")).toHaveText(question);
    await expect(book(page, "Yes")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(page.locator("img")).toHaveCount(0);
    await expect(page.locator("main script")).toHaveCount(0);
    expect(dialogs).toBe(0);
  });
});

test.describe("errors", () => {
  test("a market the listing marks ineligible is not requested until asked, then fails clearly", async ({ page, net }) => {
    await openExplorer(page);
    await select(page, "310006");
    await expect(page.getByText("Order books were not requested")).toBeVisible();
    expect(net.inspections()).toEqual([]);
    await page.getByRole("button", { name: "Check with Polymarket anyway" }).click();
    await expect(page.getByText("Inspection failed: This market cannot be inspected")).toBeVisible();
    await expect(detail(page)).toContainText("Reported reasons");
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    expect(net.inspections()).toHaveLength(1);
  });

  test("a market removed upstream is a clear, final not-found", async ({ page }, info) => {
    await openExplorer(page);
    await select(page, "310010");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Inspection failed: Polymarket has no market with this ID");
    await expect(alert).toContainText("Code: market_not_found");
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await screenshot(page, info, "not-found");
  });

  test("an upstream 429 pauses all requests locally, with a countdown", async ({ page, world }, info) => {
    await openExplorer(page);
    await select(page, "310008");
    await expect(page.getByText("Inspection failed: Polymarket rate-limited the request")).toBeVisible();
    const before = (await world.urls()).length;
    await switchTo(page, info, "310001");
    await expect(page.getByText("Inspection failed: Pausing after a Polymarket rate limit")).toBeVisible();
    await expect(detail(page)).toContainText(/Retry possible in about (1 min|\d+ s)/);
    await expect(page.getByRole("button", { name: "Try again" })).toBeDisabled();
    expect(await world.urls()).toHaveLength(before); // refused locally: nothing reached Polymarket
    await screenshot(page, info, "cooldown");
  });

  test("an upstream outage fails without an automatic retry; Try again sends one request", async ({ page, net }) => {
    await openExplorer(page);
    await select(page, "310011");
    await expect(page.getByText("Inspection failed: Polymarket is unavailable")).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(net.inspections()).toHaveLength(1);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Inspection failed: Polymarket is unavailable")).toBeVisible();
    expect(net.inspections()).toHaveLength(2);
  });

  test("a broken connection to the local server, then a manual retry", async ({ page, net }) => {
    await openExplorer(page);
    await page.route("**/api/markets/*/inspect*", (route) => route.abort("connectionrefused"));
    await select(page, "310001");
    await expect(page.getByText("Inspection failed: Cannot reach the MarketMind server")).toBeVisible();
    await expect(page.getByText("Local server unreachable")).toBeVisible();
    await page.unroute("**/api/markets/*/inspect*");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(book(page, "Yes")).toBeVisible();
    await expect(page.getByText("Local server connected")).toBeVisible();
    expect(net.inspections()).toHaveLength(2);
  });

  test("an answer that breaks the contract is refused, not shown", async ({ page }) => {
    await openExplorer(page);
    await page.route("**/api/markets/*/inspect*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ contract: "marketmind.inspect_market/1", outcomes: "nope" }) }));
    await select(page, "310001");
    await expect(page.getByText("Inspection failed: Unexpected response")).toBeVisible();
    await expect(book(page, "Yes")).toHaveCount(0);
  });

  test("a failed list page keeps a retry and no stale rows", async ({ page }) => {
    await page.route("**/api/markets?version=v1", (route) => route.abort("connectionrefused"));
    await page.goto("/");
    await expect(page.getByText("Loading V1 markets failed: Cannot reach the MarketMind server")).toBeVisible();
    await page.unroute("**/api/markets?version=v1");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Showing all 11 loaded V1 markets")).toBeVisible();
  });
});

test.describe("rolling-window budget", () => {
  // The listing reserves 2 attempts and uses 1; an inspection reserves 8 and uses 4.
  test.use({ limits: { windowLimit: 9 } });

  test("a refresh beyond the window is refused with a retry time, keeping the earlier result", async ({ page, world }) => {
    await openExplorer(page);
    await select(page, "310001");
    await expect(book(page, "Yes")).toBeVisible();
    await expect(page.getByText(/· 4 of 9 per 5 min/)).toBeVisible();
    const before = (await world.urls()).length;
    await page.getByRole("button", { name: "Refresh inspection" }).click();
    await expect(page.getByText("Refresh failed, the earlier result is shown: Request budget for the last 5 minutes is used up")).toBeVisible();
    await expect(detail(page)).toContainText(/Retry possible in about [45] min/);
    await expect(page.getByRole("button", { name: "Refresh again" })).toBeDisabled();
    await expect(book(page, "Yes")).toContainText("Best bid0.47");
    expect(await world.urls()).toHaveLength(before);
  });
});

test.describe("lifetime budget", () => {
  test.use({ limits: { processLimit: 9 } });

  test("exhausting the server's lifetime budget offers no retry", async ({ page }, info) => {
    await openExplorer(page);
    await select(page, "310001");
    await expect(book(page, "Yes")).toBeVisible();
    await page.getByRole("button", { name: "Refresh inspection" }).click();
    await expect(page.getByText("Refresh failed, the earlier result is shown: This server's request budget is used up")).toBeVisible();
    await expect(detail(page)).toContainText("Restart the MarketMind web server to reset it.");
    await expect(page.getByRole("button", { name: "Refresh again" })).toHaveCount(0);
    if (!isMobile(info)) await expect(page.getByText(/Requests left: 4 of 9/)).toBeVisible();
  });
});
