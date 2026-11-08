//! AnkiConnect transport: one JSON call per action, plus the catalog the settings dialog picks from.
//!
//! A `Client` is bound to one endpoint and one HTTP client. Settings and the catalog build it from a
//! config snapshot; a queued card job builds it from the endpoint captured when the job was created,
//! so a job never moves to a different Anki because live settings changed.

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, collections::HashMap, fmt, time::Duration};

/// Why an AnkiConnect call failed. The kinds matter to the job lifecycle: a transport failure is
/// ambiguous (the action may have been applied), a protocol error means Anki answered something the
/// add-on never sends, and an action error is Anki's own explicit refusal.
#[derive(Debug, Clone, PartialEq)]
pub enum AnkiError {
    /// The request never produced a well-formed answer: refused, timed out, connection dropped.
    Transport(String),
    /// An answer arrived but its envelope or payload does not have the documented shape.
    Protocol(String),
    /// AnkiConnect answered `error`.
    Action(String),
}

impl fmt::Display for AnkiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AnkiError::Transport(m) | AnkiError::Protocol(m) | AnkiError::Action(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for AnkiError {}

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

/// One field of a note as `notesInfo` reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct NoteInfoField {
    pub value: String,
    pub order: i64,
}

/// One note as `notesInfo` reports it. `profile` is the Anki profile active when Anki answered; a
/// note ID only means the same note inside the same profile.
#[derive(Debug, Clone, PartialEq)]
pub struct NoteInfo {
    pub note_id: i64,
    pub model_name: String,
    pub tags: Vec<String>,
    pub cards: Vec<i64>,
    pub fields: BTreeMap<String, NoteInfoField>,
    pub profile: Option<String>,
}

impl NoteInfo {
    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields.get(name).map(|f| f.value.as_str())
    }
}

/// AnkiConnect at one address, over one HTTP client (which carries the right proxy rules).
#[derive(Clone, Copy)]
pub struct Client<'a> {
    http: &'a reqwest::Client,
    url: &'a str,
}

impl<'a> Client<'a> {
    pub fn new(http: &'a reqwest::Client, url: &'a str) -> Self {
        Self { http, url }
    }

    /// One action. AnkiConnect closes the socket after each answer, so every request asks for
    /// `Connection: close` (a pooled keep-alive connection would fail).
    pub async fn call(&self, action: &str, params: Value, timeout: Duration) -> Result<Value, AnkiError> {
        let r = self
            .http
            .post(self.url)
            .header("Connection", "close")
            .timeout(timeout)
            .json(&json!({ "action": action, "version": 6, "params": params }))
            .send()
            .await
            .map_err(|e| AnkiError::Transport(format!("AnkiConnect {action}: {}", transport_text(&e))))?;
        let v: Value = r
            .json()
            .await
            .map_err(|e| AnkiError::Transport(format!("AnkiConnect {action}: {}", transport_text(&e))))?;
        let Some(obj) = v.as_object() else {
            return Err(AnkiError::Protocol(format!("AnkiConnect {action}: ответ не объект")));
        };
        // Every answered request carries both keys; one without them is not this add-on's protocol.
        if !obj.contains_key("result") || !obj.contains_key("error") {
            return Err(AnkiError::Protocol(format!("AnkiConnect {action}: нет result/error в ответе")));
        }
        match &obj["error"] {
            Value::Null => {}
            Value::String(e) => return Err(AnkiError::Action(format!("AnkiConnect {action}: {e}"))),
            _ => return Err(AnkiError::Protocol(format!("AnkiConnect {action}: error не строка и не null"))),
        }
        Ok(obj["result"].clone())
    }

    /// An empty round trip: Anki has processed everything queued before it. Used as the quiescence
    /// barrier after an add whose answer was lost.
    pub async fn version(&self) -> Result<i64, AnkiError> {
        let v = self.call("version", json!({}), Duration::from_secs(10)).await?;
        v.as_i64().ok_or_else(|| AnkiError::Protocol("AnkiConnect version: ответ не число".into()))
    }

    /// `storeMediaFile` by bytes: Flatpak Anki cannot see the app's cache directory, so a path is useless.
    pub async fn store_media(&self, file_name: &str, bytes: &[u8]) -> Result<(), AnkiError> {
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        // Answers with the stored name, or with null when Anki already had exactly these bytes.
        let v = self
            .call("storeMediaFile", json!({ "filename": file_name, "data": data }), Duration::from_secs(120))
            .await?;
        match v {
            Value::String(_) | Value::Null => Ok(()),
            _ => Err(AnkiError::Protocol("AnkiConnect storeMediaFile: ответ не имя файла".into())),
        }
    }

