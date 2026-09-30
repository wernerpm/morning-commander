//! Panel subscriptions: ties the listing cache, the filesystem watcher and the two
//! panels together.
//!
//! Invariants:
//! - Every directory in the cache is watched (cached listings are never stale).
//! - A directory is watched iff it is cached, shown by a panel, or being loaded.
//! - Lock order is `state` then `watcher`; never the reverse.
//! - A panel receives exactly one `Snapshot` per successful `open`, sent while holding the
//!   state lock, so it always precedes that directory's `Patch`es.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::thread;

use parking_lot::Mutex;

use crate::cache::{Listing, ListingCache};
use crate::listing::{display_name, read_listing, resolve_dir, stat_entry};
use crate::model::{Entry, PanelEvent};
use crate::watcher::{FsWatcher, WatchBatch};

/// Receives events for one panel. Returns `false` if the receiver is gone.
pub type PanelSink = Arc<dyn Fn(PanelEvent) -> bool + Send + Sync>;

/// More changed names than this in one batch → re-read the whole directory instead.
const FLOOD_THRESHOLD: usize = 200;

/// How often panel directories are checked for existence. FSEvents doesn't reliably
/// report the deletion of a non-recursively watched directory itself (nor volume
/// unmounts), so this is the backstop that moves panels to the nearest ancestor.
const LIVENESS_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

#[derive(Debug, Default, Clone)]
struct Dirty {
    names: HashSet<OsString>,
    full: bool,
}

impl Dirty {
    fn merge(&mut self, other: &Dirty) {
        self.full |= other.full;
        self.names.extend(other.names.iter().cloned());
    }

    fn is_empty(&self) -> bool {
        !self.full && self.names.is_empty()
    }
}

struct Subscription {
    dir: PathBuf,
    sink: PanelSink,
}

#[derive(Default)]
struct State {
    cache: ListingCache,
    panels: HashMap<u8, Subscription>,
    /// Bumped on every `open`; a load finishing with a stale number is dropped.
    seq: HashMap<u8, u64>,
    watched: HashSet<PathBuf>,
    /// In-flight loads: token → (dir, changes seen while reading).
    loading: HashMap<u64, (PathBuf, Dirty)>,
    next_token: u64,
}

enum Update {
    Fresh(Vec<Entry>),
    Stats(Vec<(String, Option<Entry>)>),
}

pub struct Hub {
    state: Mutex<State>,
    watcher: Mutex<FsWatcher>,
}

