//! AnkiConnect transport: one JSON call per action, plus the catalog the settings dialog picks from.

use crate::state::AppState;
use anyhow::{anyhow, bail};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};

/// One deck as Anki reports it; `cards` is the deck's total, subdecks excluded.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckInfo {
    pub name: String,
    pub cards: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTypeInfo {
    pub name: String,
    pub fields: Vec<String>,
}

/// Everything the settings dialog offers in its lists.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub decks: Vec<DeckInfo>,
    pub note_types: Vec<NoteTypeInfo>,
}

pub async fn call(st: &AppState, action: &str, params: Value, timeout: Duration) -> anyhow::Result<Value> {
    let url = st.cfg().anki.url.clone();
    // AnkiConnect closes the socket after each response; a pooled keep-alive connection would fail.
    let r: Value = st
        .http
        .post(&url)
        .header("Connection", "close")
        .timeout(timeout)
        .json(&json!({ "action": action, "version": 6, "params": params }))
        .send()
        .await
        .map_err(|e| anyhow!("{url}: {e}"))?
        .json()
        .await?;
    if let Some(e) = r["error"].as_str() {
        bail!("AnkiConnect {action}: {e}");
    }
    Ok(r["result"].clone())
}

pub async fn available(st: &AppState) -> bool {
    call(st, "version", json!({}), Duration::from_secs(3)).await.is_ok()
}

/// Decks with their card counts and every note type with its fields.
pub async fn catalog(st: &AppState) -> anyhow::Result<Catalog> {
    let names: Vec<String> = str_list(call(st, "deckNames", json!({}), Duration::from_secs(10)).await?);
    let mut counts: HashMap<String, i64> = HashMap::new();
    match call(st, "getDeckStats", json!({ "decks": names }), Duration::from_secs(20)).await {
        Ok(v) => {
            for stats in objects(&v) {
                if let Some(name) = stats["name"].as_str() {
                    counts.insert(name.to_string(), stats["total_in_deck"].as_i64().unwrap_or(0));
                }
            }
        }
        // Old AnkiConnect without getDeckStats: one `multi` round for all the counts.
        Err(e) => {
            crate::logs::log("app", &format!("anki catalog: getDeckStats: {e:#}"));
            let actions: Vec<Value> = names
                .iter()
                .map(|d| json!({ "action": "findCards", "version": 6, "params": { "query": format!("deck:\"{d}\"") } }))
                .collect();
            if let Ok(v) = call(st, "multi", json!({ "actions": actions }), Duration::from_secs(30)).await {
                for (name, r) in names.iter().zip(objects(&v)) {
                    let n = r["result"].as_array().map_or(0, |a| a.len() as i64);
                    counts.insert(name.clone(), n);
                }
            }
        }
    }
    let mut decks: Vec<DeckInfo> = names
        .into_iter()
        .map(|name| {
            let cards = counts.get(&name).copied().unwrap_or(0);
            DeckInfo { name, cards }
        })
        .collect();
    decks.sort_by(|a, b| a.name.cmp(&b.name));

    let mut note_types = vec![];
    for name in str_list(call(st, "modelNames", json!({}), Duration::from_secs(10)).await?) {
        let fields = str_list(call(st, "modelFieldNames", json!({ "modelName": name }), Duration::from_secs(10)).await?);
        note_types.push(NoteTypeInfo { name, fields });
    }
    Ok(Catalog { decks, note_types })
}

/// `storeMediaFile` by bytes: Flatpak Anki cannot see the app's cache directory, so a path is useless.
pub async fn store_media(st: &AppState, file_name: &str, bytes: &[u8]) -> anyhow::Result<()> {
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    // Answers with the stored name, or with null when Anki already had exactly these bytes.
    call(st, "storeMediaFile", json!({ "filename": file_name, "data": data }), Duration::from_secs(120)).await.map(|_| ())
}

/// An array of strings, whatever else Anki put in the JSON.
fn str_list(v: Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// getDeckStats answers with an object keyed by deck id; multi answers with an array. Both are objects here.
fn objects(v: &Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a.clone(),
        Value::Object(o) => o.values().cloned().collect(),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deck_stats_shape_is_read_from_both_containers() {
        let by_id = json!({ "1": { "name": "Learning English", "total_in_deck": 142 } });
        assert_eq!(objects(&by_id).len(), 1);
        assert_eq!(objects(&by_id)[0]["total_in_deck"], 142);
        let by_index = json!([{ "name": "A", "total_in_deck": 1 }, { "name": "B", "total_in_deck": 2 }]);
        assert_eq!(objects(&by_index).len(), 2);
        assert!(objects(&Value::Null).is_empty());
    }

    #[test]
    fn string_lists_ignore_anything_but_strings() {
        assert_eq!(str_list(json!(["a", 1, "b"])), vec!["a".to_string(), "b".to_string()]);
        assert!(str_list(Value::Null).is_empty());
    }
}
