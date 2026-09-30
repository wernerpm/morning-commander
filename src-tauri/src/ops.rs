//! File operations: rename, mkdir, trash, and background copy/move with progress.
//!
//! Operations never touch the listing cache: the watcher reports their effects.

use std::collections::HashMap;
use std::fs::{self, File, FileTimes};
use std::io::{self, Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::model::{OpEvent, OpKind};

pub type OpSink = Arc<dyn Fn(OpEvent) + Send + Sync>;

/// Files at or below this size use `fs::copy` (APFS clone / `fcopyfile`); larger files
/// are copied in chunks so progress and cancellation are responsive.
const SMALL_FILE: u64 = 8 * 1024 * 1024;
const CHUNK: usize = 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
const EXDEV: i32 = 18;

/// Reject names that aren't a single path component.
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("name must not be empty".into());
    }
    if name == "." || name == ".." {
        return Err(format!("\"{name}\" is not a valid name"));
    }
    if name.contains('/') {
        return Err("name must not contain \"/\"".into());
    }
    if name.contains('\0') {
        return Err("name must not contain NUL".into());
    }
    Ok(())
}

pub fn rename(dir: &Path, from: &str, to: &str) -> Result<(), String> {
    validate_name(from)?;
    validate_name(to)?;
    if from == to {
        return Ok(());
    }
    let src = dir.join(from);
    let dst = dir.join(to);
    let src_meta = fs::symlink_metadata(&src).map_err(|e| format!("{from}: {e}"))?;
    if let Ok(dst_meta) = fs::symlink_metadata(&dst) {
        // On case-/normalisation-insensitive volumes "a" → "A" resolves to the same file.
        let same = dst_meta.dev() == src_meta.dev() && dst_meta.ino() == src_meta.ino();
        if !same {
            return Err(format!("\"{to}\" already exists"));
        }
        let tmp = dir.join(format!(".{from}.mc-rename-{}", std::process::id()));
        fs::rename(&src, &tmp).map_err(|e| format!("{from}: {e}"))?;
        return fs::rename(&tmp, &dst).map_err(|e| {
            let _ = fs::rename(&tmp, &src);
            format!("{to}: {e}")
        });
    }
    fs::rename(&src, &dst).map_err(|e| format!("{from} → {to}: {e}"))
}

pub fn mkdir(dir: &Path, name: &str) -> Result<(), String> {
    validate_name(name)?;
    fs::create_dir(dir.join(name)).map_err(|e| match e.kind() {
        io::ErrorKind::AlreadyExists => format!("\"{name}\" already exists"),
        _ => format!("{name}: {e}"),
    })
}

pub fn trash(paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete_all(paths).map_err(|e| e.to_string())
}

