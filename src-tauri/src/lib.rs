pub mod cache;
pub mod commands;
pub mod fsutil;
pub mod hub;
pub mod listing;
pub mod model;
pub mod netvol;
pub mod ops;
pub mod persist;
pub mod prefs;
pub mod text;
pub mod volume;
pub mod watcher;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let home = prefs::app_home();
    let settings = prefs::Settings::load(&home);
    let config = hub::HubConfig {
        cache_dir: Some(home.join("cache")),
        cache_max_bytes: settings.cache_max_bytes(),
        cache_max_age_days: settings.cache_max_age_days(),
        force_network: std::env::var("MC_FORCE_NETWORK").is_ok_and(|v| v == "1"),
    };
    let hub = hub::Hub::new(config).expect("failed to start filesystem watcher");
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(all(feature = "webdriver", debug_assertions))]
    let builder = builder.plugin(tauri_plugin_webdriver::init());
    let app = builder
        .manage(hub.clone())
        .manage(settings.clone())
        .manage(Arc::new(ops::Ops::default()))
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
        .expect("error while building tauri application");
    app.run(move |_app, event| {
        if let tauri::RunEvent::Exit = event {
            settings.flush();
            hub.flush();
        }
    });
}