impl Hub {
    pub fn new() -> Result<Arc<Self>, String> {
        let (tx, rx) = mpsc::channel::<WatchBatch>();
        let liveness_tx = tx.clone();
        let watcher = FsWatcher::new(move |batch| {
            let _ = tx.send(batch);
        })?;
        let hub = Arc::new(Hub {
            state: Mutex::new(State::default()),
            watcher: Mutex::new(watcher),
        });
        let weak = Arc::downgrade(&hub);
        thread::Builder::new()
            .name("mc-watch".into())
            .spawn(move || {
                for batch in rx {
                    let Some(hub) = weak.upgrade() else { break };
                    hub.handle_batch(batch);
                }
            })
            .map_err(|e| e.to_string())?;
        let weak = Arc::downgrade(&hub);
        thread::Builder::new()
            .name("mc-liveness".into())
            .spawn(move || {
                loop {
                    thread::sleep(LIVENESS_INTERVAL);
                    let Some(hub) = weak.upgrade() else { break };
                    let dirs: Vec<PathBuf> = {
                        let s = hub.state.lock();
                        s.panels.values().map(|p| p.dir.clone()).collect()
                    };
                    drop(hub);
                    let missing: Vec<PathBuf> = dirs.into_iter().filter(|d| !d.is_dir()).collect();
                    // Reported like a watcher event on the directory itself, so the
                    // regular "gone" handling (serialised with real events) applies.
                    if !missing.is_empty()
                        && liveness_tx
                            .send(WatchBatch {
                                paths: missing,
                                ..WatchBatch::default()
                            })
                            .is_err()
                    {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(hub)
    }

    /// Point `panel` at `requested` and send it a snapshot (or an error). Blocking.
    pub fn open(&self, panel: u8, requested: &str, sink: PanelSink) {
        let seq = {
            let mut s = self.state.lock();
            let n = s.seq.entry(panel).or_insert(0);
            *n += 1;
            *n
        };

        let dir = match resolve_dir(requested) {
            Ok(dir) => dir,
            Err(message) => {
                if self.state.lock().seq.get(&panel) == Some(&seq) {
                    sink(PanelEvent::Error {
                        path: requested.to_string(),
                        message,
                    });
                }
                return;
            }
        };

        // Fast path: serve from cache. Otherwise start watching *before* reading so no
        // change can slip between the read and the first event.
        let token = {
            let mut s = self.state.lock();
            if s.seq.get(&panel) != Some(&seq) {
                return;
            }
            if let Some(listing) = s.cache.get(&dir) {
                let entries = listing.to_vec();
                self.commit(&mut s, panel, dir, entries, sink);
                return;
            }
            if self.ensure_watched(&mut s, &dir) {
                s.next_token += 1;
                let token = s.next_token;
                s.loading.insert(token, (dir.clone(), Dirty::default()));
                Some(token)
            } else {
                None
            }
        };

        let result = read_listing(&dir);

        let mut s = self.state.lock();
        let dirty = token.and_then(|t| s.loading.remove(&t)).map(|(_, d)| d);
        if s.seq.get(&panel) != Some(&seq) {
            self.gc(&mut s);
            return;
        }
        let entries = match result {
            Ok(entries) => entries,
            Err(e) => {
                sink(PanelEvent::Error {
                    path: dir.to_string_lossy().into_owned(),
                    message: format!("{}: {e}", dir.display()),
                });
                self.gc(&mut s);
                return;
            }
        };
        let mut listing = Listing::from_entries(entries);
        if let Some(dirty) = dirty.filter(|d| !d.is_empty()) {
            match compute_update(&dir, &dirty) {
                Some(Update::Fresh(fresh)) => {
                    listing.replace_all(fresh);
                }
                Some(Update::Stats(stats)) => {
                    listing.apply_stats(stats);
                }
                None => {}
            }
        }
        if token.is_some() {
            let pinned: Vec<PathBuf> = s.panels.values().map(|p| p.dir.clone()).collect();
            let pinned: Vec<&Path> = pinned.iter().map(PathBuf::as_path).collect();
            s.cache.insert(dir.clone(), listing.clone(), &pinned);
        }
        self.commit(&mut s, panel, dir, listing.to_vec(), sink);
    }

    /// Directory currently shown by `panel` (for tests and diagnostics).
    pub fn panel_dir(&self, panel: u8) -> Option<PathBuf> {
        self.state.lock().panels.get(&panel).map(|p| p.dir.clone())
    }

    pub fn watched_dirs(&self) -> Vec<PathBuf> {
        self.state.lock().watched.iter().cloned().collect()
    }

    fn commit(&self, s: &mut State, panel: u8, dir: PathBuf, entries: Vec<Entry>, sink: PanelSink) {
        let path = dir.to_string_lossy().into_owned();
        let parent = dir.parent().map(|p| p.to_string_lossy().into_owned());
        sink(PanelEvent::Snapshot {
            path,
            parent,
            entries,
            stale: false,
            network: false,
        });
        s.panels.insert(panel, Subscription { dir, sink });
        self.gc(s);
    }

    fn ensure_watched(&self, s: &mut State, dir: &Path) -> bool {
        if s.watched.contains(dir) {
            return true;
        }
        match self.watcher.lock().watch(dir) {
            Ok(()) => {
                s.watched.insert(dir.to_path_buf());
                true
            }
            Err(e) => {
                log::warn!(
                    "cannot watch {}: {e}; listing will not be cached",
                    dir.display()
                );
                false
            }
        }
    }

    /// Unwatch directories that are no longer cached, shown or loading.
    fn gc(&self, s: &mut State) {
        let mut keep: HashSet<&Path> = s.cache.dirs().map(PathBuf::as_path).collect();
        keep.extend(s.panels.values().map(|p| p.dir.as_path()));
        keep.extend(s.loading.values().map(|(d, _)| d.as_path()));
        let drop: Vec<PathBuf> = s
            .watched
            .iter()
            .filter(|w| !keep.contains(w.as_path()))
            .cloned()
            .collect();
        if drop.is_empty() {
            return;
        }
        let mut watcher = self.watcher.lock();
        for dir in drop {
            watcher.unwatch(&dir);
            s.watched.remove(&dir);
        }
    }

    fn handle_batch(&self, batch: WatchBatch) {
        let mut dirty: HashMap<PathBuf, Dirty> = HashMap::new();
        let mut self_hits: HashSet<PathBuf> = HashSet::new();
        {
            let mut s = self.state.lock();
            for dir in &s.watched {
                let rescan = batch.rescan_all
                    || batch
                        .rescan
                        .iter()
                        .any(|p| dir.starts_with(p) || p.starts_with(dir));
                if rescan {
                    dirty.entry(dir.clone()).or_default().full = true;
                }
            }
            for p in &batch.paths {
                if s.watched.contains(p) {
                    self_hits.insert(p.clone());
                }
                if let (Some(parent), Some(name)) = (p.parent(), p.file_name())
                    && s.watched.contains(parent)
                {
                    dirty
                        .entry(parent.to_path_buf())
                        .or_default()
                        .names
                        .insert(name.to_os_string());
                }
            }
            // Loads in flight will fold these in before sending their snapshot.
            for (dir, d) in s.loading.values_mut() {
                if let Some(x) = dirty.get(dir) {
                    d.merge(x);
                }
                if self_hits.contains(dir) {
                    d.full = true;
                }
            }
        }

        // Filesystem work happens without the lock.
        let gone: HashSet<PathBuf> = self_hits.into_iter().filter(|d| !d.is_dir()).collect();
        let updates: Vec<(PathBuf, Update)> = dirty
            .into_iter()
            .filter(|(dir, _)| !gone.contains(dir))
            .filter_map(|(dir, d)| compute_update(&dir, &d).map(|u| (dir, u)))
            .collect();

        let mut reopen: Vec<(u8, PanelSink, String)> = Vec::new();
        {
            let mut s = self.state.lock();
            for (dir, update) in updates {
                let Some(listing) = s.cache.get_mut(&dir) else {
                    continue;
                };
                let diff = match update {
                    Update::Fresh(fresh) => listing.replace_all(fresh),
                    Update::Stats(stats) => listing.apply_stats(stats),
                };
                if diff.is_empty() {
                    continue;
                }
                let path = dir.to_string_lossy().into_owned();
                for sub in s.panels.values().filter(|p| p.dir == dir) {
                    (sub.sink)(PanelEvent::Patch {
                        path: path.clone(),
                        removed: diff.removed.clone(),
                        upserted: diff.upserted.clone(),
                    });
                }
            }
            for dir in &gone {
                s.cache.remove(dir);
                for (id, sub) in s.panels.iter().filter(|(_, p)| &p.dir == dir) {
                    reopen.push((*id, sub.sink.clone(), dir.to_string_lossy().into_owned()));
                }
            }
            if !gone.is_empty() {
                self.gc(&mut s);
            }
        }
        // `open` walks up to the nearest existing ancestor.
        for (panel, sink, dir) in reopen {
            self.open(panel, &dir, sink);
        }
    }
}

/// Work out what changed in `dir`. `None` if the directory can't be read (it will be
/// handled as gone via its own event).
fn compute_update(dir: &Path, dirty: &Dirty) -> Option<Update> {
    if dirty.full || dirty.names.len() > FLOOD_THRESHOLD {
        match read_listing(dir) {
            Ok(entries) => Some(Update::Fresh(entries)),
            Err(e) => {
                log::debug!("rescan {}: {e}", dir.display());
                None
            }
        }
    } else {
        Some(Update::Stats(
            dirty
                .names
                .iter()
                .map(|n| (display_name(n), stat_entry(dir, n)))
                .collect(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, Instant};

    type Log = Arc<Mutex<Vec<PanelEvent>>>;

    fn sink() -> (PanelSink, Log) {
        let log: Log = Arc::default();
        let l = log.clone();
        (
            Arc::new(move |e| {
                l.lock().push(e);
                true
            }),
            log,
        )
    }

    /// Poll until `pred` holds for the collected events, or panic after 10 s.
    fn wait_for(log: &Log, what: &str, pred: impl Fn(&[PanelEvent]) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if pred(&log.lock()) {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {what}; got {:#?}", log.lock());
    }

    fn patched_upsert(events: &[PanelEvent], name: &str) -> bool {
        events.iter().any(|e| {
            matches!(e, PanelEvent::Patch { upserted, .. } if upserted.iter().any(|x| x.name == name))
        })
    }

    fn patched_remove(events: &[PanelEvent], name: &str) -> bool {
        events.iter().any(
            |e| matches!(e, PanelEvent::Patch { removed, .. } if removed.iter().any(|x| x == name)),
        )
    }

    fn snapshot_paths(events: &[PanelEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                PanelEvent::Snapshot { path, .. } => Some(path.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn snapshot_then_patches_for_create_delete_rename() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        fs::write(dir.join("existing.txt"), b"x").unwrap();

        let hub = Hub::new().unwrap();
        let (s, log) = sink();
        hub.open(0, dir.to_str().unwrap(), s);

        {
            let events = log.lock();
            match &events[0] {
                PanelEvent::Snapshot {
                    path,
                    parent,
                    entries,
                    ..
                } => {
                    assert_eq!(path, dir.to_str().unwrap());
                    assert!(parent.is_some());
                    assert_eq!(entries.len(), 1);
                    assert_eq!(entries[0].name, "existing.txt");
                }
                other => panic!("expected snapshot, got {other:?}"),
            }
        }

        // FSEvents may deliver the stream start slightly late; retry the first write.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut i = 0;
        while !patched_upsert(&log.lock(), &format!("new{i}.txt")) {
            assert!(
                Instant::now() < deadline,
                "no create patch: {:#?}",
                log.lock()
            );
            i += 1;
            fs::write(dir.join(format!("new{i}.txt")), b"hello").unwrap();
            thread::sleep(Duration::from_millis(400));
        }

        fs::remove_file(dir.join("existing.txt")).unwrap();
        wait_for(&log, "delete patch", |ev| {
            patched_remove(ev, "existing.txt")
        });

        fs::rename(dir.join(format!("new{i}.txt")), dir.join("renamed.txt")).unwrap();
        wait_for(&log, "rename patch", |ev| {
            patched_remove(ev, &format!("new{i}.txt")) && patched_upsert(ev, "renamed.txt")
        });

        // Changes inside a subdirectory are not direct children: only the subdir's own
        // creation is reported.
        fs::create_dir(dir.join("sub")).unwrap();
        wait_for(&log, "subdir patch", |ev| patched_upsert(ev, "sub"));
        fs::write(dir.join("sub").join("deep.txt"), b"").unwrap();
        thread::sleep(Duration::from_millis(600));
        assert!(!patched_upsert(&log.lock(), "deep.txt"));
    }

    #[test]
    fn reopening_serves_cache_and_keeps_watching() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir(dir.join("a")).unwrap();
        fs::create_dir(dir.join("b")).unwrap();
        let hub = Hub::new().unwrap();
        let (s, log) = sink();
        hub.open(0, dir.join("a").to_str().unwrap(), s.clone());
        hub.open(0, dir.join("b").to_str().unwrap(), s.clone());
        // `a` stays watched because it's cached.
        assert!(hub.watched_dirs().contains(&dir.join("a")));
        hub.open(0, dir.join("a").to_str().unwrap(), s);
        assert_eq!(snapshot_paths(&log.lock()).len(), 3);
        assert_eq!(hub.panel_dir(0), Some(dir.join("a")));
    }

    #[test]
    fn missing_dir_falls_back_to_ancestor_and_errors_on_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        fs::write(dir.join("file"), b"").unwrap();
        let hub = Hub::new().unwrap();
        let (s, log) = sink();
        hub.open(1, dir.join("nope/deeper").to_str().unwrap(), s.clone());
        assert_eq!(
            snapshot_paths(&log.lock()),
            vec![dir.to_string_lossy().to_string()]
        );
        hub.open(1, dir.join("file").to_str().unwrap(), s);
        assert!(matches!(log.lock().last(), Some(PanelEvent::Error { .. })));
        // The panel keeps its previous subscription after an error.
        assert_eq!(hub.panel_dir(1), Some(dir));
    }

    #[test]
    fn deleted_directory_reopens_on_ancestor() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        let victim = dir.join("victim");
        fs::create_dir(&victim).unwrap();
        let hub = Hub::new().unwrap();
        let (s, log) = sink();
        hub.open(0, victim.to_str().unwrap(), s);
        // Give FSEvents a moment to start, then delete.
        thread::sleep(Duration::from_millis(300));
        fs::remove_dir(&victim).unwrap();
        let expected = dir.to_string_lossy().to_string();
        wait_for(&log, "reopen on parent", |ev| {
            snapshot_paths(ev).contains(&expected)
        });
        assert_eq!(hub.panel_dir(0), Some(dir));
    }
}
