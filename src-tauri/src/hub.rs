//! Panel subscriptions: ties the listing caches (memory and disk), the filesystem watcher
//! and the two panels together.
//!
//! Where a snapshot comes from (see "Stale-while-revalidate" in `docs/ipc.md`):
//! - Memory cache, local volume: served as current (`stale: false`); FSEvents keeps it so.
//! - Memory cache, network volume: `stale: true`, then a background revalidation: `stat`
//!   the directory; unchanged mtime → `Fresh`; otherwise full re-read → `Patch` → `Fresh`.
//! - Disk cache ([`Persist`]): loaded into the memory cache, `stale: true`, then
//!   revalidated (full re-read on local volumes, the mtime shortcut on network ones).
//! - Not cached: read before the snapshot is sent (`stale: false`).
//! - `refresh`: a cached listing is sent `stale: true` and always fully re-read.
//!
//! Network directories shown by a panel are polled (FSEvents doesn't work there): every
//! [`HubConfig::poll_interval`] the same mtime-shortcut revalidation runs, backing off to
//! [`POLL_IDLE_INTERVAL`] after [`POLL_BACKOFF_AFTER`] without changes; navigation resets
//! it. [`Hub::recheck`] does the same immediately after the app's own file operations.
//!
//! Invariants:
//! - Every directory in the memory cache is watched.
//! - A directory is watched iff it is cached, shown by a panel, or being loaded
//!   (`loading` includes background re-reads).
//! - Lock order is `state` → `watcher`, and `state` → the disk cache's lock; never the
//!   reverse. No lock is held during filesystem or network I/O (except re-stats of names
//!   the watcher reported while a directory was being read, as before), and the disk
//!   cache's files are read and written without the state lock.
//! - A panel receives exactly one `Snapshot` per successful `open`, sent while holding the
//!   state lock, so it always precedes that directory's `Patch`es.
//! - A stale snapshot is followed by at most one `Fresh`, sent (after any `Patch`) when a
//!   revalidation of that directory finishes, and only while the panel still shows it.
//! - The command returns once the snapshot is sent; revalidation runs on its own thread.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak, mpsc};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use parking_lot::{Mutex, MutexGuard};

use crate::cache::{Listing, ListingCache, ListingMeta};
use crate::fsutil::now_millis;
use crate::listing::{display_name, expand_tilde, read_listing, resolve_dir, stat_entry};
use crate::model::{Entry, PanelEvent};
use crate::netvol;
use crate::persist::{Job, Limits, Persist};
use crate::prefs::{DEFAULT_CACHE_MAX_AGE_DAYS, DEFAULT_CACHE_MAX_BYTES};
use crate::watcher::{FsWatcher, WatchBatch};

/// Receives events for one panel. Returns `false` if the receiver is gone.
pub type PanelSink = Arc<dyn Fn(PanelEvent) -> bool + Send + Sync>;

/// More changed names than this in one batch → re-read the whole directory instead.
const FLOOD_THRESHOLD: usize = 200;

/// How often panel directories are checked for existence. FSEvents doesn't reliably
/// report the deletion of a non-recursively watched directory itself (nor volume
/// unmounts), so this is the backstop that moves panels to the nearest ancestor.
const LIVENESS_INTERVAL: Duration = Duration::from_secs(1);

/// How often dirty listings are written to the disk cache.
const PERSIST_INTERVAL: Duration = Duration::from_secs(2);

/// Default interval for polling shown network directories.
pub const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// Polling interval once a directory hasn't changed for [`POLL_BACKOFF_AFTER`].
pub const POLL_IDLE_INTERVAL: Duration = Duration::from_secs(10);
pub const POLL_BACKOFF_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct HubConfig {
    /// Directory of the on-disk listing cache (`~/.morning-commander/cache`); `None`
    /// keeps listings in memory only.
    pub cache_dir: Option<PathBuf>,
    pub cache_max_bytes: u64,
    pub cache_max_age_days: u64,
    /// Treat every directory as being on a network volume (`MC_FORCE_NETWORK=1`).
    pub force_network: bool,
    /// How often shown network directories are checked for changes.
    pub poll_interval: Duration,
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            cache_dir: None,
            cache_max_bytes: DEFAULT_CACHE_MAX_BYTES,
            cache_max_age_days: DEFAULT_CACHE_MAX_AGE_DAYS,
            force_network: false,
            poll_interval: POLL_INTERVAL,
        }
    }
}

/// Polling schedule of one shown network directory.
struct Poll {
    next: Instant,
    last_change: Instant,
}

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

/// A panel was sent a stale snapshot of `dir` and waits for `Fresh`.
struct Awaiting {
    dir: PathBuf,
    /// Only a full re-read satisfies it (`refresh`).
    full: bool,
}

