//! The `media://` URL scheme the viewer plays video and audio from, with read-ahead
//! for files on network volumes. See `docs/implementation-plan/step-12-video-playback.md`.
//!
//! `media://localhost/<percent-encoded absolute path>` answers range requests (at most
//! [`MAX_RESPONSE`] bytes each, which players handle like any short `206`).
//!
//! - Local files are read directly.
//! - Network files go through a [`Spool`]: a sparse file under `~/.morning-commander/media/`
//!   plus a bitmap of the [`BLOCK`]-sized blocks it holds. A reader thread copies missing
//!   blocks from the source, sequentially from the latest requested position up to the
//!   read-ahead limit, so playback keeps going through slow or stalled SMB reads. A request
//!   for blocks that aren't spooled yet reads them from the source itself, so seeking never
//!   waits behind read-ahead. Blocks far behind the playhead are released (`F_PUNCHHOLE`)
//!   so the spool stays bounded.
//! - One spool at a time: requesting another file, [`Media::close`] or dropping [`Media`]
//!   deletes it; leftovers from a crash are removed by [`Media::new`].

use std::fs::{self, File};
use std::io;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde::Serialize;

use crate::netvol;

/// Spool granularity.
pub const BLOCK: u64 = 1 << 20;
/// Largest body of one response.
pub const MAX_RESPONSE: u64 = 4 << 20;
/// Blocks the reader thread fetches per source read (SMB likes large sequential reads).
const READ_RUN_BLOCKS: u64 = 4;
/// Spooled data kept behind the playhead, so seeking back a little is instant.
const KEEP_BEHIND: u64 = 256 << 20;
/// Default read-ahead (preference `mediaReadAheadBytes`).
pub const DEFAULT_READ_AHEAD: u64 = 1 << 30;
/// How long a request waits for blocks the reader thread is fetching before reading
/// them itself.
const PENDING_WAIT: Duration = Duration::from_secs(5);
/// Pause after a failed source read before the reader thread retries.
const RETRY_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    /// File size in bytes.
    pub size: u64,
    /// Bytes held in the spool (0 for local files).
    pub cached: u64,
    /// Bytes spooled contiguously from the latest requested position (the read-ahead
    /// buffer); for local files, everything after it.
    pub ahead: u64,
    /// The file is read through a spool.
    pub network: bool,
}

/// Parse a `Range` header against a file of `size` bytes into `[start, end)`.
/// No header means the whole file. `None` means unsatisfiable (416).
pub fn parse_range(header: Option<&str>, size: u64) -> Option<(u64, u64)> {
    let Some(h) = header else {
        return (size > 0).then_some((0, size));
    };
    let spec = h.trim().strip_prefix("bytes=")?;
    // Only the first range of a multi-range request is honoured.
    let spec = spec.split(',').next().unwrap_or("").trim();
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    let (start, end) = if a.is_empty() {
        // Suffix range: the last N bytes.
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        (size.saturating_sub(n), size)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() {
            size
        } else {
            let last: u64 = b.parse().ok()?;
            if last < start {
                return None;
            }
            last.saturating_add(1).min(size)
        };
        (start, end)
    };
    if start >= size || start >= end {
        return None;
    }
    Some((start, end))
}

/// Decode the path from a `media://` request's URI path (`/<percent-encoded path>`).
pub fn decode_path(uri_path: &str) -> Option<PathBuf> {
    let raw = uri_path.strip_prefix('/').unwrap_or(uri_path);
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    let p = PathBuf::from(decoded.as_ref());
    p.is_absolute().then_some(p)
}

/// Content type by extension, for `<video>`/`<audio>`; `fetch` readers don't care.
pub fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "ts" | "m2ts" | "mts" => "video/mp2t",
        "mpg" | "mpeg" | "vob" => "video/mpeg",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "aiff" => "audio/aiff",
        "ogg" | "opus" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

