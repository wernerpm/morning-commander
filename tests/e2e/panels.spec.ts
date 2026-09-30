import { expect, test, type Page } from "@playwright/test";

const panel = (page: Page, id: 0 | 1) => page.locator(`[data-panel="${id}"]`);
const cursorName = (page: Page, id: 0 | 1 = 0) => panel(page, id).locator(".row.cursor").getAttribute("data-name");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo");
  await expect(panel(page, 0).locator(".row").first()).toBeVisible();
});

test("shows both panels with dirs first and a parent row", async ({ page }) => {
  const rows = panel(page, 0).locator(".row .name");
  await expect(rows.nth(0)).toHaveText("..");
  await expect(rows.nth(1)).toHaveText("Documents");
  await expect(panel(page, 1).locator(".panel-path")).toHaveText("/Users/demo");
  await expect(panel(page, 0)).toHaveClass(/active/);
});

test("arrow keys, Enter and Backspace navigate", async ({ page }) => {
  await page.keyboard.press("ArrowDown");
  expect(await cursorName(page)).toBe("Documents");
  await page.keyboard.press("Enter");
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo/Documents");
  await page.keyboard.press("Backspace");
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo");
  await expect.poll(() => cursorName(page)).toBe("Documents");
});

test("typing letters jumps to matching files", async ({ page }) => {
  await page.keyboard.press("p");
  expect(await cursorName(page)).toBe("Pictures");
  await page.waitForTimeout(1300); // let the buffer expire so a new prefix starts
  await page.keyboard.type("rea", { delay: 50 });
  expect(await cursorName(page)).toBe("readme.txt");
  await expect(panel(page, 0).locator(".jump")).toHaveText("Jump: rea");
});

test("pressing the same letter cycles through matches", async ({ page }) => {
  await page.keyboard.press("d");
  expect(await cursorName(page)).toBe("Documents");
  await page.keyboard.press("d");
  expect(await cursorName(page)).toBe("Downloads");
});

test("Tab switches the active panel", async ({ page }) => {
  await page.keyboard.press("Tab");
  await expect(panel(page, 1)).toHaveClass(/active/);
  await page.keyboard.press("m");
  expect(await cursorName(page, 1)).toBe("Many");
  expect(await cursorName(page, 0)).toBe("..");
});

test("rename in place with Cmd+R", async ({ page }) => {
  await page.keyboard.type("alp", { delay: 30 });
  await page.keyboard.press("Meta+r");
  const input = panel(page, 0).locator("input.rename");
  await expect(input).toBeFocused();
  // Stem is preselected, so typing replaces "alpha" and keeps ".txt".
  await page.keyboard.type("omega");
  await page.keyboard.press("Enter");
  await expect(panel(page, 0).locator('.row[data-name="omega.txt"]')).toBeVisible();
  expect(await cursorName(page)).toBe("omega.txt");
});

test("rename cancels with Escape", async ({ page }) => {
  await page.keyboard.type("zet", { delay: 30 });
  await page.keyboard.press("Meta+r");
  await page.keyboard.type("nope");
  await page.keyboard.press("Escape");
  await expect(panel(page, 0).locator("input.rename")).toHaveCount(0);
  expect(await cursorName(page)).toBe("zeta.txt");
});

test("F7 creates a folder and moves the cursor to it", async ({ page }) => {
  await page.keyboard.press("F7");
  await page.keyboard.type("New Stuff");
  await page.keyboard.press("Enter");
  await expect.poll(() => cursorName(page)).toBe("New Stuff");
});

test("F8 trashes after confirmation", async ({ page }) => {
  await page.keyboard.type("bet", { delay: 30 });
  await page.keyboard.press("F8");
  await expect(page.getByRole("dialog")).toContainText('"Beta.txt"');
  await page.keyboard.press("Enter");
  await expect(panel(page, 0).locator('.row[data-name="Beta.txt"]')).toHaveCount(0);
});

