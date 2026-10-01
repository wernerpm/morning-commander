//! `preferences.json` and `state.json` under the app home (`~/.morning-commander`, or
//! `$MC_HOME`). See "Preferences and state" in `docs/ipc.md`.
//!
//! Both documents are kept as JSON objects (`serde_json::Value`) so unknown fields
//! survive a round trip. Changes arrive as RFC 7386 merge patches.
//! - Preferences are written immediately on every change.
//! - State is written after [`STATE_DEBOUNCE`] of quiet by a background thread, and by
//!   [`Settings::flush`] on exit.
//! - A corrupt (or non-object) file is renamed to `<name>.corrupt` and treated as `{}`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::{Map, Value};

use crate::fsutil::{create_private_dir, write_atomic};

pub const PREFS_FILE: &str = "preferences.json";
pub const STATE_FILE: &str = "state.json";

/// Quiet period before a changed `state.json` is written.
pub const STATE_DEBOUNCE: Duration = Duration::from_millis(500);

pub const DEFAULT_VIDEO_VOLUME: f64 = 0.8;
pub const DEFAULT_CACHE_MAX_BYTES: u64 = 100 * 1024 * 1024;
pub const DEFAULT_CACHE_MAX_AGE_DAYS: u64 = 180;

/// The app's home directory: `$MC_HOME` if set, else `~/.morning-commander`.
pub fn app_home() -> PathBuf {
    match std::env::var_os("MC_HOME") {
        Some(h) if !h.is_empty() => PathBuf::from(h),
        _ => crate::listing::home_dir().join(".morning-commander"),
    }
}

/// RFC 7386 JSON merge patch: objects merge recursively, `null` deletes a key, anything
/// else (arrays, scalars, or a non-object patch) replaces the target.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let Value::Object(map) = target else {
        unreachable!()
    };
    for (key, value) in patch {
        if value.is_null() {
            map.remove(key);
        } else {
            merge_patch(map.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

/// Read a JSON object from `path`. Missing → `{}`. Corrupt or not an object → the file is
/// renamed to `<name>.corrupt` and `{}` is returned. Never fails.
fn load_object(path: &Path) -> Value {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return empty(),
        Err(e) => {
            log::warn!("cannot read {}: {e}; using defaults", path.display());
            return empty();
        }
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v @ Value::Object(_)) => v,
        other => {
            let why = match other {
                Err(e) => e.to_string(),
                Ok(_) => "not a JSON object".into(),
            };
            let mut corrupt = path.as_os_str().to_owned();
            corrupt.push(".corrupt");
            log::warn!(
                "{} is unreadable ({why}); moved to {} and starting empty",
                path.display(),
                Path::new(&corrupt).display()
            );
            if let Err(e) = std::fs::rename(path, &corrupt) {
                log::warn!("cannot move {} aside: {e}", path.display());
            }
            empty()
        }
    }
}

fn empty() -> Value {
    Value::Object(Map::new())
}

fn write_object(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        create_private_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    write_atomic(path, &bytes, true).map_err(|e| format!("{}: {e}", path.display()))
}

struct StateDoc {
    value: Value,
    dirty: bool,
    changed_at: Instant,
}

struct StateShared {
    path: PathBuf,
    doc: Mutex<StateDoc>,
    wake: Condvar,
    /// Serialises writes of `state.json` (background writer vs. `flush`).
    write_lock: Mutex<()>,
}

impl StateShared {
    /// Write the current state if it has unsaved changes.
    fn write_if_dirty(&self) {
        let _w = self.write_lock.lock();
        let value = {
            let mut d = self.doc.lock();
            if !d.dirty {
                return;
            }
            d.dirty = false;
            d.value.clone()
        };
        if let Err(e) = write_object(&self.path, &value) {
            log::warn!("cannot save state: {e}");
        }
    }
}

/// Preferences and session state, managed as Tauri state.
pub struct Settings {
    prefs_path: PathBuf,
    prefs: Mutex<Value>,
    state: Arc<StateShared>,
}

impl Settings {
    /// Load both files from `home` (missing or corrupt files start empty) and start the
    /// debounced state writer.
    pub fn load(home: &Path) -> Arc<Self> {
        let prefs_path = home.join(PREFS_FILE);
        let state_path = home.join(STATE_FILE);
        let prefs = load_object(&prefs_path);
        let state = Arc::new(StateShared {
            doc: Mutex::new(StateDoc {
                value: load_object(&state_path),
                dirty: false,
                changed_at: Instant::now(),
            }),
            path: state_path,
            wake: Condvar::new(),
            write_lock: Mutex::new(()),
        });
        let weak = Arc::downgrade(&state);
        if let Err(e) = thread::Builder::new()
            .name("mc-state-writer".into())
            .spawn(move || state_writer(weak))
        {
            log::warn!("cannot start state writer: {e}; state is saved on exit only");
        }
        Arc::new(Settings {
            prefs_path,
            prefs: Mutex::new(prefs),
            state,
        })
    }

    /// Preferences with defaults filled in for missing known keys.
    pub fn prefs_get(&self) -> Value {
        with_defaults(self.prefs.lock().clone())
    }

    /// Merge `patch` into the preferences, write them, and return the result (defaults
    /// filled in).
    pub fn prefs_set(&self, patch: &Value) -> Result<Value, String> {
        if !patch.is_object() {
            return Err("preferences patch must be a JSON object".into());
        }
        let mut prefs = self.prefs.lock();
        let mut next = prefs.clone();
        merge_patch(&mut next, patch);
        // Written under the lock so concurrent patches reach the file in order; the file
        // is small and local.
        write_object(&self.prefs_path, &next)?;
        *prefs = next.clone();
        Ok(with_defaults(next))
    }

    pub fn state_get(&self) -> Value {
        self.state.doc.lock().value.clone()
    }

    /// Merge `patch` into the state; the file is written after a quiet period.
    pub fn state_set(&self, patch: &Value) -> Result<(), String> {
        if !patch.is_object() {
            return Err("state patch must be a JSON object".into());
        }
        let mut d = self.state.doc.lock();
        merge_patch(&mut d.value, patch);
        d.dirty = true;
        d.changed_at = Instant::now();
        self.state.wake.notify_one();
        Ok(())
    }

    /// Write pending state now (app exit).
    pub fn flush(&self) {
        self.state.write_if_dirty();
    }

    pub fn cache_max_bytes(&self) -> u64 {
        positive_u64(&self.prefs.lock(), "cacheMaxBytes").unwrap_or(DEFAULT_CACHE_MAX_BYTES)
    }

    pub fn media_read_ahead_bytes(&self) -> u64 {
        positive_u64(&self.prefs.lock(), "mediaReadAheadBytes")
            .unwrap_or(crate::media::DEFAULT_READ_AHEAD)
    }

    pub fn cache_max_age_days(&self) -> u64 {
        positive_u64(&self.prefs.lock(), "cacheMaxAgeDays").unwrap_or(DEFAULT_CACHE_MAX_AGE_DAYS)
    }
}

fn positive_u64(prefs: &Value, key: &str) -> Option<u64> {
    let v = prefs.get(key)?;
    v.as_u64()
        .or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f as u64))
        .filter(|n| *n > 0)
}

