pub mod cache;
pub mod commands;
pub mod hub;
pub mod listing;
pub mod model;
pub mod ops;
pub mod prefs;
pub mod text;
pub mod volume;
pub mod watcher;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let hub = hub::Hub::new().expect("failed to start filesystem watcher");
    let prefs = prefs::Prefs::load(prefs::mc_home());
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(all(feature = "webdriver", debug_assertions))]
    let builder = builder.plugin(tauri_plugin_webdriver::init());
    builder
        .manage(hub)
        .manage(Arc::new(ops::Ops::default()))
        .manage(prefs.clone())
        .invoke_handler(tauri::generate_handler![
            commands::panel_open,
            commands::home_dir,
            commands::rename,
            commands::mkdir,
            commands::trash,
            commands::copy_move,
            commands::cancel_op,
            commands::resolve_conflict,
            commands::open_default,
            commands::read_text,
            commands::volume_info,
            commands::prefs_get,
            commands::prefs_set,
            commands::state_get,
            commands::state_set,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_, event| {
            if let tauri::RunEvent::Exit = event {
                prefs.flush_state();
            }
        });
}
