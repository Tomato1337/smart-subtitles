use crate::{logs, state::AppState};
use anyhow::{anyhow, bail};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, sync::OnceLock, time::Duration};
use tauri::Emitter;

const ANKI_URL: &str = "http://127.0.0.1:8765";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnkiCard { pub word: String, pub translation: String, pub status: &'static str, pub interval: i64 }

#[derive(Default)]
pub struct AnkiState {
    pub cards: Vec<AnkiCard>,
    /// lower(trim(word)) of every card in the deck, whatever its status.
    pub exact: HashSet<String>,
    pub warned: bool,
}

/// Card status as in tutor's classifyCard (without answer history). None = suspended.
pub fn classify(card_type: i64, queue: i64, interval: i64, lapses: i64) -> Option<&'static str> {
    if queue == -1 { return None; }
    Some(if lapses >= 8 { "leech" }
    else if card_type == 3 || lapses >= 3 { "weak" }
    else if card_type == 0 { "new" }
    else if card_type == 1 { "learning" }
    else if interval >= 21 { "learned" }
    else { "young" })
}

pub fn strip_html(s: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    let t = R.get_or_init(|| Regex::new(r"<[^>]*>").unwrap()).replace_all(s, "");
    t.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&").trim().to_string()
}

pub async fn call(st: &AppState, action: &str, params: Value, timeout: Duration) -> anyhow::Result<Value> {
    // AnkiConnect closes the socket after each response; a pooled keep-alive connection would fail.
    let r: Value = st.http.post(ANKI_URL).header("Connection", "close").timeout(timeout).json(&json!({ "action": action, "version": 6, "params": params })).send().await?.json().await?;
    if let Some(e) = r["error"].as_str() { bail!("AnkiConnect {action}: {e}"); }
    Ok(r["result"].clone())
}

pub async fn available(st: &AppState) -> bool {
    call(st, "version", json!({}), Duration::from_secs(3)).await.is_ok()
}

async fn fetch(st: &AppState) -> anyhow::Result<Vec<AnkiCard>> {
    let ids = call(st, "findCards", json!({ "query": format!("deck:\"{}\"", st.cfg().tutor.deck) }), Duration::from_secs(10)).await?;
    let ids: Vec<i64> = ids.as_array().ok_or_else(|| anyhow!("findCards"))?.iter().filter_map(Value::as_i64).collect();
    let mut by_note: HashMap<i64, AnkiCard> = HashMap::new();
    for chunk in ids.chunks(400) {
        let infos = call(st, "cardsInfo", json!({ "cards": chunk }), Duration::from_secs(20)).await?;
        for c in infos.as_array().cloned().unwrap_or_default() {
            let word = strip_html(c["fields"]["Word"]["value"].as_str().unwrap_or(""));
            if word.is_empty() { continue; }
            let Some(status) = classify(c["type"].as_i64().unwrap_or(0), c["queue"].as_i64().unwrap_or(0), c["interval"].as_i64().unwrap_or(0), c["lapses"].as_i64().unwrap_or(0)) else { continue };
            let card = AnkiCard {
                word,
                translation: strip_html(c["fields"]["WordTranslation"]["value"].as_str().unwrap_or("")),
                status,
                interval: c["interval"].as_i64().unwrap_or(0),
            };
            let note = c["note"].as_i64().unwrap_or_else(|| c["cardId"].as_i64().unwrap_or(0));
            match by_note.get(&note) {
                Some(old) if old.interval <= card.interval => {}
                _ => { by_note.insert(note, card); }
            }
        }
    }
    Ok(by_note.into_values().collect())
}

/// Reloads the deck, stores it and tells the frontend. Anki being down yields an empty index and one toast.
pub async fn refresh(st: &AppState) {
    match fetch(st).await {
        Ok(cards) => {
            let mut s = st.anki.lock().unwrap();
            s.exact = cards.iter().map(|c| c.word.trim().to_lowercase()).collect();
            s.cards = cards.clone();
            s.warned = false;
            drop(s);
            let _ = st.app.emit("anki:index", &cards);
        }
        Err(e) => {
            logs::log("app", &format!("anki index: {e:#}"));
            let first = { let mut s = st.anki.lock().unwrap(); s.cards.clear(); s.exact.clear(); !std::mem::replace(&mut s.warned, true) };
            let _ = st.app.emit("anki:index", Vec::<AnkiCard>::new());
            if first { let _ = st.app.emit("toast", json!({ "message": "Anki не запущен — подписи и проверка дублей выключены" })); }
        }
    }
}

pub fn has_exact(st: &AppState, word: &str) -> bool {
    st.anki.lock().unwrap().exact.contains(&word.trim().to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification() {
        assert_eq!(classify(2, 2, 30, 0), Some("learned"));
        assert_eq!(classify(0, 0, 0, 0), Some("new"));
        assert_eq!(classify(2, 2, 5, 4), Some("weak"));
        assert_eq!(classify(2, -1, 5, 0), None);
        assert_eq!(classify(1, 1, 0, 0), Some("learning"));
        assert_eq!(classify(2, 2, 5, 0), Some("young"));
        assert_eq!(classify(2, 2, 90, 8), Some("leech"));
        assert_eq!(classify(3, 1, 0, 0), Some("weak"));
    }

    #[test]
    fn html_stripping() {
        assert_eq!(strip_html("<b>bring&nbsp;up</b> &amp; co"), "bring up & co");
    }
}