test("F5 copies selected files to the other panel", async ({ page }) => {
  await page.keyboard.press("Tab");
  await page.keyboard.press("d");
  await page.keyboard.press("Enter");
  await expect(panel(page, 1).locator(".panel-path")).toHaveText("/Users/demo/Documents");
  await page.keyboard.press("Tab");
  await page.keyboard.type("alp", { delay: 30 });
  await page.keyboard.press("Space"); // select alpha.txt, cursor moves to Beta.txt
  await page.keyboard.press("Space"); // select Beta.txt
  await page.keyboard.press("F5");
  await expect(page.getByRole("dialog")).toContainText("2 items");
  await page.keyboard.press("Enter");
  await expect(panel(page, 1).locator('.row[data-name="alpha.txt"]')).toBeVisible();
  await expect(panel(page, 1).locator('.row[data-name="Beta.txt"]')).toBeVisible();
});

test("large directories stay responsive (virtualised)", async ({ page }) => {
  await page.keyboard.press("m");
  await page.keyboard.press("a");
  expect(await cursorName(page)).toBe("Many");
  await page.keyboard.press("Enter");
  await expect(panel(page, 0).locator(".panel-status")).toContainText("2000 files");
  expect(await panel(page, 0).locator(".row").count()).toBeLessThan(100);
  await page.keyboard.press("End");
  expect(await cursorName(page)).toBe("file-2000.txt");
});

test("external changes appear without refresh", async ({ page }) => {
  await page.evaluate(() => (window as any).__mock.touch("/Users/demo/appeared.txt", 5));
  await expect(panel(page, 0).locator('.row[data-name="appeared.txt"]')).toBeVisible();
  await expect(panel(page, 1).locator('.row[data-name="appeared.txt"]')).toBeVisible();
});

test("Cmd+[ and Cmd+] move through history", async ({ page }) => {
  await page.keyboard.type("doc", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo/Documents");
  await page.keyboard.press("Meta+[");
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo");
  await page.keyboard.press("Meta+]");
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo/Documents");
});

test("bookmarks: add current folder, filter, open", async ({ page }) => {
  await page.keyboard.type("pic", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo/Pictures");
  await page.keyboard.press("Meta+Shift+d");
  await page.keyboard.press("Backspace");
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo");
  await page.keyboard.press("Meta+d");
  await page.keyboard.type("pictu");
  await expect(page.locator(".bookmarks li")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(panel(page, 0).locator(".panel-path")).toHaveText("/Users/demo/Pictures");
});

async function copyReadmeIntoDocumentsTwice(page: Page) {
  // Right panel → Documents, then copy readme.txt there twice.
  await page.keyboard.press("Tab");
  await page.keyboard.type("doc", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect(panel(page, 1).locator(".panel-path")).toHaveText("/Users/demo/Documents");
  await page.keyboard.press("Tab");
  await page.keyboard.type("rea", { delay: 30 });
  await page.keyboard.press("F5");
  await page.keyboard.press("Enter");
  await expect(panel(page, 1).locator('.row[data-name="readme.txt"]')).toBeVisible();
  await page.keyboard.press("F5");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "File exists" })).toBeVisible();
}

test("copy conflict: keep both", async ({ page }) => {
  await copyReadmeIntoDocumentsTwice(page);
  await page.keyboard.press("k");
  await expect(panel(page, 1).locator('.row[data-name="readme 2.txt"]')).toBeVisible();
  // the dialog's letters must not leak into type-to-jump
  expect(await cursorName(page)).toBe("readme.txt");
});

test("copy conflict: skip and cancel", async ({ page }) => {
  await copyReadmeIntoDocumentsTwice(page);
  await page.keyboard.press("Enter"); // skip
  await expect(page.getByRole("dialog", { name: "File exists" })).toHaveCount(0);
  await expect(panel(page, 1).locator('.row[data-name="readme 2.txt"]')).toHaveCount(0);
  await page.keyboard.press("F5");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape"); // cancel
  await expect(page.locator(".statusline")).toContainText("cancelled");
});
