# IPC contract

The single source of truth for what crosses the Rust ↔ webview boundary. Rust types live in `src-tauri/src/model.rs`; TypeScript mirrors live in `src/ipc/types.ts`. **Change all three together.**

All field names are `camelCase` on the wire (`#[serde(rename_all = "camelCase")]`).

## Division of responsibility

| Concern | Owner | Notes |
|---|---|---|
| Reading directories, stat | Rust | |
| Listing cache + FS watching | Rust | One subscription per panel |
| Sorting, hidden-file filter | Frontend | Both panels can view the same dir with different sort; sorting 100k entries in JS is ~50 ms |
| Cursor, selection, jump buffer | Frontend | Hot path on every keypress; never round-trips |
| File operations | Rust | Frontend asks; the watcher reports the result |

> This deviates from the original plan ("Rust owns panel state"). Keeping sort and cursor in the frontend removes a round trip per keypress and keeps Rust stateless apart from the cache and subscriptions.

## Types

```ts
type EntryKind = "file" | "dir" | "symlink" | "other";

interface Entry {
  name: string;        // NFC-normalised file name (no path)
  kind: EntryKind;
  targetIsDir: boolean; // symlink pointing to a directory (navigable); false otherwise
  size: number;        // bytes; 0 for directories
  mtime: number;       // unix epoch millis; 0 if unknown
  hidden: boolean;     // leading "." or macOS UF_HIDDEN flag
}

type PanelEvent =
  | { type: "snapshot"; path: string; parent: string | null; entries: Entry[]; stale: boolean; network: boolean }
  | { type: "patch"; path: string; removed: string[]; upserted: Entry[] }
  | { type: "fresh"; path: string }                 // revalidation of a stale snapshot finished
  | { type: "error"; path: string; message: string };

type OpKind = "copy" | "move";

type OpEvent =
  | { type: "progress"; id: number; filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number; current: string }
  | { type: "conflict"; id: number; path: string }   // destination exists; op waits for resolve_conflict
  | { type: "done"; id: number; errors: string[] }
  | { type: "cancelled"; id: number };

// Overwrite moves the existing item to the Trash first; keepBoth uses "name 2.ext".
type ConflictChoice = "overwrite" | "skip" | "keepBoth" | "cancel";

interface TextPreview { text: string; truncated: boolean; binary: boolean; size: number }
```

