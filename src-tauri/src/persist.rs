//! On-disk listing cache (step 11b): lets a relaunched app show directories it has seen
//! before instantly (as a *stale* snapshot that the hub then revalidates).
//!
//! Layout under the cache directory (`~/.morning-commander/cache`, `0700`, excluded from
//! Time Machine; safe to delete at any time):
//!
//! ```text
//! index.json          { "version": 1, "dirs": { "<abs path>": { file, lastVisited, bytes,
//!                       dirMtime, readAt, network } } }
//! dirs/<16 hex>.json  { path, dirMtime, readAt, network, entries: [[name, kind, size, mtime, flags]] }
//! ```
//!
//! - Dir files are named by the first 16 hex chars of `sha256(path)`; kind is `f|d|l|o`,
//!   flags bit0 = hidden, bit1 = targetIsDir. All files are written atomically, `0600`.
//! - An unreadable index or a different `version` wipes the cache (never migrated).
//! - Write-behind: the hub marks directories dirty; [`Persist::flush`] (every ~2 s and on
//!   exit) writes their files, applies eviction, then writes `index.json`.
//! - Eviction: total size over `cacheMaxBytes` → least recently *visited* first, down to
//!   90% of the limit; entries not visited for `cacheMaxAgeDays` are dropped; a directory
//!   larger than 25% of the limit is never persisted; pinned (shown) directories are kept.
//! - `lastVisited` changes only through [`Persist::visit`] (a panel showed the directory),
//!   never through writes.
//!
//! Locking: `flush_lock` (serialises flushes, outermost) → the hub's state lock → `inner`.
//! `inner` is never held during file I/O except for reading small bookkeeping at startup.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::cache::ListingMeta;
use crate::fsutil::{create_private_dir, is_temp_name, now_millis, write_atomic};
use crate::model::{Entry, EntryKind};

pub const INDEX_VERSION: u32 = 1;
const INDEX_FILE: &str = "index.json";
const DIRS: &str = "dirs";
const DAY_MS: i64 = 86_400_000;

/// `tmutil addexclusion`'s xattr value: a binary plist of the string "com.apple.backupd".
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_XATTR: &str = "com.apple.metadata:com_apple_backup_excludeItem";
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_VALUE: [u8; 61] = [
    0x62, 0x70, 0x6C, 0x69, 0x73, 0x74, 0x30, 0x30, 0x5F, 0x10, 0x11, 0x63, 0x6F, 0x6D, 0x2E, 0x61,
    0x70, 0x70, 0x6C, 0x65, 0x2E, 0x62, 0x61, 0x63, 0x6B, 0x75, 0x70, 0x64, 0x08, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1C,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_bytes: u64,
    pub max_age_days: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub file: String,
    pub last_visited: i64,
    pub bytes: u64,
    pub dir_mtime: i64,
    pub read_at: i64,
    pub network: bool,
}

