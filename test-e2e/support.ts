import { request as httpRequest } from "node:http";
import { mkdirSync } from "node:fs";
import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { E2E_PORTS } from "./ports.js";

// Shared E2E fixtures. Before every test the server is reset (fresh budgets, cooldown and upstream
// log). After every test: no unexpected upstream URL, every upstream URL on a fixture host, and
// every browser request on the app's own origin (or the dev server's, for the StrictMode check).

export const APP = `http://127.0.0.1:${E2E_PORTS.web}`;
export const DEV = `http://127.0.0.1:${E2E_PORTS.dev}`;
const CONTROL = `http://127.0.0.1:${E2E_PORTS.control}`;
export const SCREENSHOTS = "test-results/e2e-screenshots";

export interface Limits {
  processLimit?: number;
  windowLimit?: number;
}

export interface World {
  /** Upstream URLs the server requested since the reset. */
  urls(): Promise<string[]>;
}

export interface Net {
  /** Every URL the browser requested. */
  requests: string[];
  /** Local API paths (with query) the browser requested. */
  api(): string[];
  inspections(): string[];
  /** Local API paths whose request failed in the browser (aborted or refused). */
  failed: string[];
}

export const test = base.extend<{ limits: Limits; world: World; net: Net }>({
  limits: [{}, { option: true }],
  world: [
    async ({ limits }, use) => {
      const reset = await fetch(`${CONTROL}/reset`, { method: "POST", body: JSON.stringify(limits) });
      expect(reset.ok).toBe(true);
      const log = async () => (await (await fetch(`${CONTROL}/log`)).json()) as { urls: string[]; unexpected: string[] };
      await use({ urls: async () => (await log()).urls });
      const { urls, unexpected } = await log();
      expect(unexpected, "upstream URLs outside the fixtures").toEqual([]);
      for (const url of urls) expect(url).toMatch(/^https:\/\/(gamma|clob)\.example\//);
    },
    { auto: true },
  ],
  net: [
    async ({ page }, use) => {
      const requests: string[] = [];
      const failed: string[] = [];
      page.on("request", (r) => requests.push(r.url()));
      page.on("requestfailed", (r) => failed.push(pathOf(r.url())));
      const api = () => requests.filter((u) => u.startsWith("http") && new URL(u).pathname.startsWith("/api/")).map(pathOf);
      await use({ requests, failed, api, inspections: () => api().filter((p) => p.includes("/inspect")) });
      for (const url of requests) {
        if (url.startsWith("data:")) continue;
        expect([APP, DEV], `browser request to ${url}`).toContain(new URL(url).origin);
      }
    },
    { auto: true },
  ],
});

export { expect };

const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

export const isMobile = (info: TestInfo) => info.project.name === "mobile";

export async function openExplorer(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await expect(page.getByText("Showing all 11 loaded V1 markets")).toBeVisible();
}

/** The V1/V2 switch: its radio is visually hidden, so users (and tests) press the label. */
export const versionLabel = (page: Page, version: "V1" | "V2") => page.locator("fieldset label").filter({ hasText: version });
export const marketButton = (page: Page, id: string) => page.locator(`#market-${id}`);
export const detail = (page: Page) => page.getByRole("complementary", { name: "Market details" });
export const marketsSection = (page: Page) => page.getByRole("region", { name: "Markets" });

/** One outcome's book panel, found by its (exact) label heading. */
export const book = (page: Page, label: string): Locator =>
  page.locator("article").filter({ has: page.getByRole("heading", { level: 4, name: label, exact: true }) });

export async function select(page: Page, id: string): Promise<void> {
  await marketButton(page, id).click();
  await expect(page.locator("#market-detail-heading")).toBeVisible();
}

/** Close the details with the in-app back action. */
export async function back(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Back to markets" }).click();
  await expect(marketsSection(page)).toBeVisible();
}

/** The list of the other market, reachable on any viewport (on phones the list hides behind details). */
export async function switchTo(page: Page, info: TestInfo, id: string): Promise<void> {
  if (isMobile(info)) await back(page);
  await select(page, id);
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll, "page wider than the viewport").toBeLessThanOrEqual(inner);
}

export async function screenshot(page: Page, info: TestInfo, name: string): Promise<void> {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-${name}.png`, fullPage: true });
}

/** The text of the market buttons in the order shown. */
export const shownQuestions = (page: Page) => page.locator("tbody button[id^=market-]").allInnerTexts();

/** A raw HTTP GET to the app server with chosen headers (fetch would refuse to set Host). */
export function rawGet(path: string, headers: Record<string, string>, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: E2E_PORTS.web, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}
