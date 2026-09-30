//! `~/.morning-commander/preferences.json` and `state.json` (see `docs/ipc.md`).
//!
//! Both are plain JSON objects kept in memory and updated with RFC 7386 merge
//! patches. Unknown keys are preserved. Preferences are written immediately;
//! state is written after ~500 ms of quiet and on exit. Writes are atomic
//! (temp file + rename); a corrupt file is moved aside to `*.corrupt`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::listing::home_dir;

const PREFS_FILE: &str = "preferences.json";
const STATE_FILE: &str = "state.json";
const STATE_DEBOUNCE: Duration = Duration::from_millis(500);

/// `$MC_HOME`, or `~/.morning-commander`.
pub fn mc_home() -> PathBuf {
    match std::env::var_os("MC_HOME") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => home_dir().join(".morning-commander"),
    }
}

/// Values `prefs_get` reports for keys the file doesn't set.
fn defaults() -> Map<String, Value> {
    match json!({
        "videoVolume": 0.8,
        "cacheMaxBytes": 100u64 * 1024 * 1024,
        "cacheMaxAgeDays": 180,
    }) {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

/// RFC 7386: objects merge recursively, `null` deletes, everything else replaces.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let map = target.as_object_mut().expect("just made an object");
    for (k, v) in patch {
        if v.is_null() {
            map.remove(k);
        } else {
            merge_patch(map.entry(k.clone()).or_insert(Value::Null), v);
        }
    }
}

/// Read a JSON object file. Missing → empty; unreadable JSON → moved to `*.corrupt`, empty.
fn load(path: &Path) -> Map<String, Value> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("{}: {e}", path.display());
            }
            return Map::new();
        }
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(m)) => m,
        _ => {
            let mut aside = path.as_os_str().to_owned();
            aside.push(".corrupt");
            log::warn!(
                "{} is not a JSON object; moving it to {}",
                path.display(),
                Path::new(&aside).display()
            );
            let _ = fs::rename(path, &aside);
            Map::new()
        }
    }
}

fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir)
}

/// Write `value` to `path` via a temp file in the same directory and a rename.
fn write_atomic(path: &Path, value: &Map<String, Value>) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent directory")?;
    ensure_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let data = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(&data)?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

struct StateInner {
    value: Map<String, Value>,
    /// Bumped on every change; a pending debounced write only runs if it still matches.
    generation: u64,
    dirty: bool,
}

pub struct Prefs {
    dir: PathBuf,
    prefs: Mutex<Map<String, Value>>,
    state: Mutex<StateInner>,
}

impl Prefs {
    /// Load both files from `dir` (usually [`mc_home`]).
    pub fn load(dir: PathBuf) -> Arc<Self> {
        let prefs = load(&dir.join(PREFS_FILE));
        let state = load(&dir.join(STATE_FILE));
        Arc::new(Self {
            dir,
            prefs: Mutex::new(prefs),
            state: Mutex::new(StateInner {
                value: state,
                generation: 0,
                dirty: false,
            }),
        })
    }

    /// Stored preferences with defaults filled in for missing known keys.
    pub fn prefs_get(&self) -> Value {
        let mut out = defaults();
        for (k, v) in self.prefs.lock().iter() {
            out.insert(k.clone(), v.clone());
        }
        Value::Object(out)
    }

    /// Apply a merge patch and write `preferences.json` now.
    pub fn prefs_set(&self, patch: &Value) -> Result<Value, String> {
        if !patch.is_object() {
            return Err("preferences patch must be an object".into());
        }
        {
            let mut prefs = self.prefs.lock();
            let mut v = Value::Object(std::mem::take(&mut *prefs));
            merge_patch(&mut v, patch);
            *prefs = match v {
                Value::Object(m) => m,
                _ => unreachable!(),
            };
            write_atomic(&self.dir.join(PREFS_FILE), &prefs)?;
        }
        Ok(self.prefs_get())
    }

    pub fn state_get(&self) -> Value {
        Value::Object(self.state.lock().value.clone())
    }

