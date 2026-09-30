# Morning Commander Implementation Plan

> Last updated: 2026-09-30

## Implementation Status

| Step | Component | Status | Detail |
|------|-----------|--------|--------|
| 0 | Scaffold: Tauri 2 + SolidJS + Vite | DONE | — |
| 1 | Rust core: directory listing (`getattrlistbulk` on macOS), entry model | DONE | [step-1](implementation-plan/step-1-rust-listing.md) |
| 2 | Dual-panel UI: virtualised lists, cursor, `Tab`, navigation | DONE | [step-2](implementation-plan/step-2-dual-panel-ui.md) |
| 3 | Listing cache + FSEvents watcher + diff push | DONE | [step-3](implementation-plan/step-3-cache-watcher.md) |
| 4 | Keyboard: type-to-jump, selection, keymap registry | DONE | [step-4](implementation-plan/step-4-keyboard.md) |
| 5 | Viewer mode: images, PDFs, videos, audio, text | DONE (verified in real app) | [step-5](implementation-plan/step-5-viewer.md) |
| 6 | Rename in place | DONE (verified in real app) | [step-6](implementation-plan/step-6-rename.md) |
| 7 | File operations: copy, move, mkdir, trash, progress, conflict prompts | DONE | [step-7](implementation-plan/step-7-file-operations.md) |
| 8 | Polish: sort modes, hidden, history, bookmarks, help, theme | PARTIAL | [step-8](implementation-plan/step-8-polish.md) |
| 9 | Packaging: app bundle, icon, signing, CI | PARTIAL (icon, `.app`/`.dmg`, CI done; notarisation not started) | [step-9](implementation-plan/step-9-packaging.md) |

Related docs: [`ipc.md`](ipc.md) (Rust ↔ webview contract), [`testing.md`](testing.md) (test layers, driving the real app), [`release.md`](release.md) (build and publish), [`../CLAUDE.md`](../CLAUDE.md) (agent guide).

### Next up (good tasks for an agent)

Each is self-contained; the linked step doc has the spec. Keep `docs/ipc.md`, the mock backend and the tests in sync.

1. **PDF focus trap** — clicking into a PDF iframe steals keys (Esc stops working). Bundle PDF.js or re-focus the document on iframe focus ([step-5](implementation-plan/step-5-viewer.md)).
2. **Network volumes** — detect non-local filesystems (`statfs` `f_fstypename`) and poll the visible directory every ~3 s instead of relying on FSEvents ([step-3](implementation-plan/step-3-cache-watcher.md)).
3. **Mini-status line** — full name, exact size, permissions, mtime of the cursor entry ([step-8](implementation-plan/step-8-polish.md)).
4. **Batch rename** when several files are selected ([step-6](implementation-plan/step-6-rename.md)).
5. **User keymap overrides + ⌘K command palette** ([step-4](implementation-plan/step-4-keyboard.md)).
6. **Compact wire format** for huge listings (10 MB JSON for 100k entries) — only if profiling says so.
7. **Release workflow** — Developer ID signing + notarisation on tag ([step-9](implementation-plan/step-9-packaging.md)).

### Measured (dev build, M-series Mac)

| Scenario | Result |
|---|---|
| 100k-file dir, Rust listing (release) | ~120–140 ms with `getattrlistbulk` (was ~180–400 ms) |
| 100k-file dir in the app, cold: IPC / sort+render | ~180 ms / ~110 ms (was ~1.2 s total) |
| 100k-file dir in the app, cached: IPC / sort+render | ~65 ms / ~70 ms |
| External create/delete/rename → UI | < 500 ms (FSEvents + 100 ms debounce) |

### Decisions made during implementation

- **Frontend owns sort, cursor, selection** (not Rust as first planned below): avoids a round trip per keypress; Rust stays stateless apart from cache + subscriptions. See `ipc.md`.
- **Hand-rolled virtual list** instead of `@tanstack/solid-virtual`: fixed row height makes it ~40 lines.
- **Sorting** uses precomputed natural-sort keys, not `Intl.Collator` (10× faster at 100k).
- **Snapshot is sent in one piece** (JSON over a Tauri channel); the two-stage snapshot wasn't needed.
- **Real-app testing** via `tauri-plugin-webdriver` behind the `webdriver` cargo feature.
- Open questions below (rename key, jump semantics) were implemented as proposed: `⌘R`/`⇧F6`/`F2`, prefix type-ahead with same-letter cycling.

