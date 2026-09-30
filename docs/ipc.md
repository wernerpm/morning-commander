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
  | { type: "snapshot"; path: string; parent: string | null; entries: Entry[] }
  | { type: "patch"; path: string; removed: string[]; upserted: Entry[] }
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

## Commands

| Command | Args | Returns | Notes |
|---|---|---|---|
| `panel_open` | `panel: 0 \| 1, path: string, onEvent: Channel<PanelEvent>` | `void` | Replaces that panel's subscription. Sends one `snapshot` (or `error`), then `patch`es while subscribed. `path` may start with `~`. |
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

Errors are returned as rejected promises with a human-readable string.

## Viewer file access

Media is loaded with `convertFileSrc(path)` (`asset://localhost/<percent-encoded path>`). The asset protocol is enabled in `tauri.conf.json` with scope `$HOME/**`, `/Volumes/**`, `/tmp/**`, `/private/**`, and the CSP allows `asset:` and `http://asset.localhost` in `img-src`, `media-src` and `frame-src`.

## Browser mock

`src/ipc/mock.ts` implements the same commands against an in-memory tree when `window.__TAURI_INTERNALS__` is absent. `pnpm dev` in a normal browser and the Playwright tests use it.