- `snapshot.path` is the canonical absolute path actually shown. It can differ from what was requested (symlinks resolved, `~` expanded, or a fallback to the nearest existing ancestor when the directory vanished).
- `snapshot.parent` is `null` at `/`. The frontend renders a synthetic `..` row when it isn't null; Rust never sends `..`.
- `patch.upserted` contains full entries for created or changed names; `removed` lists names that no longer exist. A rename arrives as one removal plus one upsert in the same patch.
- Events for a path the panel has already navigated away from must be ignored by the frontend (compare `path`).
- `snapshot.stale` is `true` when the listing came from a cache that may be out of date: the on-disk cache (after a relaunch), or the memory cache of a **network** directory (FSEvents doesn't work there). Rust revalidates it in the background, sends any differences as a `patch`, then exactly one `fresh` for that path. The panel shows "↻" in its footer between the two. A stale snapshot whose revalidation fails (directory unreachable) gets no `fresh`; if the directory is gone, the usual fallback to the nearest ancestor applies.
- `snapshot.network` is `true` when the directory is on a network volume (`statfs`: not `MNT_LOCAL`, or smbfs/nfs/afpfs/webdav), or when the app runs with `MC_FORCE_NETWORK=1` (testing). The footer shows a "NAS" badge.

### Stale-while-revalidate (step 11b)

| Source of the listing | `stale` | Background revalidation |
|---|---|---|
| Memory cache, local volume | `false` | none (FSEvents keeps it current) |
| Memory cache, network volume | `true` | `stat` the directory; mtime unchanged → `fresh`; changed → full re-read → `patch` → `fresh` |
| Disk cache, local volume | `true` | full re-read → `patch` (if different) → `fresh` |
| Disk cache, network volume | `true` | as for the memory cache on a network volume |
| Not cached | `false` | none (read before the snapshot is sent) |
| any, with `refresh: true` | `true` if cached | always a full re-read (no mtime shortcut) |

## Preferences and state

Two JSON files under `~/.morning-commander/` (directory `0700`, files `0600`, written atomically; `MC_HOME` overrides the directory, used by tests). Rust owns them; the frontend loads both once at startup (before rendering) and sends patches.

```ts
interface Bookmark { name: string; path: string }

interface Preferences {          // preferences.json: settings, rarely written
  bookmarks?: Bookmark[];        // absent → the frontend's defaults (Home, Desktop, …)
  videoVolume: number;           // 0..1, default 0.8 (step 10)
  cacheMaxBytes: number;         // default 104857600 (100 MiB); listing cache limit
  cacheMaxAgeDays: number;       // default 180; unvisited longer → evicted
  [key: string]: unknown;        // unknown fields are preserved
}

interface PanelState { path: string; sort: { key: SortKey; desc: boolean }; showHidden: boolean }

interface AppState {             // state.json: session state, written often
  panels?: { "0"?: PanelState; "1"?: PanelState };
  localStorageMigrated?: boolean; // set once the pre-files localStorage data was imported
  [key: string]: unknown;
}
```

- `prefs_set` / `state_set` take a **JSON merge patch** (RFC 7386): objects merge recursively, `null` deletes a key, arrays and scalars replace. So `state_set({ panels: { "1": {...} } })` leaves panel 0 alone.
- `prefs_get` fills in defaults for missing known keys; the file itself only stores what was set.
- `prefs_set` writes immediately. `state_set` updates memory and writes after ~500 ms of quiet (debounced), and on exit.
- A corrupt file is renamed to `*.corrupt` and treated as empty (never fatal).
- **Migration from `localStorage`:** at startup, if `state.localStorageMigrated` is not `true`, the frontend imports `localStorage` keys `mc.panel.0`, `mc.panel.1` (→ `state.panels`) and `mc.bookmarks` (→ `prefs.bookmarks`), without overwriting values already in the files, then sets `localStorageMigrated: true` and removes the keys. After that `localStorage` isn't used. (A flag rather than "state.json is missing" because the dev server origin and the bundled app have separate `localStorage`s but share the files.)

## Listing cache on disk (step 11b)

`~/.morning-commander/cache/` (excluded from Time Machine; safe to delete at any time) holds `index.json` and one file per directory in `dirs/`. It is internal to Rust and not part of the IPC surface; see [step 11](implementation-plan/step-11-persistent-cache-nas.md).

## Commands

| Command | Args | Returns | Notes |
|---|---|---|---|
| `panel_open` | `panel: 0 \| 1, path: string, refresh: boolean, onEvent: Channel<PanelEvent>` | `void` | Replaces that panel's subscription. Sends one `snapshot` (or `error`), then `patch`es (and one `fresh` after a stale snapshot) while subscribed. `path` may start with `~`. `refresh: true` (⇧⌘R) forces a full re-read even when a cached listing looks current. Returns once the snapshot is sent; revalidation continues in the background. |
| `home_dir` | — | `string` | |
| `rename` | `dir, from, to: string` | `void` | Errors if `to` exists (case-only renames allowed). Validates the name. |
| `mkdir` | `dir, name: string` | `void` | |
| `trash` | `paths: string[]` | `void` | NSFileManager trash |
| `copy_move` | `kind: OpKind, sources: string[], destDir: string, onEvent: Channel<OpEvent>` | `number` (op id) | Runs in background. When a top-level destination exists it emits `conflict` and blocks until `resolve_conflict` (or `cancel_op`). Copying an item onto itself (same dir) keeps both without asking; moving onto itself is a no-op. |
| `resolve_conflict` | `id: number, choice: ConflictChoice, applyToAll: boolean` | `void` | `applyToAll` reuses the choice for the remaining conflicts of this op. |
| `cancel_op` | `id: number` | `void` | |
| `open_default` | `path: string` | `void` | macOS `open` |
| `volume_info` | `path: string` | `{ free: number; total: number }` | `statvfs` of the volume containing `path` (bytes; `free` = available to the user) |
| `read_text` | `path: string, maxBytes: number` | `TextPreview` | For the text viewer |
| `prefs_get` | — | `Preferences` | Defaults filled in |
| `prefs_set` | `patch: object` | `Preferences` | JSON merge patch; written immediately; returns the result |
| `state_get` | — | `AppState` | |
| `state_set` | `patch: object` | `void` | JSON merge patch; debounced write |

Errors are returned as rejected promises with a human-readable string.

## Viewer file access

Media is loaded with `convertFileSrc(path)` (`asset://localhost/<percent-encoded path>`). The asset protocol is enabled in `tauri.conf.json` with scope `$HOME/**`, `/Volumes/**`, `/tmp/**`, `/private/**`, and the CSP allows `asset:` and `http://asset.localhost` in `img-src`, `media-src` and `connect-src` (PDFs are `fetch`ed and rendered with PDF.js; its worker is bundled, `worker-src 'self' blob:`).

## Window

The viewer's fullscreen (`F`) is **window** fullscreen via `@tauri-apps/api/window` (`getCurrentWindow().setFullscreen` / `isFullscreen`), not a Rust command; `capabilities/default.json` grants `core:window:allow-set-fullscreen` and `core:window:allow-is-fullscreen`. In the `Backend` interface these are `setFullscreen(on)` and `isFullscreen()`.

## Browser mock

`src/ipc/mock.ts` implements the same commands against an in-memory tree when `window.__TAURI_INTERNALS__` is absent. `pnpm dev` in a normal browser and the Playwright tests use it. Preferences, state and the fullscreen flag live in memory (`window.__mock.prefs`, `.state`, `.fullscreen`) and reset on reload. A few mock files are backed by real fixtures served by Vite from `tests/fixtures/` (`Documents/report.pdf`, `Downloads/clip.webm`, `Downloads/movie.mp4`, `Pictures/beach.jpg`, `Pictures/cat.png`, `Pictures/holiday.mp4`); other media URLs are `mock://…` and don't load.
