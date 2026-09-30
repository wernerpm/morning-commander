//! Time directory listing (fast path vs portable readdir+lstat) and JSON encoding.
//! Usage: cargo run --release --example bench_listing -- <dir> [runs] [--fast-only]
//!
//! Prints every run of the fast path (the first one is the cold one when the directory
//! hasn't been listed since mounting), the median of each implementation, and the JSON
//! size. The fast path runs first so a cold first run isn't warmed by the portable one;
//! `--fast-only` skips the portable implementation entirely.

use std::path::Path;
use std::time::{Duration, Instant};

use morning_commander_lib::listing::{read_listing, read_listing_portable};
use morning_commander_lib::model::Entry;

fn timed(f: impl Fn() -> Vec<Entry>, runs: usize) -> (Vec<Duration>, Vec<Entry>) {
    let mut times = Vec::new();
    let mut last = Vec::new();
    for _ in 0..runs {
        let t = Instant::now();
        last = f();
        times.push(t.elapsed());
    }
    (times, last)
}

fn median(times: &[Duration]) -> Duration {
    let mut t = times.to_vec();
    t.sort();
    t[t.len() / 2]
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let fast_only = args.iter().any(|a| a == "--fast-only");
    let mut positional = args.iter().filter(|a| !a.starts_with("--"));
    let dir = positional
        .next()
        .expect("usage: bench_listing <dir> [runs] [--fast-only]");
    let runs: usize = positional
        .next()
        .and_then(|r| r.parse().ok())
        .unwrap_or(3)
        .max(1);
    let dir = Path::new(dir);

    let (fast, entries) = timed(|| read_listing(dir).unwrap(), runs);
    println!("read_listing runs: {fast:?}");
    let portable = (!fast_only).then(|| median(&timed(|| read_listing_portable(dir).unwrap(), runs).0));
    let t = Instant::now();
    let json = serde_json::to_string(&entries).unwrap();
    println!(
        "{} entries: read_listing median {:?}, portable median {:?}, json {:?} ({} KB)",
        entries.len(),
        median(&fast),
        portable,
        t.elapsed(),
        json.len() / 1024
    );
}
