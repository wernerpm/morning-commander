# Step 5 — Viewer mode

> Status: IN PROGRESS. The component is built and checked in WebKit against the mock backend. Still to do: mount it from `App.tsx`, enable the asset protocol in `tauri.conf.json`, and test with real media in the Tauri app.

## Goals

`Enter` (or `F3`) on a file in a panel opens a full-window viewer for images, PDFs, video, audio and text. `Esc`/`F3` returns to the panel with the cursor on the last file shown. `←`/`→` browse the panel's files without leaving the viewer.

## Public API

```ts
// src/viewer/kind.ts
export type ViewKind = "image" | "pdf" | "video" | "audio" | "text" | "other";
export function viewKind(name: string): ViewKind; // accepts a name or a full path
export function extension(name: string): string;  // lowercase, "" if none

// src/viewer/Viewer.tsx
export interface ViewerProps {
  files: string[];                      // absolute paths of all *files* in the panel, in panel order
  index: number;                        // first file to show (clamped)
  onClose: (lastPath: string) => void;  // put the panel cursor on lastPath
}
export default function Viewer(props: ViewerProps): JSX.Element;
export function formatSize(bytes: number): string;
```

Mount it conditionally from `App.tsx`, e.g. `<Show when={viewer()}>{(v) => <Viewer {...v()} onClose={…} />}</Show>`. `files` is read once on mount (the index is internal state), so re-mount to show a different list.

## Technical approach

- **Overlay.** `position: fixed; inset: 0; z-index: 1000`. Header (name, size when known, `i / n`, close button), body, and a footer listing keys.
- **File access.** Media uses `backend.fileUrl(path)` (Tauri `convertFileSrc` → `asset://localhost/…`). Text uses `backend.readText(path, maxBytes)`. "Open with default app" uses `backend.openDefault(path)`. The Viewer never builds URLs itself.
- **Dispatch** by `viewKind(name)` (extension based; see `kind.ts` for the lists):

| Kind | Rendering |
|---|---|
| image | `<img>` with `object-fit: contain`. Zoom is `null` (fit) or a factor of the natural size; the first `+` starts from the current fitted scale. Zoomed images scroll |
| pdf | `<iframe src=asset-url>` using WebKit's built-in PDF view |
| video | `<video controls autoplay>` |
| audio | `<audio controls autoplay>` with the file name above it |
| text | `readText(path, 5 MB)`, then a single `<pre>` for content plus one `<pre>` for the line-number gutter (two text nodes whatever the file size). A banner shows when the text is truncated |
| other | `readText(path, 64 KB)` as a sniff; shown as text if not binary, otherwise an info card with the size and "Open with default app" |

- **Fallbacks.** An `error` event on `<img>`, `<video>` or `<audio>` switches to a card ("Can't play this format" or "Can't display this image") with "Open with default app" (`⌘O` or `Enter`). The same card shows when `readText` rejects.
- **Per-file state** (zoom, media error) resets whenever the index changes. The body is keyed on the path, so media elements are recreated rather than reused.
- **Styling** lives in `src/viewer/viewer.css`, using the app's CSS variables with fallbacks: `--bg`, `--fg`, `--muted`, `--accent`, `--border`, `--font-mono`, `--font-ui`, `--viewer-bg`.

## Files

```
src/viewer/
  kind.ts       — extension → ViewKind
  Viewer.tsx    — overlay, per-kind rendering, key handling, FallbackCard, TextView
  viewer.css    — styles
```

## Key handling

One `keydown` listener on `window` in the **capture** phase, added on mount and removed on cleanup.

| Key | Action |
|---|---|
| `Esc`, `F3` | Close → `onClose(currentPath)`, then blur and focus `document.body` |
| `←`, `PageUp` / `→`, `PageDown` | Previous / next file (clamped, no wrap). Goes through *all* files, including ones that can't be previewed |
| `Home` / `End` | First / last file |
| `⌘O` | Open with default app |
| `Enter` | Open with default app, only while a fallback or info card is shown |
| `Space` | Play/pause (video, audio) |
| `←`/`→` while the `<video>`/`<audio>` element has focus | Seek ∓5 s instead of changing file |
| `+`/`=`, `-`, `0` | Image zoom in, out, fit |

Propagation rules (the panels must never see keys while the viewer is open):

- Handled keys get `preventDefault()` + `stopImmediatePropagation()`.
- Unhandled keys get `stopImmediatePropagation()` only, so default actions still happen (`↑`/`↓`/`Space` scroll the text view, which is focused when it mounts).
- Exception: unhandled keys while a media element is focused aren't stopped, so WebKit's native media controls keep working.
- Keys with `⌘`/`Ctrl`/`Alt`, other than `⌘O`, are left alone, so app menu shortcuts (`⌘Q`, `⌘W`) still work.

