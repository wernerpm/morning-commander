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

async function openIn(page: Page, dir: string, file: string) {
  await page.keyboard.press("Meta+l");
  await page.keyboard.type(`/Users/demo/${dir}`);
  await page.keyboard.press("Enter");
  await expect(panel(page, 0).locator(".panel-path")).toHaveText(`/Users/demo/${dir}`);
  await page.keyboard.type(file.slice(0, 3), { delay: 30 });
  expect(await cursorName(page)).toBe(file);
  await page.keyboard.press("Enter");
  await expect(page.locator(".viewer-name")).toHaveText(file);
}

const mockState = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as {
      __mock: { prefs: Record<string, unknown>; fullscreen: boolean; focusRequests: number };
    }).__mock;
    return { prefs: m.prefs, fullscreen: m.fullscreen, focusRequests: m.focusRequests };
  });

test("PDF renders with PDF.js, has focus without a click, and arrows scroll instead of changing file", async ({ page }) => {
  await openIn(page, "Documents", "report.pdf");
  const pdf = page.locator(".viewer-pdf");
  await expect(pdf.locator(".viewer-pdf-page")).toHaveCount(6);
  await expect(pdf.locator(".viewer-pdf-page canvas").first()).toBeVisible();
  await expect(page.locator(".viewer-meta")).toContainText("p. 1 / 6");
  expect(await pdf.evaluate((el) => document.activeElement === el)).toBe(true);

  await page.keyboard.press("ArrowDown");
  await expect.poll(() => pdf.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("End");
  await expect(page.locator(".viewer-meta")).toContainText("p. 6 / 6");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".viewer-name")).toHaveText("report.pdf");

  await page.keyboard.press("Escape");
  await expect(page.locator(".viewer")).toHaveCount(0);
  expect(await cursorName(page)).toBe("report.pdf");
});

test("video: focused on open, arrows seek, = changes and remembers the volume", async ({ page }) => {
  await openIn(page, "Downloads", "clip.webm");
  const video = page.locator("video.viewer-video");
  expect(await video.evaluate((el) => document.activeElement === el)).toBe(true);
  expect(await video.evaluate((el: HTMLVideoElement) => el.volume)).toBeCloseTo(0.8);

  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(1);
  await page.keyboard.press("Space"); // pause so the clock doesn't move under us
  await page.keyboard.press("ArrowDown"); // −1 min → start
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeLessThan(0.5);
  await page.keyboard.press("ArrowRight"); // +5 s → clamped to the 3 s duration
  await expect(page.locator(".viewer-overlay")).toContainText("+5 s");
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(2.5);
  await expect(page.locator(".viewer-name")).toHaveText("clip.webm"); // arrows never change file

  await page.keyboard.press("=");
  await expect(page.locator(".viewer-overlay")).toContainText("Volume 85%");
  expect(await video.evaluate((el: HTMLVideoElement) => el.volume)).toBeCloseTo(0.85);
  await expect.poll(async () => (await mockState(page)).prefs.videoVolume).toBe(0.85);

  // ⌘→ goes to the next video, skipping installer.dmg.
  await page.keyboard.press("Meta+ArrowRight");
  await expect(page.locator(".viewer-name")).toHaveText("movie.mp4");
  await expect(page.locator(".viewer-meta")).toContainText("2 / 2 videos");
  await page.keyboard.press("Meta+ArrowLeft");
  await expect(page.locator(".viewer-name")).toHaveText("clip.webm");

  // The volume survives closing the viewer.
  await page.keyboard.press("Escape");
  await expect(page.locator(".viewer")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.locator(".viewer-name")).toHaveText("clip.webm");
  expect(await page.locator("video.viewer-video").evaluate((el: HTMLVideoElement) => el.volume)).toBeCloseTo(0.85);
});

test("photos: ←/→ skip files of other kinds", async ({ page }) => {
  await openIn(page, "Pictures", "cat.png");
  await expect(page.locator(".viewer-meta")).toContainText("2 / 3 photos");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".viewer-name")).toHaveText("Sunset.heic"); // not holiday.mp4
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".viewer-name")).toHaveText("beach.jpg");
});

test("F toggles fullscreen; Esc leaves fullscreen first, then closes", async ({ page }) => {
  await openIn(page, "Pictures", "beach.jpg");
  const viewer = page.locator(".viewer");
  await page.keyboard.press("f");
  await expect(viewer).toHaveClass(/fullscreen/);
  expect((await mockState(page)).fullscreen).toBe(true);
  await page.keyboard.press("Escape");
  await expect(viewer).not.toHaveClass(/fullscreen/);
  await expect(viewer).toBeVisible();
  expect((await mockState(page)).fullscreen).toBe(false);
  await page.keyboard.press("f");
  await page.keyboard.press("F3"); // closing while fullscreen leaves fullscreen too
  await expect(viewer).toHaveCount(0);
  expect((await mockState(page)).fullscreen).toBe(false);
});

async function leaveFullscreenKeepsFocus(page: Page, focused: string) {
  const el = page.locator(focused);
  await expect.poll(() => el.evaluate((e) => document.activeElement === e)).toBe(true);
  for (const leave of ["Escape", "f"]) {
    const before = (await mockState(page)).focusRequests;
    await page.keyboard.press("f");
    await expect(page.locator(".viewer")).toHaveClass(/fullscreen/);
    await page.keyboard.press(leave);
    await expect(page.locator(".viewer")).not.toHaveClass(/fullscreen/);
    await expect.poll(async () => (await mockState(page)).focusRequests).toBeGreaterThan(before);
    expect(await el.evaluate((e) => document.activeElement === e)).toBe(true);
  }
}

test("leaving fullscreen re-focuses the window: video", async ({ page }) => {
  await openIn(page, "Downloads", "clip.webm");
  await leaveFullscreenKeepsFocus(page, "video.viewer-video");
  await page.keyboard.press("-"); // keys still reach the player
  await expect(page.locator(".viewer-overlay")).toContainText("Volume 75%");
});

test("leaving fullscreen re-focuses the window: PDF", async ({ page }) => {
  await openIn(page, "Documents", "report.pdf");
  await expect(page.locator(".viewer-pdf-page canvas").first()).toBeVisible();
  await leaveFullscreenKeepsFocus(page, ".viewer-pdf");
  await page.keyboard.press("End"); // keys still scroll the document
  await expect(page.locator(".viewer-meta")).toContainText("p. 6 / 6");
});

test("leaving fullscreen re-focuses the window: photo", async ({ page }) => {
  await openIn(page, "Pictures", "beach.jpg");
  await expect(page.locator(".viewer-image img")).toBeVisible();
  await leaveFullscreenKeepsFocus(page, ".viewer-image");
  await page.keyboard.press("ArrowRight"); // keys still change photo
  await expect(page.locator(".viewer-name")).toHaveText("cat.png");
});
