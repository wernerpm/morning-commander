//! Reading directories into [`Entry`] lists, and resolving user-supplied paths.
//!
//! Everything here is synchronous and stateless; the cache and watcher build on it.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rayon::prelude::*;
use unicode_normalization::UnicodeNormalization;

use crate::model::{Entry, EntryKind};

/// Directories larger than this are stat'ed in parallel.
const PARALLEL_THRESHOLD: usize = 2_000;

/// macOS `UF_HIDDEN` flag (`chflags hidden`).
#[cfg(target_os = "macos")]
const UF_HIDDEN: u32 = 0x8000;

/// NFC-normalised display form of a file name. macOS often stores names in NFD.
pub fn display_name(name: &OsStr) -> String {
    name.to_string_lossy().nfc().collect()
}

/// Expand a leading `~` to `$HOME`.
pub fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(path)
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Resolve a requested directory to the canonical directory that should be shown.
///
/// Expands `~`, resolves symlinks, and when the directory no longer exists walks up to
/// the nearest existing ancestor. Fails for relative paths, for paths that exist but are
/// not directories, and for other I/O errors (e.g. permission denied).
pub fn resolve_dir(requested: &str) -> Result<PathBuf, String> {
    let path = expand_tilde(requested);
    if !path.is_absolute() {
        return Err(format!("{requested}: path must be absolute"));
    }
    let mut candidate = path.as_path();
    loop {
        match fs::canonicalize(candidate) {
            Ok(canonical) if canonical.is_dir() => return Ok(canonical),
            Ok(_) if candidate == path => return Err(format!("{requested}: not a directory")),
            // An ancestor turned out to be a file: keep walking up.
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", candidate.display())),
        }
        match candidate.parent() {
            Some(parent) => candidate = parent,
            None => return Err(format!("{requested}: no existing ancestor")),
        }
    }
}

/// Stat one directory child without following symlinks. `None` if it doesn't exist
/// (or can't be stat'ed at all).
pub fn stat_entry(dir: &Path, name: &OsStr) -> Option<Entry> {
    let path = dir.join(name);
    let meta = fs::symlink_metadata(&path).ok()?;
    let ft = meta.file_type();
    let (kind, target_is_dir) = if ft.is_symlink() {
        let target_is_dir = fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        (EntryKind::Symlink, target_is_dir)
    } else if ft.is_dir() {
        (EntryKind::Dir, false)
    } else if ft.is_file() {
        (EntryKind::File, false)
    } else {
        (EntryKind::Other, false)
    };
    let display = display_name(name);
    let hidden = display.starts_with('.') || flagged_hidden(&meta);
    let mtime = meta
        .modified()
        .ok()
        .map(|t| match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_millis() as i64,
            Err(e) => -(e.duration().as_millis() as i64),
        })
        .unwrap_or(0);
    Some(Entry {
        name: display,
        kind,
        target_is_dir,
        size: if kind == EntryKind::Dir {
            0
        } else {
            meta.len()
        },
        mtime,
        hidden,
    })
}

#[cfg(target_os = "macos")]
fn flagged_hidden(meta: &fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    meta.st_flags() & UF_HIDDEN != 0
}

#[cfg(not(target_os = "macos"))]
fn flagged_hidden(_meta: &fs::Metadata) -> bool {
    false
}

/// Raw child names of `dir`, as stored on disk.
pub fn read_names(dir: &Path) -> io::Result<Vec<OsString>> {
    fs::read_dir(dir)?
        .map(|e| e.map(|e| e.file_name()))
        .filter(|e| !matches!(e, Err(err) if err.kind() == io::ErrorKind::NotFound))
        .collect()
}

/// Read and stat every child of `dir`. Children that vanish mid-read are skipped.
pub fn read_listing(dir: &Path) -> io::Result<Vec<Entry>> {
    let names = read_names(dir)?;
    let entries = if names.len() > PARALLEL_THRESHOLD {
        names
            .par_iter()
            .filter_map(|n| stat_entry(dir, n))
            .collect()
    } else {
        names.iter().filter_map(|n| stat_entry(dir, n)).collect()
    };
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn find<'a>(entries: &'a [Entry], name: &str) -> &'a Entry {
        entries
            .iter()
            .find(|e| e.name == name)
            .unwrap_or_else(|| panic!("{name} missing from {entries:?}"))
    }

    #[test]
    fn lists_kinds_hidden_and_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        fs::write(d.join("a.txt"), b"hello").unwrap();
        fs::write(d.join(".hidden"), b"").unwrap();
        fs::create_dir(d.join("sub")).unwrap();
        symlink(d.join("sub"), d.join("link-dir")).unwrap();
        symlink(d.join("a.txt"), d.join("link-file")).unwrap();
        symlink(d.join("missing"), d.join("broken")).unwrap();

        let entries = read_listing(d).unwrap();
        assert_eq!(entries.len(), 6);

        let a = find(&entries, "a.txt");
        assert_eq!(a.kind, EntryKind::File);
        assert_eq!(a.size, 5);
        assert!(!a.hidden);
        assert!(a.mtime > 1_600_000_000_000);

        assert!(find(&entries, ".hidden").hidden);

        let sub = find(&entries, "sub");
        assert_eq!(sub.kind, EntryKind::Dir);
        assert_eq!(sub.size, 0);

        let ld = find(&entries, "link-dir");
        assert_eq!(ld.kind, EntryKind::Symlink);
        assert!(ld.target_is_dir);

        let lf = find(&entries, "link-file");
        assert_eq!(lf.kind, EntryKind::Symlink);
        assert!(!lf.target_is_dir);

        let broken = find(&entries, "broken");
        assert_eq!(broken.kind, EntryKind::Symlink);
        assert!(!broken.target_is_dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn uf_hidden_flag_marks_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("secret");
        fs::write(&p, b"").unwrap();
        let ok = std::process::Command::new("chflags")
            .arg("hidden")
            .arg(&p)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            let e = stat_entry(tmp.path(), OsStr::new("secret")).unwrap();
            assert!(e.hidden);
        }
    }

    #[test]
    fn names_are_nfc_normalised() {
        let tmp = tempfile::tempdir().unwrap();
        let nfd = "Cafe\u{301}.txt"; // "Café" decomposed
        fs::write(tmp.path().join(nfd), b"").unwrap();
        let entries = read_listing(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "Caf\u{e9}.txt");
    }

    #[test]
    fn large_directories_use_parallel_path() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..(PARALLEL_THRESHOLD + 10) {
            fs::write(tmp.path().join(format!("f{i}")), b"").unwrap();
        }
        assert_eq!(
            read_listing(tmp.path()).unwrap().len(),
            PARALLEL_THRESHOLD + 10
        );
    }

    #[test]
    fn resolve_dir_canonicalises_and_falls_back() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir(canonical.join("sub")).unwrap();
        fs::write(canonical.join("file"), b"").unwrap();

        let sub = format!("{}/sub/../sub", tmp.path().display());
        assert_eq!(resolve_dir(&sub).unwrap(), canonical.join("sub"));

        let gone = format!("{}/sub/missing/deeper", tmp.path().display());
        assert_eq!(resolve_dir(&gone).unwrap(), canonical.join("sub"));

        let file = format!("{}/file", tmp.path().display());
        assert!(resolve_dir(&file).unwrap_err().contains("not a directory"));

        assert!(resolve_dir("relative/path").is_err());
        assert_eq!(
            resolve_dir("~").unwrap(),
            fs::canonicalize(home_dir()).unwrap()
        );
    }
}
