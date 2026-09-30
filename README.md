# Morning Commander

A keyboard-first, dual-pane file manager for macOS in the spirit of Midnight Commander, built with Tauri 2 and Rust.

> Status: **usable v0.1** — panels, watcher, viewer, rename, copy/move/trash work. See [`docs/implementation-plan.md`](docs/implementation-plan.md) for what's done and next.

## Features

- **Two panels**: classic left/right layout, `Tab` switches the active panel
- **Fast listings**: directory listings are cached in memory in Rust and kept fresh by FSEvents (`notify`), not re-read on every visit
- **Type to jump**: press a letter to jump to the next entry starting with it; type quickly to match a prefix
- **Built-in viewer**: `Enter` on a PDF, image or video opens it in the app's webview; `Esc` goes back
- **Inline rename**: rename in place without a dialog
- **Midnight Commander keys**: `F3` view, `F5` copy, `F6` move, `F7` mkdir, `F8` trash, with `⌘` alternatives for Mac keyboards
- **No thumbnails**: a plain, dense file list

## Quick Start

### Prerequisites

- macOS 13 or later
- Rust (stable) via [rustup](https://rustup.rs)
- Node.js 20+ and pnpm
- Xcode Command Line Tools (`xcode-select --install`)

### Run in development

```bash
git clone <repository-url>
cd morning-commander
pnpm install
pnpm tauri dev
```

### Build an app bundle

```bash
pnpm tauri build
# → src-tauri/target/release/bundle/macos/Morning Commander.app
# → src-tauri/target/release/bundle/dmg/Morning Commander_0.1.0_aarch64.dmg
```

The app is ad-hoc signed. macOS asks for access the first time you open Desktop, Documents, Downloads or removable volumes; to browse everything (e.g. `~/Library`), grant Full Disk Access in System Settings → Privacy & Security.

### Tests

```bash
pnpm typecheck && pnpm test          # frontend unit tests
pnpm test:e2e                        # Playwright WebKit against the mock backend
(cd src-tauri && cargo test)         # Rust, including real FSEvents tests
```

See [`docs/testing.md`](docs/testing.md) for driving the real app with WebDriver.

## Keyboard reference

| Key | Action |
|---|---|
| `↑` `↓` `PgUp` `PgDn` `Home` `End` | Move cursor |
| `Enter` | Open directory / open file in the viewer |
| `Backspace` / `⌘↑` | Parent directory |
| `Tab` | Switch active panel |
| `a`–`z`, `0`–`9` | Jump to the next entry starting with that character |
| `Space` / `Insert` / `⌘T` | Toggle selection |
| `⌘R` / `Shift+F6` | Rename in place |
| `F3` | View |
| `F5` / `⌘C` | Copy to other panel |
| `F6` / `⌘M` | Move to other panel |
| `F7` / `⌘⇧N` | New folder |
| `F8` / `⌘⌫` | Move to Trash |
| `⌘O` | Open with default app |
| `⌘U` | Swap panels |
| `⌘.` | Toggle hidden files |
| `⌘1`–`⌘5` | Sort by name / extension / size / modified / unsorted (again to reverse) |
| `⌘[` `⌘]` | Back / forward |
| `⌘D` / `⇧⌘D` | Bookmarks / bookmark this folder |
| `⌘L` | Go to path |
| `F1` / `⌘/` | Keyboard help |
| `Esc` | Leave the viewer / cancel |

## Architecture

- **Backend**: Rust (Tauri 2). Owns the filesystem, the listing cache, the watcher and file operations
- **Frontend**: SolidJS + TypeScript + Vite, rendered in WKWebView. Draws two virtualised lists and the viewer; owns sorting, cursor and selection
- **IPC**: Tauri commands for requests, Tauri channels for listing snapshots and diffs
- **Viewer**: files are served through Tauri's `asset://` protocol (supports range requests, so videos stream)

Details are in the [implementation plan](docs/implementation-plan.md).

## License

Apache License 2.0
