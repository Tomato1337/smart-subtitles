use crate::{config::Config, session::SessionManager};
use rusqlite::Connection;
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use tauri::AppHandle;

pub struct AppState {
    pub cfg: Config,
    pub db: Arc<Mutex<Connection>>,
    pub sessions: SessionManager,
    pub vaapi_ok: AtomicBool,
    pub http: reqwest::Client,
    pub app: AppHandle,
    pub anki: Mutex<crate::tutor::anki_index::AnkiState>,
    /// Media ids with an agent run in flight (one chat thread per film).
    pub agent_busy: Mutex<std::collections::HashSet<String>>,
    /// Serializes background Anki jobs: one clip + image run at a time, in click order.
    pub cards_queue: tokio::sync::Mutex<()>,
    /// Serializes speech recognition (venv setup and runs).
    pub asr: tokio::sync::Mutex<()>,
}

impl AppState {
    /// Runs a closure against the SQLite connection on a blocking thread.
    pub async fn db<T, F>(&self, f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let c = db.lock().map_err(|_| "db poisoned".to_string())?;
            f(&c).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
}
