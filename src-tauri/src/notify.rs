//! Notifications the user must see and delete: errors and warnings live in the DB (so they survive a
//! restart) and pop up as toasts. Informational messages stay ephemeral and go straight to the Snackbar.

use crate::{db, logs, state::AppState};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::Emitter;

/// Most rows kept in the DB; anything older is pruned on every insert.
const KEEP: i64 = 200;

#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: i64,
    pub level: String,
    pub message: String,
    pub created_at: i64,
}

fn insert(c: &Connection, level: &str, message: &str, now: i64) -> rusqlite::Result<Notification> {
    // The same message is still in the list: refresh its time instead of piling up duplicates.
    let existing: Option<i64> = c
        .query_row("SELECT id FROM notification WHERE level=?1 AND message=?2 ORDER BY id DESC LIMIT 1", params![level, message], |r| r.get(0))
        .optional()?;
    let id = match existing {
        Some(id) => {
            c.execute("UPDATE notification SET created_at=?1 WHERE id=?2", params![now, id])?;
            id
        }
        None => {
            c.execute("INSERT INTO notification(level,message,created_at) VALUES(?1,?2,?3)", params![level, message, now])?;
            let id = c.last_insert_rowid();
            c.execute("DELETE FROM notification WHERE id NOT IN (SELECT id FROM notification ORDER BY id DESC LIMIT ?1)", [KEEP])?;
            id
        }
    };
    Ok(Notification { id, level: level.to_string(), message: message.to_string(), created_at: now })
}

/// Stores a notification and pushes it to the UI. Synchronous on purpose: sync callers (subtitle sync,
/// Anki index refresh) hold `&AppState`, and the lock is held for one INSERT.
pub fn push(st: &AppState, level: Level, message: impl Into<String>) -> Result<Notification, String> {
    let message = message.into();
    let stored = st
        .db
        .lock()
        .map_err(|_| "db poisoned".to_string())
        .and_then(|c| insert(&c, level.as_str(), &message, db::now()).map_err(|e| e.to_string()));
    match stored {
        Ok(n) => {
            logs::log("events", &format!("notify {}: {message}", level.as_str()));
            let _ = st.app.emit("notification:added", &n);
            Ok(n)
        }
        Err(e) => {
            // Logged only: the frontend shows the message from the failed command itself, so emitting a
            // snackbar here would duplicate it.
            logs::log("events", &format!("notify {} failed ({e}): {message}", level.as_str()));
            Err(e)
        }
    }
}

/// Ephemeral message (Snackbar): never stored, never in the notification center.
pub fn info(st: &AppState, message: impl Into<String>) {
    let message = message.into();
    logs::log("events", &format!("toast: {message}"));
    let _ = st.app.emit("toast", serde_json::json!({ "message": message }));
}

pub async fn list(st: &AppState) -> Result<Vec<Notification>, String> {
    st.db(|c| {
        let mut q = c.prepare("SELECT id,level,message,created_at FROM notification ORDER BY id")?;
        let rows = q.query_map([], |r| {
            Ok(Notification { id: r.get(0)?, level: r.get(1)?, message: r.get(2)?, created_at: r.get(3)? })
        })?;
        rows.collect()
    })
    .await
}

pub async fn remove(st: &AppState, id: i64) -> Result<(), String> {
    st.db(move |c| {
        c.execute("DELETE FROM notification WHERE id=?1", [id])?;
        Ok(())
    })
    .await
}

pub async fn clear(st: &AppState) -> Result<(), String> {
    st.db(|c| {
        c.execute("DELETE FROM notification", [])?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prunes_to_keep() {
        let c = Connection::open_in_memory().unwrap();
        db::init(&c).unwrap();
        let mut last = None;
        for i in 0..205 {
            last = Some(insert(&c, Level::Error.as_str(), &format!("m{i}"), i).unwrap());
        }
        let n: i64 = c.query_row("SELECT count(*) FROM notification", [], |r| r.get(0)).unwrap();
        assert_eq!(n, KEEP);
        let min: i64 = c.query_row("SELECT min(id) FROM notification", [], |r| r.get(0)).unwrap();
        assert_eq!(min, 6);
        assert_eq!(last.unwrap().id, 205);
    }

    #[test]
    fn repeats_refresh_instead_of_duplicating() {
        let c = Connection::open_in_memory().unwrap();
        db::init(&c).unwrap();
        let first = insert(&c, Level::Error.as_str(), "boom", 100).unwrap();
        let again = insert(&c, Level::Error.as_str(), "boom", 200).unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(again.created_at, 200);
        let n: i64 = c.query_row("SELECT count(*) FROM notification", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // A warning with the same text is a different row.
        insert(&c, Level::Warn.as_str(), "boom", 300).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM notification", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }
}