#[derive(Serialize, Deserialize)]
struct IndexFile {
    version: u32,
    dirs: BTreeMap<String, IndexEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum KindCode {
    #[serde(rename = "f")]
    File,
    #[serde(rename = "d")]
    Dir,
    #[serde(rename = "l")]
    Symlink,
    #[serde(rename = "o")]
    Other,
}

const FLAG_HIDDEN: u8 = 1;
const FLAG_TARGET_IS_DIR: u8 = 2;

#[derive(Debug, Serialize, Deserialize)]
struct CompactEntry(String, KindCode, u64, i64, u8);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirFile {
    path: String,
    dir_mtime: i64,
    read_at: i64,
    #[serde(default)]
    network: bool,
    entries: Vec<CompactEntry>,
}

/// Encode one directory in the compact dir-file format.
pub fn encode_dir(path: &Path, meta: &ListingMeta, entries: &[Entry]) -> Vec<u8> {
    let file = DirFile {
        path: path.to_string_lossy().into_owned(),
        dir_mtime: meta.dir_mtime,
        read_at: meta.read_at,
        network: meta.network,
        entries: entries
            .iter()
            .map(|e| {
                let kind = match e.kind {
                    EntryKind::File => KindCode::File,
                    EntryKind::Dir => KindCode::Dir,
                    EntryKind::Symlink => KindCode::Symlink,
                    EntryKind::Other => KindCode::Other,
                };
                let flags = if e.hidden { FLAG_HIDDEN } else { 0 }
                    | if e.target_is_dir {
                        FLAG_TARGET_IS_DIR
                    } else {
                        0
                    };
                CompactEntry(e.name.clone(), kind, e.size, e.mtime, flags)
            })
            .collect(),
    };
    serde_json::to_vec(&file).expect("dir file serialises")
}

/// Decode a dir file: `(path, meta, entries)`. `None` if malformed.
pub fn decode_dir(bytes: &[u8]) -> Option<(PathBuf, ListingMeta, Vec<Entry>)> {
    let file: DirFile = serde_json::from_slice(bytes).ok()?;
    let entries = file
        .entries
        .into_iter()
        .map(|CompactEntry(name, kind, size, mtime, flags)| Entry {
            name,
            kind: match kind {
                KindCode::File => EntryKind::File,
                KindCode::Dir => EntryKind::Dir,
                KindCode::Symlink => EntryKind::Symlink,
                KindCode::Other => EntryKind::Other,
            },
            target_is_dir: flags & FLAG_TARGET_IS_DIR != 0,
            size,
            mtime,
            hidden: flags & FLAG_HIDDEN != 0,
        })
        .collect();
    let meta = ListingMeta {
        dir_mtime: file.dir_mtime,
        read_at: file.read_at,
        network: file.network,
    };
    Some((PathBuf::from(file.path), meta, entries))
}

/// `dirs/` file name for a directory path.
pub fn file_name_for(path: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    let digest = Sha256::digest(path.as_os_str().as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex}.json")
}

/// A listing to be written by [`Persist::flush`].
pub struct Job {
    pub path: PathBuf,
    pub meta: ListingMeta,
    pub entries: Vec<Entry>,
}

#[derive(Default)]
struct Inner {
    index: HashMap<PathBuf, IndexEntry>,
    limits: Option<Limits>,
    /// Directories whose listing changed since the last flush.
    dirty: HashSet<PathBuf>,
    /// Visits of directories not in the index yet (applied when first written).
    visits: HashMap<PathBuf, i64>,
    /// Directories whose file should be deleted at the next flush (unless re-indexed).
    deletes: HashSet<PathBuf>,
    /// Removed since the current flush took the dirty set: don't re-index them.
    tombstones: HashSet<PathBuf>,
    index_dirty: bool,
}

impl Inner {
    fn limits(&self) -> Limits {
        self.limits.expect("limits set at open")
    }

    fn remove(&mut self, path: &Path) {
        if self.index.remove(path).is_some() {
            self.index_dirty = true;
        }
        self.dirty.remove(path);
        self.visits.remove(path);
        self.deletes.insert(path.to_path_buf());
        self.tombstones.insert(path.to_path_buf());
    }

    /// Age and size eviction. Pinned directories are never evicted.
    fn evict(&mut self, now: i64, pinned: &[PathBuf]) {
        let limits = self.limits();
        let max_age = (limits.max_age_days as i64).saturating_mul(DAY_MS);
        let expired: Vec<PathBuf> = self
            .index
            .iter()
            .filter(|(p, e)| now.saturating_sub(e.last_visited) > max_age && !pinned.contains(p))
            .map(|(p, _)| p.clone())
            .collect();
        for p in expired {
            log::debug!("cache: dropping {} (not visited recently)", p.display());
            self.remove(&p);
        }
        let mut total: u64 = self.index.values().map(|e| e.bytes).sum();
        if total <= limits.max_bytes {
            return;
        }
        let target = limits.max_bytes / 10 * 9;
        let mut candidates: Vec<(i64, PathBuf, u64)> = self
            .index
            .iter()
            .filter(|(p, _)| !pinned.contains(p))
            .map(|(p, e)| (e.last_visited, p.clone(), e.bytes))
            .collect();
        candidates.sort();
        for (_, p, bytes) in candidates {
            if total <= target {
                break;
            }
            total -= bytes;
            self.remove(&p);
        }
    }

