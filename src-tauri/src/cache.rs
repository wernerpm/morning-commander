//! In-memory cache of directory listings with LRU eviction.
//!
//! Invariant (maintained by [`crate::hub::Hub`]): every cached directory is being watched,
//! so cached entries are kept current by watcher patches and never need re-validation.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

use crate::model::Entry;

/// Maximum number of cached directories.
pub const DEFAULT_CAPACITY: usize = 64;

/// One cached directory, keyed by (NFC) entry name.
#[derive(Debug, Default, Clone)]
pub struct Listing {
    pub entries: HashMap<String, Entry>,
}

impl Listing {
    pub fn from_entries(entries: Vec<Entry>) -> Self {
        Self {
            entries: entries.into_iter().map(|e| (e.name.clone(), e)).collect(),
        }
    }

    pub fn to_vec(&self) -> Vec<Entry> {
        self.entries.values().cloned().collect()
    }

    /// Compare against a freshly read full listing, apply it, and return the difference.
    pub fn replace_all(&mut self, fresh: Vec<Entry>) -> Diff {
        let fresh = Listing::from_entries(fresh);
        let removed = self
            .entries
            .keys()
            .filter(|k| !fresh.entries.contains_key(*k))
            .cloned()
            .collect();
        let upserted = fresh
            .entries
            .values()
            .filter(|e| self.entries.get(&e.name) != Some(*e))
            .cloned()
            .collect();
        *self = fresh;
        Diff { removed, upserted }
    }

    /// Apply re-stat results for individual names (`None` = no longer exists) and return
    /// only what actually changed.
    pub fn apply_stats(&mut self, stats: Vec<(String, Option<Entry>)>) -> Diff {
        let mut diff = Diff::default();
        for (name, stat) in stats {
            match stat {
                Some(entry) => {
                    if self.entries.get(&name) != Some(&entry) {
                        self.entries.insert(name, entry.clone());
                        diff.upserted.push(entry);
                    }
                }
                None => {
                    if self.entries.remove(&name).is_some() {
                        diff.removed.push(name);
                    }
                }
            }
        }
        diff
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Diff {
    pub removed: Vec<String>,
    pub upserted: Vec<Entry>,
}

impl Diff {
    pub fn is_empty(&self) -> bool {
        self.removed.is_empty() && self.upserted.is_empty()
    }
}

#[derive(Debug)]
pub struct ListingCache {
    capacity: usize,
    map: HashMap<PathBuf, Listing>,
    /// Least recently used first.
    order: VecDeque<PathBuf>,
}

impl Default for ListingCache {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

impl ListingCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn contains(&self, dir: &Path) -> bool {
        self.map.contains_key(dir)
    }

    /// Get a listing and mark it most recently used.
    pub fn get(&mut self, dir: &Path) -> Option<&Listing> {
        if self.map.contains_key(dir) {
            self.touch(dir);
        }
        self.map.get(dir)
    }

    /// Mutable access without changing recency (used by watcher updates).
    pub fn get_mut(&mut self, dir: &Path) -> Option<&mut Listing> {
        self.map.get_mut(dir)
    }

    /// Insert or replace a listing. Returns the directories evicted to stay within
    /// capacity. Directories in `pinned` (e.g. shown by a panel) are never evicted.
    pub fn insert(&mut self, dir: PathBuf, listing: Listing, pinned: &[&Path]) -> Vec<PathBuf> {
        if self.map.insert(dir.clone(), listing).is_some() {
            self.touch(&dir);
        } else {
            self.order.push_back(dir);
        }
        let mut evicted = Vec::new();
        let mut i = 0;
        while self.map.len() > self.capacity && i < self.order.len() {
            if pinned.contains(&self.order[i].as_path()) {
                i += 1;
                continue;
            }
            let victim = self.order.remove(i).expect("index in range");
            self.map.remove(&victim);
            evicted.push(victim);
        }
        evicted
    }

    pub fn remove(&mut self, dir: &Path) -> Option<Listing> {
        self.order.retain(|d| d != dir);
        self.map.remove(dir)
    }

    pub fn dirs(&self) -> impl Iterator<Item = &PathBuf> {
        self.order.iter()
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    fn touch(&mut self, dir: &Path) {
        if let Some(pos) = self.order.iter().position(|d| d == dir) {
            let d = self.order.remove(pos).expect("index in range");
            self.order.push_back(d);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::EntryKind;

    fn e(name: &str, size: u64) -> Entry {
        Entry {
            name: name.into(),
            kind: EntryKind::File,
            target_is_dir: false,
            size,
            mtime: 0,
            hidden: false,
        }
    }

    #[test]
    fn replace_all_reports_only_changes() {
        let mut l = Listing::from_entries(vec![e("a", 1), e("b", 2), e("c", 3)]);
        let diff = l.replace_all(vec![e("a", 1), e("b", 20), e("d", 4)]);
        let mut removed = diff.removed.clone();
        removed.sort();
        assert_eq!(removed, vec!["c"]);
        let mut up: Vec<_> = diff.upserted.iter().map(|e| e.name.as_str()).collect();
        up.sort();
        assert_eq!(up, vec!["b", "d"]);
        assert_eq!(l.entries.len(), 3);
    }

    #[test]
    fn apply_stats_ignores_noops() {
        let mut l = Listing::from_entries(vec![e("a", 1)]);
        let diff = l.apply_stats(vec![
            ("a".into(), Some(e("a", 1))),
            ("ghost".into(), None),
            ("new".into(), Some(e("new", 5))),
        ]);
        assert_eq!(diff.removed, Vec::<String>::new());
        assert_eq!(diff.upserted, vec![e("new", 5)]);
        let diff = l.apply_stats(vec![("a".into(), None)]);
        assert_eq!(diff.removed, vec!["a"]);
    }

    #[test]
    fn lru_evicts_oldest_unpinned() {
        let mut c = ListingCache::new(2);
        let (a, b, d) = (
            PathBuf::from("/a"),
            PathBuf::from("/b"),
            PathBuf::from("/d"),
        );
        assert!(c.insert(a.clone(), Listing::default(), &[]).is_empty());
        assert!(c.insert(b.clone(), Listing::default(), &[]).is_empty());
        c.get(&a); // a is now most recent
        assert_eq!(
            c.insert(d.clone(), Listing::default(), &[]),
            vec![b.clone()]
        );
        // Pinned entries survive even when oldest.
        let evicted = c.insert(b.clone(), Listing::default(), &[a.as_path()]);
        assert_eq!(evicted, vec![d]);
        assert!(c.contains(&a) && c.contains(&b));
    }
}
