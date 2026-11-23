//! Known-words index: which words the learner already has in Anki, read from selectable decks.
//!
//! Every note type found in those decks is read through its own word/translation field: the saved
//! override first, then the app's field mapping for the configured note type, then a guess by name.

use crate::{
    anki::{
        connect::{self, AnkiError},
        fields::{self, Source},
    },
    config,
    logs,
    state::AppState,
};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
    time::Duration,
};
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnkiCard {
    pub word: String,
    pub translation: String,
    pub status: &'static str,
    pub interval: i64,
    pub lapses: i64,
}

/// One note type the index reads: which fields it used and how many notes it contributed.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexModel {
    pub note_type: String,
    pub cards: usize,
    pub word_field: String,
    pub translation_field: String,
    pub fields: Vec<String>,
}

#[derive(Default)]
pub struct AnkiState {
    pub cards: Vec<AnkiCard>,
    /// lower(trim(word)) of every card in the indexed decks, whatever its status.
    pub exact: HashSet<String>,
    /// Note types met in those decks, for the settings dialog's field pickers.
    pub models: Vec<IndexModel>,
    pub updated_at: Option<i64>,
    pub last_error: Option<String>,
    warned: Option<IndexFailure>,
}

#[derive(Clone, Copy, PartialEq)]
enum IndexFailure {
    Busy,
    Unreachable,
    UnexpectedReply,
    Rejected,
}