    fn serialise_index(&self) -> Vec<u8> {
        let file = IndexFile {
            version: INDEX_VERSION,
            dirs: self
                .index
                .iter()
                .map(|(p, e)| (p.to_string_lossy().into_owned(), e.clone()))
                .collect(),
        };
        serde_json::to_vec(&file).expect("index serialises")
    }
}

pub struct Persist {
    root: PathBuf,
    inner: Mutex<Inner>,
    flush_lock: Mutex<()>,
}

impl Persist {
    /// Open (creating if needed) the cache at `root`. A missing, unreadable or
    /// foreign-version index starts an empty cache.
    pub fn open(root: &Path, limits: Limits) -> io::Result<Self> {
        if create_private_dir(root)? {
            exclude_from_backup(root);
        }
        let dirs = root.join(DIRS);
        create_private_dir(&dirs)?;

        let mut index: HashMap<PathBuf, IndexEntry> = HashMap::new();
        let mut index_dirty = false;
        match fs::read(root.join(INDEX_FILE)) {
            Ok(bytes) => match serde_json::from_slice::<IndexFile>(&bytes) {
                Ok(f) if f.version == INDEX_VERSION => {
                    index = f
                        .dirs
                        .into_iter()
                        .map(|(p, e)| (PathBuf::from(p), e))
                        .collect();
                }
                Ok(f) => {
                    log::info!(
                        "listing cache version {} ≠ {INDEX_VERSION}; discarding",
                        f.version
                    );
                    wipe(&dirs)?;
                    index_dirty = true;
                }
                Err(e) => {
                    log::warn!("listing cache index unreadable ({e}); discarding");
                    wipe(&dirs)?;
                    index_dirty = true;
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => {
                log::warn!("listing cache index unreadable ({e}); discarding");
                wipe(&dirs)?;
                index_dirty = true;
            }
        }

        // Drop orphans (files not in the index, temp files from a crash) and index entries
        // whose file is missing.
        let referenced: HashSet<&str> = index.values().map(|e| e.file.as_str()).collect();
        let mut present: HashSet<String> = HashSet::new();
        for entry in fs::read_dir(&dirs)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if referenced.contains(name.as_str()) && !is_temp_name(&name) {
                present.insert(name);
            } else {
                let _ = fs::remove_file(entry.path());
            }
        }
        let before = index.len();
        index.retain(|_, e| present.contains(&e.file));
        index_dirty |= index.len() != before;

        let persist = Persist {
            root: root.to_path_buf(),
            inner: Mutex::new(Inner {
                index,
                limits: Some(limits),
                index_dirty,
                ..Inner::default()
            }),
            flush_lock: Mutex::new(()),
        };
        // Applies age eviction and writes the index if anything changed.
        persist.flush_at(now_millis(), |_| (Vec::new(), Vec::new()));
        Ok(persist)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn set_limits(&self, limits: Limits) {
        self.inner.lock().limits = Some(limits);
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.inner.lock().index.contains_key(path)
    }

    pub fn lookup(&self, path: &Path) -> Option<IndexEntry> {
        self.inner.lock().index.get(path).cloned()
    }

    /// Paths currently in the index (tests and diagnostics).
    pub fn paths(&self) -> Vec<PathBuf> {
        self.inner.lock().index.keys().cloned().collect()
    }

    /// Load a directory's cached listing. A missing or corrupt file drops the entry.
    pub fn load(&self, path: &Path) -> Option<(ListingMeta, Vec<Entry>)> {
        let file = self.inner.lock().index.get(path)?.file.clone();
        let loaded = fs::read(self.root.join(DIRS).join(&file))
            .ok()
            .and_then(|b| decode_dir(&b))
            .filter(|(p, _, _)| p == path);
        match loaded {
            Some((_, meta, entries)) => Some((meta, entries)),
            None => {
                log::debug!("cache file for {} missing or corrupt", path.display());
                self.remove(path);
                None
            }
        }
    }

    /// A panel showed `path`: bump its `lastVisited`.
    pub fn visit(&self, path: &Path) {
        self.visit_at(path, now_millis());
    }

    pub(crate) fn visit_at(&self, path: &Path, now: i64) {
        let mut i = self.inner.lock();
        if let Some(e) = i.index.get_mut(path) {
            e.last_visited = now;
            i.index_dirty = true;
        } else {
            i.visits.insert(path.to_path_buf(), now);
        }
    }

    /// The listing of `path` changed; write it at the next flush.
    pub fn mark_dirty(&self, path: &Path) {
        self.inner.lock().dirty.insert(path.to_path_buf());
    }

    /// Forget `path` (e.g. the directory is gone); its file is deleted at the next flush.
    pub fn remove(&self, path: &Path) {
        self.inner.lock().remove(path);
    }

    /// Write dirty directories, evict, and write the index. `collect` receives the dirty
    /// paths and returns the listings to write plus the pinned (shown) directories; it may
    /// take the hub's state lock (this function holds no other lock while calling it).
    pub fn flush(&self, collect: impl FnOnce(Vec<PathBuf>) -> (Vec<Job>, Vec<PathBuf>)) {
        self.flush_at(now_millis(), collect);
    }

    pub(crate) fn flush_at(
        &self,
        now: i64,
        collect: impl FnOnce(Vec<PathBuf>) -> (Vec<Job>, Vec<PathBuf>),
    ) {
        let _f = self.flush_lock.lock();
        let (dirty, limits) = {
            let mut i = self.inner.lock();
            i.tombstones.clear();
            (i.dirty.drain().collect::<Vec<_>>(), i.limits())
        };
        let (jobs, pinned) = collect(dirty);

        let dirs = self.root.join(DIRS);
        let mut written: Vec<(PathBuf, IndexEntry)> = Vec::new();
        let mut too_big: Vec<PathBuf> = Vec::new();
        for job in jobs {
            let bytes = encode_dir(&job.path, &job.meta, &job.entries);
            if bytes.len() as u64 > limits.max_bytes / 4 {
                too_big.push(job.path);
                continue;
            }
            let file = file_name_for(&job.path);
            match write_atomic(&dirs.join(&file), &bytes, false) {
                Ok(()) => written.push((
                    job.path,
                    IndexEntry {
                        file,
                        last_visited: 0, // filled in below
                        bytes: bytes.len() as u64,
                        dir_mtime: job.meta.dir_mtime,
                        read_at: job.meta.read_at,
                        network: job.meta.network,
                    },
                )),
                Err(e) => log::warn!("cannot write listing cache for {}: {e}", job.path.display()),
            }
        }

        let (deletes, index_bytes) = {
            let mut i = self.inner.lock();
            for (path, mut entry) in written {
                if i.tombstones.contains(&path) {
                    i.deletes.insert(path);
                    continue;
                }
                let visited = i.index.get(&path).map(|e| e.last_visited);
                let pending = i.visits.remove(&path);
                entry.last_visited = visited.or(pending).unwrap_or(entry.read_at);
                i.index.insert(path, entry);
                i.index_dirty = true;
            }
            for path in too_big {
                log::debug!("{} is too large for the listing cache", path.display());
                i.remove(&path);
            }
            i.evict(now, &pinned);
            let deletes: Vec<PathBuf> = std::mem::take(&mut i.deletes)
                .into_iter()
                .filter(|p| !i.index.contains_key(p))
                .map(|p| dirs.join(file_name_for(&p)))
                .collect();
            let index_bytes = i.index_dirty.then(|| i.serialise_index());
            i.index_dirty = false;
            (deletes, index_bytes)
        };

        for f in deletes {
            if let Err(e) = fs::remove_file(&f)
                && e.kind() != io::ErrorKind::NotFound
            {
                log::debug!("cannot delete {}: {e}", f.display());
            }
        }
        if let Some(bytes) = index_bytes
            && let Err(e) = write_atomic(&self.root.join(INDEX_FILE), &bytes, false)
        {
            log::warn!("cannot write listing cache index: {e}");
            self.inner.lock().index_dirty = true;
        }
    }
}

fn wipe(dirs: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dirs) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    create_private_dir(dirs).map(|_| ())
}

/// Exclude `dir` from Time Machine backups (as `tmutil addexclusion` does).
#[cfg(target_os = "macos")]
pub(crate) fn exclude_from_backup(dir: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let (Ok(path), Ok(name)) = (
        CString::new(dir.as_os_str().as_bytes()),
        CString::new(BACKUP_EXCLUDE_XATTR),
    ) else {
        return;
    };
    // SAFETY: valid NUL-terminated strings and a byte buffer of the given length.
    let rc = unsafe {
        libc::setxattr(
            path.as_ptr(),
            name.as_ptr(),
            BACKUP_EXCLUDE_VALUE.as_ptr().cast(),
            BACKUP_EXCLUDE_VALUE.len(),
            0,
            0,
        )
    };
    if rc != 0 {
        log::warn!(
            "cannot exclude {} from backups: {}",
            dir.display(),
            io::Error::last_os_error()
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn exclude_from_backup(_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = DAY_MS;

    fn entry(name: &str, kind: EntryKind, hidden: bool, target_is_dir: bool) -> Entry {
        Entry {
            name: name.into(),
            kind,
            target_is_dir,
            size: 1234,
            mtime: 1_700_000_000_000,
            hidden,
        }
    }

    /// Entries whose encoding is roughly `n * 60` bytes.
    fn entries(n: usize) -> Vec<Entry> {
        (0..n)
            .map(|i| {
                entry(
                    &format!("file-{i:04}-padding-padding.txt"),
                    EntryKind::File,
                    false,
                    false,
                )
            })
            .collect()
    }

    fn meta(read_at: i64) -> ListingMeta {
        ListingMeta {
            dir_mtime: 42,
            read_at,
            network: false,
        }
    }

    fn open(root: &Path, max_bytes: u64) -> Persist {
        Persist::open(
            root,
            Limits {
                max_bytes,
                max_age_days: 180,
            },
        )
        .unwrap()
    }

    /// Visit and write `path` with `n` entries at time `t`.
    fn store(p: &Persist, path: &str, n: usize, t: i64, pinned: &[&str]) {
        let path = PathBuf::from(path);
        p.visit_at(&path, t);
        p.mark_dirty(&path);
        let pinned: Vec<PathBuf> = pinned.iter().map(PathBuf::from).collect();
        p.flush_at(t, |dirty| {
            assert_eq!(dirty, vec![path.clone()]);
            (
                vec![Job {
                    path: path.clone(),
                    meta: meta(t),
                    entries: entries(n),
                }],
                pinned,
            )
        });
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn sorted(mut v: Vec<PathBuf>) -> Vec<PathBuf> {
        v.sort();
        v
    }

    #[test]
    fn compact_encoding_round_trips() {
        let list = vec![
            entry("a.txt", EntryKind::File, false, false),
            entry(".hidden", EntryKind::File, true, false),
            entry("dir", EntryKind::Dir, false, false),
            entry("link", EntryKind::Symlink, true, true),
            entry("fifo", EntryKind::Other, false, false),
            entry("Caf\u{e9} \"quoted\"", EntryKind::File, false, false),
        ];
        let m = ListingMeta {
            dir_mtime: 1_759_250_000_000,
            read_at: 1_759_251_234_000,
            network: true,
        };
        let bytes = encode_dir(Path::new("/Volumes/share/dir"), &m, &list);
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["path"], "/Volumes/share/dir");
        assert_eq!(v["dirMtime"], 1_759_250_000_000_i64);
        assert_eq!(v["network"], true);
        assert_eq!(
            v["entries"][3],
            serde_json::json!(["link", "l", 1234, 1_700_000_000_000_i64, 3])
        );
        assert_eq!(v["entries"][2][1], "d");
        let (path, m2, back) = decode_dir(&bytes).unwrap();
        assert_eq!(path, PathBuf::from("/Volumes/share/dir"));
        assert_eq!(m2, m);
        assert_eq!(back, list);
        assert!(decode_dir(b"{\"path\":1}").is_none());
        assert_eq!(file_name_for(Path::new("/a")).len(), 16 + 5);
    }

    #[test]
    fn store_load_and_reopen() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("cache");
        let p = open(&root, 1_000_000);
        let now = now_millis();
        store(&p, "/d/one", 3, now, &[]);
        let (m, e) = p.load(Path::new("/d/one")).unwrap();
        assert_eq!(m, meta(now));
        assert_eq!(e, entries(3));
        drop(p);
        let p = open(&root, 1_000_000);
        assert!(p.contains(Path::new("/d/one")));
        assert_eq!(p.load(Path::new("/d/one")).unwrap().1.len(), 3);
        // Removed entries lose their file at the next flush.
        p.remove(Path::new("/d/one"));
        p.flush(|_| (Vec::new(), Vec::new()));
        assert!(files_in(&root.join(DIRS)).is_empty());
        assert!(p.load(Path::new("/d/one")).is_none());
    }

    #[test]
    fn evicts_least_recently_visited_down_to_90_percent() {
        let tmp = tempfile::tempdir().unwrap();
        let p = open(tmp.path(), 1_000_000);
        store(&p, "/d/0", 40, 1000, &[]);
        // All directories encode to the same size `b`; room for 7.5 of them.
        let b = p.lookup(Path::new("/d/0")).unwrap().bytes;
        let limit = b * 15 / 2;
        p.set_limits(Limits {
            max_bytes: limit,
            max_age_days: 180,
        });
        for i in 1..7 {
            store(&p, &format!("/d/{i}"), 40, 1000 + i, &[]);
        }
        assert_eq!(p.paths().len(), 7);
        // Visiting /d/0 makes it the most recent.
        p.visit_at(Path::new("/d/0"), 5000);
        // The 8th goes over the limit. /d/1 is now the oldest but pinned.
        store(&p, "/d/7", 40, 6000, &["/d/1"]);
        let total: u64 = p.paths().iter().map(|d| p.lookup(d).unwrap().bytes).sum();
        assert!(total <= limit / 10 * 9, "total {total}");
        // Only as many as needed: one fewer eviction would not have reached 90%.
        assert!(total + b > limit / 10 * 9);
        let expected: Vec<PathBuf> = [0, 1, 4, 5, 6, 7]
            .iter()
            .map(|i| PathBuf::from(format!("/d/{i}")))
            .collect();
        assert_eq!(sorted(p.paths()), expected);
        assert_eq!(files_in(&tmp.path().join(DIRS)).len(), 6);
    }

    #[test]
    fn huge_directories_are_not_persisted() {
        let tmp = tempfile::tempdir().unwrap();
        let p = open(tmp.path(), 20_000);
        store(&p, "/d/small", 10, 1000, &[]);
        assert!(p.contains(Path::new("/d/small")));
        // Grows beyond 25% of the limit: dropped, file removed.
        store(&p, "/d/small", 200, 2000, &[]);
        assert!(!p.contains(Path::new("/d/small")));
        store(&p, "/d/huge", 200, 3000, &[]);
        assert!(!p.contains(Path::new("/d/huge")));
        assert!(files_in(&tmp.path().join(DIRS)).is_empty());
    }

    #[test]
    fn unvisited_entries_expire() {
        let tmp = tempfile::tempdir().unwrap();
        let now = 1000 * DAY;
        let p = open(tmp.path(), 1_000_000);
        store(&p, "/d/old", 1, now - 200 * DAY, &[]);
        store(&p, "/d/new", 1, now - DAY, &[]);
        // Flushing at `now` drops the old one.
        p.flush_at(now, |_| (Vec::new(), Vec::new()));
        assert_eq!(p.paths(), vec![PathBuf::from("/d/new")]);
        // At startup too.
        p.visit_at(Path::new("/d/new"), 1);
        p.flush_at(2, |_| (Vec::new(), Vec::new()));
        drop(p);
        let p = open(tmp.path(), 1_000_000);
        assert!(p.paths().is_empty());
        assert!(files_in(&tmp.path().join(DIRS)).is_empty());
    }

    #[test]
    fn corrupt_or_foreign_index_is_discarded() {
        for index in [&b"{ garbage"[..], br#"{"version":99,"dirs":{}}"#] {
            let tmp = tempfile::tempdir().unwrap();
            let p = open(tmp.path(), 1_000_000);
            store(&p, "/d/x", 2, now_millis(), &[]);
            drop(p);
            fs::write(tmp.path().join(INDEX_FILE), index).unwrap();
            let p = open(tmp.path(), 1_000_000);
            assert!(p.paths().is_empty());
            assert!(files_in(&tmp.path().join(DIRS)).is_empty());
            let v: serde_json::Value =
                serde_json::from_slice(&fs::read(tmp.path().join(INDEX_FILE)).unwrap()).unwrap();
            assert_eq!(v["version"], 1);
        }
    }

    #[test]
    fn writes_are_atomic_and_private() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("cache");
        let p = open(&root, 1_000_000);
        let now = now_millis();
        for i in 0..5 {
            store(&p, &format!("/d/{i}"), 5, now, &[]);
        }
        assert_eq!(files_in(&root), vec!["dirs", "index.json"]);
        for f in files_in(&root.join(DIRS)) {
            assert!(!is_temp_name(&f), "{f}");
            let mode = fs::metadata(root.join(DIRS).join(&f))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn writes_do_not_bump_last_visited() {
        let tmp = tempfile::tempdir().unwrap();
        let p = open(tmp.path(), 1_000_000);
        let now = now_millis();
        store(&p, "/d/x", 2, now - 10, &[]);
        assert_eq!(p.lookup(Path::new("/d/x")).unwrap().last_visited, now - 10);
        // A revalidation rewrite (no visit).
        p.mark_dirty(Path::new("/d/x"));
        p.flush_at(now, |_| {
            (
                vec![Job {
                    path: "/d/x".into(),
                    meta: meta(now),
                    entries: entries(3),
                }],
                Vec::new(),
            )
        });
        let e = p.lookup(Path::new("/d/x")).unwrap();
        assert_eq!(e.last_visited, now - 10);
        assert_eq!(e.read_at, now);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cache_dir_is_excluded_from_time_machine() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("cache");
        let _p = open(&root, 1_000_000);
        let out = std::process::Command::new("tmutil")
            .arg("isexcluded")
            .arg(&root)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("[Excluded]"), "{text}");
    }
}
