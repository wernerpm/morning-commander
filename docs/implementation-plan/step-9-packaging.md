# Step 9 — Packaging

> Status: NOT STARTED

## Goals

A `.app` you can drag into `/Applications` and use daily.

## Tasks

1. **Icon**: design a 1024×1024 PNG (sun over two panels?) → `pnpm tauri icon path/to/icon.png` regenerates `src-tauri/icons/*`.
2. **Bundle config** (`src-tauri/tauri.conf.json`): `bundle.targets: ["app", "dmg"]`, `bundle.macOS.minimumSystemVersion: "13.0"`, category `public.app-category.utilities`, copyright.
3. **Build**: `pnpm tauri build` → `src-tauri/target/release/bundle/macos/Morning Commander.app`.
4. **Signing**: for personal use, ad-hoc (`signingIdentity: "-"`). Unsigned/ad-hoc apps get new TCC prompts (Desktop/Documents/Downloads/removable volumes) after every rebuild — expected.
5. **Distribution (optional)**: Developer ID signing + notarisation (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` env vars for `tauri build`), then a GitHub Actions release workflow on a macOS runner.
6. **Full Disk Access**: document in README how to grant it (System Settings → Privacy & Security → Full Disk Access) for browsing `~/Library` etc.
7. **Release checks**: the `webdriver` cargo feature must be off; CSP intact; `cargo build --release` has no debug-only plugins.

## CI (separate, can happen earlier)

GitHub Actions on `macos-latest`: `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm exec playwright install webkit && pnpm test:e2e`, `cargo clippy -D warnings`, `cargo test`. A Linux job can run everything except the macOS-specific Rust tests.
