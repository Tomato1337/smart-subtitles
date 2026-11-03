use super::prompts::mmss;
use crate::{patterns, session::Session, state::AppState, tutor::{anki_index, cards::{self, WordDraft}}};
use rusqlite::params;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::Emitter;

pub struct ToolCtx { pub st: Arc<AppState>, pub session: Arc<Session>, pub cue_idx: u32 }

const WORD_FIELDS: [&str; 7] = ["word", "translation", "word_type", "cloze_sentence", "full_sentence", "sentence_translation", "image_prompt"];
const STATUSES: [&str; 6] = ["new", "learning", "young", "learned", "weak", "leech"];

fn s(description: &str) -> Value { json!({ "type": "string", "description": description }) }

/// Same shape as tutor's WORD_SCHEMA (lib/memory.mjs).
pub fn word_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "word": s("English word or phrase"),
            "translation": s("Russian translation"),
            "word_type": s("noun, verb, adjective…"),
            "cloze_sentence": s("A1 sentence with the word replaced by {{c1::word}}"),
            "full_sentence": s("Same sentence in full"),
            "sentence_translation": s("Russian translation of the sentence"),
            "image_prompt": s("Concrete English image prompt: one visible scene showing the word's meaning, no text or letters in the picture"),
        },
        "required": WORD_FIELDS,
        "additionalProperties": false,
    })
}

/// Tool descriptions in tutor's `{name,label,description,parameters}` form.
pub fn definitions() -> Vec<Value> {
    let mut statuses: Vec<&str> = STATUSES.to_vec();
    statuses.push("problem");
    vec![
        json!({
            "name": "media_transcript", "label": "Transcript",
            "description": "Lines of the current film's script: [idx] m:ss text | russian. At most 120 lines; use fromMs/toMs (milliseconds) to choose a window.",
            "parameters": { "type": "object", "properties": {
                "fromMs": { "type": "integer", "minimum": 0 }, "toMs": { "type": "integer", "minimum": 0 } }, "additionalProperties": false },
        }),
        json!({
            "name": "anki_words", "label": "Anki words",
            "description": "Words of the Anki deck 'Learning English' with status (new, learning, young, learned, weak, leech; 'problem' = weak+leech). With 'word': only that word. It never changes Anki.",
            "parameters": { "type": "object", "properties": {
                "status": { "type": "string", "enum": statuses }, "word": s("One word to look up") }, "additionalProperties": false },
        }),
        json!({
            "name": "pattern_ref", "label": "Grammar pattern",
            "description": "Grammar pattern from the catalog: formula, explanation, where it occurs in this film and how many times the learner has met it.",
            "parameters": { "type": "object", "properties": { "id": s("Pattern id, e.g. PRESENT_PERFECT") }, "required": ["id"], "additionalProperties": false },
        }),
        json!({
            "name": "propose_cards", "label": "Propose cards",
            "description": "Propose 1-10 Anki cards. The learner decides; you cannot add cards yourself. Use for words and phrases worth learning.",
            "parameters": { "type": "object", "properties": { "words": { "type": "array", "minItems": 1, "maxItems": 10, "items": word_schema() } }, "required": ["words"], "additionalProperties": false },
        }),
    ]
}

/// OpenAI function-calling form of `definitions()`.
pub fn openai_tools() -> Vec<Value> {
    definitions().into_iter().map(|d| json!({ "type": "function", "function": { "name": d["name"], "description": d["description"], "parameters": d["parameters"] } })).collect()
}

pub async fn call_tool(ctx: &ToolCtx, name: &str, args: Value) -> String {
    match name {
        "media_transcript" => transcript(ctx, &args).await,
        "anki_words" => anki_words(ctx, &args).await,
        "pattern_ref" => pattern_ref(ctx, &args).await,
        "propose_cards" => propose_cards(ctx, &args).await,
        _ => format!("Unknown tool {name}"),
    }
}

