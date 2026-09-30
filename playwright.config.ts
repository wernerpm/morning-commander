import { defineConfig, devices } from "@playwright/test";

// Runs the frontend in WebKit (same engine as the app's WKWebView) against
// the in-memory mock backend in src/ipc/mock.ts.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 15_000,
  use: { baseURL: "http://localhost:1420", viewport: { width: 1200, height: 800 } },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1200, height: 800 } } }],
  webServer: { command: "pnpm dev", url: "http://localhost:1420", reuseExistingServer: true, timeout: 30_000 },
});
