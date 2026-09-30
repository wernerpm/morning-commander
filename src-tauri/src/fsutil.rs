//! Small helpers for the app's own files under `~/.morning-commander/`: private
//! directories (`0700`) and atomic, private (`0600`) file writes.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Create `dir` (and missing parents) with mode `0700`. Returns `true` if `dir` itself
/// was created by this call.
pub fn create_private_dir(dir: &Path) -> io::Result<bool> {
    if dir.is_dir() {
        return Ok(false);
    }
    DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    Ok(true)
}

/// Write `bytes` to `path` atomically: a temp file (mode `0600`) in the same directory,
/// then `rename`. Readers see either the old or the new content, never a partial file.
/// `durable` also fsyncs the data before the rename.
pub fn write_atomic(path: &Path, bytes: &[u8], durable: bool) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        if durable {
            f.sync_all()?;
        }
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Is `name` a temp file left behind by [`write_atomic`]?
pub fn is_temp_name(name: &str) -> bool {
    name.starts_with('.') && name.ends_with(".tmp")
}

/// Milliseconds since the Unix epoch.
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn atomic_write_is_private_and_leaves_no_temp_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("a/b");
        assert!(create_private_dir(&dir).unwrap());
        assert!(!create_private_dir(&dir).unwrap());
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let f = dir.join("x.json");
        write_atomic(&f, b"one", false).unwrap();
        write_atomic(&f, b"two", true).unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"two");
        assert_eq!(
            fs::metadata(&f).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["x.json"]);
    }
}