fn with_defaults(mut prefs: Value) -> Value {
    if let Value::Object(map) = &mut prefs {
        map.entry("videoVolume")
            .or_insert_with(|| DEFAULT_VIDEO_VOLUME.into());
        map.entry("cacheMaxBytes")
            .or_insert_with(|| DEFAULT_CACHE_MAX_BYTES.into());
        map.entry("cacheMaxAgeDays")
            .or_insert_with(|| DEFAULT_CACHE_MAX_AGE_DAYS.into());
        map.entry("mediaReadAheadBytes")
            .or_insert_with(|| crate::media::DEFAULT_READ_AHEAD.into());
    }
    prefs
}

/// Background writer: waits for a change, then for [`STATE_DEBOUNCE`] without further
/// changes, then writes. Exits once the settings are dropped.
fn state_writer(weak: Weak<StateShared>) {
    loop {
        let Some(shared) = weak.upgrade() else { return };
        let due = {
            let mut d = shared.doc.lock();
            if !d.dirty {
                // Time out now and then so the thread notices when `Settings` is gone.
                shared.wake.wait_for(&mut d, Duration::from_secs(1));
            }
            d.dirty && d.changed_at.elapsed() >= STATE_DEBOUNCE
        };
        if due {
            shared.write_if_dirty();
            continue;
        }
        let wait = {
            let d = shared.doc.lock();
            if !d.dirty {
                continue;
            }
            STATE_DEBOUNCE.saturating_sub(d.changed_at.elapsed())
        };
        drop(shared);
        thread::sleep(wait.max(Duration::from_millis(10)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn patched(target: Value, patch: Value) -> Value {
        let mut t = target;
        merge_patch(&mut t, &patch);
        t
    }

    #[test]
    fn merge_patch_follows_rfc_7386() {
        // Examples from RFC 7386 appendix A.
        assert_eq!(
            patched(json!({"a":"b"}), json!({"a":"c"})),
            json!({"a":"c"})
        );
        assert_eq!(
            patched(json!({"a":"b"}), json!({"b":"c"})),
            json!({"a":"b","b":"c"})
        );
        assert_eq!(patched(json!({"a":"b"}), json!({"a":null})), json!({}));
        assert_eq!(
            patched(json!({"a":"b","b":"c"}), json!({"a":null})),
            json!({"b":"c"})
        );
        assert_eq!(
            patched(json!({"a":["b"]}), json!({"a":"c"})),
            json!({"a":"c"})
        );
        assert_eq!(
            patched(json!({"a":"c"}), json!({"a":["b"]})),
            json!({"a":["b"]})
        );
        assert_eq!(
            patched(json!({"a":{"b":"c"}}), json!({"a":{"b":"d","c":null}})),
            json!({"a":{"b":"d"}})
        );
        assert_eq!(
            patched(json!({"a":[{"b":"c"}]}), json!({"a":[1]})),
            json!({"a":[1]})
        );
        assert_eq!(
            patched(json!(["a", "b"]), json!(["c", "d"])),
            json!(["c", "d"])
        );
        assert_eq!(patched(json!({"a":"b"}), json!(["c"])), json!(["c"]));
        assert_eq!(patched(json!({"a":"foo"}), json!(null)), json!(null));
        assert_eq!(patched(json!({"a":"foo"}), json!("bar")), json!("bar"));
        assert_eq!(
            patched(json!({"e":null}), json!({"a":1})),
            json!({"e":null,"a":1})
        );
        assert_eq!(
            patched(json!([1, 2]), json!({"a":"b","c":null})),
            json!({"a":"b"})
        );
        assert_eq!(
            patched(json!({}), json!({"a":{"bb":{"ccc":null}}})),
            json!({"a":{"bb":{}}})
        );
        // Sibling panels are left alone.
        assert_eq!(
            patched(
                json!({"panels":{"0":{"path":"/a"},"1":{"path":"/b"}}}),
                json!({"panels":{"1":{"path":"/c"}}})
            ),
            json!({"panels":{"0":{"path":"/a"},"1":{"path":"/c"}}})
        );
    }

    #[test]
    fn prefs_defaults_are_filled_but_not_stored() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Settings::load(tmp.path());
        let p = s.prefs_get();
        assert_eq!(p["videoVolume"], json!(0.8));
        assert_eq!(p["cacheMaxBytes"], json!(104857600));
        assert_eq!(p["cacheMaxAgeDays"], json!(180));
        assert_eq!(s.cache_max_bytes(), DEFAULT_CACHE_MAX_BYTES);

        let out = s.prefs_set(&json!({"videoVolume": 0.5})).unwrap();
        assert_eq!(out["videoVolume"], json!(0.5));
        assert_eq!(out["cacheMaxAgeDays"], json!(180));
        let file: Value =
            serde_json::from_slice(&fs::read(tmp.path().join(PREFS_FILE)).unwrap()).unwrap();
        assert_eq!(file, json!({"videoVolume": 0.5}));
        let mode = fs::metadata(tmp.path().join(PREFS_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);

        s.prefs_set(&json!({"cacheMaxBytes": 1000, "cacheMaxAgeDays": 7}))
            .unwrap();
        assert_eq!(s.cache_max_bytes(), 1000);
        assert_eq!(s.cache_max_age_days(), 7);
        assert!(s.prefs_set(&json!([1])).is_err());
    }

    #[test]
    fn unknown_fields_are_preserved() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            tmp.path().join(PREFS_FILE),
            br#"{"future":{"x":[1,2]},"videoVolume":0.3}"#,
        )
        .unwrap();
        let s = Settings::load(tmp.path());
        s.prefs_set(&json!({"bookmarks":[{"name":"Home","path":"/Users/demo"}]}))
            .unwrap();
        drop(s);
        let s = Settings::load(tmp.path());
        let p = s.prefs_get();
        assert_eq!(p["future"], json!({"x":[1,2]}));
        assert_eq!(p["videoVolume"], json!(0.3));
        assert_eq!(p["bookmarks"][0]["name"], json!("Home"));
    }

    #[test]
    fn corrupt_files_are_moved_aside() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(PREFS_FILE), b"{ not json").unwrap();
        fs::write(tmp.path().join(STATE_FILE), b"[1,2,3]").unwrap();
        let s = Settings::load(tmp.path());
        assert_eq!(s.state_get(), json!({}));
        assert_eq!(s.prefs_get()["videoVolume"], json!(0.8));
        assert!(!tmp.path().join(PREFS_FILE).exists());
        assert_eq!(
            fs::read(tmp.path().join("preferences.json.corrupt")).unwrap(),
            b"{ not json"
        );
        assert!(tmp.path().join("state.json.corrupt").exists());
    }

    #[test]
    fn state_writes_are_debounced_and_flushed() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let s = Settings::load(&home);
        let file = home.join(STATE_FILE);
        s.state_set(&json!({"panels":{"0":{"path":"/a"}}})).unwrap();
        s.state_set(&json!({"panels":{"1":{"path":"/b"}}})).unwrap();
        assert_eq!(s.state_get()["panels"]["1"]["path"], json!("/b"));
        // Nothing is written right away…
        thread::sleep(Duration::from_millis(150));
        assert!(!file.exists());
        // …but after the quiet period.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !file.exists() {
            assert!(Instant::now() < deadline, "state was never written");
            thread::sleep(Duration::from_millis(50));
        }
        let read = || -> Value { serde_json::from_slice(&fs::read(&file).unwrap()).unwrap() };
        assert_eq!(read()["panels"]["0"]["path"], json!("/a"));

        // flush() writes pending changes immediately.
        s.state_set(&json!({"localStorageMigrated": true})).unwrap();
        s.flush();
        assert_eq!(read()["localStorageMigrated"], json!(true));
        assert_eq!(
            fs::metadata(&home).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
