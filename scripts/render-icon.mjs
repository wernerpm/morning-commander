// Render assets/icon.svg to a 1024×1024 PNG with a transparent background.
// Usage: node scripts/render-icon.mjs out.png  →  pnpm tauri icon out.png
import { readFileSync } from "node:fs";
import { webkit } from "@playwright/test";

const out = process.argv[2] ?? "icon.png";
const svg = readFileSync(new URL("../assets/icon.svg", import.meta.url), "utf8");
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.locator("svg").screenshot({ path: out, omitBackground: true });
await browser.close();
