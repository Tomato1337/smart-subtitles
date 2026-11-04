//! The note type the app writes into: the built-in one is created on demand, extended with missing
//! fields and kept on the bundled template and CSS; any other note type is used as the user made it.
//!
//! Templates and CSS are copied verbatim from tutor's `anki/flashcards.py`, so cards made by the app
//! look like the ones tutor made.

use crate::{
    anki::connect,
    state::AppState,
};
use anyhow::anyhow;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

pub const BUILTIN_NAME: &str = "Smart Subtitles — Vocab";
pub const BUILTIN_FIELDS: [&str; 12] = [
    "Word",
    "ClozeText",
    "FullSentence",
    "WordTranslation",
    "SentenceTranslation",
    "WordType",
    "Image",
    "WordAudio",
    "SentenceAudio",
    "Clip",
    "ClipText",
    "ClipSource",
];
const TEMPLATE_NAME: &str = "Type the Word";
const CARD_CSS: &str = include_str!("builtin/card.css");
const FRONT_TEMPLATE: &str = include_str!("builtin/front.html");
const BACK_TEMPLATE: &str = include_str!("builtin/back.html");

/// Fields, template and CSS of a note type; `exists` is false for the built-in view of an empty Anki.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTypeView {
    pub name: String,
    pub fields: Vec<String>,
    pub front: String,
    pub back: String,
    pub css: String,
    pub builtin: bool,
    pub exists: bool,
}

/// Builds the built-in note type when Anki does not have it; when it does, adds missing fields and
/// brings its template and CSS up to the bundled version. Other note types are the user's business.
pub async fn ensure(st: &AppState, name: &str) -> anyhow::Result<()> {
    if name != BUILTIN_NAME {
        return Ok(());
    }
    let names = connect::call(st, "modelNames", json!({}), Duration::from_secs(10)).await?;
    let present = names.as_array().is_some_and(|a| a.iter().any(|x| x.as_str() == Some(name)));
    if !present {
        connect::call(
            st,
            "createModel",
            json!({
                "modelName": BUILTIN_NAME,
                "inOrderFields": BUILTIN_FIELDS,
                "css": CARD_CSS,
                "isCloze": false,
                "cardTemplates": [{ "Name": TEMPLATE_NAME, "Front": FRONT_TEMPLATE, "Back": BACK_TEMPLATE }],
            }),
            Duration::from_secs(30),
        )
        .await?;
        return Ok(());
    }
    let have = connect::call(st, "modelFieldNames", json!({ "modelName": name }), Duration::from_secs(10)).await?;
    let mut have: Vec<String> = have.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    for field in BUILTIN_FIELDS {
        if have.iter().any(|h| h == field) {
            continue;
        }
        connect::call(
            st,
            "modelFieldAdd",
            json!({ "modelName": name, "fieldName": field, "index": have.len() }),
            Duration::from_secs(10),
        )
        .await?;
        have.push(field.to_string());
    }
    let templates = connect::call(st, "modelTemplates", json!({ "modelName": name }), Duration::from_secs(10)).await?;
    let current = templates.as_object().and_then(|o| o.iter().next());
    let stale = current.is_none_or(|(_, t)| t["Front"].as_str() != Some(FRONT_TEMPLATE) || t["Back"].as_str() != Some(BACK_TEMPLATE));
    if stale {
        let template = current.map_or(TEMPLATE_NAME, |(n, _)| n.as_str());
        connect::call(
            st,
            "updateModelTemplates",
            json!({ "model": { "name": name, "templates": { template: { "Front": FRONT_TEMPLATE, "Back": BACK_TEMPLATE } } } }),
            Duration::from_secs(10),
        )
        .await?;
    }
    let styling = connect::call(st, "modelStyling", json!({ "modelName": name }), Duration::from_secs(10)).await?;
    if styling["css"].as_str() != Some(CARD_CSS) {
        connect::call(st, "updateModelStyling", json!({ "model": { "name": name, "css": CARD_CSS } }), Duration::from_secs(10)).await?;
    }
    Ok(())
}

/// The note type as Anki has it. Anki down or the built-in type not created yet: the built-in constants.
pub async fn view(st: &AppState, name: &str) -> anyhow::Result<NoteTypeView> {
    let builtin = name == BUILTIN_NAME;
    let names = connect::call(st, "modelNames", json!({}), Duration::from_secs(5)).await;
    let exists = match &names {
        Ok(v) => v.as_array().is_some_and(|a| a.iter().any(|x| x.as_str() == Some(name))),
        Err(_) => false,
    };
    if exists {
        let fields = connect::call(st, "modelFieldNames", json!({ "modelName": name }), Duration::from_secs(10)).await?;
        // The built-in type gets the bundled template and CSS on the next add, so preview those.
        let (front, back, css) = if builtin {
            (FRONT_TEMPLATE.to_string(), BACK_TEMPLATE.to_string(), CARD_CSS.to_string())
        } else {
            let templates = connect::call(st, "modelTemplates", json!({ "modelName": name }), Duration::from_secs(10)).await?;
            let styling = connect::call(st, "modelStyling", json!({ "modelName": name }), Duration::from_secs(10)).await?;
            let (front, back) = first_template(&templates).unwrap_or_default();
            (front, back, styling["css"].as_str().unwrap_or("").to_string())
        };
        return Ok(NoteTypeView {
            name: name.to_string(),
            fields: string_list(&fields),
            front,
            back,
            css,
            builtin,
            exists: true,
        });
    }
    if builtin {
        return Ok(NoteTypeView {
            name: name.to_string(),
            fields: BUILTIN_FIELDS.iter().map(|f| f.to_string()).collect(),
            front: FRONT_TEMPLATE.to_string(),
            back: BACK_TEMPLATE.to_string(),
            css: CARD_CSS.to_string(),
            builtin,
            exists: false,
        });
    }
    let why = match names {
        Ok(_) => String::new(),
        Err(e) => format!(" ({e:#})"),
    };
    Err(anyhow!("Тип заметки «{name}» не найден в Anki{why}"))
}

/// `modelTemplates` shape: `{"Type the Word": {"Front": …, "Back": …}}`; the first one is the card.
fn first_template(v: &Value) -> Option<(String, String)> {
    let o = v.as_object()?;
    let t = o.values().next()?;
    let get = |k: &str| t[k].as_str().unwrap_or("").to_string();
    Some((get("Front"), get("Back")))
}

fn string_list(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_templates_are_complete() {
        assert!(FRONT_TEMPLATE.contains("{{ClozeText}}"));
        assert!(FRONT_TEMPLATE.contains("{{type:Word}}"));
        assert!(BACK_TEMPLATE.contains("{{FullSentence}}") && BACK_TEMPLATE.contains("{{ClipText}}"));
        assert!(CARD_CSS.contains(".clip-wrap"));
        assert_eq!(BUILTIN_FIELDS[0], "Word");
        assert_eq!(BUILTIN_FIELDS.len(), 12);
    }

    #[test]
    fn the_first_template_is_read_from_the_object() {
        let v = json!({ "Type the Word": { "Front": "f", "Back": "b" } });
        assert_eq!(first_template(&v), Some(("f".into(), "b".into())));
        assert_eq!(first_template(&Value::Null), None);
    }
}
