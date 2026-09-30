//! Time a cold directory listing and its JSON encoding.
//! Usage: cargo run --release --example bench_listing -- /tmp/mc-big

use std::time::Instant;

fn main() {
    let dir = std::env::args().nth(1).expect("usage: bench_listing <dir>");
    let t = Instant::now();
    let entries = morning_commander_lib::listing::read_listing(std::path::Path::new(&dir)).unwrap();
    let listed = t.elapsed();
    let t = Instant::now();
    let json = serde_json::to_string(&entries).unwrap();
    println!(
        "{} entries: list {:?}, json {:?} ({} KB)",
        entries.len(),
        listed,
        t.elapsed(),
        json.len() / 1024
    );
}
