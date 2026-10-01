# Step 10 — Media-specific viewers

> Status: DONE (2026-09-30), except verification in the real app (`scripts/drive.mjs`, needs macOS). Frontend unit + e2e (mock backend) and Rust tests pass.

## Goals

Each content type gets the keyboard behaviour that suits it, instead of one shared "arrows change file" viewer:

| Type | On open | Arrow keys | Other keys |
|---|---|---|---|
| **Photos** | Image fitted to the window | `←`/`→` previous/next *photo* in the panel | `+`/`-`/`0` zoom (as today), `F` fullscreen |
| **Videos** | Player opens, starts playing and **has focus immediately** | `←`/`→` seek −5 s / +5 s; `↑`/`↓` seek +1 min / −1 min | `=`/`-` volume up/down, `Space` play/pause, `F` fullscreen, `M` mute |
| **PDFs** | Document opens **focused** (no click needed) | `↑`/`↓` scroll within the document; arrows never change file | `F` fullscreen, `Space`/`⇧Space` page down/up, `Home`/`End` first/last page, `+`/`-` zoom |

Common to all: `Esc` closes (or leaves fullscreen first), `⌘O` opens in the default app.

The video volume is remembered across files and restarts in a **global preferences file** (`~/.morning-commander/preferences.json`, see below).

## Changing files when arrows are taken

Arrows seek in videos and scroll in PDFs, so they can't also change file. Proposal (to confirm):

- `⌘←` / `⌘→` (and `PageUp`/`PageDown` for photos and videos) → previous/next file **of the same kind** in the panel, for every viewer. For photos plain `←`/`→` does the same.
- Navigation skips files of other kinds: in a folder of mixed photos and videos, `→` in the photo viewer goes to the next photo.

`↑` = +1 min / `↓` = −1 min follows the brief ("up and down arrows move 1 minute previous and next"); that's `↑` forward, like a volume knob. Flip it if it feels wrong in use.

## Technical approach

### Split the viewer

`src/viewer/Viewer.tsx` becomes a shell (header, file list, close/fullscreen handling, file-to-file navigation by kind) that mounts one of:

```
src/viewer/ImageView.tsx   zoom/pan, ←/→ = next photo
src/viewer/VideoView.tsx   custom key handling on <video>, volume from prefs
src/viewer/PdfView.tsx     PDF.js renderer (see below)
src/viewer/TextView.tsx    unchanged behaviour
src/viewer/InfoCard.tsx    other/binary
```

Each view exports `handleKey(e: KeyboardEvent): boolean` (true = consumed). The shell's single capture-phase listener asks the active view first and falls back to shell keys (`Esc`, `⌘←/⌘→`, `⌘O`, `F`). This replaces today's special case "←/→ seek only while the video element is focused".

### Video

- On mount: `video.focus()`, `autoplay`, `volume = prefs.videoVolume`.
- Seek: `video.currentTime = clamp(t ± 5 | 60, 0, duration)`. Show a brief overlay ("+5 s", "1:23 / 45:10") so seeking is visible without controls.
- Volume: `=`/`-` in steps of 0.05 with an overlay bar; on change, debounce 500 ms and save to preferences. Keep `muted` separate (`M`) and don't persist it.
- Hide native controls after 2 s without mouse movement; show on mouse move.

### PDF — switch to PDF.js

The native WebKit PDF view lives in an `<iframe>` on the `asset://` origin: we can't focus it programmatically *and* keep receiving keys, and clicking into it traps `Esc` (known gap from step 5). Rendering with [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) puts the pages in our own document, so:

- The scroll container gets focus on open; `↑`/`↓` scroll by ~10% of the viewport, `Space` by a page.
- Render pages lazily (only visible ± 2 pages) to keep big PDFs fast; use the PDF.js worker (bundle it; CSP `worker-src 'self' blob:`).
- Load via `fetch(backend.fileUrl(path))` → `ArrayBuffer` (asset protocol supports range requests; PDF.js can use range loading for large files).
- Text selection layer optional (later); search (`⌘F`) later.

This also fixes the step-5 focus-trap limitation.

### Fullscreen (`F`)

Use the **window**: `getCurrentWindow().setFullscreen(!isFullscreen)` from `@tauri-apps/api/window` (needs the `core:window:allow-set-fullscreen` permission in `capabilities/default.json`). The viewer already fills the window, so window fullscreen = viewer fullscreen, and it avoids WKWebView's element-fullscreen quirks. `Esc` leaves fullscreen first, a second `Esc` closes the viewer. Closing the viewer while fullscreen also leaves fullscreen.

### Preferences and state files (do this first)

**Decision (2026-09-30):** all persistent settings live in files under `~/.morning-commander/`, owned by Rust — **not** in `localStorage`. Reasons: Rust needs some settings before the webview exists (cache limits, polling, prefetch — step 11); `localStorage` is per-origin (dev `http://localhost:1420` and the bundled app keep separate copies) and hidden in `~/Library/WebKit/<app>/WebsiteData/…`, where it can be wiped; files are editable, backup-able and testable. `~/.morning-commander/` (not `~/Library/Application Support/…`) because it fits a keyboard-driven MC-style tool (MC uses `~/.config/mc/`).

Layout:

