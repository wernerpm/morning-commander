# Step 9 — Packaging

> Status: PARTIAL — icon, bundle config, local `.app`/`.dmg` build (ad-hoc signed) and CI done; notarisation/release workflow not started

## Goals

A `.app` you can drag into `/Applications` and use daily.

## Tasks

1. **Icon** — DONE: source is `assets/icon.svg` (sunrise behind two panels). Regenerate with `node scripts/render-icon.mjs /tmp/icon.png && pnpm tauri icon /tmp/icon.png`, then delete `src-tauri/icons/android` and `ios`.
2. **Bundle config** — DONE (`src-tauri/tauri.conf.json`): targets app + dmg, macOS 13.0+, utilities category, copyright.
3. **Build** — DONE: `pnpm tauri build` → `src-tauri/target/release/bundle/macos/Morning Commander.app` (5.7 MB) and `bundle/dmg/Morning Commander_0.1.0_aarch64.dmg` (2.8 MB). Verified the release binary contains no WebDriver code.
4. **Signing**: for personal use, ad-hoc (`signingIdentity: "-"`). Unsigned/ad-hoc apps get new TCC prompts (Desktop/Documents/Downloads/removable volumes) after every rebuild — expected.
5. **Distribution (optional)**: Developer ID signing + notarisation (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` env vars for `tauri build`), then a GitHub Actions release workflow on a macOS runner.
6. **Full Disk Access**: document in README how to grant it (System Settings → Privacy & Security → Full Disk Access) for browsing `~/Library` etc.
7. **Release checks**: the `webdriver` cargo feature must be off; CSP intact; `cargo build --release` has no debug-only plugins.

## CI — DONE (`.github/workflows/ci.yml`)

GitHub Actions on `macos-latest`: `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm exec playwright install webkit && pnpm test:e2e`, `cargo clippy -D warnings`, `cargo test`. A Linux job can run everything except the macOS-specific Rust tests.