---

## Overview

A dual-pane file manager for macOS in the spirit of Midnight Commander (MC), built with Tauri 2. Rust owns everything that touches the disk; the webview only draws. Target: personal daily driver, keyboard first, fast in large folders, with no thumbnails and nothing that doesn't earn its place.

### Goals

- Two panels, one active, MC-style keys
- Listings open instantly on revisit (in-memory cache) and stay correct without manual refresh (FSEvents)
- Press a letter to jump to a file starting with it
- `Enter` on a file opens a full-window viewer for PDFs, images and videos inside the app
- Rename in place
- Stays smooth in folders with 100k entries

### Non-goals (for v1)

- Thumbnails, icons beyond a type glyph
- Remote filesystems (SFTP, S3), archives as folders
- Built-in editor (`F4` hands off to `$EDITOR` or the default app)
- Windows or Linux support (nothing should prevent it later, but we don't test it)
- Tabs within a panel

---

## Technology decisions

| Concern | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** | Native WKWebView on macOS, small bundle, Rust backend. Required by the brief |
| Frontend | **SolidJS + TypeScript + Vite** | Fine-grained signals update only the rows that changed, which suits a list that is patched by watcher events. Solid and Svelte 5 both benchmark within ~5% of vanilla JS; Solid avoids React's re-render and memoisation overhead on large tables |
| Virtual list | Hand-rolled (planned: `@tanstack/solid-virtual`) | Fixed row height makes virtualisation trivial; only ~50 DOM rows exist at any time |
| FS watching | `notify` + `notify-debouncer-full` | FSEvents backend on macOS. The full debouncer stitches FSEvents' two-part renames into one rename event using file IDs |
| Directory read | `std::fs::read_dir` + `symlink_metadata`, parallel stat with `rayon` for big dirs | Simple; stat is the cost, not readdir |
| Trash | `trash` crate, `DeleteMethod::NsFileManager` | Same API as Finder's "Move to Trash", no Automation permission prompt |
| Open with default app | `tauri-plugin-opener` | Official plugin, wraps `open` |
| Copy / move | `std::fs::rename` same-volume; `fs_extra` or hand-rolled chunked copy cross-volume, later `copyfile(3)` for APFS clones | Start simple, keep a seam for native copy |
| Rust → JS streaming | **Tauri channels** (`tauri::ipc::Channel`) | Tauri docs: events are JSON-only and "not designed for low latency or high throughput"; channels are ordered and fast |
| Viewer file access | Tauri **asset protocol** (`convertFileSrc` → `asset://localhost/…`) | Supports HTTP range requests, so `<video>` seeks and streams without loading the whole file |
| PDF rendering | WKWebView native PDF in an `<iframe>`, fallback to **PDF.js** | Native is free and fast on macOS; PDF.js if iframe display turns out unreliable |

### Alternatives considered

- **Svelte 5**: equally good fit; pick Solid for the slightly more explicit reactivity when applying diffs. Either works.
- **Leptos / Dioxus (Rust in the webview)**: one language, but slower iteration and thinner ecosystem for virtual lists and PDF.js. Not worth it for v1.
- **React**: what [Newt](https://github.com/tibordp/newt) and [Fazi](https://github.com/Pascalrjt/Fazi) use. Works, but needs care to avoid re-rendering 100k-row state.
- **`tauri-plugin-fs` watch API**: exposes `notify` to JS. We want the watcher next to the cache in Rust, so use `notify` directly.

### Prior art worth reading before building

- [Newt](https://github.com/tibordp/newt): Tauri 2 dual-pane manager. Rust is the source of truth and pushes patches to the frontend; a `Vfs` trait abstracts local and remote filesystems.
- [Fazi](https://github.com/Pascalrjt/Fazi): Tauri 2 macOS manager. Streams listings in two stages and hydrates from the viewport outward (100k entries in <50 ms). One command registry feeds keybindings and the command palette.
- [Nimble Commander](https://github.com/mikekazakov/nimble-commander): mature native dual-pane manager for Mac; good reference for behaviour and keys.
- [furman](https://github.com/fenio/furman): another dual-pane macOS manager.

---

## Architecture

```
┌────────────────────── WKWebView (SolidJS) ──────────────────────┐
│  Panel L (virtual list)   Panel R (virtual list)   Viewer       │
│  KeyRouter → CommandRegistry → invoke("cmd", …)                 │
└──────────────▲─────────────────────────────┬────────────────────┘
               │ Channel<PanelMsg>            │ invoke
┌──────────────┴─────────────────────────────▼────────────────────┐
│ Rust (Tauri 2)                                                   │
│  PanelState ×2 ── ListingCache (LRU, Arc<Listing>)               │
│                         ▲                                        │
│                  Watcher (notify-debouncer-full, FSEvents)       │
│  FileOps worker (copy/move/trash, progress via Channel)          │
└──────────────────────────────────────────────────────────────────┘
```

### Rust is the source of truth

> Superseded: the frontend owns sort, cursor and selection (see "Decisions made during implementation" above and `docs/ipc.md`). Kept for history.

Following Newt, panel state (path, sort, selection, cursor) lives in Rust. The frontend renders what it is sent and sends intents back (`navigate`, `toggle_select`, `rename`). This keeps the cache, the watcher and the panels consistent, and makes the core testable without a webview.

The one exception is the cursor: moving it happens on every keypress, so the frontend owns it and reports it to Rust only when it matters (on navigate, operations, and before a diff is applied so the cursor can be kept on the same file).

### Entry model

```rust
struct Entry {
    name: String,          // display name (NFC-normalised)
    kind: Kind,            // File | Dir | Symlink { target_is_dir } | Other
    size: u64,
    modified: i64,         // unix millis
    hidden: bool,          // leading '.' or UF_HIDDEN flag
    ext: Option<String>,   // lowercase, for viewer dispatch and sort
}

struct Listing {
    path: PathBuf,
    entries: Vec<Entry>,   // unsorted, as read
    generation: u64,       // bumped on every change
    read_at: Instant,
}
```

Sorting and hidden-file filtering are views over a `Listing`, computed per panel, so both panels can show the same cached directory with different sort orders.

Sort defaults to MC order: `..` first, then directories, then files, each group by name with natural (numeric-aware) case-insensitive comparison (the `natord` crate or a small custom comparator).

### Listing cache

- `ListingCache`: `HashMap<PathBuf, Arc<Listing>>` behind a `parking_lot::RwLock`, with an LRU cap (say 64 directories or ~500k entries in total, whichever comes first).
- Visiting a cached directory returns immediately; there is no stat re-check, because the watcher keeps entries correct.
- Evicted directories are unwatched unless a panel is showing them.

### Watcher

- One `notify-debouncer-full` debouncer with a ~100 ms window. FSEvents is recursive by nature, so watch each cached directory **non-recursively** so that watching `~` doesn't flood us with events from deep inside it.
- On events for directory `D`, if `D` is cached: for each affected name, re-`stat` it and upsert or remove it. Never trust the event kind alone; FSEvents coalesces events and can report stale flags.
- On `Rescan` / overflow events, or more than N events for one dir in a batch: re-read the whole directory and compute a diff.
- If the directory itself disappears, navigate the panel to the nearest existing ancestor.
- Watch volumes too: detect unmounts (`/Volumes`) so a panel on an ejected disk falls back cleanly.

> Pitfall seen in the wild: `notify-debouncer-full`'s file-ID cache walks the whole watch root. With non-recursive watches per directory this is cheap, but never add a recursive watch on a large root.

### Frontend protocol

> As built, the protocol is `PanelEvent` in `docs/ipc.md` (no generation numbers; paths identify events). Kept for history.

Each panel gets one `Channel<PanelMsg>` on startup:

```ts
type PanelMsg =
  | { type: "snapshot"; path: string; generation: number; entries: Entry[]; cursorName?: string }
  | { type: "patch"; generation: number; removed: string[]; upserted: Entry[] }
  | { type: "error"; path: string; message: string }       // permission denied, gone, …
```

- The first message for a directory is a full `snapshot`; watcher updates are `patch` messages.
- For very large dirs, the snapshot is sent in two stages (Fazi's approach): names and kinds first (the list is usable), then sizes and dates.
- The frontend keeps a sorted array in a Solid store and applies patches in place; the cursor stays on the same *name* if it still exists, otherwise on the same index.
- Serialisation: JSON first. Switch to a compact encoding (arrays of tuples, or MessagePack) only if profiling shows the 100k-entry snapshot is slow.

### Commands (Rust, `#[tauri::command]`)

| Command | Purpose |
|---|---|
| `panel_open(panel, path)` | Navigate; replies via the panel's channel |
| `panel_parent(panel)` | Go up, putting the cursor on the directory we came from |
| `panel_set_sort(panel, key, dir)` | Change sort |
| `panel_toggle_hidden(panel)` | Show or hide dotfiles |
| `rename(dir, from, to)` | Rename in place; errors if the target exists |
| `mkdir(dir, name)` | New folder |
| `trash(paths)` | Move to Trash |
| `copy(paths, dest, channel)` / `move(paths, dest, channel)` | Long-running; progress on the channel, cancellable |
| `open_default(path)` | Hand off to macOS `open` |
| `file_info(path)` | For the viewer header and the text viewer size check |

Every path argument is canonicalised and checked in Rust; the frontend never builds paths by string concatenation.

---

## Keyboard design

MC and Total Commander conventions, adapted for a Mac keyboard. Mac laptops send media keys unless `fn` is held, so every F-key action also gets a `⌘` binding.

### Rule: bare letters are for jumping

Because plain letters jump to entries, **no command is bound to an unmodified letter**. Commands use F-keys, `⌘`, `Tab`, `Space`, `Enter`, `Esc` and arrows.

### Type-to-jump (quick search)

The brief says "clicking letters navigates to a file starting with that given letter". Proposed behaviour, combining Finder and MC:

1. A printable key starts a prefix buffer and moves the cursor to the first entry (from the cursor down, wrapping) whose name starts with the buffer, case-insensitive and diacritic-insensitive.
2. More keys within 800 ms extend the buffer (`r`,`e`,`a` → "rea" → `README.md`).
3. Pressing the **same single letter** again after the timeout, or `↓` while the buffer is shown, cycles to the *next* match. This gives the "press `s` repeatedly to walk through the s-files" behaviour.
4. The buffer is shown in the panel's status line; `Esc` or `Backspace` to empty clears it.
5. No match: the buffer is shown in red and the cursor stays put.

Matching runs in the frontend on the sorted, visible array (an O(n) scan from the cursor is fine even at 100k entries).

### Keymap (v1)

| Key | Action | MC equivalent |
|---|---|---|
| `↑` `↓` `PgUp` `PgDn` `Home` `End` | Move cursor | same |
| `Enter` | Dir: open. File: open viewer (or default app if the type isn't viewable) | same |
| `⌘Enter` / `⌘O` | Open with the default macOS app | — |
| `Backspace` / `⌘↑` | Parent directory | `..` + Enter |
| `Tab` | Switch active panel | same |
| `Space` / `Insert` / `⌘T` | Toggle selection, move down | `Insert` / `Ctrl-T` |
| `⌘A` / `⌘⇧A` | Select all / none | `*`, `+`, `-` |
| `⌘R` / `Shift+F6` | Rename in place | `Shift+F6` |
| `F3` | View | same |
| `F4` | Edit (`$EDITOR` in Terminal, or default app) | same |
| `F5` / `⌘C` | Copy to other panel (confirm dialog) | same |
| `F6` / `⌘M` | Move to other panel | same |
| `F7` / `⌘⇧N` | New folder | same |
| `F8` / `⌘⌫` | Move to Trash | `F8` (MC deletes; we trash) |
| `⌘U` | Swap panels | `Ctrl-U` |
| `⌘=` | Other panel shows the same dir | `Alt-o`-ish |
| `⌘.` | Toggle hidden files | `Alt-.` |
| `⌘1` … `⌘5` | Sort by name, ext, size, mtime, unsorted | sort menu |
| `⌘L` | Go to path (type or paste) | `Alt-c` |
| `⌘D` | Bookmarks / hotlist | `Ctrl-\` |
| `Esc` | Leave viewer / cancel dialog / clear jump buffer | same |

All bindings go through one **command registry** (id, title, default keys, handler, "enabled in" context such as `panel`, `viewer` or `rename`). This gives remappable keys later and a `⌘K` command palette for free.

### Focus contexts

Key handling is modal: `panel` (default), `rename` (input owns keys except `Enter`/`Esc`), `viewer`, and `dialog`. The router dispatches on the current context so, for example, a letter typed in the rename box never triggers a jump.

---

## Viewer mode

`Enter` (or `F3`) on a file switches the window into the viewer, a full-window overlay over both panels. `Esc` returns with the cursor unchanged. In the viewer, `←`/`→` (or `PgUp`/`PgDn`) move to the previous or next *viewable* file in the panel, so you can browse a folder of photos without leaving.

| Kind | Extensions (initial) | How |
|---|---|---|
| Image | png jpg jpeg gif webp avif heic heif bmp tiff svg ico | `<img src=convertFileSrc(path)>`, `object-fit: contain`; `+`/`-`/`0` zoom |
| PDF | pdf | `<iframe src=asset-url>` using WebKit's native PDF view; fall back to bundled PDF.js if the iframe misbehaves |
| Video | mp4 m4v mov (H.264/HEVC), webm | `<video controls autoplay>`; `Space` play/pause, `←`/`→` ±5 s (only while the video has focus) |
| Audio | mp3 m4a aac wav flac | `<audio controls>` |
| Text | txt md json toml yaml rs ts js log csv, and unknown files that pass a UTF-8 sniff | Read in Rust (cap 5 MB), `<pre>` with line numbers; syntax highlighting later |
| Other | — | Info card (size, dates, kind) + "Open with default app" |

Notes:

- **Asset protocol scope.** The asset protocol must be enabled (`app.security.assetProtocol.enable`) with a scope, and `asset:` / `http://asset.localhost` allowed in the CSP (`img-src`, `media-src`, `frame-src`). A personal file manager needs broad scope (`$HOME/**`, `/Volumes/**`). Keep CSP strict otherwise: no remote origins, and never render file content as HTML.
- **Range requests.** Tauri 2's asset protocol supports byte ranges, so large videos stream. The known range bug is Android-only.
- **Codec limits.** WKWebView plays what Safari plays. MKV, AVI and most non-H.264/HEVC files won't play; detect the `error` event and offer "Open with default app".
- **Folder permissions (TCC).** Some folders (Desktop, Documents, Downloads, removable volumes) trigger macOS TCC prompts the first time. That is expected; document it and handle `EPERM` with a clear message.
- **Later:** a Quick Look–style `Space` peek using `QLPreviewPanel` via `objc2` would cover every type macOS knows. Out of scope for v1.

---

## Rename in place

`⌘R` / `Shift+F6` replaces the row's name cell with an `<input>`:

- Preselect the stem, not the extension (`report` in `report.pdf`), like Finder. A second `⌘R` selects everything.
- `Enter` commits → `rename(dir, from, to)`. `Esc` cancels. Losing focus cancels.
- Rust validates: non-empty, no `/`, no `\0`, not `.`/`..`, and the target doesn't exist (case-only renames on case-insensitive APFS are allowed: rename via a temp name).
- Optimistic UI: show the new name immediately; the watcher patch confirms it. On error, revert and show the message in the status bar.
- With several files selected, `⌘R` opens a batch-rename dialog (find/replace, numbering) later; v1 renames only the cursor entry.

---

## File operations

- Operations run on a background worker (`tokio::task::spawn_blocking`), one queue per app, and report progress over a `Channel<OpProgress>` (files done/total, bytes done/total, current file).
- **Move**: `rename(2)` when source and destination share a volume (instant); otherwise copy then delete.
- **Copy**: v1 uses a chunked copy with progress and preserves mtime and permissions. Later, `copyfile(3)` with `COPYFILE_CLONE` for instant APFS clones and extended attributes.
- **Conflicts**: ask per file (Overwrite / Skip / Rename / Apply to all).
- **Cancel**: cooperative flag checked between chunks; remove the partial file on cancel.
- **Delete** always goes to the Trash. Permanent delete (`⇧F8`) needs a typed confirmation and comes later.
- Watchers update both panels automatically; operations never patch the UI directly.

---

## Project layout

```
morning-commander/
├── README.md
├── LICENSE
├── docs/implementation-plan.md
├── package.json / pnpm-lock.yaml / vite.config.ts / tsconfig.json
├── src/                          # SolidJS frontend
│   ├── main.tsx
│   ├── app/App.tsx               # layout: two panels, status bar, viewer overlay
│   ├── panel/Panel.tsx           # virtual list, row, header, rename input
│   ├── panel/store.ts            # snapshot/patch application, sort, cursor
│   ├── panel/jump.ts             # type-to-jump buffer + matching
│   ├── keys/registry.ts          # command registry, contexts, keymap
│   ├── viewer/Viewer.tsx         # dispatch by kind
│   ├── viewer/{Image,Pdf,Video,Text}.tsx
│   ├── ops/OpsDialog.tsx         # copy/move confirm + progress
│   └── ipc.ts                    # typed invoke + channel wrappers
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json           # asset protocol scope, CSP, window
    ├── capabilities/default.json
    └── src/
        ├── main.rs / lib.rs      # builder, plugin + command registration
        ├── model.rs              # Entry, Kind, Listing
        ├── listing.rs            # read_dir + stat, parallel for big dirs
        ├── cache.rs              # ListingCache (LRU)
        ├── watcher.rs            # notify debouncer → cache updates → diffs
        ├── panel.rs              # PanelState, channels, navigation
        ├── sort.rs               # natural sort, dirs-first
        ├── ops/{copy,move_,trash,rename,mkdir}.rs
        └── commands.rs           # #[tauri::command] surface
```

---

## Steps

Each step ends with something runnable.

### Step 0 — Scaffold

- `pnpm create tauri-app` (Solid + TS), app id `com.wernerpm.morningcommander` (confirm), default window 1200×800.
- Add crates: `notify`, `notify-debouncer-full`, `trash`, `parking_lot`, `rayon`, `serde`, `thiserror`, `tauri-plugin-opener`.
- (Planned `@tanstack/solid-virtual`; ended up hand-rolling the virtual list.)
- `cargo clippy`, `cargo test`, `pnpm tsc --noEmit` all pass.

### Step 1 — Rust core listing

- `model.rs`, `listing.rs`, `sort.rs`.
- Handle symlinks (show target kind, don't follow for size), broken links, `EPERM` and `ENOENT`.
- NFC-normalise names for display and matching (macOS filenames are often NFD).
- Unit tests with `tempfile`: sort order, hidden detection, symlinks, unicode.
- Benchmark: list a 100k-file temp dir; target < 150 ms cold.

### Step 2 — Dual-panel UI

- Two panels, fixed row height (22 px), columns: name, size, modified. Monospace-friendly, dense.
- Header shows the path; footer shows item count, selection size and free space.
- Cursor, `Enter` into dirs, `Backspace` up (cursor lands on the dir we left), `Tab` switch.
- Remember each panel's path and restore it on launch (`tauri-plugin-store`).

### Step 3 — Cache + watcher

- `ListingCache` + `watcher.rs` + snapshot/patch protocol.
- Integration test: create, delete and rename files in a watched temp dir; assert the patches.
- Manual test: `touch`, `mv`, `rm` in Terminal show up within ~200 ms; the cursor stays on the same file.
- Stress: `for i in {1..10000}; do touch f$i; done` must not freeze the UI (batching + rescan fallback).

### Step 4 — Keyboard

- Command registry, contexts, keymap table above.
- Type-to-jump with the prefix buffer and repeat-to-cycle.
- Selection (Space/Insert/⌘T), selected-count/size in the footer.

### Step 5 — Viewer

- Asset protocol config + CSP.
- Image, PDF, video, audio, text viewers; prev/next viewable file; `Esc` back.
- Unsupported codec / type → info card + open with default app.

### Step 6 — Rename in place

- Inline input, stem preselection, validation, case-only rename, error revert.

### Step 7 — File operations

- mkdir, trash, copy, move with progress, conflicts and cancel.
- Confirm dialogs follow MC: `F5` shows "Copy N files to <other panel path>" with an editable destination.

### Step 8 — Polish

- Sort modes, hidden toggle, swap panels, same-dir, go-to-path, bookmarks.
- Light and dark theme following the system; optional classic MC blue theme.
- Status bar messages, error toasts.

### Step 9 — Packaging

- App icon, `tauri build`, ad-hoc signing for personal use; Developer ID + notarisation only if distributing.
- Document the Full Disk Access / folder permission prompts in the README.

---

## Risks and open questions

| Item | Notes |
|---|---|
| **Rename shortcut** | The brief says "command + for renaming", which looks cut off. Plan uses `⌘R` plus MC's `Shift+F6`. `Enter` (Finder's rename key) is taken by the viewer. Confirm. |
| **Letter jump semantics** | Plan: prefix type-ahead + same-letter repeat cycles. Alternative: every letter press always cycles to the next single-letter match (no prefix). Confirm. |
| **WKWebView PDF in iframe** | Should render natively; if it's flaky (toolbar, scrolling, focus stealing keys), switch to PDF.js. Spike this early in Step 5. |
| **Keyboard focus in viewer** | `<video>` and PDF iframes swallow keys. Need a capture-phase listener on the window for `Esc` and prev/next, and to test that iframes don't trap focus. |
| **FSEvents on network volumes** | SMB/NFS mounts may not deliver events. Detect non-local volumes (`statfs`) and fall back to polling the visible directory every few seconds. |
| **TCC prompts** | Reading Desktop/Documents/Downloads/removable volumes prompts once per app. Unsigned dev builds may re-prompt after each rebuild. |
| **Huge directories** | Measured: 100k files ≈ 0.3 s cold, 0.14 s cached. Next lever would be a compact wire format (10 MB JSON today). |
| **WebDriver key coverage** | tauri-plugin-webdriver 0.2 doesn't send End/Home/PageUp/PageDown; `drive.mjs press:` works around it. |
| **App id / signing identity** | Needed for Step 9. |

---

## Sources

- Tauri 2 — [Calling the frontend from Rust (events vs channels)](https://v2.tauri.app/develop/calling-frontend/)
- Tauri 2 — [File System plugin (watch, scopes)](https://v2.tauri.app/plugin/file-system/)
- Tauri 2 — [`convertFileSrc` / core API](https://v2.tauri.app/reference/javascript/api/namespacecore/)
- Tauri — [Streaming large files via asset protocol (issue #4133)](https://github.com/tauri-apps/tauri/issues/4133)
- Tauri/wry — [Android-only range request bug (#1864)](https://github.com/tauri-apps/wry/issues/1864)
- [`notify-debouncer-full` docs](https://docs.rs/notify-debouncer-full/latest/notify_debouncer_full/) — rename stitching on FSEvents via file IDs
- [Rust file watcher memory pitfall (file-ID cache on large roots)](https://dev.to/jacksonxly/our-rust-file-watcher-ate-236-gb-of-ram-and-our-ignore-rules-never-had-a-chance-49pn)
- [`trash` crate](https://github.com/Byron/trash-rs) — NSFileManager trash on macOS
- [`open` crate](https://docs.rs/open) / [`opener` crate](https://docs.rs/opener)
- Midnight Commander keys — [macOS cheatsheet](https://gist.github.com/ipanin/c1bc02e7da5d24c398386d1c2d3cfdc9), [cheat sheet](https://gist.github.com/samiraguiar/9cd4264445545cfd459d), [ratfactor notes](https://ratfactor.com/mc)
- Frontend perf — [SolidJS vs Svelte 5 vs React reactivity (2026)](https://www.pkgpulse.com/guides/solidjs-vs-svelte-5-vs-react-reactivity-2026)
- Prior art — [Newt](https://github.com/tibordp/newt), [Fazi](https://github.com/Pascalrjt/Fazi), [Nimble Commander](https://github.com/mikekazakov/nimble-commander), [furman](https://github.com/fenio/furman)