```
~/.morning-commander/            0700; overridable with env MC_HOME (tests)
  preferences.json   settings, rarely written: bookmarks, default sort, showHidden default,
                     videoVolume, cacheMaxBytes, cacheMaxAgeDays, prefetch …
  state.json         session state, written often: per-panel path/sort/showHidden, history
  cache/             listing cache (step 11), excluded from Time Machine
```

- Keep preferences and state in separate files so frequent state writes can never corrupt settings.
- **Migration:** on first launch (no `state.json`), the frontend reads `localStorage` keys `mc.panel.0`, `mc.panel.1`, `mc.bookmarks`, sends them to Rust (`prefs_set` / `state_set`), then removes them. After that `localStorage` isn't used.
- State writes are debounced (~500 ms) and flushed on exit.

New Rust module `prefs.rs` and commands (add to `docs/ipc.md`):

| Command | Args | Returns |
|---|---|---|
| `prefs_get` | — | `Preferences` |
| `prefs_set` | `patch: Partial<Preferences>` | `Preferences` |
| `state_get` | — | `AppState` |
| `state_set` | `patch: Partial<AppState>` | `void` (debounced write) |

```ts
interface Preferences {
  videoVolume: number;      // 0..1, default 0.8
  // future: theme, keymap overrides, bookmarks (move from localStorage), showHidden default…
}
```

- Stored at `~/.morning-commander/preferences.json` (create the dir with `0700`). Atomic write (temp file + rename). Unknown fields are preserved (forward compatible).
- Loaded once at startup; the frontend keeps a copy and sends patches.
- The mock backend keeps preferences in memory.
- Bookmarks move to `preferences.json`; panel path/sort/hidden + history move to `state.json` (replacing `localStorage` in `src/panel/store.ts` and `src/app/Bookmarks.tsx`).

## Tests

- Unit: key maps per view (pure functions: `videoKey(state, key) → action`).
- e2e (mock): open a `.mp4` → `→` sends seek (assert on a fake `HTMLMediaElement` or on `currentTime` with a tiny real video fixture — add `tests/fixtures/tiny.mp4`, a 3-second clip, and serve it from the mock's `fileUrl`), `=` changes volume and calls `prefs_set`; PDF view receives `↓` without a click; `⌘→` goes to the next file of the same kind.
- Rust: prefs round-trip, atomic write, unknown-field preservation.
- Real app (`scripts/drive.mjs`): video seek/volume, PDF scroll, fullscreen toggle.

## Implementation notes

- **Files:** `src/viewer/Viewer.tsx` (shell), `ImageView.tsx`, `MediaView.tsx` (video *and* audio: audio gets the same seek/volume keys), `PdfView.tsx`, `TextView.tsx`, `InfoCard.tsx`; key maps are pure functions in `src/viewer/keys.ts` (`shellKey`, `mediaKey`, `pdfKey`, `imageKey`); navigation groups in `kind.ts` (`navGroup`, `stepInGroup`).
- **Navigation groups:** photos, videos, audio, PDFs, and "documents" (text + unknown files together, so the text viewer's `←`/`→` still walks readme → notes → archive). Every view: `⌘←`/`⌘→`; views that don't use them also get plain `←`/`→`, `PageUp`/`PageDown`, `Home`/`End`. The header shows the position within the group ("2 / 3 photos").
- **Video:** the key handler runs in the window's capture phase and `preventDefault`s what it consumes, so native controls never double-handle `Space`/arrows. Volume changes from the native slider are saved too (on `volumechange`, debounced 500 ms, flushed on close). `+`/`=` and `-`/`_` both work (with or without Shift). Controls hide after 2 s without mouse movement.
- **PDF:** `pdfjs-dist` **legacy** build (supports the Safari 16 WKWebView on macOS 13), lazy-loaded into its own chunk (~150 KB gzip + worker), so the main bundle is unchanged. The file is `fetch`ed whole (`connect-src` now allows `asset:`); pages are laid out at page 1's size, fitted to the window width (max 1000 px), and rendered into canvases only within ~2 screens of the viewport (farther canvases are dropped). The header shows "p. 3 / 12". `frame-src` was removed from the CSP.
- **Fullscreen:** the header and hint bar are hidden while fullscreen. A window `resize` re-reads `isFullscreen()` so leaving fullscreen with the green button keeps `Esc` right.
- **Preferences/state:** `src-tauri/src/prefs.rs` + `src/app/settings.ts`, exactly as specified in `docs/ipc.md` (merge patches, defaults, debounced state, flush on exit, `*.corrupt`, `localStorageMigrated`). `src/index.tsx` loads settings before rendering; panels and bookmarks no longer touch `localStorage`.

## Acceptance criteria

- [x] Opening a video: it plays and `←`/`→`/`↑`/`↓` seek immediately, no click (e2e: focus + seek)
- [x] `=`/`-` change volume; the level survives closing the viewer and restarting the app (e2e: survives closing; restart = `preferences.json`, Rust tests)
- [x] Opening a PDF: `↓` scrolls immediately; arrows never change file; `Esc` always closes
- [x] `F` toggles fullscreen in all three viewers; `Esc` leaves fullscreen first
- [x] `⌘←`/`⌘→` move to the previous/next file of the same kind
- [x] Photos: `←`/`→` skip non-photo files
- [ ] Verified in the real app on macOS (video seek/volume, PDF scroll, fullscreen toggle)

## Open questions

- Keys for "next file" in video/PDF: `⌘←`/`⌘→` proposed.
- Should videos resume where you left off (per-file position in the cache dir)? Nice for long videos on the NAS.
