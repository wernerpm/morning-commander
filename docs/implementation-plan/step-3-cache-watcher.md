# Step 3 — Listing cache, FSEvents watcher and panel subscriptions

> Status: DONE. Frontend patch application is in `src/panel/store.ts`; create/delete/rename from Terminal verified in the real app (< 0.5 s).

## Goals

- Revisiting a directory is instant: listings are served from memory.
- Listings never go stale: every cached directory is watched, and changes arrive at the frontend as small `patch` events without a manual refresh.
- A panel whose directory disappears moves to the nearest existing ancestor on its own.

## Technical approach

```
FSEvents ─▶ notify (NonRecursive) ─▶ notify-debouncer-full (100 ms, NoCache)
          ─▶ FsWatcher handler: DebouncedEvent → WatchBatch { paths, rescan, rescan_all }
          ─▶ mpsc ─▶ "mc-watch" thread ─▶ Hub::handle_batch
                                           ├─ re-stat changed names / re-read dir
                                           ├─ ListingCache diff + apply
                                           └─ PanelEvent::Patch → subscribed panel sinks
```

- **Non-recursive watches, one per directory.** notify's FSEvents backend filters out anything that isn't a direct child of the watched directory (or the directory itself). Never add a recursive watch on a large root.
- **`NoCache` instead of the debouncer's file-ID cache.** Every reported name is re-stat'ed, so rename stitching isn't needed; a rename shows up as a `removed` old name plus an `upserted` new name in the same patch. It also avoids walking each directory again on `watch`.
- **Never trust event kinds.** FSEvents coalesces flags. The hub only uses *which paths* were mentioned, then asks the filesystem what's actually there.

## Files

| File | Responsibility |
|---|---|
| `src-tauri/src/cache.rs` | `Listing` (name → `Entry`), `Diff`, `ListingCache` (LRU, capacity 64, pinned entries never evicted). Pure data, no I/O. |
| `src-tauri/src/watcher.rs` | `FsWatcher`: owns the debouncer and turns events into `WatchBatch`es. No interpretation. |
| `src-tauri/src/hub.rs` | `Hub`: panel subscriptions, open/load, watch bookkeeping, event → patch routing. |
| `src-tauri/src/commands.rs` | `panel_open` wraps a Tauri `Channel<PanelEvent>` into a `PanelSink` and calls `Hub::open` on the blocking pool. |

## Hub invariants

1. **Every cached directory is watched.** A directory whose watch fails isn't cached; it's re-read on every visit instead.
2. **A directory is watched if and only if it's cached, shown by a panel, or being loaded.** `Hub::gc` restores this after every open, eviction or removal.
3. **Lock order is `state` then `watcher`.** Filesystem reads happen outside the state lock. The exception is the rare re-stat of names that changed while a snapshot was loading.
4. **Snapshot before patches.** `commit` sends the snapshot while holding the state lock and only then registers the subscription, so a panel never gets a patch for a directory before its snapshot.
5. **The last open wins.** Each `open` bumps a per-panel sequence number. A slow load that finishes after a newer `open` for the same panel is discarded.
6. **No lost updates while loading.** The directory is watched *before* `read_dir` starts. Events that arrive during the read are recorded against the load's token (`State::loading`) and folded into the listing before the snapshot is sent.
7. **Only direct children are reported.** An event path `P` counts if `P.parent()` is watched (re-stat `P`'s name) or `P` itself is watched (check the directory still exists).

## Event handling (`Hub::handle_batch`)

1. Under the lock: map each event path to `dirty[dir].names`. Mark `dirty[dir].full` for OS rescan requests: a rescan path related to the dir, or `rescan_all`. Also copy these marks into any in-flight loads.
2. Without the lock: watched directories that were mentioned themselves and are no longer directories are *gone*. For the rest, a full rescan or more than 200 names (`FLOOD_THRESHOLD`) means `read_listing` and a whole-listing diff; otherwise re-stat each name.
3. Under the lock: apply to the cache, and send a `Patch` to every panel on that directory if the diff isn't empty.
4. Gone directories: drop them from the cache, then call `Hub::open(panel, gone_dir)` for each panel that showed one. `resolve_dir` walks up to the nearest existing ancestor and a new `Snapshot` goes out.

## Tests (`cargo test hub:: cache::`)

- `snapshot_then_patches_for_create_delete_rename`: real FSEvents on a tempdir. Checks the snapshot contents, then create, delete and rename patches, and that a file created inside a subdirectory doesn't produce a patch. Polls with a 10 s timeout. The first write is retried because FSEvents can start a few hundred ms late.
- `reopening_serves_cache_and_keeps_watching`: a cached directory stays watched after the panel leaves it.
- `missing_dir_falls_back_to_ancestor_and_errors_on_files`: fallback, plus an error event that keeps the old subscription.
- `deleted_directory_reopens_on_ancestor`: `rmdir` of the shown directory → snapshot of its parent.
- `cache::tests::*`: diff correctness, no-op suppression, LRU with pinning.

## Acceptance criteria

- [x] `touch`, `mv`, `rm` in a shown directory produce patches within ~200 ms.
- [x] Deleting the shown directory moves the panel to its parent.
- [x] Tests are stable across repeated runs (5× locally).
- [ ] Stress: `for i in {1..10000}; do touch f$i; done` in a shown directory causes a handful of full rescans, not 10k patches. Needs a manual check in the real app.

## Known limitations / follow-ups

- **FSEvents stream restarts.** notify's FSEvents watcher stops and recreates its stream on every `watch`/`unwatch`, with `since_when = now`. Events in that tiny gap are lost. A fix is either one stream with `kFSEventStreamEventIdSinceNow` replaced by the last seen event id, or a periodic cheap re-validation (compare the directory's mtime).
- **Network volumes** (SMB/NFS) may not deliver FSEvents. Detect them with `statfs` (`f_flags & MNT_LOCAL`) and poll the shown directory every few seconds instead of caching.
- **Rename across watched directories** shows up as a removal in one directory and an addition in the other. That's correct, but the frontend can't keep the cursor on the moved file.
- The cache capacity is by directory count only. Add an entry-count budget (e.g. 500k entries) if memory matters.
- Snapshots of very large directories are one JSON message. Split into two stages (names first, then attributes) if profiling shows > 100 ms for 100k entries.

## Liveness backstop (added after CI flakiness)

FSEvents doesn't reliably emit an event for the deletion of a directory that is itself watched non-recursively (`deleted_directory_reopens_on_ancestor` failed 2 of 3 times on GitHub's macOS runners, never locally). `Hub::new` therefore starts an `mc-liveness` thread that every second checks each panel's directory with `is_dir()` and, for missing ones, injects a `WatchBatch { paths: [dir] }` into the watcher channel. The normal "gone" handling then evicts the cache entry and re-opens the panel on the nearest existing ancestor. This also covers ejected volumes.