#[derive(Default)]
struct State {
    cache: ListingCache,
    panels: HashMap<u8, Subscription>,
    /// Bumped on every `open`; a load finishing with a stale number is dropped.
    seq: HashMap<u8, u64>,
    watched: HashSet<PathBuf>,
    /// In-flight reads: token → (dir, changes seen while reading).
    loading: HashMap<u64, (PathBuf, Dirty)>,
    next_token: u64,
    awaiting: HashMap<u8, Awaiting>,
    /// Background revalidations in flight: dir → (id, full re-read).
    revalidating: HashMap<PathBuf, (u64, bool)>,
    /// Shown network directories being polled.
    polls: HashMap<PathBuf, Poll>,
}

enum Update {
    Fresh(Vec<Entry>),
    Stats(Vec<(String, Option<Entry>)>),
}

enum Outcome {
    /// Revalidated (`full`: by a complete re-read).
    Fresh { full: bool },
    /// The directory no longer exists.
    Gone,
    /// Couldn't tell (e.g. unreachable); the listing stays stale.
    Failed,
}

pub struct Hub {
    state: Mutex<State>,
    watcher: Mutex<FsWatcher>,
    persist: Option<Persist>,
    force_network: bool,
    /// Feeds the watcher thread (serialised with real events).
    batches: mpsc::Sender<WatchBatch>,
    weak: Weak<Hub>,
    full_reads: AtomicU64,
    poll_interval: Duration,
    polls_started: AtomicU64,
}