**The panel key router must register its listener after the Viewer mounts, or also check "viewer open"**. `stopImmediatePropagation` on a window capture listener blocks later capture and all bubble listeners, but not a capture listener on `window` that was registered earlier. The simplest contract is for the app's key router to skip everything while the viewer context is active.

### Focus

- On mount the overlay root (`tabIndex=-1`) takes focus; the text view focuses its scroll container when it mounts.
- When the file changes, and on the PDF iframe's `load`, `reclaimFocus` blurs a focused iframe and focuses the text scroller or root, so `Esc` keeps working after a PDF opens.

## Known limitations

- **Clicking into the PDF moves focus into the iframe's document.** Key events then don't reach our window listener, so `Esc` does nothing until the user clicks back on the header/footer. We can't attach listeners inside the iframe: `asset://` is a different origin. Options: a transparent "click to interact" shield, a window `blur` handler that reclaims focus after a delay (fights with PDF scrolling), or the PDF.js fallback (renders in our document).
- **Codecs.** WKWebView plays what Safari plays: H.264/HEVC in MP4/MOV, WebM (VP8/VP9) on recent macOS. MKV, AVI, WMV and FLV fall back to the "Can't play this format" card. Formats such as `mkv` are classified `other`, so they get the binary info card directly.
- **HEIC/AVIF/TIFF** depend on WebKit support on the running macOS (all fine on macOS 13+).
- **Size in the header** only shows for text and "other" files (from `TextPreview.size`). Media files have no size, because there is no `file_info` command yet.
- **Text encoding.** `read_text` decides whether a file is binary or UTF-8 on the Rust side; other encodings (Latin-1, UTF-16) show as binary.
- **Very long lines** aren't wrapped (horizontal scroll). No syntax highlighting.
- **Mock backend.** `fileUrl` returns `mock://…`, so in a plain browser images and video always show the fallback card. Text works.

## Testing

Checked with Playwright (WebKit) against the mock backend, with the Viewer temporarily mounted in `App.tsx`:

1. Opens on `readme.txt`: text renders with gutter `1`, header shows `42 B · 1 / 6`, and focus is on `.viewer-text`
2. `→` → `notes.md` (3 lines in the gutter); `PageDown` → `report.pdf` renders an `iframe.viewer-pdf`
3. `→` → `cat.png` → image fallback card (expected with `mock://`); `→` → `archive.zip` → "No preview" card with the size
4. `End` → `movie.mp4` → media fallback card; `Home` → back to `readme.txt`
5. A bubble-phase `window` keydown listener standing in for the panels saw **0** keys during the whole session, including an unhandled `x`
6. `F3` closes, `onClose` received `/Users/demo/readme.txt`, and focus is on `BODY`

When Playwright tests land in the repo (`tests/e2e/`), port this scenario as `viewer.spec.ts`: open the viewer via `Enter` on a text file in the mock tree and assert the same.

## Acceptance criteria (in the Tauri app)

- [ ] `Enter` on a JPEG/PNG/HEIC shows it fitted; `+`/`-`/`0` zoom and fit
- [ ] `Enter` on a PDF shows WebKit's PDF view; `Esc` closes without clicking first
- [ ] `Enter` on an MP4 (H.264) plays with sound; `Space` pauses; seeking with the scrubber works on a >1 GB file (range requests)
- [ ] `Enter` on an MKV shows the fallback card; `Enter`/`⌘O` opens it in the default app
- [ ] `Enter` on a 50 MB log shows the first 5 MB with a truncation banner without freezing the UI
- [ ] `←`/`→` walk through the panel's files; closing puts the panel cursor on the last file shown
- [ ] No key pressed in the viewer moves the panel cursor or triggers type-to-jump

## Follow-ups

- **PDF.js fallback**: bundle `pdfjs-dist`, render into a canvas stack in our document. Fixes the focus limitation above and gives page keys (`j`/`k`, `g`/`G`).
- **Quick Look peek** (`Space` in the panel): `QLPreviewPanel` via `objc2`, a native window over the app. Covers every type macOS can preview (Office docs, Keynote, fonts, 3D, ...).
- **Syntax highlighting** for text: lazy-load Shiki or highlight.js only when the file is below ~1 MB.
- **Markdown rendering** toggle (`m`) for `.md` files; sanitise and never load remote resources.
- **`file_info` command**: size, dates and dimensions for the header on media files.
- **Hex view** for binary files (`h` in the info card).
- **Slideshow** (`s`) for images; **rotate** (`r`) for images.
- **Remember zoom** per session, and fit-width mode for tall images.
