# Building and publishing

## Build

Prerequisites: macOS 13+, Xcode Command Line Tools, Rust (stable), Node 22+ and pnpm (`packageManager` in `package.json` pins the version; `corepack enable` or `npm i -g pnpm`).

```bash
pnpm install
pnpm tauri build
```

`pnpm build` (run by `tauri build`) first runs `scripts/fetch-libmedia.mjs`, which copies the libmedia video player into `public/libmedia/` and **downloads its WASM decoders from jsDelivr** (pinned, checksummed, ~15 MB; skipped when already present). The first build therefore needs network access. libmedia is LGPL-3.0: its files ship unmodified as separate files with `COPYING.LGPLv3` next to them.

Output:

| File | What |
|---|---|
| `src-tauri/target/release/bundle/macos/Morning Commander.app` | The app (≈ 6 MB + ≈ 17 MB libmedia player and decoders) |
| `src-tauri/target/release/bundle/dmg/Morning Commander_<version>_aarch64.dmg` | Drag-to-Applications disk image |

The build is **Apple Silicon only** (the host architecture). For an Intel or universal build you need rustup (Homebrew's Rust can't add targets):

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
pnpm tauri build --target universal-apple-darwin
```

Before building a release, run the checks: `pnpm typecheck && pnpm test && pnpm test:e2e && (cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test)`.

Never build releases with `--features webdriver` (it's also compiled out of release builds by `cfg(debug_assertions)`, but don't rely on that alone).

### Version

Bump the version in **both** `package.json` and `src-tauri/tauri.conf.json` (and `src-tauri/Cargo.toml` to keep them aligned), commit, then tag: `git tag v0.2.0 && git push --tags`.

## Install locally

```bash
cp -R "src-tauri/target/release/bundle/macos/Morning Commander.app" /Applications/
```

Local builds are **ad-hoc signed**. That's fine on the machine that built them. macOS privacy prompts (Desktop, Documents, Downloads, removable volumes) may reappear after each rebuild because the signature changes.

## Publish

Three levels, from least to most effort.

### 1. GitHub Release with an unsigned (ad-hoc) DMG — works today

```bash
gh release create v0.1.0 \
  "src-tauri/target/release/bundle/dmg/Morning Commander_0.1.0_aarch64.dmg" \
  --title "Morning Commander 0.1.0" --notes "First release"
```

Anyone downloading it gets Gatekeeper's "can't be opened because Apple cannot check it for malicious software". They have to right-click → Open (macOS 14) or allow it in System Settings → Privacy & Security → "Open Anyway" (macOS 15+), or run:

```bash
xattr -dr com.apple.quarantine "/Applications/Morning Commander.app"
```

Acceptable for yourself and friends; not for a wider audience.

### 2. Signed and notarised — needed for a normal download experience

Requires an Apple Developer Program membership (USD 99/year).

1. In Xcode or developer.apple.com, create a **Developer ID Application** certificate and install it in your login keychain. Find its name with `security find-identity -v -p codesigning`.
2. Create an app-specific password at appleid.apple.com (or an App Store Connect API key).
3. Build with these environment variables; Tauri signs, notarises and staples automatically:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
pnpm tauri build
```

(API-key alternative: `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` instead of `APPLE_ID`/`APPLE_PASSWORD`.)

4. Verify: `spctl -a -vv "src-tauri/target/release/bundle/macos/Morning Commander.app"` should say `source=Notarized Developer ID`.
5. Upload the DMG with `gh release create` as above.

### 3. Automated builds from CI

`.github/workflows/build.yml` builds release bundles on GitHub Actions:

| Runner | Output |
|---|---|
| `macos-latest` | universal (Apple Silicon + Intel) `.dmg`, ad-hoc signed |
| `ubuntu-22.04` | `.deb` and `.AppImage` (x86_64, glibc ≥ 2.35) |

It runs on `v*` tags, on demand (Actions → Build → Run workflow) and on PRs that change the build setup. Every run uploads the bundles as workflow artifacts; a tag run also creates a **draft** GitHub Release with them attached, which you review and publish by hand.

So a release is: bump the version (above), `git tag v0.2.0 && git push --tags`, wait for the Build workflow, then publish the draft.

The Linux build is a by-product of Tauri being cross-platform. The app is designed for macOS (Finder-style Trash, `/Volumes`, FSEvents), so treat Linux as best-effort. Windows is not built: the backend uses `std::os::unix` and `libc` outside `cfg(target_os = "macos")` gates (`ops.rs`, `fsutil.rs`, `volume.rs`, `persist.rs`), so it needs a porting step before a `windows-latest` entry can be added to the matrix.

**Signing and notarising in CI (not set up yet).** Once you have a Developer ID certificate, add these repository secrets and pass them to the macOS build step's `env` (Tauri's CLI imports `APPLE_CERTIFICATE` into a temporary keychain and notarises when the `APPLE_ID` variables are set). Replace the ad-hoc `APPLE_SIGNING_IDENTITY: '-'` with the secret.

| Secret | Contents |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the exported `.p12` (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | password of the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: …` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarisation credentials |

Later options: Tauri's updater plugin (signed update manifests on GitHub Releases) and a Homebrew cask (`brew install --cask morning-commander`) pointing at the release DMG.
