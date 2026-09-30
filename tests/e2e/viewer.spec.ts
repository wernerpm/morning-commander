import { expect, test, type Page } from "@playwright/test";

const panel = (page: Page, id: 0 | 1) => page.locator(`[data-panel="${id}"]`);
const cursorName = (page: Page) => panel(page, 0).locator(".row.cursor").getAttribute("data-name");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(panel(page, 0).locator(".row").first()).toBeVisible();
});

test("Enter on a text file opens the viewer; Esc returns", async ({ page }) => {
  await page.keyboard.type("rea", { delay: 30 });
  await page.keyboard.press("Enter");
  const viewer = page.locator(".viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".viewer-name")).toHaveText("readme.txt");
  await expect(viewer.locator(".viewer-code")).toContainText("Morning Commander mock filesystem");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  expect(await cursorName(page)).toBe("readme.txt");
});

test("arrow keys walk files in panel order and the cursor follows on close", async ({ page }) => {
  await page.keyboard.type("alp", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect(page.locator(".viewer-name")).toHaveText("alpha.txt");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".viewer-name")).toHaveText("Beta.txt");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".viewer-name")).toHaveText("readme.txt");
  await page.keyboard.press("Escape");
  expect(await cursorName(page)).toBe("readme.txt");
});

test("panel keys don't fire while the viewer is open", async ({ page }) => {
  await page.keyboard.type("rea", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect(page.locator(".viewer")).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("F7");
  await expect(page.getByRole("dialog", { name: "New folder" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel(page, 0)).toHaveClass(/active/);
});

test("F3 on a PDF shows it in an iframe", async ({ page }) => {
  await page.keyboard.type("doc", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo/Documents");
  await page.keyboard.type("rep", { delay: 30 });
  expect(await cursorName(page)).toBe("report.pdf");
  await page.keyboard.press("F3");
  await expect(page.locator(".viewer-name")).toHaveText("report.pdf");
  await expect(page.locator("iframe.viewer-pdf")).toBeVisible();
});