    /// Apply a merge patch in memory; `state.json` is written after [`STATE_DEBOUNCE`] of quiet.
    pub fn state_set(self: &Arc<Self>, patch: &Value) -> Result<(), String> {
        if !patch.is_object() {
            return Err("state patch must be an object".into());
        }
        let generation = {
            let mut s = self.state.lock();
            let mut v = Value::Object(std::mem::take(&mut s.value));
            merge_patch(&mut v, patch);
            s.value = match v {
                Value::Object(m) => m,
                _ => unreachable!(),
            };
            s.generation += 1;
            s.dirty = true;
            s.generation
        };
        let this = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(STATE_DEBOUNCE);
            if this.state.lock().generation == generation {
                this.flush_state();
            }
        });
        Ok(())
    }

    /// Write `state.json` now if it has unsaved changes (debounce timer, app exit).
    pub fn flush_state(&self) {
        let mut s = self.state.lock();
        if !s.dirty {
            return;
        }
        match write_atomic(&self.dir.join(STATE_FILE), &s.value) {
            Ok(()) => s.dirty = false,
            Err(e) => log::warn!("saving state: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn merge_patch_follows_rfc7386() {
        let mut v = json!({ "a": "b", "c": { "d": "e", "f": "g" }, "arr": [1, 2] });
        merge_patch(
            &mut v,
            &json!({ "a": "z", "c": { "f": null, "h": 1 }, "arr": [3] }),
        );
        assert_eq!(
            v,
            json!({ "a": "z", "c": { "d": "e", "h": 1 }, "arr": [3] })
        );
        merge_patch(&mut v, &json!({ "a": { "x": 1 } }));
        assert_eq!(v["a"], json!({ "x": 1 }));
    }

    #[test]
    fn prefs_defaults_round_trip_and_unknown_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("mc");
        let p = Prefs::load(dir.clone());
        assert_eq!(p.prefs_get()["videoVolume"], json!(0.8));
        assert!(!dir.exists(), "nothing is written until something is set");

        let out = p
            .prefs_set(&json!({ "videoVolume": 0.35, "futureThing": { "x": 1 } }))
            .unwrap();
        assert_eq!(out["videoVolume"], json!(0.35));
        assert_eq!(out["cacheMaxAgeDays"], json!(180));

        // The file only stores what was set, including unknown keys.
        let file = read(&dir.join(PREFS_FILE));
        assert_eq!(
            file,
            json!({ "videoVolume": 0.35, "futureThing": { "x": 1 } })
        );

        let p2 = Prefs::load(dir.clone());
        assert_eq!(p2.prefs_get()["videoVolume"], json!(0.35));
        p2.prefs_set(&json!({ "videoVolume": null })).unwrap();
        assert_eq!(p2.prefs_get()["videoVolume"], json!(0.8));
        assert_eq!(
            read(&dir.join(PREFS_FILE)),
            json!({ "futureThing": { "x": 1 } })
        );
        assert!(!dir.join("preferences.json.tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn permissions_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("mc");
        Prefs::load(dir.clone())
            .prefs_set(&json!({ "videoVolume": 0.5 }))
            .unwrap();
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(dir.join(PREFS_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn corrupt_file_is_moved_aside() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(PREFS_FILE), b"{ not json").unwrap();
        let p = Prefs::load(tmp.path().to_path_buf());
        assert_eq!(p.prefs_get()["videoVolume"], json!(0.8));
        assert!(tmp.path().join("preferences.json.corrupt").exists());
        assert!(!tmp.path().join(PREFS_FILE).exists());
    }

    #[test]
    fn state_merges_and_writes_after_debounce_or_flush() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(STATE_FILE);
        let s = Prefs::load(tmp.path().to_path_buf());
        s.state_set(&json!({ "panels": { "0": { "path": "/a" } } }))
            .unwrap();
        s.state_set(&json!({ "panels": { "1": { "path": "/b" } } }))
            .unwrap();
        assert_eq!(
            s.state_get(),
            json!({ "panels": { "0": { "path": "/a" }, "1": { "path": "/b" } } })
        );
        assert!(!path.exists(), "write is debounced");

        std::thread::sleep(STATE_DEBOUNCE + Duration::from_millis(400));
        assert_eq!(read(&path)["panels"]["1"]["path"], json!("/b"));

        s.state_set(&json!({ "localStorageMigrated": true }))
            .unwrap();
        s.flush_state();
        assert_eq!(read(&path)["localStorageMigrated"], json!(true));
        assert_eq!(
            Prefs::load(tmp.path().to_path_buf()).state_get()["panels"]["0"]["path"],
            json!("/a")
        );
    }

    #[test]
    fn non_object_patch_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let p = Prefs::load(tmp.path().to_path_buf());
        assert!(p.prefs_set(&json!([1])).is_err());
        assert!(p.state_set(&json!("x")).is_err());
    }
}
