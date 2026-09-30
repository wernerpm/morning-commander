//! Is a path on a network volume?
//!
//! Uses the kernel's mount table (`getmntinfo(MNT_NOWAIT)`), which is local data: unlike
//! `statfs(path)` it never talks to the server, so it can't block on a sleeping NAS.

use std::path::Path;

/// Filesystem types treated as network volumes even if they claim `MNT_LOCAL`.
#[cfg(any(target_os = "macos", test))]
const NETWORK_FS_TYPES: [&str; 4] = ["smbfs", "nfs", "afpfs", "webdav"];

/// `true` if `path` (absolute) is on a network volume, or always when `force` is set
/// (`MC_FORCE_NETWORK=1`, for testing the network code paths locally).
pub fn is_network(path: &Path, force: bool) -> bool {
    force || platform::is_network(path)
}

/// Pick the mount point that is the longest (component-wise) prefix of `path`.
#[cfg(any(target_os = "macos", test))]
fn best_mount<'a, T>(path: &Path, mounts: &'a [(std::path::PathBuf, T)]) -> Option<&'a T> {
    mounts
        .iter()
        .filter(|(on, _)| path.starts_with(on))
        .max_by_key(|(on, _)| on.components().count())
        .map(|(_, t)| t)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use parking_lot::Mutex;

    use super::{NETWORK_FS_TYPES, best_mount};

    /// `getmntinfo` returns a buffer owned by libc that the next call reuses.
    static MNTINFO_LOCK: Mutex<()> = Mutex::new(());

    struct Mount {
        local: bool,
        fstype: String,
    }

    fn mounts() -> Vec<(PathBuf, Mount)> {
        let _g = MNTINFO_LOCK.lock();
        let mut buf: *mut libc::statfs = std::ptr::null_mut();
        // SAFETY: getmntinfo fills `buf` with a pointer to `n` statfs records that stay
        // valid until the next call, which MNTINFO_LOCK prevents while we copy them out.
        let n = unsafe { libc::getmntinfo(&mut buf, libc::MNT_NOWAIT) };
        if n <= 0 || buf.is_null() {
            return Vec::new();
        }
        // SAFETY: see above; `n` records starting at `buf`.
        let records = unsafe { std::slice::from_raw_parts(buf, n as usize) };
        records
            .iter()
            .map(|st| {
                // SAFETY: both fields are NUL-terminated C strings filled in by the kernel.
                let on = unsafe { CStr::from_ptr(st.f_mntonname.as_ptr()) };
                let ty = unsafe { CStr::from_ptr(st.f_fstypename.as_ptr()) };
                (
                    PathBuf::from(std::ffi::OsStr::from_bytes(on.to_bytes())),
                    Mount {
                        local: st.f_flags & libc::MNT_LOCAL as u32 != 0,
                        fstype: ty.to_string_lossy().into_owned(),
                    },
                )
            })
            .collect()
    }

    pub fn is_network(path: &Path) -> bool {
        let mounts = mounts();
        best_mount(path, &mounts)
            .map(|m| !m.local || NETWORK_FS_TYPES.contains(&m.fstype.as_str()))
            .unwrap_or(false)
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use std::path::Path;

    pub fn is_network(_path: &Path) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn root_and_temp_dirs_are_local() {
        assert!(!is_network(Path::new("/"), false));
        let tmp = tempfile::tempdir().unwrap();
        let dir = std::fs::canonicalize(tmp.path()).unwrap();
        assert!(!is_network(&dir, false));
    }

    #[test]
    fn forced_mode_counts_everything_as_network() {
        assert!(is_network(Path::new("/"), true));
    }

    #[test]
    fn longest_component_prefix_wins() {
        let mounts = vec![
            (PathBuf::from("/"), "root"),
            (PathBuf::from("/Volumes/share"), "share"),
            (PathBuf::from("/Volumes/share/sub"), "sub"),
        ];
        assert_eq!(best_mount(Path::new("/Users/demo"), &mounts), Some(&"root"));
        assert_eq!(
            best_mount(Path::new("/Volumes/share/dir"), &mounts),
            Some(&"share")
        );
        assert_eq!(
            best_mount(Path::new("/Volumes/share/sub/x"), &mounts),
            Some(&"sub")
        );
        // Component-wise, not string prefix.
        assert_eq!(
            best_mount(Path::new("/Volumes/shared"), &mounts),
            Some(&"root")
        );
        assert!(NETWORK_FS_TYPES.contains(&"smbfs"));
    }
}
