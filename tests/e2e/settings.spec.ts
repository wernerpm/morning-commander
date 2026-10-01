import { expect, test, type Page } from "@playwright/test";

// Preferences/state live in the (mock) backend, not localStorage; the old
// localStorage data is imported once. Plus stale-while-revalidate indicators.

const panel = (page: Page, id: 0 | 1) => page.locator(`[data-panel="${id}"]`);
const mockValue = <T>(page: Page, fn: string) => page.evaluate((f) => new Function(`return window.__mock.${f}`)() as T, fn);

async function ready(page: Page) {
  await expect(panel(page, 0).locator(".row").first()).toBeVisible();
}

test("imports localStorage panel state and bookmarks once", async ({ page }) => {
  await page.addInitScript(() => {
    // Only on the first load: the app removes the keys afterwards.
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(
      "mc.panel.0",
      JSON.stringify({ path: "/Users/demo/Documents", sort: { key: "size", desc: true }, showHidden: false }),
    );
    localStorage.setItem("mc.bookmarks", JSON.stringify([{ name: "Holiday pics", path: "/Users/demo/Pictures" }]));
  });
  await page.goto("/");
  await ready(page);
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo/Documents");
  await expect(panel(page, 0).locator(".sort-indicator")).toContainText("size↓");
  await expect(panel(page, 1).locator(".panel-path")).toHaveText("/Users/demo");

  const keys = await page.evaluate(() => ["mc.panel.0", "mc.panel.1", "mc.bookmarks"].map((k) => localStorage.getItem(k)));
  expect(keys).toEqual([null, null, null]);
  expect(await mockValue(page, "state.localStorageMigrated")).toBe(true);
  expect(await mockValue(page, "state.panels['0'].path")).toBe("/Users/demo/Documents");

  await page.keyboard.press("Meta+d");
  await expect(page.locator(".bookmarks li")).toHaveCount(1);
  await expect(page.locator(".bookmarks li")).toContainText("Holiday pics");
  await page.keyboard.press("Enter");
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo/Pictures");
});

test("preseeded state wins over localStorage", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__mockSeed = {
      state: { panels: { "1": { path: "/Users/demo/Music", sort: { key: "name", desc: false }, showHidden: false } } },
    };
    localStorage.setItem("mc.panel.1", JSON.stringify({ path: "/Users/demo/Downloads" }));
  });
  await page.goto("/");
  await ready(page);
  await expect(panel(page, 1).locator(".panel-path")).toHaveText("/Users/demo/Music");
  expect(await mockValue(page, "state.panels['1'].path")).toBe("/Users/demo/Music");
});

test.describe("with a clean backend", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await ready(page);
  });

  test("navigating saves panel state", async ({ page }) => {
    await page.keyboard.type("pic", { delay: 30 });
    await page.keyboard.press("Enter");
    await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo/Pictures");
    await expect.poll(() => mockValue(page, "state.panels['0'].path")).toBe("/Users/demo/Pictures");
    await page.keyboard.press("Meta+.");
    await expect.poll(() => mockValue(page, "state.panels['0'].showHidden")).toBe(true);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
  });

  test("adding a bookmark saves it to prefs", async ({ page }) => {
    await page.keyboard.type("mus", { delay: 30 });
    await page.keyboard.press("Enter");
    await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo/Music");
    await page.keyboard.press("Meta+Shift+d");
    await expect
      .poll(() => mockValue<{ name: string; path: string }[] | undefined>(page, "prefs.bookmarks"))
      .toContainEqual({ name: "Music", path: "/Users/demo/Music" });
  });

  test("network dir: NAS badge, and ↻ while a cached listing revalidates", async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__mock.setNetwork("/Users/demo");
      (window as any).__mock.revalidateMs = 800;
    });
    const status = panel(page, 0).locator(".panel-status");
    await page.keyboard.type("doc", { delay: 30 });
    await page.keyboard.press("Enter");
    await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo/Documents");
    await expect(status.locator(".nas-badge")).toBeVisible();
    await expect(status.locator(".stale-marker")).toHaveCount(0); // first visit: read, not cached
    await page.keyboard.press("Backspace");
    await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo");
    const marker = status.locator(".stale-marker");
    await expect(marker).toBeVisible();
    await expect(marker).toHaveAttribute("title", "Refreshing…");
    await expect(marker).toHaveCSS("opacity", "1"); // shown after the 150 ms delay
    await expect(status.locator(".nas-badge")).toHaveText("NAS");
    await expect(marker).toHaveCount(0, { timeout: 3000 });
    await expect(status.locator(".nas-badge")).toBeVisible();
  });

  test("⇧⌘R re-reads with refresh", async ({ page }) => {
    await page.evaluate(() => ((window as any).__mock.revalidateMs = 800));
    await page.keyboard.press("Meta+Shift+r");
    await expect(panel(page, 0).locator(".stale-marker")).toBeVisible();
    await expect(panel(page, 0).locator(".nas-badge")).toHaveCount(0);
    await expect(panel(page, 0).locator(".stale-marker")).toHaveCount(0, { timeout: 3000 });
  });
});
