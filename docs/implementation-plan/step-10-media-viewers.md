# Step 10 — Media-specific viewers

> Status: NOT STARTED (planned 2026-09-30)

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

### Preferences file

New Rust module `prefs.rs` and two commands (add to `docs/ipc.md`):

| Command | Args | Returns |
|---|---|---|
| `prefs_get` | — | `Preferences` |
| `prefs_set` | `patch: Partial<Preferences>` | `Preferences` |

```ts
interface Preferences {
  videoVolume: number;      // 0..1, default 0.8
  // future: theme, keymap overrides, bookmarks (move from localStorage), showHidden default…
}
```

- Stored at `~/.morning-commander/preferences.json` (create the dir with `0700`). Atomic write (temp file + rename). Unknown fields are preserved (forward compatible).
- Loaded once at startup; the frontend keeps a copy and sends patches.
- The mock backend keeps preferences in memory.
- Later: move bookmarks and panel state from `localStorage` here so they survive WebView data resets.

## Tests

- Unit: key maps per view (pure functions: `videoKey(state, key) → action`).
- e2e (mock): open a `.mp4` → `→` sends seek (assert on a fake `HTMLMediaElement` or on `currentTime` with a tiny real video fixture — add `tests/fixtures/tiny.mp4`, a 3-second clip, and serve it from the mock's `fileUrl`), `=` changes volume and calls `prefs_set`; PDF view receives `↓` without a click; `⌘→` goes to the next file of the same kind.
- Rust: prefs round-trip, atomic write, unknown-field preservation.
- Real app (`scripts/drive.mjs`): video seek/volume, PDF scroll, fullscreen toggle.

## Acceptance criteria

- [ ] Opening a video: it plays and `←`/`→`/`↑`/`↓` seek immediately, no click
- [ ] `=`/`-` change volume; the level survives closing the viewer and restarting the app
- [ ] Opening a PDF: `↓` scrolls immediately; arrows never change file; `Esc` always closes
- [ ] `F` toggles fullscreen in all three viewers; `Esc` leaves fullscreen first
- [ ] `⌘←`/`⌘→` move to the previous/next file of the same kind
- [ ] Photos: `←`/`→` skip non-photo files

## Open questions

- Keys for "next file" in video/PDF: `⌘←`/`⌘→` proposed.
- Should videos resume where you left off (per-file position in the cache dir)? Nice for long videos on the NAS.
