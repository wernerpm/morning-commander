# Step 7 — File operations (backend)

> Status: DONE (backend). The frontend dialogs, progress UI and conflict prompts are tracked separately.

## Goals

Rename, create folders, move to Trash, and copy or move files between panels, with progress and cancellation, without ever losing user data.

## Principles

- **Operations never touch the cache or send panel events.** The watcher reports their effects like any other change. The frontend may apply an optimistic rename, but the watcher patch is authoritative.
- **Nothing is permanently deleted.** `trash` uses `NSFileManager` (`trash` crate, `DeleteMethod::NsFileManager`: no Finder Automation prompt). A move deletes its source only after an error-free copy.
- **Conflicts never overwrite.** v1 policy: skip and report in `Done.errors`.
- All errors are human-readable `String`s prefixed with the affected name.

## Files

| File | Responsibility |
|---|---|
| `src-tauri/src/ops.rs` | `validate_name`, `rename`, `mkdir`, `trash`, `Ops` (registry of running copy/move jobs), `Job` (the copy engine). |
| `src-tauri/src/text.rs` | `read_text` for the viewer (bounded, binary sniff). |
| `src-tauri/src/commands.rs` | `rename`, `mkdir`, `trash`, `copy_move`, `cancel_op`, `open_default`, `read_text`. |

## Commands

### `rename(dir, from, to)`

- `validate_name` for both: non-empty, not `.`/`..`, no `/`, no NUL.
- `from == to` → no-op.
- If `dir/to` exists: when it's the **same inode** as `dir/from` (a case-only or normalisation-only change on a case-insensitive volume), rename via a hidden temporary name (`.<from>.mc-rename-<pid>`) so the new spelling sticks. Otherwise error `"<to>" already exists`.
- Known race: the existence check and `rename(2)` aren't atomic. Follow-up: use `renamex_np(RENAME_EXCL)`.

### `mkdir(dir, name)`

`validate_name`, then `create_dir`. An existing name gives `"<name>" already exists`.

### `trash(paths)`

One `delete_all` call for all paths. Errors come back as one string.

### `copy_move(kind, sources, destDir, onEvent) → id`

Runs on its own thread (`mc-op-<id>`). Event sequence on `onEvent`:

```
Progress (forced, totals known) → Progress* (≤ 20/s) → Progress (forced) → Done { errors } | Cancelled
```

Totals: `measure()` walks each source without following symlinks. `filesTotal` counts files, directories and symlinks; `bytesTotal` counts regular-file bytes.

Per source:

1. The destination is `destDir/<source name>`.
2. A directory into itself or a descendant → error "cannot copy a directory into itself".
3. The destination exists (lstat) → error "already exists, skipped". It still counts toward progress.
4. **Move**: try `rename(2)`. `EXDEV` (another volume) → fall back to copy, then delete the source only if the copy added no errors.
5. **Copy** (`copy_tree`, recursive, never follows symlinks):
   - symlink → recreate the link with the same target
   - directory → `create_dir`, recurse, then copy permissions and mtime (after the children, so a read-only directory still gets filled)
   - file ≤ 8 MiB → `fs::copy` (APFS clone / `fcopyfile`); larger → 1 MiB chunks using `create_new`, checking for cancellation between chunks
   - then copy permissions and mtime (best effort)
   - other (FIFO, socket, device) → skipped with an error
6. Per-file errors are collected and the operation continues.

### `cancel_op(id)`

Sets the job's cancel flag. The engine checks it between entries and between chunks. On cancel, the partially written file is removed. Files already copied stay; for a cross-volume move, the source is untouched.

### `read_text(path, maxBytes)`

Reads at most `min(maxBytes, 16 MiB)`. It's binary if the first 8 KiB contain a NUL or UTF-8 that is invalid for any reason other than a cut-off final character. A cut-off final character is dropped; other invalid sequences are decoded lossily. `truncated` = the file is larger than what was read.

### `open_default(path)`

`tauri_plugin_opener::open_path` (macOS `open`). It's called from Rust, so no opener capability permissions are needed.

## Tests (`cargo test ops:: text::`)

- `validates_names`, `mkdir_creates_and_rejects_existing`
- `rename_basic_conflict_and_case_only`: `c.txt` → `C.txt` on APFS keeps the new case.
- `copies_nested_tree_preserving_mtime_and_skipping_conflicts`: nested dirs, symlink kept as a symlink, mtime preserved, a conflict is skipped and reported, progress events are emitted.
- `moves_and_refuses_moving_into_itself`
- `cancel_removes_partial_file`: 512 MiB sparse file, cancel after the first bytes; tolerates the copy winning the race.
- `text::tests::*`: truncation on a char boundary, binary detection (NUL, Latin-1), directory rejection.

## Acceptance criteria

- [x] All tests pass; clippy is clean.
- [ ] A manual copy of a multi-GB file between two volumes shows smooth progress and cancels in < 200 ms.

## Follow-ups

- Conflict prompts: emit `OpEvent::Conflict` and wait for a `resolve_conflict(id, choice)` command (overwrite / skip / rename / apply to all).
- `copyfile(3)` with `COPYFILE_CLONE | COPYFILE_ALL` for extended attributes, ACLs and Finder tags; APFS clones for large files too.
- Preserve directory and file ownership when running as root (not relevant for a personal app).
- An operations queue: run one job at a time per destination volume.
- Batch rename (find/replace, numbering) as a separate command.