/// Registry of running copy/move operations.
#[derive(Default)]
pub struct Ops {
    next_id: AtomicU64,
    running: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

impl Ops {
    /// Start a copy or move in the background. Returns the operation id; progress and the
    /// final `Done`/`Cancelled` event go to `sink`.
    pub fn start(
        self: &Arc<Self>,
        kind: OpKind,
        sources: Vec<PathBuf>,
        dest_dir: PathBuf,
        sink: OpSink,
    ) -> Result<u64, String> {
        if !dest_dir.is_dir() {
            return Err(format!("{}: not a directory", dest_dir.display()));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        self.running.lock().insert(id, cancel.clone());
        let ops = self.clone();
        thread::Builder::new()
            .name(format!("mc-op-{id}"))
            .spawn(move || {
                let mut job = Job::new(id, cancel, sink.clone());
                let outcome = job.run(kind, &sources, &dest_dir);
                ops.running.lock().remove(&id);
                sink(match outcome {
                    Outcome::Done => OpEvent::Done {
                        id,
                        errors: job.errors,
                    },
                    Outcome::Cancelled => OpEvent::Cancelled { id },
                });
            })
            .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn cancel(&self, id: u64) {
        if let Some(flag) = self.running.lock().get(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

enum Outcome {
    Done,
    Cancelled,
}

struct Cancelled;

struct Job {
    id: u64,
    cancel: Arc<AtomicBool>,
    sink: OpSink,
    errors: Vec<String>,
    files_done: u64,
    files_total: u64,
    bytes_done: u64,
    bytes_total: u64,
    current: String,
    last_progress: Option<Instant>,
}

impl Job {
    fn new(id: u64, cancel: Arc<AtomicBool>, sink: OpSink) -> Self {
        Self {
            id,
            cancel,
            sink,
            errors: Vec::new(),
            files_done: 0,
            files_total: 0,
            bytes_done: 0,
            bytes_total: 0,
            current: String::new(),
            last_progress: None,
        }
    }

    fn run(&mut self, kind: OpKind, sources: &[PathBuf], dest_dir: &Path) -> Outcome {
        for src in sources {
            let (files, bytes) = measure(src);
            self.files_total += files;
            self.bytes_total += bytes;
        }
        self.progress(true);
        for src in sources {
            if let Err(Cancelled) = self.one(kind, src, dest_dir) {
                return Outcome::Cancelled;
            }
        }
        self.progress(true);
        Outcome::Done
    }

    fn one(&mut self, kind: OpKind, src: &Path, dest_dir: &Path) -> Result<(), Cancelled> {
        let Some(name) = src.file_name() else {
            self.errors
                .push(format!("{}: invalid source", src.display()));
            return Ok(());
        };
        let label = name.to_string_lossy().into_owned();
        let dst = dest_dir.join(name);
        let src_meta = match fs::symlink_metadata(src) {
            Ok(m) => m,
            Err(e) => {
                self.errors.push(format!("{label}: {e}"));
                return Ok(());
            }
        };
        if src_meta.is_dir() && dest_dir.starts_with(src) {
            self.errors
                .push(format!("{label}: cannot copy a directory into itself"));
            return Ok(());
        }
        if fs::symlink_metadata(&dst).is_ok() {
            self.errors
                .push(format!("{label}: already exists, skipped"));
            let (files, bytes) = measure(src);
            self.files_done += files;
            self.bytes_done += bytes;
            return Ok(());
        }
        if kind == OpKind::Move {
            match fs::rename(src, &dst) {
                Ok(()) => {
                    let (files, bytes) = measure(&dst);
                    self.files_done += files;
                    self.bytes_done += bytes;
                    self.current = label;
                    self.progress(false);
                    return Ok(());
                }
                Err(e) if e.raw_os_error() == Some(EXDEV) => {}
                Err(e) => {
                    self.errors.push(format!("{label}: {e}"));
                    return Ok(());
                }
            }
        }
        let errors_before = self.errors.len();
        self.copy_tree(src, &dst)?;
        if kind == OpKind::Move && self.errors.len() == errors_before {
            let removed = if src_meta.is_dir() {
                fs::remove_dir_all(src)
            } else {
                fs::remove_file(src)
            };
            if let Err(e) = removed {
                self.errors
                    .push(format!("{label}: copied but could not remove source: {e}"));
            }
        }
        Ok(())
    }

    fn copy_tree(&mut self, src: &Path, dst: &Path) -> Result<(), Cancelled> {
        self.check_cancel()?;
        let label = src.display().to_string();
        let meta = match fs::symlink_metadata(src) {
            Ok(m) => m,
            Err(e) => {
                self.errors.push(format!("{label}: {e}"));
                return Ok(());
            }
        };
        let ft = meta.file_type();
        if ft.is_symlink() {
            let result = fs::read_link(src).and_then(|t| std::os::unix::fs::symlink(t, dst));
            if let Err(e) = result {
                self.errors.push(format!("{label}: {e}"));
            }
            self.files_done += 1;
            self.progress(false);
        } else if ft.is_dir() {
            if let Err(e) = fs::create_dir(dst) {
                self.errors.push(format!("{label}: {e}"));
                return Ok(());
            }
            self.files_done += 1;
            match fs::read_dir(src) {
                Ok(children) => {
                    for child in children.flatten() {
                        self.copy_tree(&child.path(), &dst.join(child.file_name()))?;
                    }
                }
                Err(e) => self.errors.push(format!("{label}: {e}")),
            }
            copy_metadata(&meta, dst);
        } else if ft.is_file() {
            self.current = src
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            self.progress(false);
            match self.copy_file(src, dst, meta.len()) {
                Ok(()) => copy_metadata(&meta, dst),
                Err(CopyError::Cancelled) => {
                    let _ = fs::remove_file(dst);
                    return Err(Cancelled);
                }
                Err(CopyError::Io(e)) => {
                    let _ = fs::remove_file(dst);
                    self.errors.push(format!("{label}: {e}"));
                }
            }
            self.files_done += 1;
            self.progress(false);
        } else {
            self.errors
                .push(format!("{label}: skipped (not a regular file)"));
            self.files_done += 1;
        }
        Ok(())
    }

    fn copy_file(&mut self, src: &Path, dst: &Path, len: u64) -> Result<(), CopyError> {
        if len <= SMALL_FILE {
            fs::copy(src, dst)?;
            self.bytes_done += len;
            return Ok(());
        }
        let mut input = File::open(src)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dst)?;
        let mut buf = vec![0u8; CHUNK];
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(CopyError::Cancelled);
            }
            let n = input.read(&mut buf)?;
            if n == 0 {
                break;
            }
            output.write_all(&buf[..n])?;
            self.bytes_done += n as u64;
            self.progress(false);
        }
        output.flush()?;
        Ok(())
    }

    fn check_cancel(&self) -> Result<(), Cancelled> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(Cancelled)
        } else {
            Ok(())
        }
    }