fn is_busy_action(msg: &str) -> bool {
    let text = msg.split_once(": ").map_or(msg, |(_, rest)| rest).to_lowercase();
    [
        "collection lifecycle operation is active",
        "collection is not available",
        "collection is unavailable",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

impl IndexFailure {
    fn of(error: &AnkiError) -> Self {
        match error {
            AnkiError::Action(m) if is_busy_action(m) => Self::Busy,
            AnkiError::Refused(_) | AnkiError::Transport(_) => Self::Unreachable,
            AnkiError::Protocol(_) => Self::UnexpectedReply,
            AnkiError::Action(_) => Self::Rejected,
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::Busy => "Anki занят синхронизацией или открытием коллекции",
            Self::Unreachable => "Anki не отвечает — проверьте, что он запущен и адрес AnkiConnect верен",
            Self::UnexpectedReply => "Ответ не похож на AnkiConnect — проверьте адрес и установку дополнения",
            Self::Rejected => "AnkiConnect не смог прочитать коллекцию — подробности в журнале",
        }
    }
}

/// Card status as in tutor's classifyCard (without answer history). None = suspended.
pub fn classify(card_type: i64, queue: i64, interval: i64, lapses: i64) -> Option<&'static str> {
    if queue == -1 {
        return None;
    }
    Some(if lapses >= 8 {
        "leech"
    } else if card_type == 3 || lapses >= 3 {
        "weak"
    } else if card_type == 0 {
        "new"
    } else if card_type == 1 {
        "learning"
    } else if interval >= 21 {
        "learned"
    } else {
        "young"
    })
}

pub fn strip_html(s: &str) -> String {
    static R: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*>").unwrap());
    let t = R.replace_all(s, "");
    t.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
        .trim()
        .to_string()
}

/// `findCards` query for the configured decks: `deck:*` for every deck, one `deck:` term per deck,
/// and the target deck when the list is empty.
pub fn query(index_decks: &[String], deck: &str) -> String {
    if index_decks.iter().any(|d| d == "*") {
        return "deck:*".into();
    }
    if index_decks.is_empty() {
        return format!("deck:\"{}\"", connect::escape_query(deck));
    }
    format!(
        "({})",
        index_decks
            .iter()
            .map(|d| format!("deck:\"{}\"", connect::escape_query(d)))
            .collect::<Vec<_>>()
            .join(" OR ")
    )
}

/// Word and translation fields of one note type: the saved override, the app's mapping for the
/// configured note type, otherwise the first fields named like a word and like a translation.
fn pick_fields(model: &str, ordered: &[String], cfg: &config::Anki) -> (Option<String>, Option<String>) {
    if let Some(saved) = cfg.index_fields.get(model) {
        if !saved.word.is_empty() {
            return (Some(saved.word.clone()), Some(saved.translation.clone()).filter(|t| !t.is_empty()));
        }
    }
    if model == cfg.note_type {
        let map = fields::resolve(ordered, &cfg.fields);
        let word = map.iter().find(|(_, s)| *s == Some(Source::Word)).map(|(f, _)| f.clone());
        if word.is_some() {
            let translation = map.iter().find(|(_, s)| *s == Some(Source::Translation)).map(|(f, _)| f.clone());
            return (word, translation);
        }
    }
    let word = ordered
        .iter()
        .find(|f| fields::auto_source(f) == Some(Source::Word))
        .cloned()
        .or_else(|| ordered.first().cloned());
    let translation = ordered
        .iter()
        .find(|f| fields::auto_source(f) == Some(Source::Translation) && Some(f.as_str()) != word.as_deref())
        .cloned()
        .or_else(|| ordered.get(1).cloned().filter(|f| Some(f.as_str()) != word.as_deref()));
    (word, translation)
}

/// Field names of one card in model order.
fn ordered_fields(fields: &Value) -> Vec<String> {
    let mut v: Vec<(i64, String)> = fields
        .as_object()
        .map(|o| o.iter().map(|(k, f)| (f["order"].as_i64().unwrap_or(i64::MAX), k.clone())).collect())
        .unwrap_or_default();
    v.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    v.into_iter().map(|(_, k)| k).collect()
}

type Picked = (Option<String>, Option<String>, Vec<String>);

async fn fetch(http: &reqwest::Client, cfg: &config::Anki) -> Result<(Vec<AnkiCard>, Vec<IndexModel>), AnkiError> {
    let started = tokio::time::Instant::now();
    let mut busy_delays = [1, 2, 5].into_iter();
    let mut transport_delays = [1, 2].into_iter();
    loop {
        match fetch_snapshot(http, cfg).await {
            Err(e) => {
                let delay = match &e {
                    AnkiError::Refused(_) => return Err(e),
                    AnkiError::Transport(_) => {
                        if started.elapsed() >= Duration::from_secs(20) {
                            return Err(e);
                        }
                        transport_delays.next()
                    }
                    _ if IndexFailure::of(&e) == IndexFailure::Busy => busy_delays.next(),
                    _ => return Err(e),
                };
                match delay {
                    Some(seconds) => tokio::time::sleep(Duration::from_secs(seconds)).await,
                    None => return Err(e),
                }
            }
            Ok(snapshot) => return Ok(snapshot),
        }
    }
}

async fn fetch_snapshot(http: &reqwest::Client, cfg: &config::Anki) -> Result<(Vec<AnkiCard>, Vec<IndexModel>), AnkiError> {
    let client = connect::Client::new(http, &cfg.url);
    let q = query(&cfg.index_decks, &cfg.deck);
    let ids = client.call("findCards", json!({ "query": q }), Duration::from_secs(10)).await?;
    let ids = ids.as_array().and_then(|ids| ids.iter().map(Value::as_i64).collect::<Option<Vec<_>>>())
        .ok_or_else(|| AnkiError::Protocol("AnkiConnect findCards: ожидался список ID".into()))?;
    let mut by_note: HashMap<i64, AnkiCard> = HashMap::new();
    let mut picked: HashMap<String, Picked> = HashMap::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for chunk in ids.chunks(400) {
        let infos = client.call("cardsInfo", json!({ "cards": chunk }), Duration::from_secs(20)).await?;
        let infos = infos.as_array()
            .ok_or_else(|| AnkiError::Protocol("AnkiConnect cardsInfo: ожидался список карточек".into()))?;
        for c in infos {
            let model = c["modelName"].as_str().unwrap_or("").to_string();
            let entry = picked.entry(model.clone()).or_insert_with(|| {
                let ordered = ordered_fields(&c["fields"]);
                let (w, t) = pick_fields(&model, &ordered, cfg);
                (w, t, ordered)
            });
            let value = |field: &Option<String>| {
                field.as_ref().and_then(|f| c["fields"][f.as_str()]["value"].as_str()).map(strip_html).unwrap_or_default()
            };
            let word = value(&entry.0);
            if word.is_empty() {
                continue;
            }
            let lapses = c["lapses"].as_i64().unwrap_or(0);
            let Some(status) = classify(c["type"].as_i64().unwrap_or(0), c["queue"].as_i64().unwrap_or(0), c["interval"].as_i64().unwrap_or(0), lapses) else {
                continue;
            };
            let card = AnkiCard { word, translation: value(&entry.1), status, interval: c["interval"].as_i64().unwrap_or(0), lapses };
            let note = c["note"].as_i64().unwrap_or_else(|| c["cardId"].as_i64().unwrap_or(0));
            match by_note.get(&note) {
                Some(old) if old.interval <= card.interval => {}
                _ => {
                    by_note.insert(note, card);
                }
            }
            *counts.entry(model).or_default() += 1;
        }
    }
    let mut models: Vec<IndexModel> = picked
        .into_iter()
        .map(|(note_type, (word, translation, all))| IndexModel {
            cards: counts.get(&note_type).copied().unwrap_or(0),
            word_field: word.unwrap_or_default(),
            translation_field: translation.unwrap_or_default(),
            fields: all,
            note_type,
        })
        .filter(|m| m.cards > 0)
        .collect();
    models.sort_by(|a, b| a.note_type.cmp(&b.note_type));
    Ok((by_note.into_values().collect(), models))
}

/// Publishes a complete snapshot only. Sync or a dropped connection must not erase the last good index.
pub async fn refresh(st: &AppState) {
    // Concurrent refreshes (e.g. a save during sync) must not publish out of order.
    let _refresh = st.anki_refresh.lock().await;
    match fetch(&st.http, &st.cfg().anki).await {
        Ok((cards, models)) => {
            let exact = cards.iter().map(|c| c.word.trim().to_lowercase()).collect();
            let mut s = st.anki.lock().unwrap();
            s.exact = exact;
            s.cards = cards.clone();
            s.models = models;
            s.warned = None;
            s.updated_at = Some(crate::db::now());
            s.last_error = None;
            drop(s);
            let _ = st.app.emit("anki:index", &cards);
        }
        Err(e) => {
            logs::log("app", &format!("anki index: {e:#}"));
            let failure = IndexFailure::of(&e);
            let (first, has_snapshot) = {
                let mut s = st.anki.lock().unwrap();
                s.last_error = Some(failure.message().to_owned());
                (s.warned.replace(failure) != Some(failure), !s.cards.is_empty())
            };
            if first {
                let mut message = failure.message().to_owned();
                if has_snapshot {
                    message.push_str(". Используется предыдущий список известных слов.");
                }
                let _ = crate::notify::push(st, crate::notify::Level::Warn, message);
            }
        }
    }
}

pub fn has_exact(st: &AppState, word: &str) -> bool {
    st.anki.lock().unwrap().exact.contains(&word.trim().to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[tokio::test]
    async fn index_recovers_when_collection_is_temporarily_busy() {
        use axum::{routing::post, Json, Router};
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

        let busy = Arc::new(AtomicBool::new(true));
        let app = Router::new().route("/", post(move |Json(req): Json<Value>| {
            let busy = req["action"] == "cardsInfo" && busy.swap(false, Ordering::Relaxed);
            async move {
                Json(match req["action"].as_str().unwrap() {
                    "findCards" => json!({ "result": [42], "error": null }),
                    "cardsInfo" if busy => json!({ "result": null, "error": "Collection lifecycle operation is active." }),
                    "cardsInfo" => json!({ "result": [{
                        "note": 24, "modelName": "Basic",
                        "fields": { "Front": { "order": 0, "value": "weirdo" } }
                    }], "error": null }),
                    action => panic!("unexpected action: {action}"),
                })
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let cfg = config::Anki { url: format!("http://{}", listener.local_addr().unwrap()), ..Default::default() };
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let snapshot = fetch(&http, &cfg).await;
        server.abort();
        let (cards, models) = snapshot.unwrap();
        assert_eq!(cards[0].word, "weirdo");
        assert_eq!(models[0].note_type, "Basic");
    }

    #[tokio::test]
    async fn index_fails_fast_on_connection_refused() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let cfg = config::Anki { url: format!("http://{addr}"), ..Default::default() };
        let started = std::time::Instant::now();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let err = fetch(&http, &cfg).await.unwrap_err();
        assert!(matches!(err, AnkiError::Refused(_)), "expected Refused, got {err:?}");
        assert!(started.elapsed() < Duration::from_secs(2), "refused took too long: {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn index_retries_collection_not_available() {
        use axum::{routing::post, Json, Router};
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

        let unavailable = Arc::new(AtomicBool::new(true));
        let app = Router::new().route("/", post(move |Json(req): Json<Value>| {
            let unavailable = req["action"] == "findCards" && unavailable.swap(false, Ordering::Relaxed);
            async move {
                Json(match req["action"].as_str().unwrap() {
                    "findCards" if unavailable => json!({ "result": null, "error": "collection is not available" }),
                    "findCards" => json!({ "result": [42], "error": null }),
                    "cardsInfo" => json!({ "result": [{
                        "note": 24, "modelName": "Basic",
                        "fields": { "Front": { "order": 0, "value": "brisk" } }
                    }], "error": null }),
                    action => panic!("unexpected action: {action}"),
                })
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let cfg = config::Anki { url: format!("http://{}", listener.local_addr().unwrap()), ..Default::default() };
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let snapshot = fetch(&http, &cfg).await;
        server.abort();
        let (cards, models) = snapshot.unwrap();
        assert_eq!(cards[0].word, "brisk");
        assert_eq!(models[0].note_type, "Basic");
    }

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

    #[test]
    fn deck_query_follows_the_selection() {
        assert_eq!(query(&s(&["*"]), "Learning English"), "deck:*");
        assert_eq!(query(&s(&["A", "B"]), "Learning English"), "(deck:\"A\" OR deck:\"B\")");
        assert_eq!(query(&[], "Learning English"), "deck:\"Learning English\"");
    }

    #[test]
    fn fields_are_picked_by_override_mapping_then_name() {
        let mut cfg = config::Anki::default();
        cfg.note_type = "Smart Subtitles — Vocab".into();
        let builtin = s(&["Word", "ClozeText", "FullSentence", "WordTranslation"]);
        assert_eq!(
            pick_fields("Smart Subtitles — Vocab", &builtin, &cfg),
            (Some("Word".into()), Some("WordTranslation".into()))
        );

        cfg.index_fields.insert(
            "Basic".into(),
            config::IndexFields { word: "Front".into(), translation: "Back".into() },
        );
        assert_eq!(pick_fields("Basic", &s(&["Front", "Back", "Extra"]), &cfg), (Some("Front".into()), Some("Back".into())));

        // The app's mapping for its own note type: a remapped pair wins over the name table.
        cfg.fields.insert("Word".into(), String::new());
        cfg.fields.insert("FullSentence".into(), "word".into());
        cfg.fields.insert("ClozeText".into(), "translation".into());
        assert_eq!(
            pick_fields("Smart Subtitles — Vocab", &builtin, &cfg),
            (Some("FullSentence".into()), Some("ClozeText".into()))
        );

        // Unknown note type: the first word-like and translation-like fields, else the first two.
        cfg.note_type = "Other".into();
        assert_eq!(pick_fields("Cloze", &s(&["Text", "Extra"]), &cfg), (Some("Text".into()), Some("Extra".into())));
        assert_eq!(pick_fields("Odd", &s(&["Alpha", "Beta"]), &cfg), (Some("Alpha".into()), Some("Beta".into())));
        assert_eq!(pick_fields("One", &s(&["Only"]), &cfg), (Some("Only".into()), None));
    }

    #[test]
    fn field_order_comes_from_anki() {
        let v = json!({ "B": { "value": "", "order": 1 }, "A": { "value": "", "order": 0 } });
        assert_eq!(ordered_fields(&v), vec!["A".to_string(), "B".to_string()]);
    }
}
