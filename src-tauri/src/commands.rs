//! The `#[tauri::command]` surface. Argument names must match `docs/ipc.md`
//! (Tauri maps the frontend's camelCase keys to these snake_case parameters).
//!
//! Filesystem work runs on the blocking pool, so a slow disk never stalls the main thread.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use crate::hub::{Hub, PanelSink};
use crate::listing::{expand_tilde, home_dir as home};
use crate::model::{ConflictChoice, OpEvent, OpKind, PanelEvent, TextPreview, VolumeInfo};
use crate::ops::{self, OpSink, Ops};
use crate::prefs::Settings;
use crate::text;
use crate::volume;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Expand `~` and require an absolute path.
fn abs(path: &str) -> Result<PathBuf, String> {
    let p = expand_tilde(path);
    if p.is_absolute() {
        Ok(p)
    } else {
        Err(format!("{path}: path must be absolute"))
    }
}

#[tauri::command]
pub async fn panel_open(
    hub: State<'_, Arc<Hub>>,
    panel: u8,
    path: String,
    refresh: bool,
    on_event: Channel<PanelEvent>,
) -> Result<(), String> {
    if panel > 1 {
        return Err(format!("invalid panel {panel}"));
    }
    let hub = hub.inner().clone();
    let sink: PanelSink = Arc::new(move |e| on_event.send(e).is_ok());
    blocking(move || {
        hub.open(panel, &path, refresh, sink);
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn home_dir() -> String {
    home().to_string_lossy().into_owned()
}

#[tauri::command]
pub async fn rename(dir: String, from: String, to: String) -> Result<(), String> {
    let dir = abs(&dir)?;
    blocking(move || ops::rename(&dir, &from, &to)).await
}

#[tauri::command]
pub async fn mkdir(dir: String, name: String) -> Result<(), String> {
    let dir = abs(&dir)?;
    blocking(move || ops::mkdir(&dir, &name)).await
}

#[tauri::command]
pub async fn trash(paths: Vec<String>) -> Result<(), String> {
    let paths = paths
        .iter()
        .map(|p| abs(p))
        .collect::<Result<Vec<_>, _>>()?;
    blocking(move || ops::trash(&paths)).await
}

#[tauri::command]
pub fn copy_move(
    ops: State<'_, Arc<Ops>>,
    kind: OpKind,
    sources: Vec<String>,
    dest_dir: String,
    on_event: Channel<OpEvent>,
) -> Result<u64, String> {
    let sources = sources
        .iter()
        .map(|p| abs(p))
        .collect::<Result<Vec<_>, _>>()?;
    let dest_dir = abs(&dest_dir)?;
    let sink: OpSink = Arc::new(move |e| {
        let _ = on_event.send(e);
    });
    ops.start(kind, sources, dest_dir, sink)
}

#[tauri::command]
pub fn cancel_op(ops: State<'_, Arc<Ops>>, id: u64) {
    ops.cancel(id);
}

#[tauri::command]
pub fn resolve_conflict(
    ops: State<'_, Arc<Ops>>,
    id: u64,
    choice: ConflictChoice,
    apply_to_all: bool,
) {
    ops.resolve(id, choice, apply_to_all);
}

#[tauri::command]
pub async fn open_default(path: String) -> Result<(), String> {
    let path = abs(&path)?;
    blocking(move || tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
pub async fn read_text(path: String, max_bytes: u64) -> Result<TextPreview, String> {
    let path = abs(&path)?;
    blocking(move || text::read_text(&path, max_bytes)).await
}

#[tauri::command]
pub async fn volume_info(path: String) -> Result<VolumeInfo, String> {
    let path = abs(&path)?;
    blocking(move || volume::volume_info(&path)).await
}

#[tauri::command]
pub fn prefs_get(settings: State<'_, Arc<Settings>>) -> serde_json::Value {
    settings.prefs_get()
}

#[tauri::command]
pub async fn prefs_set(
    settings: State<'_, Arc<Settings>>,
    hub: State<'_, Arc<Hub>>,
    patch: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let settings = settings.inner().clone();
    let hub = hub.inner().clone();
    blocking(move || {
        let prefs = settings.prefs_set(&patch)?;
        hub.set_cache_limits(settings.cache_max_bytes(), settings.cache_max_age_days());
        Ok(prefs)
    })
    .await
}

#[tauri::command]
pub fn state_get(settings: State<'_, Arc<Settings>>) -> serde_json::Value {
    settings.state_get()
}

#[tauri::command]
pub fn state_set(
    settings: State<'_, Arc<Settings>>,
    patch: serde_json::Value,
) -> Result<(), String> {
    settings.state_set(&patch)
}
