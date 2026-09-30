//! Fast directory listing on macOS with `getattrlistbulk(2)`.
//!
//! One syscall returns names, types, mtimes, flags and sizes for many children at
//! once, instead of a `readdir` plus one `lstat` per child. Regular files and
//! directories are built straight from the packed buffer; symlinks and special files
//! (rare, and symlinks need a second stat of the target anyway) go through
//! [`stat_entry`] so both paths produce identical entries.

use std::ffi::{CString, OsStr};
use std::io;
use std::mem::size_of;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use crate::listing::{UF_HIDDEN, display_name, stat_entry};
use crate::model::{Entry, EntryKind};

/// Not exported by `libc`; value from `<sys/attr.h>`.
const ATTR_CMN_ERROR: u32 = 0x2000_0000;

/// `fsobj_type_t` values from `<sys/vnode.h>`.
const VREG: u32 = 1;
const VDIR: u32 = 2;

const BUF_SIZE: usize = 256 * 1024;

/// Owned directory file descriptor, closed on drop.
struct Fd(libc::c_int);

impl Drop for Fd {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a descriptor we opened and have not closed yet.
        unsafe { libc::close(self.0) };
    }
}

/// Reads packed attribute data. Every read is bounds-checked against the record so a
/// malformed buffer yields an error instead of undefined behaviour.
struct Cursor<'a> {
    record: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> io::Result<&'a [u8]> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.record.len());
        let end = end.ok_or_else(|| bad("attribute record truncated"))?;
        let bytes = &self.record[self.pos..end];
        self.pos = end;
        Ok(bytes)
    }

    fn u32(&mut self) -> io::Result<u32> {
        Ok(u32::from_ne_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i32(&mut self) -> io::Result<i32> {
        Ok(i32::from_ne_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i64(&mut self) -> io::Result<i64> {
        Ok(i64::from_ne_bytes(self.take(8)?.try_into().unwrap()))
    }
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}

/// Milliseconds since the epoch, truncated toward zero like `Duration::as_millis`
/// on either side of the epoch (matches `listing::stat_entry`).
fn millis(sec: i64, nsec: i64) -> i64 {
    let total = sec as i128 * 1_000_000_000 + nsec as i128;
    (total / 1_000_000) as i64
}

/// List `dir` with `getattrlistbulk`. Errors (e.g. a filesystem without bulk
/// support) are returned so the caller can fall back to the portable path.
pub fn read_listing_bulk(dir: &Path) -> io::Result<Vec<Entry>> {
    let c_path = CString::new(dir.as_os_str().as_bytes()).map_err(|_| bad("NUL in path"))?;
    // SAFETY: `c_path` is a valid NUL-terminated string that outlives the call.
    let fd = unsafe {
        libc::open(
            c_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = Fd(fd);

    // SAFETY: `attrlist` is a plain C struct of integers; all-zero is a valid value.
    let mut attrs: libc::attrlist = unsafe { std::mem::zeroed() };
    attrs.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    attrs.commonattr = libc::ATTR_CMN_RETURNED_ATTRS
        | ATTR_CMN_ERROR
        | libc::ATTR_CMN_NAME
        | libc::ATTR_CMN_OBJTYPE
        | libc::ATTR_CMN_MODTIME
        | libc::ATTR_CMN_FLAGS;
    attrs.fileattr = libc::ATTR_FILE_DATALENGTH;

    // u64 storage keeps the buffer 8-byte aligned, as the kernel expects.
    let mut buf = vec![0u64; BUF_SIZE / 8];
    let mut entries = Vec::new();
    let mut fallback_names = Vec::new();

    loop {
        // SAFETY: `fd` is an open directory, `attrs` is initialised, and `buf` is a
        // writable allocation of exactly BUF_SIZE bytes that outlives the call.
        let count = unsafe {
            libc::getattrlistbulk(
                fd.0,
                &mut attrs as *mut libc::attrlist as *mut libc::c_void,
                buf.as_mut_ptr() as *mut libc::c_void,
                BUF_SIZE,
                libc::FSOPT_PACK_INVAL_ATTRS as u64,
            )
        };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        if count == 0 {
            break;
        }
        // SAFETY: reinterpreting initialised u64s as bytes; u8 has no alignment or
        // validity requirements and the length matches the allocation.
        let bytes = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, BUF_SIZE) };
        let mut offset = 0usize;
        for _ in 0..count {
            let len_bytes = bytes
                .get(offset..offset + 4)
                .ok_or_else(|| bad("buffer overrun"))?;
            let len = u32::from_ne_bytes(len_bytes.try_into().unwrap()) as usize;
            let record = bytes
                .get(offset..offset + len)
                .ok_or_else(|| bad("buffer overrun"))?;
            parse_record(record, &mut entries, &mut fallback_names)?;
            offset += len;
        }
    }

    entries.extend(
        fallback_names
            .iter()
            .filter_map(|n: &Vec<u8>| stat_entry(dir, OsStr::from_bytes(n))),
    );
    Ok(entries)
}

/// Decode one packed record: u32 length, attribute_set_t returned, u32 error,
/// attrreference_t name, u32 objtype, timespec mtime, u32 flags, then for
/// non-directories off_t datalength. With FSOPT_PACK_INVAL_ATTRS every requested
/// common attribute is present (unsupported ones zero-filled); file attributes are
/// omitted for directories.
fn parse_record(
    record: &[u8],
    entries: &mut Vec<Entry>,
    fallback: &mut Vec<Vec<u8>>,
) -> io::Result<()> {
    let mut c = Cursor { record, pos: 4 };
    // attribute_set_t (which attributes are valid). Not needed: invalid common
    // attributes are zero-filled in place, and we detect datalength by position.
    c.take(size_of::<libc::attribute_set_t>())?;
    let error = c.u32()?;

    let name_ref_pos = c.pos;
    let name_off = c.i32()?;
    let name_len = c.u32()? as usize;
    let name_start = usize::try_from(name_ref_pos as i64 + name_off as i64)
        .map_err(|_| bad("bad name offset"))?;
    let name = record
        .get(name_start..name_start + name_len)
        .ok_or_else(|| bad("name out of bounds"))?;
    // attr_length includes the trailing NUL.
    let name = name.strip_suffix(&[0]).unwrap_or(name);

    let objtype = c.u32()?;
    let sec = c.i64()?;
    let nsec = c.i64()?;
    let flags = c.u32()?;
    // File attributes are only packed for non-directories.
    let size = if objtype != VDIR && c.pos + 8 <= record.len() {
        c.i64()?
    } else {
        0
    };

    if error != 0 || (objtype != VREG && objtype != VDIR) {
        // Symlinks, special files, and entries the kernel couldn't fully read.
        fallback.push(name.to_vec());
        return Ok(());
    }

    let display = display_name(OsStr::from_bytes(name));
    let hidden = display.starts_with('.') || flags & UF_HIDDEN != 0;
    let is_dir = objtype == VDIR;
    entries.push(Entry {
        name: display,
        kind: if is_dir {
            EntryKind::Dir
        } else {
            EntryKind::File
        },
        target_is_dir: false,
        size: if is_dir { 0 } else { size.max(0) as u64 },
        mtime: millis(sec, nsec),
        hidden,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::listing::read_listing_portable;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn sorted(mut v: Vec<Entry>) -> Vec<Entry> {
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    #[test]
    fn bulk_matches_portable() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        fs::write(d.join("a.txt"), b"hello").unwrap();
        fs::write(d.join("big.bin"), vec![7u8; 100_000]).unwrap();
        fs::write(d.join(".dotfile"), b"").unwrap();
        fs::create_dir(d.join("sub")).unwrap();
        fs::create_dir(d.join(".hidden-dir")).unwrap();
        symlink(d.join("sub"), d.join("link-dir")).unwrap();
        symlink(d.join("a.txt"), d.join("link-file")).unwrap();
        symlink(d.join("missing"), d.join("broken")).unwrap();
        fs::write(d.join("Cafe\u{301}.txt"), b"nfd").unwrap();
        let secret = d.join("secret");
        fs::write(&secret, b"").unwrap();
        let c = CString::new(secret.as_os_str().as_bytes()).unwrap();
        // SAFETY: valid NUL-terminated path; chflags only reads it.
        assert_eq!(unsafe { libc::chflags(c.as_ptr(), UF_HIDDEN) }, 0);

        let bulk = sorted(read_listing_bulk(d).unwrap());
        let portable = sorted(read_listing_portable(d).unwrap());
        assert_eq!(bulk, portable);
        assert_eq!(bulk.len(), 10);
        assert!(bulk.iter().find(|e| e.name == "secret").unwrap().hidden);
        assert!(bulk.iter().any(|e| e.name == "Caf\u{e9}.txt"));
        assert_eq!(
            bulk.iter().find(|e| e.name == "big.bin").unwrap().size,
            100_000
        );
    }

    #[test]
    fn bulk_handles_many_entries_across_buffers() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..5_000 {
            fs::write(
                tmp.path()
                    .join(format!("file-with-a-longish-name-{i:05}.txt")),
                b"x",
            )
            .unwrap();
        }
        let bulk = sorted(read_listing_bulk(tmp.path()).unwrap());
        assert_eq!(bulk, sorted(read_listing_portable(tmp.path()).unwrap()));
        assert_eq!(bulk.len(), 5_000);
    }

    #[test]
    fn bulk_errors_on_missing_dir() {
        assert!(read_listing_bulk(Path::new("/definitely/not/here")).is_err());
    }

    #[test]
    fn millis_truncates_toward_zero() {
        assert_eq!(millis(1, 999_999_999), 1_999);
        assert_eq!(millis(-2, 500_000_000), -1_500);
    }
}
