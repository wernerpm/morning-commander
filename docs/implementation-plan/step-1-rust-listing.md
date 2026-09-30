# Step 1 — Rust core: directory listing

> Status: DONE

## Goals

Turn a directory on disk into the `Entry` list defined in [`docs/ipc.md`](../ipc.md), fast and correctly, and resolve whatever path the frontend asks for into a canonical directory to show.

## Technical approach

- `std::fs::read_dir` for names, then `symlink_metadata` (lstat) per name. Stat is the cost, not readdir, so above 2,000 entries the stat calls run on the `rayon` pool.
- Nothing is sorted in Rust. Sorting and hidden-file filtering belong to the frontend (see `docs/ipc.md`, "Division of responsibility").
- Names are NFC-normalised for display and as cache keys. macOS APFS stores whatever form the creator used (often NFD). APFS is normalisation-insensitive, so joining an NFC name back onto a directory still finds the file.

## Files

| File | Responsibility |
|---|---|
| `src-tauri/src/model.rs` | Wire types (`Entry`, `EntryKind`, `PanelEvent`, `OpEvent`, `TextPreview`). Mirror of `src/ipc/types.ts`. |
| `src-tauri/src/listing.rs` | `read_listing`, `read_names`, `stat_entry`, `display_name`, `expand_tilde`, `home_dir`, `resolve_dir`. Stateless and synchronous. |

### `Entry` field rules

| Field | Rule |
|---|---|
| `name` | NFC form of the on-disk name (`display_name`). Lossy for non-UTF-8 names. |
| `kind` | From lstat: `symlink` > `dir` > `file` > `other` (sockets, FIFOs, devices). |
| `targetIsDir` | Only for symlinks: `fs::metadata` (follows) is a dir. Broken links → `false`. Always `false` for non-symlinks. |
| `size` | lstat length; `0` for directories. For symlinks it's the link's own size (targets are not followed). |
| `mtime` | Unix millis from `modified()`; negative before 1970; `0` if unavailable. |
| `hidden` | Name starts with `.`, or the macOS `UF_HIDDEN` flag (`0x8000`, set by `chflags hidden`) is set. |

### `resolve_dir(requested)`

1. Expand `~` / `~/…` using `$HOME`.
2. Reject relative paths.
3. Canonicalise (resolves symlinks, `..`, `/tmp` → `/private/tmp`).
4. If the path exists but isn't a directory → error `"<path>: not a directory"`.
5. If it doesn't exist → try each ancestor in turn and return the first existing directory (the "directory vanished" fallback).
6. Any other I/O error (e.g. `EACCES` on an ancestor) → error.

Snapshots always carry the canonical path, so the frontend must display `snapshot.path` rather than what it requested.

## Tests (`cargo test listing::`)

- `lists_kinds_hidden_and_symlinks`: file/dir/hidden/symlink-to-dir/symlink-to-file/broken symlink.
- `uf_hidden_flag_marks_hidden`: `chflags hidden` (macOS only).
- `names_are_nfc_normalised`: NFD `Café` comes back NFC.
- `large_directories_use_parallel_path`: above the rayon threshold.
- `resolve_dir_canonicalises_and_falls_back`: `..` handling, missing-dir fallback, file error, relative error, `~`.

## Acceptance criteria

- [x] All the above tests pass; `cargo clippy --all-targets -- -D warnings` is clean.
- [ ] Benchmark: listing a 100k-file directory takes < 150 ms cold on an M-series Mac (not yet measured; see follow-ups).

## Follow-ups

- Add a `criterion` bench (or an ignored test with timing output) for 10k/100k entries.
- Non-UTF-8 names are displayed lossily and can't be round-tripped for rename/trash. If this matters, add an opaque `rawName` (base64 bytes) to `Entry` and accept it in commands.
- Consider `getattrlistbulk(2)` for very large directories: one syscall returns names plus attributes, avoiding a stat per entry.
