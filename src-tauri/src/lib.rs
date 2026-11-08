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
mod proc;
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

/// VAAPI exists only on Linux; elsewhere video that needs re-encoding goes through libx264.
pub(crate) async fn vaapi_selftest(dev: &str) -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    let out = proc::command("ffmpeg")
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
                card_jobs: Default::default(),
                asr: Default::default(),
                models_dev: Default::default(),
            });
            app.manage(st.clone());

            // Local job recovery completes before any card operation is accepted; network
            // reconciliation of sent operations is scheduled separately.
            let jobs = st.clone();
            tauri::async_runtime::spawn(async move {
                crate::anki::jobs::start(jobs).await;
            });

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
            // deb/rpm register smartsubs:// through their .desktop file; an AppImage has no installer, and on
            // Windows the per-user registry entry keeps pointing at the exe that runs now.
            #[cfg(target_os = "linux")]
            let register = app.env().appimage.is_some();
            #[cfg(windows)]
            let register = true;
            #[cfg(any(windows, target_os = "linux"))]
            if register {
                if let Err(e) = app.deep_link().register_all() {
                    logs::log("app", &format!("smartsubs:// не зарегистрирован: {e}"));
                }
            }
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
            commands::media_set_hidden,
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
            commands::cards_add,
            commands::cards_dismiss,
            commands::cards_job_create,
            commands::cards_jobs,
            commands::cards_job_get,
            commands::cards_job_hold,
            commands::cards_job_cancel,
            commands::cards_job_edit,
            commands::cards_job_preview,
            commands::cards_job_image,
            commands::cards_job_save,
            commands::cards_job_delete,
            commands::cards_job_retry,
            commands::anki_refresh,
            commands::anki_catalog,
            commands::anki_index_models,
            commands::anki_note_type,
            commands::cards_preview,
            commands::images_generate,
            commands::images_route,
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
                st.card_jobs.shutdown();
                tauri::async_runtime::block_on(st.sessions.close());
            }
        }
    });
}

/// The UI and the backend share command and event names only as strings; these tests keep the two sides in step.
#[cfg(test)]
mod ipc_contract {
    use regex::Regex;
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    fn sources(dir: &Path, exts: &[&str], out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, exts, out);
            } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| exts.contains(&e)) {
                out.push(path);
            }
        }
    }

    fn captures(re: &str, text: &str) -> BTreeSet<String> {
        Regex::new(re).unwrap().captures_iter(text).map(|c| c[1].to_string()).collect()
    }

    fn read_all(dir: &Path, exts: &[&str]) -> String {
        let mut files = Vec::new();
        sources(dir, exts, &mut files);
        files.iter().map(|f| std::fs::read_to_string(f).unwrap()).collect::<Vec<_>>().join("\n")
    }

    fn frontend() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../src") }

    fn diff(a: &BTreeSet<String>, b: &BTreeSet<String>) -> Vec<String> { a.difference(b).cloned().collect() }

    #[test]
    fn every_command_is_defined_registered_and_called() {
        let lib = include_str!("lib.rs");
        let handler = lib.split("generate_handler![").nth(1).unwrap().split(']').next().unwrap();
        let registered = captures(r"commands::(\w+)", handler);
        let defined = captures(r"#\[tauri::command\]\s*pub\s+(?:async\s+)?fn\s+(\w+)", include_str!("commands.rs"));
        // `call` in common/api/tauri.ts, plus the raw `invoke` of the event log, which must not log itself.
        let called = captures(r"\b(?:call|invoke)(?:<[^()]*>)?\(\s*'(\w+)'", &read_all(&frontend(), &["ts", "tsx"]));

        assert!(!called.is_empty(), "no command calls found in src/");
        assert_eq!(diff(&defined, &registered), Vec::<String>::new(), "defined in commands.rs but missing from generate_handler!");
        assert_eq!(diff(&called, &registered), Vec::<String>::new(), "called by the UI but not registered");
        assert_eq!(diff(&registered, &called), Vec::<String>::new(), "registered but never called by the UI");
    }

    #[test]
    fn every_event_is_emitted_and_typed() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        // `.emit(<literal name>, …)` on the app handle and module helpers of the form `emit(st, <literal name>, …)`.
        let emitted = captures(r#"emit\(\s*(?:&?\w+\s*,\s*)?"([^"]+)""#, &read_all(&src, &["rs"]));
        let api = std::fs::read_to_string(frontend().join("common/api/tauri.ts")).unwrap();
        let block = api.split("export type AppEvents = {").nth(1).unwrap().split("\n}").next().unwrap();
        let typed = captures(r"(?m)^\s*'?([\w:]+)'?\s*:", block);

        assert!(!emitted.is_empty() && !typed.is_empty(), "event extraction found nothing");
        assert_eq!(diff(&emitted, &typed), Vec::<String>::new(), "emitted by Rust but missing from AppEvents in tauri.ts");
        assert_eq!(diff(&typed, &emitted), Vec::<String>::new(), "in AppEvents but never emitted by Rust");
    }
}
