# Step 1 — Rust core: directory listing

> Status: DONE

## Goals

Turn a directory on disk into the `Entry` list defined in [`docs/ipc.md`](../ipc.md), fast and correctly, and resolve whatever path the frontend asks for into a canonical directory to show.

## Technical approach

- **macOS fast path** (`listing_macos.rs`, declared inside `listing.rs` via `#[path]`): `getattrlistbulk(2)` returns name, object type, mtime, BSD flags and data length for many children per syscall (256 KB buffer). Regular files and directories are built straight from the packed records. Symlinks, special files and records with `ATTR_CMN_ERROR` set are handed to `stat_entry` (symlinks need a second stat of the target anyway, and it guarantees identical output). If the call fails for any reason other than `NotFound`/`PermissionDenied` (e.g. a filesystem without bulk support) `read_listing` falls back to the portable path.
- **Portable path** (`read_listing_portable`, also used off macOS): `std::fs::read_dir` for names, then `symlink_metadata` (lstat) per name, on the `rayon` pool above 2,000 entries.
- Record layout parsed by `listing_macos::parse_record`: `u32` length, `attribute_set_t`, `u32` error, `attrreference_t` name (offset relative to the reference itself, length includes the NUL), `u32` objtype, `timespec` mtime, `u32` flags, then `off_t` data length **only for non-directories** (with `FSOPT_PACK_INVAL_ATTRS` unsupported common attributes are zero-filled in place, but file attributes are omitted for directories). All reads are bounds-checked; a malformed record returns an error, which triggers the fallback.
- Nothing is sorted in Rust. Sorting and hidden-file filtering belong to the frontend (see `docs/ipc.md`, "Division of responsibility").
- Names are NFC-normalised for display and as cache keys. macOS APFS stores whatever form the creator used (often NFD). APFS is normalisation-insensitive, so joining an NFC name back onto a directory still finds the file.

## Files

| File | Responsibility |
|---|---|
| `src-tauri/src/model.rs` | Wire types (`Entry`, `EntryKind`, `PanelEvent`, `OpEvent`, `TextPreview`). Mirror of `src/ipc/types.ts`. |
| `src-tauri/src/listing.rs` | `read_listing` (dispatch), `read_listing_portable`, `read_names`, `stat_entry`, `display_name`, `expand_tilde`, `home_dir`, `resolve_dir`. Stateless and synchronous. |
| `src-tauri/src/listing_macos.rs` | `read_listing_bulk` via `getattrlistbulk`; private submodule of `listing`. |
| `src-tauri/examples/bench_listing.rs` | `cargo run --release --example bench_listing -- <dir> [runs]`: median of fast vs portable listing, plus JSON encoding time. |

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
- `listing::macos::tests::bulk_matches_portable`: bulk and portable produce identical entries (sorted by name) for files, a 100 KB file, dirs, a hidden dir, dotfile, symlink to dir, symlink to file, broken symlink, NFD name and a `UF_HIDDEN` file.
- `bulk_handles_many_entries_across_buffers`: 5,000 long names span several syscalls.
- `bulk_errors_on_missing_dir`, `millis_truncates_toward_zero`.

## Performance

Release build, M-series Mac, APFS, 100k empty files (`/tmp/mc-big`, `/tmp/mc-big2`), `bench_listing` medians:

| Directory | Before (readdir + parallel lstat) | After (`getattrlistbulk`) | JSON encode |
|---|---|---|---|
| `/tmp/mc-big` (100,001) | 318–404 ms (first single runs); 175–196 ms median when warm | 133–142 ms median | ~9.5 ms (10 MB) |
| `/tmp/mc-big2` (100,000) | 176–190 ms median (warm) | 118–127 ms median | ~9.5 ms |

Where the time goes: instrumenting the bulk path showed ~95% of it inside the `getattrlistbulk` syscall; parsing and NFC are negligible. `ls -f /tmp/mc-big` (readdir only, no stat) takes ~140 ms wall / 110 ms sys, so the bulk path is at the kernel's floor for a 100k-entry APFS directory. Further gains must come from not listing at all (the cache) or from streaming the first entries early, not from the syscall layer.

`display_name` skips Unicode normalisation for ASCII names (already NFC).

## Acceptance criteria

- [x] All the above tests pass; `cargo clippy --all-targets -- -D warnings` is clean.
- [x] Benchmark: listing a 100k-file directory takes < 150 ms on an M-series Mac (118–142 ms median, see Performance).

## Follow-ups

- Non-UTF-8 names are displayed lossily and can't be round-tripped for rename/trash. If this matters, add an opaque `rawName` (base64 bytes) to `Entry` and accept it in commands.
- Two-stage snapshot for huge directories: send the first bulk buffer's entries immediately and the rest as a patch (the protocol already supports `snapshot` then `patch`).
- The JS side (sorting 100k names with `Intl.Collator` ≈ 215 ms in WKWebView) is now the larger cost; precomputed sort keys would help (frontend).