    /// The stored bytes of a media file, or an action error when Anki does not have it.
    pub async fn retrieve_media(&self, file_name: &str) -> Result<Vec<u8>, AnkiError> {
        let v = self.call("retrieveMediaFile", json!({ "filename": file_name }), Duration::from_secs(30)).await?;
        match v {
            Value::String(b64) => base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| AnkiError::Protocol(format!("AnkiConnect retrieveMediaFile: {e}"))),
            Value::Bool(false) | Value::Null => Err(AnkiError::Action(format!(
                "AnkiConnect retrieveMediaFile: «{file_name}» нет в Anki"
            ))),
            _ => Err(AnkiError::Protocol("AnkiConnect retrieveMediaFile: ответ не base64".into())),
        }
    }

    pub async fn create_deck(&self, deck: &str) -> Result<(), AnkiError> {
        self.call("createDeck", json!({ "deck": deck }), Duration::from_secs(30)).await.map(|_| ())
    }

    pub async fn model_field_names(&self, model: &str) -> Result<Vec<String>, AnkiError> {
        let v = self.call("modelFieldNames", json!({ "modelName": model }), Duration::from_secs(10)).await?;
        v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).ok_or_else(|| {
            AnkiError::Protocol("AnkiConnect modelFieldNames: ответ не массив".into())
        })
    }

    /// Adds one note; the answer is the new positive note ID.
    pub async fn add_note(&self, note: Value) -> Result<i64, AnkiError> {
        let v = self.call("addNote", json!({ "note": note }), Duration::from_secs(60)).await?;
        match v.as_i64() {
            Some(id) if id > 0 => Ok(id),
            _ => Err(AnkiError::Protocol(format!("AnkiConnect addNote: id заметки «{v}» не положительный"))),
        }
    }

    pub async fn find_notes(&self, query: &str) -> Result<Vec<i64>, AnkiError> {
        let v = self.call("findNotes", json!({ "query": query }), Duration::from_secs(10)).await?;
        let arr = v.as_array().ok_or_else(|| AnkiError::Protocol("AnkiConnect findNotes: ответ не массив".into()))?;
        let mut out = Vec::with_capacity(arr.len());
        for id in arr {
            match id.as_i64() {
                Some(id) => out.push(id),
                None => return Err(AnkiError::Protocol(format!("AnkiConnect findNotes: «{id}» не id заметки"))),
            }
        }
        Ok(out)
    }

    pub async fn notes_info(&self, ids: &[i64]) -> Result<Vec<NoteInfo>, AnkiError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let v = self.call("notesInfo", json!({ "notes": ids }), Duration::from_secs(10)).await?;
        parse_notes(v, ids)
    }

    /// Replaces the given fields of one note; other fields, cards and scheduling stay as they are.
    pub async fn update_note_fields(&self, id: i64, fields: &BTreeMap<String, String>) -> Result<(), AnkiError> {
        self.call("updateNoteFields", json!({ "note": { "id": id, "fields": fields } }), Duration::from_secs(30))
            .await
            .map(|_| ())
    }

    pub async fn delete_notes(&self, ids: &[i64]) -> Result<(), AnkiError> {
        if ids.is_empty() {
            return Ok(());
        }
        self.call("deleteNotes", json!({ "notes": ids }), Duration::from_secs(30)).await.map(|_| ())
    }

    pub async fn sync(&self) -> Result<(), AnkiError> {
        self.call("sync", json!({}), Duration::from_secs(300)).await.map(|_| ())
    }

    /// Decks with their card counts and every note type with its fields.
    pub async fn catalog(&self) -> Result<Catalog, AnkiError> {
        let names: Vec<String> = str_list(self.call("deckNames", json!({}), Duration::from_secs(10)).await?);
        let mut counts: HashMap<String, i64> = HashMap::new();
        match self.call("getDeckStats", json!({ "decks": names }), Duration::from_secs(20)).await {
            Ok(v) => {
                for stats in objects(&v) {
                    if let Some(name) = stats["name"].as_str() {
                        counts.insert(name.to_string(), stats["total_in_deck"].as_i64().unwrap_or(0));
                    }
                }
            }
            // Old AnkiConnect without getDeckStats: one `multi` round for all the counts.
            Err(e) => {
                crate::logs::log("app", &format!("anki catalog: getDeckStats: {e}"));
                let actions: Vec<Value> = names
                    .iter()
                    .map(|d| json!({ "action": "findCards", "version": 6, "params": { "query": format!("deck:\"{d}\"") } }))
                    .collect();
                if let Ok(v) = self.call("multi", json!({ "actions": actions }), Duration::from_secs(30)).await {
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
        for name in str_list(self.call("modelNames", json!({}), Duration::from_secs(10)).await?) {
            let fields = self.model_field_names(&name).await?;
            note_types.push(NoteTypeInfo { name, fields });
        }
        Ok(Catalog { decks, note_types })
    }
}

/// Parses `notesInfo`. A missing note is `{}` and is skipped; any malformed entry or a note the
/// caller did not ask for is a protocol error, never a silently missing note.
fn parse_notes(v: Value, requested: &[i64]) -> Result<Vec<NoteInfo>, AnkiError> {
    const BAD: &str = "AnkiConnect notesInfo: ответ не соответствует запросу";
    let arr = v.as_array().ok_or_else(|| AnkiError::Protocol(format!("{BAD}: не массив")))?;
    let mut out = Vec::with_capacity(arr.len());
    for n in arr {
        let Some(obj) = n.as_object() else { return Err(AnkiError::Protocol(BAD.into())) };
        // A deleted/missing note comes back as an empty object.
        if obj.is_empty() {
            continue;
        }
        let note_id = obj.get("noteId").and_then(Value::as_i64).ok_or_else(|| AnkiError::Protocol(format!("{BAD}: нет noteId")))?;
        if !requested.contains(&note_id) {
            return Err(AnkiError::Protocol(format!("{BAD}: незапрошенная заметка {note_id}")));
        }
        let model_name = obj.get("modelName").and_then(Value::as_str).ok_or_else(|| AnkiError::Protocol(format!("{BAD}: нет modelName")))?;
        let fields = obj.get("fields").and_then(Value::as_object).ok_or_else(|| AnkiError::Protocol(format!("{BAD}: нет fields")))?;
        let mut out_fields = BTreeMap::new();
        for (k, f) in fields {
            let value = f.get("value").and_then(Value::as_str).ok_or_else(|| AnkiError::Protocol(format!("{BAD}: поле {k} без value")))?;
            let order = f.get("order").and_then(Value::as_i64).unwrap_or(i64::MAX);
            out_fields.insert(k.clone(), NoteInfoField { value: value.to_string(), order });
        }
        let tags = obj
            .get("tags")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|t| t.as_str().map(String::from).ok_or_else(|| AnkiError::Protocol(format!("{BAD}: тег не строка")))).collect::<Result<Vec<_>, _>>())
            .transpose()?
            .unwrap_or_default();
        let cards = obj
            .get("cards")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|c| c.as_i64().ok_or_else(|| AnkiError::Protocol(format!("{BAD}: card не число")))).collect::<Result<Vec<_>, _>>())
            .transpose()?
            .unwrap_or_default();
        out.push(NoteInfo {
            note_id,
            model_name: model_name.to_string(),
            tags,
            cards,
            fields: out_fields,
            profile: obj.get("profile").and_then(Value::as_str).map(String::from),
        });
    }
    Ok(out)
}

/// Request errors without their URL: a URL may carry credentials, and the reason is user-visible.
fn transport_text(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    if let Some(u) = e.url() {
        let raw = u.as_str().to_string();
        if !raw.is_empty() {
            s = s.replace(&raw, "");
        }
    }
    crate::logs::redact(s.trim())
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

    #[test]
    fn notes_parser_accepts_missing_notes_but_rejects_malformed_entries() {
        let ok = json!([{}, {
            "noteId": 42,
            "modelName": "M",
            "tags": ["smartsubs-job::j"],
            "cards": [7],
            "profile": "User 1",
            "fields": { "Word": { "value": "bring", "order": 0 } }
        }]);
        let notes = parse_notes(ok, &[42]).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].note_id, 42);
        assert_eq!(notes[0].field("Word"), Some("bring"));
        assert_eq!(notes[0].cards, vec![7]);

        assert!(parse_notes(json!([{ "noteId": 43 }]), &[42]).is_err(), "an unrequested note is not absence");
        assert!(parse_notes(json!([{ "noteId": 42, "modelName": "M" }]), &[42]).is_err(), "fields are required");
        assert!(parse_notes(json!({ "noteId": 42 }), &[42]).is_err());
    }
}