    fn progress(&mut self, force: bool) {
        let now = Instant::now();
        if !force
            && self
                .last_progress
                .is_some_and(|t| now.duration_since(t) < PROGRESS_INTERVAL)
        {
            return;
        }
        self.last_progress = Some(now);
        (self.sink)(OpEvent::Progress {
            id: self.id,
            files_done: self.files_done,
            files_total: self.files_total,
            bytes_done: self.bytes_done,
            bytes_total: self.bytes_total,
            current: self.current.clone(),
        });
    }
}

enum CopyError {
    Cancelled,
    Io(io::Error),
}

impl From<io::Error> for CopyError {
    fn from(e: io::Error) -> Self {
        CopyError::Io(e)
    }
}

/// Count entries (files, symlinks, directories) and regular-file bytes under `path`,
/// without following symlinks.
fn measure(path: &Path) -> (u64, u64) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return (0, 0);
    };
    if meta.is_dir() {
        let mut totals = (1, 0);
        if let Ok(children) = fs::read_dir(path) {
            for child in children.flatten() {
                let (f, b) = measure(&child.path());
                totals.0 += f;
                totals.1 += b;
            }
        }
        totals
    } else if meta.is_file() {
        (1, meta.len())
    } else {
        (1, 0)
    }
}

/// Best effort: permissions and modification time.
fn copy_metadata(meta: &fs::Metadata, dst: &Path) {
    if let Err(e) = fs::set_permissions(dst, meta.permissions()) {
        log::debug!("set_permissions {}: {e}", dst.display());
    }
    if let Ok(mtime) = meta.modified() {
        let times = FileTimes::new().set_modified(mtime);
        let result = File::open(dst).and_then(|f| f.set_times(times));
        if let Err(e) = result {
            log::debug!("set_times {}: {e}", dst.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn collect_sink() -> (OpSink, Arc<Mutex<Vec<OpEvent>>>) {
        let log: Arc<Mutex<Vec<OpEvent>>> = Arc::default();
        let l = log.clone();
        (Arc::new(move |e| l.lock().push(e)), log)
    }

    fn wait_final(log: &Arc<Mutex<Vec<OpEvent>>>) -> OpEvent {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(e) = log
                .lock()
                .iter()
                .find(|e| matches!(e, OpEvent::Done { .. } | OpEvent::Cancelled { .. }))
            {
                return e.clone();
            }
            assert!(Instant::now() < deadline, "operation did not finish");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn validates_names() {
        assert!(validate_name("ok.txt").is_ok());
        for bad in ["", ".", "..", "a/b", "nul\0"] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn rename_basic_conflict_and_case_only() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        fs::write(d.join("a.txt"), b"a").unwrap();
        fs::write(d.join("b.txt"), b"b").unwrap();

        rename(d, "a.txt", "c.txt").unwrap();
        assert!(d.join("c.txt").exists() && !d.join("a.txt").exists());

        let err = rename(d, "c.txt", "b.txt").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read(d.join("b.txt")).unwrap(), b"b");

        assert!(rename(d, "c.txt", "x/y").is_err());
        assert!(rename(d, "missing", "z").is_err());

        rename(d, "c.txt", "C.txt").unwrap();
        let names: Vec<String> = fs::read_dir(d)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"C.txt".to_string()), "{names:?}");
        assert!(!names.contains(&"c.txt".to_string()), "{names:?}");
    }

    #[test]
    fn mkdir_creates_and_rejects_existing() {
        let tmp = tempfile::tempdir().unwrap();
        mkdir(tmp.path(), "new").unwrap();
        assert!(tmp.path().join("new").is_dir());
        assert!(
            mkdir(tmp.path(), "new")
                .unwrap_err()
                .contains("already exists")
        );
        assert!(mkdir(tmp.path(), "../escape").is_err());
    }

    fn make_tree(root: &Path) {
        fs::create_dir_all(root.join("src/nested/deeper")).unwrap();
        fs::write(root.join("src/top.txt"), b"top").unwrap();
        fs::write(root.join("src/nested/mid.txt"), b"middle").unwrap();
        fs::write(root.join("src/nested/deeper/leaf.bin"), vec![7u8; 4096]).unwrap();
        std::os::unix::fs::symlink("top.txt", root.join("src/link")).unwrap();
        fs::write(root.join("single.txt"), b"single").unwrap();
        fs::create_dir(root.join("dest")).unwrap();
    }

    #[test]
    fn copies_nested_tree_preserving_mtime_and_skipping_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        make_tree(r);
        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
        File::options()
            .write(true)
            .open(r.join("src/top.txt"))
            .unwrap()
            .set_times(FileTimes::new().set_modified(old))
            .unwrap();
        fs::write(r.join("dest/single.txt"), b"existing").unwrap();

        let ops = Arc::new(Ops::default());
        let (sink, log) = collect_sink();
        ops.start(
            OpKind::Copy,
            vec![r.join("src"), r.join("single.txt")],
            r.join("dest"),
            sink,
        )
        .unwrap();
        match wait_final(&log) {
            OpEvent::Done { errors, .. } => {
                assert_eq!(errors.len(), 1, "{errors:?}");
                assert!(errors[0].contains("single.txt"));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            fs::read(r.join("dest/src/nested/mid.txt")).unwrap(),
            b"middle"
        );
        assert_eq!(
            fs::read(r.join("dest/src/nested/deeper/leaf.bin"))
                .unwrap()
                .len(),
            4096
        );
        assert_eq!(
            fs::read_link(r.join("dest/src/link")).unwrap(),
            PathBuf::from("top.txt")
        );
        assert_eq!(fs::read(r.join("dest/single.txt")).unwrap(), b"existing");
        let copied = fs::metadata(r.join("dest/src/top.txt"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(copied, old);
        assert!(r.join("src/top.txt").exists(), "copy keeps the source");
        assert!(
            log.lock()
                .iter()
                .any(|e| matches!(e, OpEvent::Progress { .. }))
        );
    }

    #[test]
    fn moves_and_refuses_moving_into_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        make_tree(r);
        let ops = Arc::new(Ops::default());
        let (sink, log) = collect_sink();
        ops.start(OpKind::Move, vec![r.join("src")], r.join("dest"), sink)
            .unwrap();
        assert!(matches!(wait_final(&log), OpEvent::Done { errors, .. } if errors.is_empty()));
        assert!(!r.join("src").exists());
        assert!(r.join("dest/src/nested/deeper/leaf.bin").exists());

        let (sink, log) = collect_sink();
        ops.start(OpKind::Move, vec![r.join("dest")], r.join("dest/src"), sink)
            .unwrap();
        match wait_final(&log) {
            OpEvent::Done { errors, .. } => assert!(errors[0].contains("into itself")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn cancel_removes_partial_file() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        let big = r.join("big.bin");
        let f = File::create(&big).unwrap();
        f.set_len(512 * 1024 * 1024).unwrap(); // sparse, reads as zeros
        fs::create_dir(r.join("dest")).unwrap();

        let ops = Arc::new(Ops::default());
        let (sink, log) = collect_sink();
        let id = ops
            .start(OpKind::Copy, vec![big], r.join("dest"), sink)
            .unwrap();
        // Cancel as soon as bytes start flowing.
        let deadline = Instant::now() + Duration::from_secs(10);
        while !log
            .lock()
            .iter()
            .any(|e| matches!(e, OpEvent::Progress { bytes_done, .. } if *bytes_done > 0))
        {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
        ops.cancel(id);
        let last = wait_final(&log);
        if matches!(last, OpEvent::Cancelled { .. }) {
            assert!(!r.join("dest/big.bin").exists(), "partial file left behind");
        } else {
            // The copy won the race; it must then be complete.
            assert_eq!(
                fs::metadata(r.join("dest/big.bin")).unwrap().len(),
                512 * 1024 * 1024
            );
        }
    }
}
