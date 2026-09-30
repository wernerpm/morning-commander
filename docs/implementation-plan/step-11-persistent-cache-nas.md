# Step 11 — Persistent listing cache and fast NAS browsing

> Status: NOT STARTED (planned 2026-09-30) — **highest priority**: most of the media library lives on a NAS, and slow remote listings (Finder is very slow there) are the main pain point.

## Goals

1. **Instant listings for directories visited before**, even right after launch, even on a NAS: show the last known listing immediately, refresh it in the background, and apply the differences as patches.
2. **Persist the listing cache to disk as JSON** under `~/.morning-commander/`, capped (default **100 MB**), keeping the most recently visited directories and evicting the oldest ones.
3. **Network volumes behave well**: never block the UI, show progress for slow listings, detect changes without FSEvents (which doesn't work reliably on SMB/NFS), and prefetch likely next directories.

## Today (baseline)

- In-memory `ListingCache` (LRU, 64 dirs), lost on quit. Every launch re-reads from the network.
- Freshness relies on FSEvents via `notify`; on network mounts events usually don't arrive, so remote listings go stale while shown.
- A listing is sent as one snapshot after the whole directory is read, so a slow remote directory shows nothing until it's done.
- `getattrlistbulk` is used on macOS (smbfs supports it; falls back to readdir + lstat).

### Environment and first measurements (2026-09-30)

- NAS: consumer 2-bay NAS, **SMB** share mounted under `/Volumes/<share>`.
- Biggest media directories: **5k–10k entries** each (no 100k-entry folders).

Measured on one ~4.3k-entry directory of the share (release build, `bench_listing`, **warm** — the directory had just been listed, so the macOS SMB client's attribute cache was populated):

| Path | Time |
|---|---|
| `read_listing` (`getattrlistbulk`) | ~10 ms |
| portable (readdir + lstat per entry) | ~63 ms |
| JSON encoding | < 1 ms (≈ 660 KB) |

**Cold** measurements (2026-09-30, same ~4.3k-entry directory, release build; "cold" = first listing after unmounting and remounting the share, or after ≥ 60 s without touching the directory):

| What | Cold | Warm |
|---|---|---|
| `read_listing` (`getattrlistbulk`) | **~8.6 s** (8.67 s after remount; 8.57 s after 60 s idle) | 2.5–7 ms |
| names only (`readdir`, no attributes) | ~9.6 s | — |
| portable (readdir + `lstat` per entry) | ~38.6 s | ~46 ms |
| `stat` of the directory itself | **~30 ms** | < 0.1 ms |

- The macOS SMB client forgets the listing within a minute, so **every** revisit after a short pause costs ~8.6 s today, not just the first visit after mounting.
- The time is the server enumerating the directory (names alone take as long), so no client-side listing trick helps; only not listing does: the persistent cache plus the directory-mtime shortcut (one ~30 ms `stat`).
- **Dir-mtime shortcut verified on this NAS:** creating, renaming and deleting a child each changed the directory's mtime, and the server's value matched after the client cache expired.

Takeaways:
- Warm listings are already fast; the pain is **cold** listings (first visit after mount/launch, or after the SMB client cache expires) and whatever Finder does on top. (Cold numbers above.)
- At 5–10k entries a directory is ≈ 0.4–0.8 MB of JSON today, ≈ 0.2–0.4 MB with the compact encoding below, so the 100 MB cache holds a few hundred large media directories — enough to keep the whole library's structure warm.
- `getattrlistbulk` works on this SMB share (6× faster than per-entry stat); keep it as the primary path.
- Streaming (phase 11a) matters less at this size than stale-while-revalidate (11b); consider doing 11b first.

**Docs rule:** never commit real share names, mount paths, directory or file names from the NAS (or anyone's disk) — use placeholders like `/Volumes/<share>/<dir>`.

## Design

### Directory layout

```
~/.morning-commander/            (0700)
  preferences.json               (step 10)
  cache/
    index.json                   { version, dirs: { "<abs path>": { file, lastVisited, bytes, dirMtime, readAt, network } } }
    dirs/<sha256(path)[0..16]>.json
```

- **One JSON file per directory** so a change rewrites only that directory; `index.json` is small and loaded at startup.
- Compact entry encoding to keep files small (100k entries ≈ 4–5 MB instead of 10 MB):
  ```json
  { "path": "/Volumes/media/Movies", "dirMtime": 1759250000000, "readAt": 1759251234000,
    "entries": [["Alien (1979).mkv", "f", 4823449600, 1700000000000, 0], ["Extras", "d", 0, 1700000000000, 0]] }
  ```
  `[name, kind f|d|l|o, size, mtime, flags(bit0 hidden, bit1 targetIsDir)]`.
- Files are written atomically (temp + rename), mode `0600` (file names on the NAS are private data).
- **Exclude `cache/` from Time Machine** when creating it (set `NSURLIsExcludedFromBackupKey` / the `com.apple.metadata:com_apple_backup_excludeItem` xattr, as `tmutil addexclusion` does): 100 MB of churning JSON shouldn't be backed up. The cache must be safe to delete at any time.
- A `version` field; on mismatch the cache is discarded, never migrated.

### Size limit and eviction

- `cacheMaxBytes` in `preferences.json`, default `100 * 1024 * 1024`.
- Eviction order: **least recently visited first** (`lastVisited` updates when a panel shows the directory, not when it's prefetched). Evict until under 90% of the limit to avoid thrashing.
- Also drop entries whose directory no longer exists when revalidation finds it gone, and entries not visited for `cacheMaxAgeDays` (default 180).
- A single directory larger than 25% of the limit isn't persisted (stays memory-only).
- Currently shown directories are never evicted.

### Stale-while-revalidate

`panel_open(path)`:

1. Memory cache hit → send `snapshot` immediately.
2. Else disk cache hit → load the JSON (fast, local SSD), send `snapshot { stale: true }` immediately, insert into memory cache.
3. Else → start reading; send progress (see streaming) and the snapshot when done.
4. For 1 and 2, **revalidate in the background**:
   - Local volume: the FSEvents watch already guarantees freshness for memory-cache hits; disk-cache hits get a full re-read (fast locally).
   - Network volume: `stat` the directory; if its mtime equals the cached `dirMtime`, the set of names is unchanged → send `fresh` without re-reading (sizes/mtimes of files may be stale; `⇧⌘R` forces a full re-read). If it changed → full re-read → diff → `patch` → `fresh`.
5. The UI shows a small "↻" in the panel footer while `stale`; cleared on `fresh`.

Wire changes (update `docs/ipc.md`, `model.rs`, `types.ts`, the mock):

```ts
| { type: "snapshot"; path; parent; entries; stale?: boolean; complete?: boolean }
| { type: "append"; path: string; entries: Entry[] }        // streaming, see below
| { type: "fresh"; path: string }                           // revalidation finished
| { type: "progress"; path: string; count: number }         // slow read in progress
```

### Network volume detection

`statfs(path)`: network if `(f_flags & MNT_LOCAL) == 0` or `f_fstypename` ∈ {`smbfs`, `nfs`, `afpfs`, `webdav`}. Cache the result per mount point (`f_mntonname`). Expose `network: boolean` on the snapshot so the UI can show a small "NAS" badge.

### Change detection on network volumes

- Don't rely on FSEvents there (keep the watch — it's harmless and sometimes works for changes made from this Mac).
- **Poll the directories shown in panels**: every 3 s `stat` the directory (one round trip); if `mtime` changed, re-read and patch. Back off to 10 s after a minute without changes; reset on navigation.
- Changes made by Morning Commander itself (copy/move/rename/trash) trigger an immediate re-read of the affected directories instead of waiting for the poll.
- The liveness check (`LIVENESS_INTERVAL`) must not block on an unreachable NAS: run the `is_dir` probes with a timeout on a separate thread and treat a timeout as "unknown", not "gone".

### Never block on the network

- All filesystem calls for network paths run off the hub lock (already true for listing; make sure `resolve_dir`, liveness, `volume_info` and `stat` for revalidation are too).
- Navigating away while a slow read is in flight must be instant (the per-panel `seq` already drops stale results; also stop reading early: check a cancel flag between `getattrlistbulk` batches).
- If the NAS disappears (sleep, Wi-Fi), show the cached listing with an "offline" badge instead of an error, and keep polling.

### Streaming large remote listings

`getattrlistbulk` returns entries in batches. For network volumes send the first batch as `snapshot { complete: false }` after ~100 ms or 500 entries, then `append` every ~250 ms, then `fresh`/`complete`. The frontend inserts appended entries into the sorted list (reuse the patch path). Type-to-jump works while loading. The footer shows "Reading… 12,345".

### Prefetch (optional, network only)

After a network directory is shown and idle for 1 s, prefetch listings of its visible subdirectories (the ones near the cursor first), concurrency 2, low priority, into memory + disk cache, **without** updating `lastVisited`. Stops when the user navigates. Makes `Enter` into a folder on the NAS instant. Setting `prefetch: true|false` in preferences.

### Memory cache vs disk cache

- Memory: current LRU, raise to ~256 dirs or a byte budget (~200 MB of entries).
- Disk: write-behind. On snapshot/patch mark the directory dirty; a background thread flushes dirty directories every 2 s and on app exit (Tauri `RunEvent::ExitRequested`). `index.json` is flushed after the directory files.

## Files

```
src-tauri/src/persist.rs     disk cache: index, load/store dir files, eviction, flush thread
src-tauri/src/netvol.rs      statfs-based network detection + mount-point cache
src-tauri/src/poller.rs      mtime polling for shown network directories
src-tauri/src/hub.rs         stale-while-revalidate, streaming, fresh/append events
src-tauri/src/prefs.rs       (from step 10) cacheMaxBytes, cacheMaxAgeDays, prefetch
src/panel/store.ts           stale/fresh/append handling, footer indicators
```

## Phases

1. **11a — Non-blocking + visible progress**: network detection, streaming snapshots, cancel between batches, "Reading…" footer, offline handling. (Helps even before persistence.)
2. **11b — Persistence**: disk cache with limits, stale-while-revalidate, dir-mtime shortcut.
3. **11c — Freshness on NAS**: polling of shown directories, immediate re-read after own operations.
4. **11d — Prefetch** of subdirectories.

## Tests

- Rust unit: compact encoding round-trip; eviction order and size limit; corrupt/foreign-version cache ignored; atomic write; `lastVisited` not bumped by prefetch.
- Rust integration: stale snapshot then `fresh` for an unchanged dir; `patch` then `fresh` after adding a file while the app was "closed" (drop and recreate the hub with the same cache dir, pointed at a tempdir via an env var like `MC_HOME`).
- Network behaviour can't run on CI: add a `MC_FORCE_NETWORK=1` switch that makes every path count as network (polling instead of FSEvents, streaming on) so the logic is testable locally and on CI.
- Real NAS: manual checklist below, timings recorded in this doc.

## Acceptance criteria

- [ ] Relaunching the app and opening a previously visited NAS directory shows its listing in < 100 ms, then refreshes
- [ ] A NAS directory with 5k–10k entries shows the first entries within ~200 ms of `Enter` (cold) and stays navigable while loading
- [ ] Files added on the NAS from another machine appear in a shown panel within ~5 s
- [ ] `~/.morning-commander/cache` never exceeds the configured limit; oldest visited directories go first
- [ ] Unplugging the network shows the cached listing marked offline, no spinner lock-up, no crash
- [ ] Navigating away from a slow directory is instant

## Open questions

- ~~Protocol, mount location, directory sizes~~ — answered: SMB, `/Volumes/<share>`, 5k–10k entries.
- ~~Is the dir-mtime shortcut safe on this NAS?~~ — yes (verified 2026-09-30, see measurements).
- Should the cache also remember per-directory cursor position and sort?
