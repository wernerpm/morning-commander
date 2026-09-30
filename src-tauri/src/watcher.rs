//! Thin wrapper over `notify-debouncer-full` that reduces debounced events to
//! "these paths changed" batches. All interpretation happens in [`crate::hub`].

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, NoCache, new_debouncer_opt};

pub const DEBOUNCE: Duration = Duration::from_millis(100);

/// One debounced batch of filesystem activity.
#[derive(Debug, Default)]
pub struct WatchBatch {
    /// Every path mentioned by an event (both sides of a rename included).
    pub paths: Vec<PathBuf>,
    /// Paths for which the OS asked us to rescan (FSEvents `MustScanSubDirs`, dropped events).
    pub rescan: Vec<PathBuf>,
    /// The OS reported an error or overflow with no path: rescan everything.
    pub rescan_all: bool,
}

pub struct FsWatcher {
    // `NoCache`: we re-stat every reported name ourselves, so rename stitching via file
    // IDs isn't needed, and it avoids walking each watched directory on `watch`.
    debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

impl FsWatcher {
    pub fn new(mut on_batch: impl FnMut(WatchBatch) + Send + 'static) -> Result<Self, String> {
        let handler = move |result: DebounceEventResult| {
            let mut batch = WatchBatch::default();
            match result {
                Ok(events) => {
                    for ev in events {
                        if ev.need_rescan() {
                            if ev.paths.is_empty() {
                                batch.rescan_all = true;
                            }
                            batch.rescan.extend(ev.paths.iter().cloned());
                        }
                        batch.paths.extend(ev.paths.iter().cloned());
                    }
                }
                Err(errors) => {
                    for e in errors {
                        log::warn!("watcher error: {e}");
                        if e.paths.is_empty() {
                            batch.rescan_all = true;
                        }
                        batch.rescan.extend(e.paths);
                    }
                }
            }
            on_batch(batch);
        };
        let debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE,
            None,
            handler,
            NoCache,
            notify::Config::default(),
        )
        .map_err(|e| e.to_string())?;
        Ok(Self { debouncer })
    }

    /// Watch the direct children of `dir` (non-recursive).
    pub fn watch(&mut self, dir: &Path) -> Result<(), String> {
        self.debouncer
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())
    }

    pub fn unwatch(&mut self, dir: &Path) {
        if let Err(e) = self.debouncer.unwatch(dir) {
            log::debug!("unwatch {}: {e}", dir.display());
        }
    }
}
