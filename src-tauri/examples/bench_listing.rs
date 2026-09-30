//! Time directory listing (fast path vs portable readdir+lstat) and JSON encoding.
//! Usage: cargo run --release --example bench_listing -- /tmp/mc-big [runs]
//! Prints the median of `runs` (default 3) for each implementation.

use std::path::Path;
use std::time::{Duration, Instant};

use morning_commander_lib::listing::{read_listing, read_listing_portable};
use morning_commander_lib::model::Entry;

fn median(f: impl Fn() -> Vec<Entry>, runs: usize) -> (Duration, Vec<Entry>) {
    let mut times = Vec::new();
    let mut last = Vec::new();
    for _ in 0..runs {
        let t = Instant::now();
        last = f();
        times.push(t.elapsed());
    }
    times.sort();
    (times[runs / 2], last)
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: bench_listing <dir> [runs]");
    let runs: usize = std::env::args()
        .nth(2)
        .and_then(|r| r.parse().ok())
        .unwrap_or(3);
    let dir = Path::new(&dir);

    let (portable, _) = median(|| read_listing_portable(dir).unwrap(), runs);
    let (fast, entries) = median(|| read_listing(dir).unwrap(), runs);
    let t = Instant::now();
    let json = serde_json::to_string(&entries).unwrap();
    println!(
        "{} entries: read_listing {:?}, portable {:?}, json {:?} ({} KB)",
        entries.len(),
        fast,
        portable,
        t.elapsed(),
        json.len() / 1024
    );
}
