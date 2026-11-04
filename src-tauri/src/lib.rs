mod anki;
mod asr;
mod commands;
mod config;
mod db;
mod deps;
mod llm;
mod logs;
mod media;
mod notify;
mod patterns;
mod poster;
mod server;
mod session;
mod setup;
mod state;
mod subs;
mod theme;
mod tutor;
mod types;

use state::AppState;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use tauri::{Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

pub(crate) async fn vaapi_selftest(dev: &str) -> bool {
    let out = tokio::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-v", "error", "-init_hw_device", &format!("vaapi=va:{dev}"), "-f", "lavfi", "-i", "testsrc=s=320x240:d=1", "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-f", "null", "-"])
        .output()
        .await;
    matches!(out, Ok(o) if o.status.success())
}

/// Apps started from Finder/Dock get PATH=/usr/bin:/bin:/usr/sbin:/sbin, so Homebrew's ffmpeg, ffprobe
/// and uv are not found. Appends the Homebrew prefixes (Apple Silicon, Intel) that PATH lacks.
#[cfg(target_os = "macos")]
fn add_homebrew_to_path() {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(&current).collect();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if !dirs.iter().any(|d| d.as_os_str() == extra) {
            dirs.push(extra.into());
        }
    }
    if let Ok(path) = std::env::join_paths(dirs) {
        // Runs first in run(), before Tauri or tokio start any threads.
        std::env::set_var("PATH", path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    add_homebrew_to_path();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| session::show_main_window(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            logs::vacuum();
            let cfg = config::Config::load()?;
            let port = cfg.server.port;
            let conn = db::open(&config::config_dir().join("data.db"))?;
            let st = Arc::new(AppState {
                config: std::sync::RwLock::new(Arc::new(cfg)),
                listen_port: port,
                db: Arc::new(Mutex::new(conn)),
                sessions: Default::default(),
                vaapi_ok: AtomicBool::new(false),
                http: reqwest::Client::builder().build()?,
                llm_http: llm::client::http_client()?,
                app: app.handle().clone(),
                anki: Default::default(),
                agent_busy: Default::default(),
                cards_queue: Default::default(),
                asr: Default::default(),
                models_dev: Default::default(),
            });
            app.manage(st.clone());

            let s2 = st.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::serve(s2.clone()).await {
                    logs::log("app", &format!("server: {e}"));
                    let _ = notify::push(&s2, notify::Level::Error, format!("Порт {} занят — Lampa не сможет открыть фильм", s2.cfg().server.port));
                }
            });
            let s5 = st.clone();
            tauri::async_runtime::spawn(async move {
                llm::catalog::models_dev(&s5).await;
            });
            let s3 = st.clone();
            tauri::async_runtime::spawn(async move {
                let ok = vaapi_selftest(&s3.cfg().ffmpeg.vaapi_device).await;
                s3.vaapi_ok.store(ok, Ordering::Relaxed);
                logs::log("app", &format!("vaapi_ok={ok}"));
            });

            let s4 = st.clone();
            tauri::async_runtime::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(300));
                tick.tick().await;
                loop {
                    tick.tick().await;
                    if s4.app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false) {
                        anki::index::refresh(&s4).await;
                    }
                }
            });

            let h = app.handle().clone();
            tauri::async_runtime::spawn(theme::watch(h));

            let h = app.handle().clone();
            app.deep_link().on_open_url(move |_| session::show_main_window(&h));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session_current,
            commands::session_close,
            commands::session_open_file,
            commands::session_open_playlist_item,
            commands::media_open_stream,
            commands::media_torrent_health,
            commands::media_save_position,
            commands::media_set_audio,
            commands::media_set_sub_offset,
            commands::media_recent,
            commands::media_reset_annot,
            commands::session_reopen,
            commands::subs_list,
            commands::subs_load_file,
            commands::subs_candidates,
            commands::subs_select,
            commands::subs_embedded_state,
            commands::subs_embedded_decide,
            commands::annot_prioritize,
            commands::annot_status,
            commands::annot_estimate,
            commands::annot_cost,
            commands::annot_set,
            commands::annot_model,
            commands::annot_retry,
            commands::llm_explain,
            commands::agent_send,
            commands::agent_history,
            commands::agent_usage,
            commands::cards_draft,
            commands::cards_create_proposal,
            commands::cards_add,
            commands::cards_dismiss,
            commands::anki_refresh,
            commands::anki_catalog,
            commands::anki_index_models,
            commands::anki_note_type,
            commands::cards_preview,
            commands::images_generate,
            commands::tutor_import_script,
            commands::config_get,
            commands::config_save,
            commands::llm_providers,
            commands::llm_models,
            commands::llm_model_info,
            commands::llm_ping,
            commands::setup_status,
            commands::deps_check,
            commands::patterns_exposure,
            commands::patterns_stats,
            commands::patterns_set_status,
            commands::patterns_occurrences,
            commands::theme_current,
            commands::notifications_list,
            commands::notifications_push,
            commands::notifications_remove,
            commands::notifications_clear,
            commands::log_events,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, ev| {
        if let RunEvent::Exit = ev {
            if let Some(st) = handle.try_state::<Arc<AppState>>() {
                tauri::async_runtime::block_on(st.sessions.close());
            }
        }
    });
}