async fn transcript(ctx: &ToolCtx, a: &Value) -> String {
    let from = a["fromMs"].as_f64().map(|v| v / 1000.0).unwrap_or(0.0);
    let to = a["toMs"].as_f64().map(|v| v / 1000.0).unwrap_or(f64::MAX);
    let m = ctx.session.media_id.clone();
    let rows: Result<Vec<(u32, f64, String, Option<String>)>, String> = ctx
        .st
        .db(move |c| {
            c.prepare("SELECT idx,start,text,ru FROM cue WHERE media_id=?1 AND end>=?2 AND start<=?3 ORDER BY idx LIMIT 120")?
                .query_map(params![m, from, to.min(1e12)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect()
        })
        .await;
    match rows {
        Ok(r) if r.is_empty() => "No lines in this range".into(),
        Ok(r) => r.iter().map(|(i, t, x, ru)| format!("[{i}] {} {} | {}", mmss(*t), x.replace('\n', " / "), ru.clone().unwrap_or_default())).collect::<Vec<_>>().join("\n"),
        Err(e) => e,
    }
}

async fn anki_words(ctx: &ToolCtx, a: &Value) -> String {
    let status = a["status"].as_str();
    let word = a["word"].as_str().map(|w| w.trim().to_lowercase()).filter(|w| !w.is_empty());
    let api_status = match status { Some("problem") => "problem", Some("learned") => "learned", _ => "all" };
    let tutor_url = ctx.st.cfg().tutor.api_url.clone();
    let mut url = format!("{}/api/anki/words?status={api_status}&limit=200", tutor_url.trim_end_matches('/'));
    if let Some(w) = &word { url.push_str(&format!("&q={}", url::form_urlencoded::byte_serialize(w.as_bytes()).collect::<String>())); }
    let down = || format!("Tutor не запущен ({tutor_url})");
    let Ok(r) = ctx.st.http.get(&url).timeout(Duration::from_secs(10)).send().await else { return down() };
    let Ok(v) = r.json::<Value>().await else { return down() };
    let mut out = vec![];
    for w in v["words"].as_array().cloned().unwrap_or_default() {
        let st_ = w["status"].as_str().unwrap_or("");
        if let Some(want) = status.filter(|x| STATUSES.contains(x)) { if st_ != want { continue; } }
        let text = w["word"].as_str().unwrap_or("");
        if let Some(q) = &word { if !text.to_lowercase().contains(q.as_str()) { continue; } }
        out.push(format!("{text} | {st_} | interval {}d | lapses {}", w["interval"], w["lapses"]));
        if out.len() == 60 { break; }
    }
    if out.is_empty() { "No matching words".into() } else { out.join("\n") }
}

async fn pattern_ref(ctx: &ToolCtx, a: &Value) -> String {
    let id = a["id"].as_str().unwrap_or("");
    let Some(p) = patterns::get(id) else { return format!("Unknown pattern {id}") };
    let (m, pid) = (ctx.session.media_id.clone(), id.to_string());
    let data: Result<(Vec<(u32, String)>, i64), String> = ctx
        .st
        .db(move |c| {
            let occ = c
                .prepare("SELECT c.idx,c.text FROM cue_pattern p JOIN cue c ON c.media_id=p.media_id AND c.idx=p.cue_idx WHERE p.media_id=?1 AND p.pattern_id=?2 ORDER BY c.idx LIMIT 30")?
                .query_map(params![m, pid], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            let n: i64 = c.query_row("SELECT count(*) FROM exposure WHERE pattern_id=?1", [&pid], |r| r.get(0))?;
            Ok((occ, n))
        })
        .await;
    let (occ, n) = data.unwrap_or_default();
    let lines: Vec<String> = occ.iter().map(|(i, t)| format!("[{i}] {}", t.replace('\n', " / "))).collect();
    format!("{} ({}) — {}\nLevel {}. {}\nLearner has met it {n} times in total.\nIn this film:\n{}", p.id, p.formula, p.label, p.level, p.about, if lines.is_empty() { "(none)".into() } else { lines.join("\n") })
}

async fn propose_cards(ctx: &ToolCtx, a: &Value) -> String {
    let Some(list) = a["words"].as_array() else { return "words must be an array".into() };
    if list.is_empty() || list.len() > 10 { return "Propose between 1 and 10 words".into(); }
    let mut words: Vec<WordDraft> = vec![];
    for w in list {
        for f in WORD_FIELDS {
            if f == "image_prompt" { continue; }
            if w[f].as_str().map(|x| x.trim().is_empty() || x.len() > 400).unwrap_or(true) { return format!("Each word needs {f}"); }
        }
        let d: WordDraft = match serde_json::from_value(w.clone()) { Ok(d) => d, Err(e) => return format!("Invalid word: {e}") };
        if !d.cloze_sentence.contains("{{c1::") { return format!("cloze_sentence of «{}» must contain {{{{c1::…}}}}", d.word); }
        words.push(d);
    }
    let (fresh, dup): (Vec<_>, Vec<_>) = words.into_iter().partition(|w| !anki_index::has_exact(&ctx.st, &w.word));
    if fresh.is_empty() { return format!("All {} words are already in the deck; nothing proposed.", dup.len()); }
    let id = match cards::create_proposal(&ctx.st, &ctx.session.media_id, ctx.cue_idx, &fresh).await { Ok(i) => i, Err(e) => return e };
    let (m, ci) = (ctx.session.media_id.clone(), ctx.cue_idx);
    let _ = ctx.st.db(move |c| { c.execute("INSERT INTO chat_message(media_id,cue_idx,role,json,created_at) VALUES(?1,?2,'proposal',?3,?4)", params![m, ci, json!({ "proposalId": id }).to_string(), crate::db::now()])?; Ok(()) }).await;
    let _ = ctx.st.app.emit("agent:proposal", json!({ "mediaId": ctx.session.media_id, "proposalId": id, "words": fresh }));
    let skipped = if dup.is_empty() { String::new() } else { format!(" Skipped {} already in the deck.", dup.len()) };
    format!("Proposed {} cards; the learner decides. Do not repeat the list in your reply.{skipped}", fresh.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_have_tutor_shape() {
        let d = definitions();
        assert_eq!(d.iter().map(|t| t["name"].as_str().unwrap()).collect::<Vec<_>>(), ["media_transcript", "anki_words", "pattern_ref", "propose_cards"]);
        for t in &d { assert!(t["label"].is_string() && t["description"].is_string() && t["parameters"]["type"] == "object"); }
        let w = &d[3]["parameters"]["properties"]["words"]["items"];
        assert_eq!(w["required"].as_array().unwrap().len(), 7);
        assert_eq!(w["additionalProperties"], false);
    }

    #[test]
    fn openai_form() {
        let t = openai_tools();
        assert_eq!(t[0]["type"], "function");
        assert_eq!(t[0]["function"]["name"], "media_transcript");
        assert!(t[0]["function"]["parameters"].is_object());
    }
}