impl Hub {
    pub fn new(config: HubConfig) -> Result<Arc<Self>, String> {
        let (tx, rx) = mpsc::channel::<WatchBatch>();
        let liveness_tx = tx.clone();
        let watcher_tx = tx.clone();
        let watcher = FsWatcher::new(move |batch| {
            let _ = watcher_tx.send(batch);
        })?;
        let persist = config.cache_dir.as_ref().and_then(|dir| {
            let limits = Limits {
                max_bytes: config.cache_max_bytes,
                max_age_days: config.cache_max_age_days,
            };
            Persist::open(dir, limits)
                .map_err(|e| log::warn!("listing cache disabled ({}): {e}", dir.display()))
                .ok()
        });
        let has_persist = persist.is_some();
        let hub = Arc::new_cyclic(|weak| Hub {
            state: Mutex::new(State::default()),
            watcher: Mutex::new(watcher),
            persist,
            force_network: config.force_network,
            batches: tx,
            weak: weak.clone(),
            full_reads: AtomicU64::new(0),
            poll_interval: config.poll_interval,
            polls_started: AtomicU64::new(0),
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
                    let force = hub.force_network;
                    drop(hub);
                    // Network directories are left to the poller: `is_dir` on an asleep or
                    // unreachable NAS fails without the directory being gone.
                    let missing: Vec<PathBuf> = dirs
                        .into_iter()
                        .filter(|d| !netvol::is_network(d, force) && !d.is_dir())
                        .collect();
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
        let weak = Arc::downgrade(&hub);
        let tick =
            (config.poll_interval / 4).clamp(Duration::from_millis(50), Duration::from_millis(500));
        thread::Builder::new()
            .name("mc-poll".into())
            .spawn(move || {
                loop {
                    thread::sleep(tick);
                    let Some(hub) = weak.upgrade() else { break };
                    hub.poll_due(Instant::now());
                }
            })
            .map_err(|e| e.to_string())?;
        if has_persist {
            let weak = Arc::downgrade(&hub);
            thread::Builder::new()
                .name("mc-persist".into())
                .spawn(move || {
                    loop {
                        thread::sleep(PERSIST_INTERVAL);
                        let Some(hub) = weak.upgrade() else { break };
                        hub.flush();
                    }
                })
                .map_err(|e| e.to_string())?;
        }
        Ok(hub)
    }

    /// Point `panel` at `requested` and send it a snapshot (or an error). Blocks until the
    /// snapshot is sent; revalidation of a stale snapshot continues in the background.
    pub fn open(&self, panel: u8, requested: &str, refresh: bool, sink: PanelSink) {
        let seq = {
            let mut s = self.state.lock();
            let n = s.seq.entry(panel).or_insert(0);
            *n += 1;
            *n
        };
        self.open_seq(panel, seq, requested, refresh, sink, true);
    }

    fn open_seq(
        &self,
        panel: u8,
        seq: u64,
        requested: &str,
        refresh: bool,
        sink: PanelSink,
        allow_fast: bool,
    ) {
        // A path that is exactly a cache key skips `resolve_dir`, whose canonicalize can
        // take seconds on a waking NAS.
        let fast = if allow_fast {
            self.cached_key(requested)
        } else {
            None
        };
        let from_fast = fast.is_some();
        let dir = match fast {
            Some(dir) => dir,
            None => match resolve_dir(requested) {
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
            },
        };
        // Local kernel data only; never touches the network.
        let network = netvol::is_network(&dir, self.force_network);

        // 1. Memory cache.
        let on_disk = {
            let mut s = self.state.lock();
            if s.seq.get(&panel) != Some(&seq) {
                return;
            }
            // Local: FSEvents keeps it current. Network: stale until revalidated.
            if self.serve_cached(
                &mut s,
                panel,
                &dir,
                network,
                network || refresh,
                refresh,
                &sink,
            ) {
                return;
            }
            self.persist.as_ref().is_some_and(|p| p.contains(&dir))
        };

        // 2. Disk cache (read without the state lock).
        if on_disk && let Some((meta, entries)) = self.persist.as_ref().and_then(|p| p.load(&dir)) {
            let mut s = self.state.lock();
            if s.seq.get(&panel) != Some(&seq) {
                return;
            }
            if self.serve_cached(
                &mut s,
                panel,
                &dir,
                network,
                network || refresh,
                refresh,
                &sink,
            ) {
                return;
            }
            if self.ensure_watched(&mut s, &dir) {
                let meta = ListingMeta { network, ..meta };
                let listing = Listing::from_entries(entries).with_meta(meta);
                let pinned: Vec<PathBuf> = s.panels.values().map(|p| p.dir.clone()).collect();
                let pinned: Vec<&Path> = pinned.iter().map(PathBuf::as_path).collect();
                s.cache.insert(dir.clone(), listing, &pinned);
                // Always stale. `refresh` or a local volume: full re-read; network: the
                // mtime shortcut.
                self.serve_cached(
                    &mut s,
                    panel,
                    &dir,
                    network,
                    true,
                    refresh || !network,
                    &sink,
                );
                return;
            }
            // Can't watch it: treat as not cached.
        }

        // 3. Not cached: read it now. Start watching *before* reading so no change can
        // slip between the read and the first event.
        let token = {
            let mut s = self.state.lock();
            if s.seq.get(&panel) != Some(&seq) {
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

        let read_at = now_millis();
        // Stat before reading: a change during the read makes the mtime differ next time.
        let result = dir_mtime(&dir).and_then(|m| read_listing(&dir).map(|e| (m, e)));

        let (mtime, entries) = match result {
            Ok(r) => r,
            Err(e) => {
                let mut s = self.state.lock();
                if let Some(t) = token {
                    s.loading.remove(&t);
                }
                self.gc(&mut s);
                if s.seq.get(&panel) != Some(&seq) {
                    return;
                }
                if from_fast && is_gone(&e) {
                    // A cached directory that no longer exists: forget it and resolve
                    // the request normally (nearest existing ancestor).
                    s.cache.remove(&dir);
                    self.gc(&mut s);
                    drop(s);
                    if let Some(p) = &self.persist {
                        p.remove(&dir);
                    }
                    self.open_seq(panel, seq, requested, refresh, sink, false);
                    return;
                }
                sink(PanelEvent::Error {
                    path: dir.to_string_lossy().into_owned(),
                    message: format!("{}: {e}", dir.display()),
                });
                return;
            }
        };
        let (mut s, listing) = self.finish_read(token, &dir, entries);
        if s.seq.get(&panel) != Some(&seq) {
            self.gc(&mut s);
            return;
        }
        let listing = listing.with_meta(ListingMeta {
            dir_mtime: mtime,
            read_at,
            network,
        });
        let entries = listing.to_vec();
        if token.is_some() {
            let pinned: Vec<PathBuf> = s.panels.values().map(|p| p.dir.clone()).collect();
            let pinned: Vec<&Path> = pinned.iter().map(PathBuf::as_path).collect();
            s.cache.insert(dir.clone(), listing, &pinned);
            if let Some(p) = &self.persist {
                p.mark_dirty(&dir);
            }
        }
        self.visit(&dir);
        self.commit(&mut s, panel, dir, entries, false, network, false, sink);
    }

    /// If `dir` is in the memory cache, send its snapshot and, when `stale`, start a
    /// background revalidation (`full`: complete re-read, else the mtime shortcut).
    /// Returns whether it was cached.
    #[allow(clippy::too_many_arguments)]
    fn serve_cached(
        &self,
        s: &mut State,
        panel: u8,
        dir: &Path,
        network: bool,
        stale: bool,
        full: bool,
        sink: &PanelSink,
    ) -> bool {
        let Some(listing) = s.cache.get(dir) else {
            return false;
        };
        let entries = listing.to_vec();
        self.visit(dir);
        self.commit(
            s,
            panel,
            dir.to_path_buf(),
            entries,
            stale,
            network,
            full,
            sink.clone(),
        );
        if stale {
            self.start_revalidation(s, dir, network, full);
        }
        true
    }

    /// The tilde-expanded, absolute `requested` path if it is exactly a key of the memory
    /// or disk cache.
    fn cached_key(&self, requested: &str) -> Option<PathBuf> {
        let path = expand_tilde(requested);
        if !path.is_absolute() {
            return None;
        }
        let path: PathBuf = path.components().collect();
        let s = self.state.lock();
        let known =
            s.cache.contains(&path) || self.persist.as_ref().is_some_and(|p| p.contains(&path));
        known.then_some(path)
    }

    /// Directory currently shown by `panel` (for tests and diagnostics).
    pub fn panel_dir(&self, panel: u8) -> Option<PathBuf> {
        self.state.lock().panels.get(&panel).map(|p| p.dir.clone())
    }

    pub fn watched_dirs(&self) -> Vec<PathBuf> {
        self.state.lock().watched.iter().cloned().collect()
    }

    /// Number of full directory re-reads done by background revalidation (tests).
    pub fn revalidation_reads(&self) -> u64 {
        self.full_reads.load(Ordering::Relaxed)
    }

    /// Apply new cache limits (after `prefs_set`); they take effect at the next flush.
    pub fn set_cache_limits(&self, max_bytes: u64, max_age_days: u64) {
        if let Some(p) = &self.persist {
            p.set_limits(Limits {
                max_bytes,
                max_age_days,
            });
        }
    }

    /// Write dirty listings and the index of the disk cache now (also runs every ~2 s).
    pub fn flush(&self) {
        let Some(persist) = &self.persist else {
            return;
        };
        persist.flush(|dirty| {
            let s = self.state.lock();
            let jobs = dirty
                .into_iter()
                .filter_map(|path| {
                    let listing = s.cache.peek(&path)?;
                    Some(Job {
                        meta: listing.meta,
                        entries: listing.to_vec(),
                        path,
                    })
                })
                .collect();
            let pinned = s.panels.values().map(|p| p.dir.clone()).collect();
            (jobs, pinned)
        });
    }

    fn visit(&self, dir: &Path) {
        if let Some(p) = &self.persist {
            p.visit(dir);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn commit(
        &self,
        s: &mut State,
        panel: u8,
        dir: PathBuf,
        entries: Vec<Entry>,
        stale: bool,
        network: bool,
        needs_full: bool,
        sink: PanelSink,
    ) {
        let path = dir.to_string_lossy().into_owned();
        let parent = dir.parent().map(|p| p.to_string_lossy().into_owned());
        sink(PanelEvent::Snapshot {
            path,
            parent,
            entries,
            stale,
            network,
        });
        if stale {
            s.awaiting.insert(
                panel,
                Awaiting {
                    dir: dir.clone(),
                    full: needs_full,
                },
            );
        } else {
            s.awaiting.remove(&panel);
        }
        if network {
            // Navigation (re)starts polling at the fast rate.
            let now = Instant::now();
            s.polls.insert(
                dir.clone(),
                Poll {
                    next: now + self.poll_interval,
                    last_change: now,
                },
            );
        }
        s.panels.insert(panel, Subscription { dir, sink });
        self.gc(s);
    }

    /// Start the mtime-shortcut revalidation of every polled directory that is due, and
    /// stop polling directories no panel shows any more.
    fn poll_due(&self, now: Instant) {
        let mut s = self.state.lock();
        let shown: HashSet<PathBuf> = s.panels.values().map(|p| p.dir.clone()).collect();
        s.polls.retain(|d, _| shown.contains(d));
        let interval = self.poll_interval;
        let due: Vec<PathBuf> = s
            .polls
            .iter_mut()
            .filter(|(_, p)| p.next <= now)
            .map(|(d, p)| {
                let idle = now.duration_since(p.last_change) >= POLL_BACKOFF_AFTER;
                p.next = now
                    + if idle {
                        POLL_IDLE_INTERVAL.max(interval)
                    } else {
                        interval
                    };
                d.clone()
            })
            .collect();
        for dir in due {
            if s.cache.contains(&dir) {
                self.polls_started.fetch_add(1, Ordering::Relaxed);
                self.start_revalidation(&mut s, &dir, true, false);
            }
        }
    }

    /// Re-check cached network directories now (after the app's own file operations,
    /// which FSEvents may not report there). Local directories are left to the watcher.
    pub fn recheck(&self, dirs: &[PathBuf]) {
        let mut s = self.state.lock();
        let now = Instant::now();
        for dir in dirs {
            let network = s.cache.peek(dir).is_some_and(|l| l.meta.network);
            if !network {
                continue;
            }
            if let Some(p) = s.polls.get_mut(dir) {
                p.last_change = now;
                p.next = now + self.poll_interval;
            }
            self.start_revalidation(&mut s, dir, true, false);
        }
    }

    /// Number of poll-triggered revalidations started (tests).
    pub fn polls_started(&self) -> u64 {
        self.polls_started.load(Ordering::Relaxed)
    }

    /// Start a background revalidation of the cached `dir` unless one that is good enough
    /// is already running.
    fn start_revalidation(&self, s: &mut State, dir: &Path, network: bool, full: bool) {
        if let Some((_, running_full)) = s.revalidating.get(dir)
            && (*running_full || !full)
        {
            return;
        }
        let Some(hub) = self.weak.upgrade() else {
            return;
        };
        s.next_token += 1;
        let id = s.next_token;
        s.revalidating.insert(dir.to_path_buf(), (id, full));
        let dir = dir.to_path_buf();
        let spawned = thread::Builder::new().name("mc-revalidate".into()).spawn({
            let dir = dir.clone();
            move || hub.revalidate(id, dir, network, full)
        });
        if let Err(e) = spawned {
            log::warn!("cannot start revalidation of {}: {e}", dir.display());
            s.revalidating.remove(&dir);
        }
    }

    fn revalidate(&self, id: u64, dir: PathBuf, network: bool, full: bool) {
        let outcome = self.revalidate_inner(id, &dir, network, full);
        let mut s = self.state.lock();
        if s.revalidating.get(&dir).map(|(i, _)| *i) == Some(id) {
            s.revalidating.remove(&dir);
        }
        match outcome {
            Outcome::Fresh { full } => {
                let path = dir.to_string_lossy().into_owned();
                let done: Vec<u8> = s
                    .awaiting
                    .iter()
                    .filter(|(_, a)| a.dir == dir && (full || !a.full))
                    .map(|(id, _)| *id)
                    .collect();
                for panel in done {
                    s.awaiting.remove(&panel);
                    if let Some(sub) = s.panels.get(&panel) {
                        (sub.sink)(PanelEvent::Fresh { path: path.clone() });
                    }
                }
            }
            Outcome::Gone => {
                log::debug!("{} is gone", dir.display());
                s.cache.remove(&dir);
                self.gc(&mut s);
                drop(s);
                if let Some(p) = &self.persist {
                    p.remove(&dir);
                }
                // Panels still showing it move to the nearest ancestor via the regular
                // "gone" handling.
                let _ = self.batches.send(WatchBatch {
                    paths: vec![dir],
                    ..WatchBatch::default()
                });
            }
            Outcome::Failed => {}
        }
    }

    fn revalidate_inner(&self, id: u64, dir: &Path, network: bool, full: bool) -> Outcome {
        if !full {
            let cached = self.state.lock().cache.peek(dir).map(|l| l.meta.dir_mtime);
            match dir_mtime(dir) {
                Ok(m) if m != 0 && cached == Some(m) => return Outcome::Fresh { full: false },
                Ok(_) => {}
                Err(e) if is_gone(&e) => return Outcome::Gone,
                Err(e) => {
                    log::info!("cannot revalidate {}: {e}", dir.display());
                    return Outcome::Failed;
                }
            }
        }

        // Full re-read. Registered in `loading` so watcher changes arriving meanwhile are
        // folded in.
        let token = {
            let mut s = self.state.lock();
            if let Some(r) = s.revalidating.get_mut(dir)
                && r.0 == id
            {
                r.1 = true;
            }
            if !s.cache.contains(dir) {
                // Dropped meanwhile (evicted or gone); nothing to update.
                return Outcome::Failed;
            }
            s.next_token += 1;
            let token = s.next_token;
            s.loading
                .insert(token, (dir.to_path_buf(), Dirty::default()));
            token
        };
        self.full_reads.fetch_add(1, Ordering::Relaxed);
        let read_at = now_millis();
        let result = dir_mtime(dir).and_then(|m| read_listing(dir).map(|e| (m, e)));
        let (mtime, entries) = match result {
            Ok(r) => r,
            Err(e) => {
                let mut s = self.state.lock();
                s.loading.remove(&token);
                self.gc(&mut s);
                if is_gone(&e) {
                    return Outcome::Gone;
                }
                log::info!("cannot re-read {}: {e}", dir.display());
                return Outcome::Failed;
            }
        };
        let (mut s, fresh) = self.finish_read(Some(token), dir, entries);
        if let Some(listing) = s.cache.get_mut(dir) {
            let diff = listing.replace_all(fresh.entries.into_values().collect());
            listing.meta = ListingMeta {
                dir_mtime: mtime,
                read_at,
                network,
            };
            if let Some(p) = &self.persist {
                p.mark_dirty(dir);
            }
            if !diff.is_empty() {
                if let Some(p) = s.polls.get_mut(dir) {
                    let now = Instant::now();
                    p.last_change = now;
                    p.next = p.next.min(now + self.poll_interval);
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
        }
        self.gc(&mut s);
        Outcome::Fresh { full: true }
    }

    /// Fold the watcher changes seen while `token`'s read was running into `entries`,
    /// re-stat'ing without the lock, until no more arrive; then deregister the read.
    /// Returns with the state lock held.
    fn finish_read(
        &self,
        token: Option<u64>,
        dir: &Path,
        entries: Vec<Entry>,
    ) -> (MutexGuard<'_, State>, Listing) {
        let mut listing = Listing::from_entries(entries);
        loop {
            let mut s = self.state.lock();
            let dirty = token
                .and_then(|t| s.loading.get_mut(&t))
                .map(|(_, d)| std::mem::take(d))
                .unwrap_or_default();
            if dirty.is_empty() {
                if let Some(t) = token {
                    s.loading.remove(&t);
                }
                return (s, listing);
            }
            drop(s);
            match compute_update(dir, &dirty) {
                Some(Update::Fresh(fresh)) => {
                    listing.replace_all(fresh);
                }
                Some(Update::Stats(stats)) => {
                    listing.apply_stats(stats);
                }
                None => {}
            }
        }
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
            // Reads in flight will fold these in before using their result.
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
        // Only a definite "doesn't exist" drops the disk cache (not an unreachable NAS).
        let really_gone: Vec<PathBuf> = gone
            .iter()
            .filter(|d| matches!(dir_mtime(d), Err(e) if is_gone(&e)))
            .cloned()
            .collect();
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
                if let Some(p) = &self.persist {
                    p.mark_dirty(&dir);
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
            if let Some(p) = &self.persist {
                for dir in &really_gone {
                    p.remove(dir);
                }
            }
            if !gone.is_empty() {
                self.gc(&mut s);
            }
        }
        // `open` walks up to the nearest existing ancestor.
        for (panel, sink, dir) in reopen {
            self.open(panel, &dir, false, sink);
        }
    }
}

/// The directory's own mtime in unix millis (errors if it isn't a directory).
fn dir_mtime(dir: &Path) -> io::Result<i64> {
    let meta = fs::metadata(dir)?;
    if !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            "not a directory",
        ));
    }
    Ok(meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0))
}

/// The error means the directory doesn't exist (as opposed to e.g. an unreachable server).
fn is_gone(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
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

        let hub = Hub::new(HubConfig::default()).unwrap();
        let (s, log) = sink();
        hub.open(0, dir.to_str().unwrap(), false, s);

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
        let hub = Hub::new(HubConfig::default()).unwrap();
        let (s, log) = sink();
        hub.open(0, dir.join("a").to_str().unwrap(), false, s.clone());
        hub.open(0, dir.join("b").to_str().unwrap(), false, s.clone());
        // `a` stays watched because it's cached.
        assert!(hub.watched_dirs().contains(&dir.join("a")));
        hub.open(0, dir.join("a").to_str().unwrap(), false, s);
        assert_eq!(snapshot_paths(&log.lock()).len(), 3);
        assert_eq!(hub.panel_dir(0), Some(dir.join("a")));
    }

    #[test]
    fn missing_dir_falls_back_to_ancestor_and_errors_on_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        fs::write(dir.join("file"), b"").unwrap();
        let hub = Hub::new(HubConfig::default()).unwrap();
        let (s, log) = sink();
        hub.open(
            1,
            dir.join("nope/deeper").to_str().unwrap(),
            false,
            s.clone(),
        );
        assert_eq!(
            snapshot_paths(&log.lock()),
            vec![dir.to_string_lossy().to_string()]
        );
        hub.open(1, dir.join("file").to_str().unwrap(), false, s);
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
        let hub = Hub::new(HubConfig::default()).unwrap();
        let (s, log) = sink();
        hub.open(0, victim.to_str().unwrap(), false, s);
        // Give FSEvents a moment to start, then delete.
        thread::sleep(Duration::from_millis(300));
        fs::remove_dir(&victim).unwrap();
        let expected = dir.to_string_lossy().to_string();
        wait_for(&log, "reopen on parent", |ev| {
            snapshot_paths(ev).contains(&expected)
        });
        assert_eq!(hub.panel_dir(0), Some(dir));
    }

    // --- Stale-while-revalidate -------------------------------------------------------

    fn cached_hub(cache: &Path, force_network: bool) -> Arc<Hub> {
        Hub::new(HubConfig {
            cache_dir: Some(cache.to_path_buf()),
            force_network,
            ..HubConfig::default()
        })
        .unwrap()
    }

    fn fresh_count(events: &[PanelEvent]) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, PanelEvent::Fresh { .. }))
            .count()
    }

    fn patch_count(events: &[PanelEvent]) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, PanelEvent::Patch { .. }))
            .count()
    }

    /// `(stale, network, sorted names)` of a snapshot event.
    fn snap(e: &PanelEvent) -> (bool, bool, Vec<String>) {
        match e {
            PanelEvent::Snapshot {
                stale,
                network,
                entries,
                ..
            } => {
                let mut names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
                names.sort();
                (*stale, *network, names)
            }
            other => panic!("expected snapshot, got {other:?}"),
        }
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// Open `dir` on a hub with a disk cache, persist it, and drop the hub ("quit").
    fn visit_and_quit(cache: &Path, dir: &Path, force_network: bool) {
        let hub = cached_hub(cache, force_network);
        let (s, log) = sink();
        hub.open(0, dir.to_str().unwrap(), false, s);
        assert!(!snap(&log.lock()[0]).0);
        hub.flush();
    }

    #[test]
    fn relaunch_serves_disk_cache_stale_then_fresh() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        fs::write(dir.join("a.txt"), b"a").unwrap();
        visit_and_quit(cache.path(), &dir, false);

        let hub = cached_hub(cache.path(), false);
        let (s, log) = sink();
        hub.open(0, dir.to_str().unwrap(), false, s);
        assert_eq!(snap(&log.lock()[0]), (true, false, names(&["a.txt"])));
        wait_for(&log, "fresh", |ev| fresh_count(ev) == 1);
        thread::sleep(Duration::from_millis(300));
        let events = log.lock();
        assert_eq!(patch_count(&events), 0, "{events:#?}");
        assert_eq!(fresh_count(&events), 1);
        assert_eq!(hub.revalidation_reads(), 1);
    }

    #[test]
    fn relaunch_patches_changes_made_while_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        fs::write(dir.join("a.txt"), b"a").unwrap();
        visit_and_quit(cache.path(), &dir, false);
        fs::write(dir.join("b.txt"), b"b").unwrap();

        let hub = cached_hub(cache.path(), false);
        let (s, log) = sink();
        hub.open(0, dir.to_str().unwrap(), false, s);
        assert_eq!(snap(&log.lock()[0]), (true, false, names(&["a.txt"])));
        wait_for(&log, "fresh", |ev| fresh_count(ev) == 1);
        let events = log.lock();
        assert!(patched_upsert(&events[1..2], "b.txt"), "{events:#?}");
        assert!(matches!(events.last(), Some(PanelEvent::Fresh { .. })));
    }

    #[test]
    fn network_memory_hits_revalidate_with_mtime_shortcut() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let (x, y) = (root.join("x"), root.join("y"));
        fs::create_dir(&x).unwrap();
        fs::create_dir(&y).unwrap();
        fs::write(x.join("one"), b"1").unwrap();
        let hub = Hub::new(HubConfig {
            force_network: true,
            ..HubConfig::default()
        })
        .unwrap();
        let (s, log) = sink();
        hub.open(0, x.to_str().unwrap(), false, s.clone());
        assert_eq!(snap(&log.lock()[0]), (false, true, names(&["one"])));
        hub.open(0, y.to_str().unwrap(), false, s.clone());

        // Unchanged: stale snapshot, then `fresh` without re-reading.
        let start = log.lock().len();
        hub.open(0, x.to_str().unwrap(), false, s.clone());
        assert_eq!(snap(&log.lock()[start]), (true, true, names(&["one"])));
        wait_for(&log, "fresh", |ev| fresh_count(ev) == 1);
        assert_eq!(hub.revalidation_reads(), 0);
        assert_eq!(patch_count(&log.lock()), 0);

        // A new file changes the directory's mtime: full re-read, then `fresh`. (The
        // watcher may have delivered the file already, so the patch can come from
        // either.)
        thread::sleep(Duration::from_millis(50));
        fs::write(x.join("two"), b"2").unwrap();
        let start = log.lock().len();
        hub.open(0, x.to_str().unwrap(), false, s);
        assert!(snap(&log.lock()[start]).0);
        wait_for(&log, "second fresh", |ev| fresh_count(ev) == 2);
        assert_eq!(hub.revalidation_reads(), 1);
        let events = log.lock();
        let seen = snap(&events[start]).2.contains(&"two".to_string())
            || patched_upsert(&events[start..], "two");
        assert!(seen, "{events:#?}");
    }

    #[test]
    fn network_disk_hit_with_changed_mtime_patches_then_fresh() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        fs::write(dir.join("a.txt"), b"a").unwrap();
        visit_and_quit(cache.path(), &dir, true);
        thread::sleep(Duration::from_millis(50));
        fs::write(dir.join("b.txt"), b"b").unwrap();

        let hub = cached_hub(cache.path(), true);
        let (s, log) = sink();
        hub.open(0, dir.to_str().unwrap(), false, s);
        assert_eq!(snap(&log.lock()[0]), (true, true, names(&["a.txt"])));
        wait_for(&log, "fresh", |ev| fresh_count(ev) == 1);
        let events = log.lock();
        assert_eq!(events.len(), 3, "{events:#?}");
        assert!(patched_upsert(&events[1..2], "b.txt"));
        assert_eq!(hub.revalidation_reads(), 1);
    }

    #[test]
    fn refresh_rereads_even_when_dir_mtime_is_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        fs::write(dir.join("f"), b"1").unwrap();
        visit_and_quit(cache.path(), &dir, true);
        // Rewriting a file in place doesn't change the directory's mtime.
        fs::write(dir.join("f"), b"longer").unwrap();

        let hub = cached_hub(cache.path(), true);
        let (s, log) = sink();
        let size_of = |e: &PanelEvent| match e {
            PanelEvent::Snapshot { entries, .. } => entries[0].size,
            other => panic!("expected snapshot, got {other:?}"),
        };
        // FSEvents may still deliver the rewrite (it happened just before the watch
        // started), so a watcher patch is allowed; what must not happen is a re-read.
        let last_size = |events: &[PanelEvent]| {
            events.iter().rev().find_map(|e| match e {
                PanelEvent::Snapshot { entries, .. } => {
                    entries.iter().find(|x| x.name == "f").map(|x| x.size)
                }
                PanelEvent::Patch { upserted, .. } => {
                    upserted.iter().find(|x| x.name == "f").map(|x| x.size)
                }
                _ => None,
            })
        };
        // Without refresh the mtime shortcut says "unchanged": no re-read.
        hub.open(0, dir.to_str().unwrap(), false, s.clone());
        wait_for(&log, "fresh", |ev| fresh_count(ev) == 1);
        assert_eq!(size_of(&log.lock()[0]), 1, "served from the disk cache");
        assert_eq!(hub.revalidation_reads(), 0);

        // With refresh: a full re-read, ending with the new size, then fresh.
        let start = log.lock().len();
        hub.open(0, dir.to_str().unwrap(), true, s);
        assert!(snap(&log.lock()[start]).0);
        wait_for(&log, "second fresh", |ev| fresh_count(ev) == 2);
        let events = log.lock();
        assert_eq!(last_size(&events[..]), Some(6), "{events:#?}");
        assert!(matches!(events.last(), Some(PanelEvent::Fresh { .. })));
        assert_eq!(hub.revalidation_reads(), 1);
    }

    #[test]
    fn cached_dir_deleted_while_closed_falls_back_to_ancestor() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let victim = root.join("victim");
        fs::create_dir(&victim).unwrap();
        visit_and_quit(cache.path(), &victim, false);
        fs::remove_dir(&victim).unwrap();

        let hub = cached_hub(cache.path(), false);
        let (s, log) = sink();
        hub.open(0, victim.to_str().unwrap(), false, s);
        let expected = root.to_string_lossy().to_string();
        wait_for(&log, "fallback to parent", |ev| {
            snapshot_paths(ev).last() == Some(&expected)
        });
        assert_eq!(hub.panel_dir(0), Some(root));
        hub.flush();
        assert!(!hub.persist.as_ref().unwrap().contains(&victim));
    }

    #[test]
    fn shown_network_dirs_are_polled_and_rechecked() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        fs::write(dir.join("a"), b"").unwrap();
        let hub = Hub::new(HubConfig {
            force_network: true,
            poll_interval: Duration::from_millis(200),
            ..HubConfig::default()
        })
        .unwrap();
        let (s, log) = sink();
        hub.open(0, dir.to_str().unwrap(), false, s);
        let wait = |what: &str, cond: &dyn Fn() -> bool| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !cond() {
                assert!(Instant::now() < deadline, "timed out waiting for {what}");
                thread::sleep(Duration::from_millis(20));
            }
        };
        wait("two polls", &|| hub.polls_started() >= 2);
        assert_eq!(
            hub.revalidation_reads(),
            0,
            "an unchanged dir must not be re-read"
        );

        // A change bumps the directory's mtime: the next poll re-reads and patches.
        fs::write(dir.join("b"), b"").unwrap();
        wait("re-read after change", &|| hub.revalidation_reads() >= 1);
        wait_for(&log, "patch with b", |ev| {
            patched_upsert(ev, "b")
                || ev.iter().any(|e| matches!(e, PanelEvent::Snapshot { entries, .. } if entries.iter().any(|x| x.name == "b")))
        });

        // `recheck` re-reads a changed directory without waiting for the poll.
        let reads = hub.revalidation_reads();
        fs::write(dir.join("c"), b"").unwrap();
        hub.recheck(std::slice::from_ref(&dir));
        wait("recheck re-read", &|| hub.revalidation_reads() > reads);

        // Navigating away stops polling the old directory.
        let other = tempfile::tempdir().unwrap();
        let (s2, _) = sink();
        hub.open(0, other.path().to_str().unwrap(), false, s2);
        thread::sleep(Duration::from_millis(300));
        assert!(!hub.state.lock().polls.contains_key(&dir));
    }
}
