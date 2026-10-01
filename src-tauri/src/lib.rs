pub mod cache;
pub mod commands;
pub mod fsutil;
pub mod hub;
pub mod listing;
pub mod media;
pub mod model;
pub mod netvol;
pub mod ops;
pub mod persist;
pub mod prefs;
pub mod text;
pub mod volume;
pub mod watcher;

use std::sync::Arc;

/// `MC_FORCE_NETWORK=1` treats every path as a network path (for testing NAS code paths).
fn config_force_network() -> bool {
    std::env::var("MC_FORCE_NETWORK").is_ok_and(|v| v == "1")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let home = prefs::app_home();
    let settings = prefs::Settings::load(&home);
    let config = hub::HubConfig {
        cache_dir: Some(home.join("cache")),
        cache_max_bytes: settings.cache_max_bytes(),
        cache_max_age_days: settings.cache_max_age_days(),
        force_network: config_force_network(),
        poll_interval: hub::POLL_INTERVAL,
    };
    let hub = hub::Hub::new(config).expect("failed to start filesystem watcher");
    let media = Arc::new(media::Media::new(
        home.join("media"),
        config_force_network(),
        settings.media_read_ahead_bytes(),
    ));
    let media_scheme = media.clone();
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(all(feature = "webdriver", debug_assertions))]
    let builder = builder.plugin(tauri_plugin_webdriver::init());
    let app = builder
        .register_asynchronous_uri_scheme_protocol("media", move |_ctx, request, responder| {
            let media = media_scheme.clone();
            // Blocking file (and possibly network) reads: keep them off the main thread.
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(media::respond(&media, &request));
            });
        })
        .manage(hub.clone())
        .manage(media.clone())
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
            commands::media_status,
            commands::media_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(move |_app, event| {
        if let tauri::RunEvent::Exit = event {
            settings.flush();
            media.close();
            hub.flush();
        }
    });
}
