import { back, book, detail, expect, expectNoHorizontalOverflow, isMobile, marketButton, marketsSection, openExplorer, screenshot, select, shownQuestions, test, versionLabel } from "./support.js";

// The complete explorer journey on both viewports: browse, search, filter, sort, page, select,
// inspect, change the ladder depth, refresh and go back. Local changes never reach Polymarket.

const keysetCalls = (urls: string[]) => urls.filter((u) => u.includes("/markets/keyset"));

test("browse, search, filter, sort and load more pages, all on loaded markets", async ({ page, world, net }, info) => {
  await openExplorer(page);
  await expect(page.getByText("11 markets in 1 of at most 5 pages")).toBeVisible();
  await expect(page.getByText("search covers loaded markets only, not all of Polymarket")).toBeVisible();
  // Exact decimal strings from Gamma, regrouped only; a missing value is "Not reported".
  await expect(marketButton(page, "310001").locator("xpath=ancestor::tr")).toContainText("5,000.75");
  await expect(marketButton(page, "310005").locator("xpath=ancestor::tr")).toContainText("1,500.5");
  await expect(marketButton(page, "310011").locator("xpath=ancestor::tr")).toContainText("Not reported");
  await expectNoHorizontalOverflow(page);
  await screenshot(page, info, "list");
  expect(keysetCalls(await world.urls())).toHaveLength(1);

  // Local search (question or slug, any case).
  const search = page.getByRole("searchbox", { name: "Search loaded markets" });
  await search.fill("SLOW");
  await expect(page.getByText("1 match among 11 loaded V1 markets")).toBeVisible();
  expect(await shownQuestions(page)).toEqual(["Slow market: will the answer be late?"]);
  await search.fill("no such market");
  await expect(page.getByText("No loaded markets match")).toBeVisible();
  await page.getByRole("button", { name: "Clear search and filters" }).click();
  await expect(page.getByText("Showing all 11 loaded V1 markets")).toBeVisible();

  // Eligibility filter.
  await page.getByLabel("Eligibility").selectOption("not_inspectable");
  expect(await shownQuestions(page)).toEqual(["Ineligible: is the order book disabled?"]);
  await page.getByLabel("Eligibility").selectOption("all");

  // Sorting: volume (server order, unknown last), then question A to Z.
  const byVolume = await shownQuestions(page);
  expect(byVolume[0]).toBe("Will the valid V1 market resolve Yes?");
  expect(byVolume.at(-1)).toBe("Upstream outage: does the book fail?");
  await page.getByLabel("Sort loaded markets").selectOption("question");
  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  expect(await shownQuestions(page)).toEqual([...byVolume].sort((a, b) => collator.compare(a, b)));
  await page.getByLabel("Sort loaded markets").selectOption("volume");
  expect(keysetCalls(await world.urls())).toHaveLength(1); // none of that reached Polymarket

  // Version switch fetches once per version; switching back reuses what is loaded.
  await versionLabel(page, "V2").click();
  await expect(page.getByText("Showing all 2 loaded V2 markets")).toBeVisible();
  await versionLabel(page, "V1").click();
  await expect(page.getByText("Showing all 11 loaded V1 markets")).toBeVisible();
  expect(keysetCalls(await world.urls())).toHaveLength(2);

  // Load more: page 2 repeats one market (deduplicated); page 3 is the last.
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("13 markets in 2 of at most 5 pages · 1 repeated market skipped")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("14 markets in 3 of at most 5 pages")).toBeVisible();
  await expect(page.getByText("End of results: Polymarket has no further pages for this version.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect(page.locator("#market-310005")).toHaveCount(1);
  const keyset = keysetCalls(await world.urls());
  expect(keyset).toHaveLength(4);
  expect(keyset.slice(2).map((u) => new URL(u).searchParams.get("after_cursor"))).toEqual(["c2", "c3"]);
  expect(net.api().filter((p) => p.startsWith("/api/markets?"))).toEqual(["/api/markets?version=v1", "/api/markets?version=v2", "/api/markets?version=v1&cursor=c2", "/api/markets?version=v1&cursor=c3"]);
  await expectNoHorizontalOverflow(page);
});

test("select, inspect both books, change depth, refresh and go back", async ({ page, world, net }, info) => {
  await openExplorer(page);
  const search = page.getByRole("searchbox", { name: "Search loaded markets" });
  await search.fill("valid");
  const before = (await world.urls()).length;

  await select(page, "310001");
  await expect(page).toHaveURL(/#\/market\/310001$/);
  const yes = book(page, "Yes");
  const no = book(page, "No");
  await expect(yes).toContainText("Outcome 1 · Yes side");
  await expect(no).toContainText("Outcome 2 · No side");
  await expect(yes).toContainText("Best bid0.47125.25 shares");
  await expect(yes).toContainText("Best ask0.49125.25 shares");
  await expect(yes.locator("dl div", { hasText: "Spread" })).toHaveText("Spread0.02");
  await expect(yes.locator("dl div", { hasText: "Midpoint" })).toHaveText("Midpoint0.48");
  await expect(yes.locator("dl div", { hasText: "Total bid depth" })).toHaveText("Total bid depth (shares)9,753");
  await expect(no).toContainText("Best bid0.51125.25 shares");
  await expect(no).toContainText("Best ask0.53125.25 shares");
  // Best price first, as the server ordered it.
  const bids = yes.locator("table").filter({ hasText: "Bids" }).locator("tbody tr td:first-child");
  await expect(bids).toHaveText(["0.47", "0.46", "0.45", "0.44", "0.43"]);
  await expect(yes.locator("table").filter({ hasText: "Asks" }).locator("tbody tr td:first-child")).toHaveText(["0.49", "0.5", "0.51", "0.52", "0.53"]);
  await expect(yes).toContainText("Showing 5 of 12 bid levels and 5 of 12 ask levels");
  expect(net.inspections()).toEqual(["/api/markets/310001/inspect?levels=20"]);
  const afterInspect = await world.urls();
  expect(afterInspect.slice(before)).toEqual([
    "https://gamma.example/markets/310001",
    expect.stringMatching(/^https:\/\/clob\.example\/clob-markets\/0x/),
    expect.stringMatching(/^https:\/\/clob\.example\/book\?token_id=/),
    expect.stringMatching(/^https:\/\/clob\.example\/book\?token_id=/),
  ]);
  await expectNoHorizontalOverflow(page);
  await screenshot(page, info, "detail");

  // Ladder depth is local: the inspection already holds 20 levels per side.
  const apiBefore = net.api().length;
  await page.getByLabel("Levels per side").selectOption("10");
  await expect(bids).toHaveCount(10);
  await page.getByLabel("Levels per side").selectOption("20");
  await expect(bids).toHaveCount(12);
  expect(net.api()).toHaveLength(apiBefore);
  expect(await world.urls()).toHaveLength(afterInspect.length);

  // Refresh is explicit and sends exactly one inspection (4 upstream requests).
  await page.getByRole("button", { name: "Refresh inspection" }).click();
  await expect(page.getByRole("button", { name: "Refresh inspection" })).toBeEnabled();
  expect(net.inspections()).toHaveLength(2);
  expect(await world.urls()).toHaveLength(afterInspect.length + 4);

  // Back: the list returns with its search intact, focus on the market just closed.
  await back(page);
  await expect(page).toHaveURL(/#\/$/);
  await expect(search).toHaveValue("valid");
  await expect(marketButton(page, "310001")).toBeFocused();
  await expect(detail(page)).toContainText("Select a market");
  if (isMobile(info)) await expect(marketsSection(page)).toBeVisible();
  expect(net.inspections()).toHaveLength(2);
});

test("on phones the details replace the list and Back restores it with its pages", async ({ page }, info) => {
  test.skip(!isMobile(info), "phone layout");
  await openExplorer(page);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("13 markets in 2 of at most 5 pages")).toBeVisible();
  await select(page, "310012");
  await expect(marketsSection(page)).toBeHidden();
  await expect(page.locator("#market-detail-heading")).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await back(page);
  await expect(page.getByText("13 markets in 2 of at most 5 pages")).toBeVisible();
  await expect(marketButton(page, "310012")).toBeFocused();
  // The browser's own back button closes the details too.
  await select(page, "310001");
  await page.goBack();
  await expect(marketsSection(page)).toBeVisible();
  await expect(detail(page)).toContainText("Select a market");
});

test("on desktop the details scroll inside their own column", async ({ page }, info) => {
  test.skip(isMobile(info), "desktop layout");
  await openExplorer(page);
  await select(page, "310001");
  await expect(book(page, "Yes")).toBeVisible();
  const column = detail(page).locator("xpath=..");
  const { scrollHeight, clientHeight } = await column.evaluate((e) => ({ scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }));
  expect(scrollHeight).toBeGreaterThan(clientHeight);
  const provenance = page.getByRole("heading", { name: "Freshness and provenance" });
  await provenance.scrollIntoViewIfNeeded();
  await expect(provenance).toBeInViewport();
  expect(await column.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  // The list keeps its own position: its first market is still on screen.
  await expect(marketButton(page, "310001")).toBeInViewport();
});
