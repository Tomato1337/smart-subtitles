use crate::{config::Config, session::SessionManager};
use rusqlite::Connection;
use std::sync::{atomic::AtomicBool, Arc, Mutex, RwLock};
use tauri::AppHandle;

pub struct AppState {
    /// Live config; `config_save` swaps it, readers take a cheap Arc snapshot via `cfg()`.
    pub config: RwLock<Arc<Config>>,
    /// Port the HTTP server was bound to at startup; config.server.port may differ until restart.
    pub listen_port: u16,
    pub db: Arc<Mutex<Connection>>,
    pub sessions: SessionManager,
    pub vaapi_ok: AtomicBool,
    pub http: reqwest::Client,
    /// LLM calls only: same-host redirects, so a keyed header never follows a cross-host hop.
    pub llm_http: reqwest::Client,
    pub app: AppHandle,
    pub anki: Mutex<crate::anki::index::AnkiState>,
    /// Media ids with an agent run in flight (one chat thread per film).
    pub agent_busy: Mutex<std::collections::HashSet<String>>,
    /// Serializes card preparation: one clip + image run at a time, in click order.
    pub cards_queue: tokio::sync::Mutex<()>,
    /// Durable card jobs: grace timers, holds and per-job cancellation.
    pub card_jobs: crate::anki::jobs::Runtime,
    /// Serializes speech recognition (venv setup and runs).
    pub asr: tokio::sync::Mutex<()>,
    /// models.dev index and when it was loaded; one download a day, shared by every call.
    pub models_dev: tokio::sync::Mutex<Option<(std::time::Instant, Arc<crate::llm::catalog::DevIndex>)>>,
}

impl AppState {
    /// Snapshot of the current config. Hold it for one operation; later reads may see a newer one.
    pub fn cfg(&self) -> Arc<Config> {
        self.config.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Runs a closure against the SQLite connection on a blocking thread.
    pub async fn db<T, F>(&self, f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        db_task(&self.db, f).await
    }
}

/// The synchronous body of [`db_task`]: lock the connection and run one closure. Job transactions
/// use it directly so their CAS and commit behaviour is testable with an in-memory database.
pub fn with_db<T, F>(db: &Arc<Mutex<Connection>>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
{
    let c = db.lock().map_err(|_| "db poisoned".to_string())?;
    f(&c).map_err(|e| e.to_string())
}

/// Same as [`with_db`] but off the async runtime's threads.
pub async fn db_task<T, F>(db: &Arc<Mutex<Connection>>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
{
    let db = db.clone();
    tokio::task::spawn_blocking(move || with_db(&db, f)).await.map_err(|e| e.to_string())?
}