/// Body and range of a successful read.
pub struct Chunk {
    pub start: u64,
    pub size: u64,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub enum ServeError {
    NotFound(io::Error),
    Unsatisfiable { size: u64 },
    Io(io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Block {
    Missing,
    /// Being read from the source (by the reader thread or a request).
    Pending,
    Have,
}

struct SpoolState {
    blocks: Vec<Block>,
    /// Latest requested byte position: read-ahead starts here.
    head: u64,
}

impl SpoolState {
    fn set(&mut self, range: std::ops::Range<u64>, from: Block, to: Block) {
        for b in range {
            if self.blocks[b as usize] == from {
                self.blocks[b as usize] = to;
            }
        }
    }
}

/// Read-ahead copy of one network file. See the module docs.
pub struct Spool {
    src_path: PathBuf,
    size: u64,
    src: File,
    spool: File,
    spool_path: PathBuf,
    read_ahead: u64,
    state: Mutex<SpoolState>,
    wake: Condvar,
    stop: AtomicBool,
    /// Bytes read from the source (tests and diagnostics).
    source_reads: AtomicU64,
}

impl Spool {
    fn create(src_path: &Path, spool_path: PathBuf, read_ahead: u64) -> io::Result<Arc<Self>> {
        let src = File::open(src_path)?;
        let meta = src.metadata()?;
        if !meta.is_file() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a file"));
        }
        let size = meta.len();
        let spool = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&spool_path)?;
        spool.set_len(size)?; // sparse until written
        let blocks = size.div_ceil(BLOCK) as usize;
        let s = Arc::new(Spool {
            src_path: src_path.to_path_buf(),
            size,
            src,
            spool,
            spool_path,
            read_ahead,
            state: Mutex::new(SpoolState {
                blocks: vec![Block::Missing; blocks],
                head: 0,
            }),
            wake: Condvar::new(),
            stop: AtomicBool::new(false),
            source_reads: AtomicU64::new(0),
        });
        let weak = Arc::downgrade(&s);
        thread::Builder::new()
            .name("mc-media-spool".into())
            .spawn(move || reader_loop(weak))?;
        Ok(s)
    }

    fn block_len(&self, b: u64) -> u64 {
        (self.size - b * BLOCK).min(BLOCK)
    }

    /// Read whole blocks `[first, last)` from the source.
    fn read_source(&self, first: u64, last: u64) -> io::Result<Vec<u8>> {
        let (a, z) = (first * BLOCK, (last * BLOCK).min(self.size));
        let mut buf = vec![0; (z - a) as usize];
        self.src.read_exact_at(&mut buf, a)?;
        self.source_reads.fetch_add(z - a, Ordering::Relaxed);
        Ok(buf)
    }

    /// Read `[start, end)` and move the read-ahead there. Spooled blocks come from the
    /// spool; blocks the reader thread is fetching are waited for (up to
    /// [`PENDING_WAIT`]); missing ones are read from the source and spooled.
    fn read(&self, start: u64, end: u64) -> io::Result<Vec<u8>> {
        let (b0, b1) = (start / BLOCK, end.div_ceil(BLOCK));
        let deadline = Instant::now() + PENDING_WAIT;
        let mut st = self.state.lock();
        st.head = start;
        self.wake.notify_all();
        loop {
            let range = &st.blocks[b0 as usize..b1 as usize];
            if range.iter().all(|&b| b == Block::Have) {
                // Read under the lock so the blocks can't be released meanwhile.
                let mut buf = vec![0; (end - start) as usize];
                self.spool.read_exact_at(&mut buf, start)?;
                return Ok(buf);
            }
            let missing = range.iter().position(|&b| b == Block::Missing);
            let (first, last) = match missing {
                Some(i) => {
                    let j = range
                        .iter()
                        .rposition(|&b| b == Block::Missing)
                        .unwrap_or(i);
                    (b0 + i as u64, b0 + j as u64 + 1)
                }
                // Only blocks in flight: wait for them, then read them ourselves.
                None if Instant::now() < deadline => {
                    self.wake.wait_until(&mut st, deadline);
                    continue;
                }
                None => (b0, b1),
            };
            st.set(first..last, Block::Missing, Block::Pending);
            drop(st);
            let data = match self.read_source(first, last) {
                Ok(d) => d,
                Err(e) => {
                    self.state
                        .lock()
                        .set(first..last, Block::Pending, Block::Missing);
                    self.wake.notify_all();
                    return Err(e);
                }
            };
            self.store(first, &data);
            if first == b0 && last == b1 {
                let off = (start - first * BLOCK) as usize;
                return Ok(data[off..off + (end - start) as usize].to_vec());
            }
            st = self.state.lock();
        }
    }

    /// Write blocks starting at `b0` into the spool and mark them present.
    fn store(&self, b0: u64, data: &[u8]) {
        let n = (data.len() as u64).div_ceil(BLOCK);
        let ok = self.spool.write_all_at(data, b0 * BLOCK);
        let mut st = self.state.lock();
        match ok {
            Ok(()) => {
                for b in b0..b0 + n {
                    st.blocks[b as usize] = Block::Have;
                }
                self.release_behind(&mut st);
            }
            Err(e) => {
                log::warn!("media spool write: {e}");
                st.set(b0..b0 + n, Block::Pending, Block::Missing);
            }
        }
        self.wake.notify_all();
    }

    /// Release spooled blocks more than [`KEEP_BEHIND`] before the head.
    fn release_behind(&self, st: &mut SpoolState) {
        let keep_from = st.head.saturating_sub(KEEP_BEHIND) / BLOCK;
        let mut b = 0;
        while b < keep_from {
            if st.blocks[b as usize] != Block::Have {
                b += 1;
                continue;
            }
            let first = b;
            while b < keep_from && st.blocks[b as usize] == Block::Have {
                st.blocks[b as usize] = Block::Missing;
                b += 1;
            }
            punch_hole(&self.spool, first * BLOCK, (b - first) * BLOCK);
        }
    }

    /// Next run of missing blocks within the read-ahead window, marked pending.
    fn next_job(&self, st: &mut SpoolState) -> Option<(u64, u64)> {
        let blocks = st.blocks.len() as u64;
        let from = st.head / BLOCK;
        let to = (st.head.saturating_add(self.read_ahead))
            .div_ceil(BLOCK)
            .min(blocks);
        let missing = |b: u64| st.blocks[b as usize] == Block::Missing;
        let first = (from..to).find(|&b| missing(b))?;
        let mut last = first + 1;
        while last < to && last - first < READ_RUN_BLOCKS && missing(last) {
            last += 1;
        }
        st.set(first..last, Block::Missing, Block::Pending);
        Some((first, last))
    }

    pub fn status(&self) -> MediaStatus {
        let st = self.state.lock();
        let have = |b: u64| st.blocks[b as usize] == Block::Have;
        let n = st.blocks.len() as u64;
        let mut b = st.head / BLOCK;
        while b < n && have(b) {
            b += 1;
        }
        let cached = (0..n).filter(|&b| have(b)).map(|b| self.block_len(b)).sum();
        MediaStatus {
            size: self.size,
            cached,
            ahead: (b * BLOCK).min(self.size).saturating_sub(st.head),
            network: true,
        }
    }

    fn shutdown(&self) {
        if !self.stop.swap(true, Ordering::SeqCst) {
            self.wake.notify_all();
            let _ = fs::remove_file(&self.spool_path);
        }
    }
}

impl Drop for Spool {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn reader_loop(weak: Weak<Spool>) {
    loop {
        let Some(s) = weak.upgrade() else { return };
        if s.stop.load(Ordering::SeqCst) {
            return;
        }
        let job = {
            let mut st = s.state.lock();
            let job = s.next_job(&mut st);
            if job.is_none() {
                // Wait for a new head (or shutdown); re-check periodically.
                s.wake.wait_for(&mut st, Duration::from_millis(500));
            }
            job
        };
        let Some((first, last)) = job else { continue };
        match s.read_source(first, last) {
            Ok(data) if !s.stop.load(Ordering::SeqCst) => s.store(first, &data),
            Ok(_) => return,
            Err(e) => {
                log::warn!("media read-ahead {}: {e}", s.src_path.display());
                s.state
                    .lock()
                    .set(first..last, Block::Pending, Block::Missing);
                s.wake.notify_all();
                drop(s);
                thread::sleep(RETRY_DELAY);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn punch_hole(f: &File, offset: u64, len: u64) {
    use std::os::fd::AsRawFd;
    let arg = libc::fpunchhole_t {
        fp_flags: 0,
        reserved: 0,
        fp_offset: offset as libc::off_t,
        fp_length: len as libc::off_t,
    };
    // SAFETY: valid fd and a pointer to a properly initialised fpunchhole_t.
    let rc = unsafe { libc::fcntl(f.as_raw_fd(), libc::F_PUNCHHOLE, &arg) };
    if rc != 0 {
        log::debug!("F_PUNCHHOLE: {}", io::Error::last_os_error());
    }
}

#[cfg(not(target_os = "macos"))]
fn punch_hole(_f: &File, _offset: u64, _len: u64) {}

/// Owner of the `media://` scheme's state.
pub struct Media {
    dir: PathBuf,
    force_network: bool,
    read_ahead: u64,
    current: Mutex<Option<Arc<Spool>>>,
    seq: AtomicU64,
}

impl Media {
    /// `dir` holds spool files; it is created (private, excluded from backups) and emptied.
    pub fn new(dir: PathBuf, force_network: bool, read_ahead: u64) -> Self {
        if let Err(e) = crate::fsutil::create_private_dir(&dir) {
            log::warn!("media spool dir {}: {e}", dir.display());
        }
        crate::persist::exclude_from_backup(&dir);
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.flatten() {
                let _ = fs::remove_file(e.path());
            }
        }
        Media {
            dir,
            force_network,
            read_ahead,
            current: Mutex::new(None),
            seq: AtomicU64::new(0),
        }
    }

    fn is_network(&self, path: &Path) -> bool {
        netvol::is_network(path, self.force_network)
    }

    /// The spool for `path`, replacing any other one.
    fn spool(&self, path: &Path) -> io::Result<Arc<Spool>> {
        let mut cur = self.current.lock();
        if let Some(s) = cur.as_ref().filter(|s| s.src_path == path) {
            return Ok(s.clone());
        }
        if let Some(old) = cur.take() {
            old.shutdown();
        }
        let n = self.seq.fetch_add(1, Ordering::Relaxed);
        let spool_path = self
            .dir
            .join(format!("spool-{}-{n}.bin", std::process::id()));
        let s = Spool::create(path, spool_path, self.read_ahead)?;
        *cur = Some(s.clone());
        Ok(s)
    }

    /// Answer a range request for `path`.
    pub fn serve(&self, path: &Path, range: Option<&str>) -> Result<Chunk, ServeError> {
        if self.is_network(path) {
            let s = self.spool(path).map_err(ServeError::NotFound)?;
            let size = s.size;
            let (start, end) =
                parse_range(range, size).ok_or(ServeError::Unsatisfiable { size })?;
            let end = end.min(start + MAX_RESPONSE);
            let data = s.read(start, end).map_err(ServeError::Io)?;
            return Ok(Chunk { start, size, data });
        }
        let f = File::open(path).map_err(ServeError::NotFound)?;
        let size = f.metadata().map_err(ServeError::NotFound)?.len();
        let (start, end) = parse_range(range, size).ok_or(ServeError::Unsatisfiable { size })?;
        let end = end.min(start + MAX_RESPONSE);
        let mut data = vec![0; (end - start) as usize];
        f.read_exact_at(&mut data, start).map_err(ServeError::Io)?;
        Ok(Chunk { start, size, data })
    }

    /// Buffer state for `path`; local files report everything as available.
    pub fn status(&self, path: &Path) -> Result<MediaStatus, String> {
        if let Some(s) = self.current.lock().as_ref().filter(|s| s.src_path == path) {
            return Ok(s.status());
        }
        let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
        let network = self.is_network(path);
        Ok(MediaStatus {
            size,
            cached: 0,
            ahead: if network { 0 } else { size },
            network,
        })
    }

    /// Stop read-ahead and delete the spool (viewer closed).
    pub fn close(&self) {
        if let Some(s) = self.current.lock().take() {
            s.shutdown();
        }
    }

    /// [`Media::close`], but only if the spool is for `path`: the viewer closes the file
    /// it was showing, which must not stop the next file's spool.
    pub fn close_path(&self, path: &Path) {
        let mut cur = self.current.lock();
        if cur.as_ref().is_some_and(|s| s.src_path == path)
            && let Some(s) = cur.take()
        {
            s.shutdown();
        }
    }
}

impl Drop for Media {
    fn drop(&mut self) {
        self.close();
    }
}

/// Build the HTTP response for a `media://` request.
pub fn respond(
    media: &Media,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{Method, Response, StatusCode, header};

    let cors = |b: tauri::http::response::Builder| {
        b.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
            .header(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "Content-Range, Content-Length, Accept-Ranges",
            )
    };
    let error = |status: StatusCode, msg: String| {
        cors(Response::builder().status(status))
            .header(header::CONTENT_TYPE, "text/plain")
            .body(msg.into_bytes())
            .unwrap_or_default()
    };

    if request.method() == Method::OPTIONS {
        return cors(Response::builder().status(StatusCode::NO_CONTENT))
            .body(Vec::new())
            .unwrap_or_default();
    }
    let Some(path) = decode_path(request.uri().path()) else {
        return error(StatusCode::BAD_REQUEST, "bad path".into());
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    match media.serve(&path, range) {
        Ok(c) => {
            let end = c.start + c.data.len() as u64; // exclusive
            let b = cors(Response::builder().status(StatusCode::PARTIAL_CONTENT))
                .header(header::CONTENT_TYPE, content_type(&path))
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_LENGTH, c.data.len())
                .header(
                    header::CONTENT_RANGE,
                    format!("bytes {}-{}/{}", c.start, end.saturating_sub(1), c.size),
                );
            if request.method() == Method::HEAD {
                b.body(Vec::new()).unwrap_or_default()
            } else {
                b.body(c.data).unwrap_or_default()
            }
        }
        Err(ServeError::Unsatisfiable { size }) => {
            cors(Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE))
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Vec::new())
                .unwrap_or_default()
        }
        Err(ServeError::NotFound(e)) => error(StatusCode::NOT_FOUND, e.to_string()),
        Err(ServeError::Io(e)) => error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parse_range_forms() {
        assert_eq!(parse_range(None, 100), Some((0, 100)));
        assert_eq!(parse_range(Some("bytes=0-0"), 100), Some((0, 1)));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Some((10, 20)));
        assert_eq!(parse_range(Some("bytes=90-"), 100), Some((90, 100)));
        assert_eq!(parse_range(Some("bytes=90-500"), 100), Some((90, 100)));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Some((90, 100)));
        assert_eq!(parse_range(Some("bytes=-500"), 100), Some((0, 100)));
        assert_eq!(parse_range(Some("bytes=0-9, 20-29"), 100), Some((0, 10)));
        assert_eq!(parse_range(Some("bytes=100-"), 100), None);
        assert_eq!(parse_range(Some("bytes=20-10"), 100), None);
        assert_eq!(parse_range(Some("bytes=-0"), 100), None);
        assert_eq!(parse_range(Some("items=0-1"), 100), None);
        assert_eq!(parse_range(None, 0), None);
    }

