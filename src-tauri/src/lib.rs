pub mod cache;
pub mod commands;
pub mod hub;
pub mod listing;
pub mod model;
pub mod ops;
pub mod text;
pub mod watcher;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let hub = hub::Hub::new().expect("failed to start filesystem watcher");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(hub)
        .manage(Arc::new(ops::Ops::default()))
        .invoke_handler(tauri::generate_handler![
            commands::panel_open,
            commands::home_dir,
            commands::rename,
            commands::mkdir,
            commands::trash,
            commands::copy_move,
            commands::cancel_op,
            commands::open_default,
            commands::read_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
