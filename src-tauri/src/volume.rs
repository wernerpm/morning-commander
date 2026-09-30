//! Free/total space of the volume containing a path (for the panel footer).

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use crate::model::VolumeInfo;

pub fn volume_info(path: &Path) -> Result<VolumeInfo, String> {
    let c = CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // SAFETY: `c` is a valid NUL-terminated path and `st` is a properly sized,
    // zero-initialised out-parameter that statvfs fills in on success.
    let st = unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut st) != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        st
    };
    let frag = st.f_frsize as u64;
    Ok(VolumeInfo {
        // f_bavail: blocks available to unprivileged users (what Finder shows as available,
        // minus purgeable space).
        free: st.f_bavail as u64 * frag,
        total: st.f_blocks as u64 * frag,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_space_for_temp_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let v = volume_info(tmp.path()).unwrap();
        assert!(v.total > 0 && v.free <= v.total, "{v:?}");
    }

    #[test]
    fn errors_for_missing_path() {
        assert!(volume_info(Path::new("/definitely/not/here")).is_err());
    }
}