    #[test]
    fn decode_path_roundtrip() {
        assert_eq!(
            decode_path("/%2FVolumes%2Fshare%2Fa%20b%20%C3%A9.mkv"),
            Some(PathBuf::from("/Volumes/share/a b é.mkv"))
        );
        assert_eq!(decode_path("/relative"), None);
    }

    /// A file whose byte at offset i is (i % 251), so any range can be checked.
    fn pattern_file(dir: &Path, len: u64) -> PathBuf {
        let p = dir.join("video.mkv");
        let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        File::create(&p).unwrap().write_all(&data).unwrap();
        p
    }

    fn check(data: &[u8], start: u64) {
        for (i, b) in data.iter().enumerate() {
            assert_eq!(
                *b,
                ((start + i as u64) % 251) as u8,
                "byte {}",
                start + i as u64
            );
        }
    }

    fn wait_until(mut f: impl FnMut() -> bool) {
        let t = Instant::now();
        while !f() {
            assert!(t.elapsed() < Duration::from_secs(10), "timed out");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn local_files_are_served_directly() {
        let tmp = tempfile::tempdir().unwrap();
        let src = pattern_file(tmp.path(), 3 * BLOCK + 17);
        let m = Media::new(tmp.path().join("spool"), false, DEFAULT_READ_AHEAD);
        let c = m.serve(&src, Some("bytes=1000-1999")).unwrap();
        assert_eq!(
            (c.start, c.size, c.data.len()),
            (1000, 3 * BLOCK + 17, 1000)
        );
        check(&c.data, 1000);
        // Unbounded ranges are capped.
        let c = m.serve(&src, Some("bytes=0-")).unwrap();
        assert_eq!(c.data.len() as u64, (3 * BLOCK + 17).min(MAX_RESPONSE));
        assert!(m.current.lock().is_none());
        assert_eq!(m.status(&src).unwrap().ahead, 3 * BLOCK + 17);
    }

    #[test]
    fn network_files_read_ahead_and_spool() {
        let tmp = tempfile::tempdir().unwrap();
        let len = 10 * BLOCK + 123;
        let src = pattern_file(tmp.path(), len);
        let spool_dir = tmp.path().join("spool");
        // Window of 6.5 blocks: rounds up to 7 for any head inside block 0.
        let m = Media::new(spool_dir.clone(), true, 6 * BLOCK + BLOCK / 2);

        let c = m.serve(&src, Some("bytes=0-99")).unwrap();
        check(&c.data, 0);
        let s = m.current.lock().clone().unwrap();
        // Read-ahead fills the window and stops there.
        wait_until(|| s.status().ahead >= 7 * BLOCK);
        thread::sleep(Duration::from_millis(100));
        let st = s.status();
        assert_eq!(st.cached, 7 * BLOCK);
        assert!(st.network);

        // A spooled range is served without touching the source.
        let before = s.source_reads.load(Ordering::Relaxed);
        let c = m.serve(&src, Some("bytes=1000-2100000")).unwrap();
        check(&c.data, 1000);
        assert_eq!(s.source_reads.load(Ordering::Relaxed), before);

        // Seeking past the window reads directly and moves the read-ahead there.
        let c = m
            .serve(&src, Some(&format!("bytes={}-", 9 * BLOCK + 5)))
            .unwrap();
        assert_eq!(c.data.len() as u64, len - 9 * BLOCK - 5);
        check(&c.data, 9 * BLOCK + 5);
        wait_until(|| s.status().ahead == len - (9 * BLOCK + 5));

        // Closing another path leaves the spool alone; closing this one removes it.
        assert_eq!(fs::read_dir(&spool_dir).unwrap().count(), 1);
        m.close_path(&tmp.path().join("other.mkv"));
        assert!(m.current.lock().is_some());
        m.close_path(&src);
        assert_eq!(fs::read_dir(&spool_dir).unwrap().count(), 0);
        assert_eq!(m.status(&src).unwrap().cached, 0);
    }

    #[test]
    fn requests_and_read_ahead_never_read_a_block_twice() {
        let tmp = tempfile::tempdir().unwrap();
        let len = 40 * BLOCK + 7;
        let src = pattern_file(tmp.path(), len);
        let m = Media::new(tmp.path().join("spool"), true, DEFAULT_READ_AHEAD);
        // A player reading sequentially in small pieces while read-ahead runs.
        let mut pos = 0;
        while pos < len {
            let c = m
                .serve(&src, Some(&format!("bytes={pos}-{}", pos + 300_000)))
                .unwrap();
            check(&c.data, pos);
            pos += c.data.len() as u64;
        }
        let s = m.current.lock().clone().unwrap();
        wait_until(|| s.status().cached == len);
        assert_eq!(s.source_reads.load(Ordering::Relaxed), len);
    }

    #[test]
    fn blocks_far_behind_the_head_are_released() {
        let tmp = tempfile::tempdir().unwrap();
        let len = KEEP_BEHIND + 8 * BLOCK;
        let src = tmp.path().join("big.mkv");
        let f = File::create(&src).unwrap();
        f.set_len(len).unwrap(); // sparse source: zeros
        let m = Media::new(tmp.path().join("spool"), true, 2 * BLOCK);
        m.serve(&src, Some("bytes=0-0")).unwrap();
        let s = m.current.lock().clone().unwrap();
        wait_until(|| s.status().cached >= 2 * BLOCK);
        // Jump far ahead: the first blocks are now more than KEEP_BEHIND behind.
        m.serve(&src, Some(&format!("bytes={}-", KEEP_BEHIND + 4 * BLOCK)))
            .unwrap();
        wait_until(|| {
            let st = s.state.lock();
            st.blocks[0] == Block::Missing && st.blocks[1] == Block::Missing
        });
    }

    #[test]
    fn unsatisfiable_and_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let src = pattern_file(tmp.path(), 10);
        let m = Media::new(tmp.path().join("spool"), false, DEFAULT_READ_AHEAD);
        assert!(matches!(
            m.serve(&src, Some("bytes=10-")),
            Err(ServeError::Unsatisfiable { size: 10 })
        ));
        assert!(matches!(
            m.serve(&tmp.path().join("nope.mkv"), None),
            Err(ServeError::NotFound(_))
        ));
    }

    #[test]
    fn leftover_spools_are_removed_at_startup() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("spool");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("spool-1-0.bin"), b"x").unwrap();
        let _m = Media::new(dir.clone(), false, DEFAULT_READ_AHEAD);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }
}
