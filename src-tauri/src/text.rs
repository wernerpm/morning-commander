//! Bounded text reading for the viewer.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::model::TextPreview;

/// Bytes inspected to decide whether a file is binary.
const SNIFF: usize = 8 * 1024;
/// Hard cap regardless of what the frontend asks for.
const MAX_BYTES: u64 = 16 * 1024 * 1024;

pub fn read_text(path: &Path, max_bytes: u64) -> Result<TextPreview, String> {
    let err = |e: std::io::Error| format!("{}: {e}", path.display());
    let file = File::open(path).map_err(err)?;
    let meta = file.metadata().map_err(err)?;
    if meta.is_dir() {
        return Err(format!("{}: is a directory", path.display()));
    }
    let size = meta.len();
    let limit = max_bytes.min(MAX_BYTES);
    let mut buf = Vec::with_capacity(limit.min(size) as usize);
    let mut file = file.take(limit);
    // Sniff first, so a large binary file (a video on the NAS) costs one small read.
    (&mut file)
        .take(SNIFF as u64)
        .read_to_end(&mut buf)
        .map_err(err)?;
    if is_binary(&buf) {
        return Ok(TextPreview {
            text: String::new(),
            truncated: size > buf.len() as u64,
            binary: true,
            size,
        });
    }
    file.read_to_end(&mut buf).map_err(err)?;
    let truncated = size > buf.len() as u64;
    let text = match String::from_utf8(buf) {
        Ok(s) => s,
        Err(e) => {
            let utf8 = e.utf8_error();
            let mut bytes = e.into_bytes();
            if utf8.error_len().is_none() {
                // Only an incomplete sequence at the end (we cut mid-character).
                bytes.truncate(utf8.valid_up_to());
                String::from_utf8(bytes).expect("valid prefix")
            } else {
                String::from_utf8_lossy(&bytes).into_owned()
            }
        }
    };
    Ok(TextPreview {
        text,
        truncated,
        binary: false,
        size,
    })
}

/// NUL bytes, or UTF-8 errors that aren't just a sequence cut off at the end.
fn is_binary(sample: &[u8]) -> bool {
    if sample.contains(&0) {
        return true;
    }
    match std::str::from_utf8(sample) {
        Ok(_) => false,
        Err(e) => e.error_len().is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reads_text_and_truncates_on_char_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.txt");
        fs::write(&p, "héllo wörld").unwrap();
        let full = read_text(&p, 1024).unwrap();
        assert_eq!(full.text, "héllo wörld");
        assert!(!full.truncated && !full.binary);

        // "h" + first byte of "é" → the partial char is dropped.
        let cut = read_text(&p, 2).unwrap();
        assert_eq!(cut.text, "h");
        assert!(cut.truncated);
        assert_eq!(cut.size, "héllo wörld".len() as u64);
    }

    #[test]
    fn detects_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("b.bin");
        fs::write(&p, [0x89, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        let r = read_text(&p, 1024).unwrap();
        assert!(r.binary);
        assert!(r.text.is_empty());

        let latin1 = tmp.path().join("l.txt");
        fs::write(&latin1, [b'c', b'a', b'f', 0xe9, b'!']).unwrap();
        assert!(read_text(&latin1, 1024).unwrap().binary);
    }

    #[test]
    fn rejects_directories() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_text(tmp.path(), 10).is_err());
    }
}
