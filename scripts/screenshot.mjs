// Screenshot the frontend (mock backend) in WebKit, optionally after typing keys.
// Usage: node scripts/screenshot.mjs out.png [key ...]
//   keys are Playwright key names ("ArrowDown", "Meta+r") or "type:text".
// Needs `pnpm dev` running on :1420.
import { webkit } from "@playwright/test";

const [out = "screenshot.png", ...keys] = process.argv.slice(2);
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto("http://localhost:1420/");
await page.waitForSelector(".row");
for (const k of keys) {
  if (k.startsWith("type:")) await page.keyboard.type(k.slice(5), { delay: 40 });
  else if (k.startsWith("wait:")) await page.waitForTimeout(Number(k.slice(5)));
  else await page.keyboard.press(k);
}
await page.waitForTimeout(150);
await page.screenshot({ path: out });
await browser.close();
