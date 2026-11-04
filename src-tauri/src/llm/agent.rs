use super::{client, prompts, tools};
use crate::{db::now, session::Session, state::AppState, anki::cards::WordDraft};
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Emitter;

const MAX_ITERATIONS: usize = 6;
/// Cues before the learner's position quoted into the latest question.
const CONTEXT_BEFORE: u32 = 8;

const RULES: &str = "Ты в чате с учеником, который смотрит этот фильм. Каждое его сообщение начинается с пометки \
[позиция mm:ss · реплика N]: это место фильма, где он был, когда спрашивал. Слова «эта фраза», «что он сказал», \
«здесь», «сейчас» относятся к этому месту и репликам прямо перед ним. Не пересказывай сюжет дальше позиции ученика \
(без спойлеров). Ссылаясь на реплику, пиши её номер в квадратных скобках, например [229]: в интерфейсе это кнопка \
перехода к реплике. Отвечай на русском в Markdown: короткие абзацы, списки, **жирный** для ключевых слов, без заголовка \
первого уровня. Используй tools как в tutor: предлагай карточки только через propose_cards, никогда не утверждай, что \
добавил в Anki сам.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: i64,
    pub role: String,
    pub text: String,
    /// Where in the film the learner was when sending (user messages).
    pub cue_idx: Option<u32>,
    pub at: Option<f64>,
    pub proposal_id: Option<i64>,
    pub words: Option<Vec<WordDraft>>,
    pub status: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatUsage {
    pub model: String,
    pub model_name: String,
    pub effort: super::tasks::Effort,
    pub context_window: Option<u64>,
    /// Prompt plus output of the latest request: how full the window was.
    pub context_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub usd: Option<f64>,
    /// Some requests in the chat have no known price, so `usd` is a lower bound.
    pub usd_partial: bool,
}

/// Totals of the film's chat plus the currently configured model: the footer before and after a message.
pub async fn usage(st: &AppState, media_id: &str) -> Result<ChatUsage, String> {
    let t = st.cfg().target(super::tasks::Task::Chat);
    let info = super::catalog::model_info_for(st, &t).await;
    let m = media_id.to_string();
    let rows: Vec<(i64, i64, i64, i64, Option<f64>)> = st
        .db(move |c| {
            c.prepare("SELECT input,cache_read,cache_write,output,usd FROM llm_usage WHERE media_id=?1 AND task='chat' ORDER BY id")?
                .query_map(params![m], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect()
        })
        .await?;
    let (input_tokens, output_tokens, context_tokens, usd, usd_partial) = totals(&rows);
    Ok(ChatUsage {
        model: t.model,
        model_name: info.name,
        effort: t.effort,
        context_window: info.context_window,
        context_tokens,
        input_tokens,
        output_tokens,
        usd,
        usd_partial,
    })
}

/// Running totals of the film chat: all prompt tokens, all output, the last request's window fill.
fn totals(rows: &[(i64, i64, i64, i64, Option<f64>)]) -> (u64, u64, u64, Option<f64>, bool) {
    let (mut input_tokens, mut output_tokens, mut context_tokens) = (0u64, 0u64, 0u64);
    let (mut usd, mut priced, mut unpriced) = (0.0f64, false, false);
    for (input, cache_read, cache_write, output, row_usd) in rows {
        let prompt = (input + cache_read + cache_write) as u64;
        input_tokens += prompt;
        output_tokens += *output as u64;
        context_tokens = prompt + *output as u64;
        match row_usd {
            Some(x) => { priced = true; usd += x; }
            None => unpriced = true,
        }
    }
    (input_tokens, output_tokens, context_tokens, if priced { Some(usd) } else { None }, priced && unpriced)
}

/// The film's whole chat, oldest first: one thread per media, kept across closing the panel and restarts.
pub async fn history(st: &AppState, media_id: &str) -> Result<Vec<ChatMessage>, String> {
    let m = media_id.to_string();
    st.db(move |c| load_history(c, &m)).await
}

fn load_history(c: &rusqlite::Connection, media_id: &str) -> rusqlite::Result<Vec<ChatMessage>> {
    let rows = c
        .prepare("SELECT id,role,json,created_at,cue_idx FROM chat_message WHERE media_id=?1 ORDER BY id")?
        .query_map(params![media_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, u32>(4)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = vec![];
    for (id, role, j, created_at, col_cue) in rows {
        let v: Value = serde_json::from_str(&j).unwrap_or(Value::Null);
        if role == "proposal" {
            let pid = v["proposalId"].as_i64().unwrap_or(0);
            let p: Option<(String, String)> = c.query_row("SELECT words_json,status FROM proposal WHERE id=?1", [pid], |r| Ok((r.get(0)?, r.get(1)?))).ok();
            let Some((w, status)) = p else { continue };
            out.push(ChatMessage { id, role, text: String::new(), cue_idx: None, at: None, proposal_id: Some(pid), words: serde_json::from_str(&w).ok(), status: Some(status), created_at });
        } else {
            // Messages from before the per-film thread have no `at` in json: the column holds their cue.
            let cue_idx = if v.get("at").is_some() { v["cue"].as_u64().map(|x| x as u32) } else { Some(col_cue) };
            out.push(ChatMessage { id, role, text: v["text"].as_str().unwrap_or("").to_string(), cue_idx, at: v["at"].as_f64(), proposal_id: None, words: None, status: None, created_at });
        }
    }
    Ok(out)
}

async fn save(st: &AppState, media_id: &str, role: &'static str, body: Value, cue_idx: Option<u32>) {
    let m = media_id.to_string();
    let _ = st.db(move |c| { c.execute("INSERT INTO chat_message(media_id,cue_idx,role,json,created_at) VALUES(?1,?2,?3,?4,?5)", params![m, cue_idx.unwrap_or(0), role, body.to_string(), now()])?; Ok(()) }).await;
}

fn emit(st: &AppState, name: &str, payload: Value) { let _ = st.app.emit(name, payload); }

/// `[позиция 12:34 · реплика 618]` tag put in front of a user message for the model.
fn position_tag(cue_idx: Option<u32>, at: Option<f64>) -> String {
    match (at, cue_idx) {
        (Some(t), Some(i)) => format!("[позиция {} · реплика {i}]", prompts::mmss(t)),
        (Some(t), None) => format!("[позиция {} · до первой реплики]", prompts::mmss(t)),
        (None, Some(i)) => format!("[реплика {i}]"),
        (None, None) => String::new(),
    }
}

/// Stores the user message with the learner's position and runs the tool loop in the background;
/// progress arrives as agent:* events.
pub async fn send(st: &Arc<AppState>, s: &Arc<Session>, cue_idx: Option<u32>, at: f64, text: String) -> Result<(), String> {
    if st.cfg().target(super::tasks::Task::Chat).endpoint.api_key.is_empty() { return Err("LLM не настроен".into()); }
    if !st.agent_busy.lock().unwrap().insert(s.media_id.clone()) { return Err("агент ещё отвечает".into()); }
    save(st, &s.media_id, "user", json!({ "text": text, "cue": cue_idx, "at": at }), cue_idx).await;
    let (st2, s2) = (st.clone(), s.clone());
    tauri::async_runtime::spawn(async move {
        let res = run(&st2, &s2, cue_idx).await;
        st2.agent_busy.lock().unwrap().remove(&s2.media_id);
        match res {
            Ok(()) => emit(&st2, "agent:done", json!({ "mediaId": s2.media_id })),
            Err(e) => {
                crate::logs::log("llm", &format!("agent: {e}"));
                emit(&st2, "agent:error", json!({ "mediaId": s2.media_id, "message": e }));
            }
        }
    });
    Ok(())
}

/// Lines `[i] mm:ss text` of the cues up to and including `cue_idx`.
async fn recent_cues(st: &AppState, media_id: &str, cue_idx: u32) -> Result<String, String> {
    let (m, from) = (media_id.to_string(), cue_idx.saturating_sub(CONTEXT_BEFORE));
    let rows: Vec<(u32, f64, String)> = st
        .db(move |c| {
            c.prepare("SELECT idx,start,text FROM cue WHERE media_id=?1 AND idx BETWEEN ?2 AND ?3 ORDER BY idx")?
                .query_map(params![m, from, cue_idx], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        })
        .await?;
    Ok(rows.iter().map(|(i, t, x)| format!("[{i}] {} {}", prompts::mmss(*t), x.replace('\n', " / "))).collect::<Vec<_>>().join("\n"))
}

async fn run(st: &Arc<AppState>, s: &Arc<Session>, cue_idx: Option<u32>) -> Result<(), String> {
    let mut messages = (*prompts::prefix(st, s).await.map_err(|e| e.to_string())?).clone();
    messages.push(json!({ "role": "system", "content": RULES }));
    let hist = history(st, &s.media_id).await?;
    let last_user = hist.iter().rposition(|m| m.role == "user");
    for (k, m) in hist.iter().enumerate() {
        match m.role.as_str() {
            "assistant" => messages.push(json!({ "role": "assistant", "content": m.text })),
            "user" => {
                let mut content = format!("{} {}", position_tag(m.cue_idx, m.at), m.text).trim().to_string();
                // Only the newest question carries the quoted scene, so earlier turns stay byte-stable for the prefix cache.
                if Some(k) == last_user {
                    if let Some(i) = m.cue_idx {
                        content = format!("Последние реплики до моей позиции:\n{}\n\n{content}", recent_cues(st, &s.media_id, i).await?);
                    }
                }
                messages.push(json!({ "role": "user", "content": content }));
            }
            _ => {}
        }
    }
    let tool_defs = tools::openai_tools();
    let ctx = tools::ToolCtx { st: st.clone(), session: s.clone(), cue_idx: cue_idx.unwrap_or(0) };
    let mut final_text = String::new();
    for _ in 0..MAX_ITERATIONS {
        let mid = s.media_id.clone();
        let st2 = st.clone();
        let turn = client::chat_stream(st, super::tasks::Task::Chat, &s.media_id, "agent", &messages, &tool_defs, move |t| emit(&st2, "agent:delta", json!({ "mediaId": mid, "text": t }))).await.map_err(|e| e.to_string())?;
        final_text.push_str(&turn.content);
        if turn.tool_calls.is_empty() { break; }
        let mut assistant = json!({
            "role": "assistant",
            "content": turn.content,
            "tool_calls": turn.tool_calls.iter().map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.arguments } })).collect::<Vec<_>>(),
        });
        // DeepSeek needs its own reasoning back in the tool loop; Anthropic needs the thinking blocks.
        if !turn.reasoning.is_empty() { assistant["reasoning_content"] = json!(turn.reasoning); }
        if !turn.thinking.is_empty() { assistant["anthropic_thinking"] = json!(turn.thinking); }
        messages.push(assistant);
        for c in &turn.tool_calls {
            emit(st, "agent:tool", json!({ "mediaId": s.media_id, "name": c.name }));
            let args: Value = serde_json::from_str(&c.arguments).unwrap_or(json!({}));
            let out = tools::call_tool(&ctx, &c.name, args).await;
            messages.push(json!({ "role": "tool", "tool_call_id": c.id, "content": out }));
        }
        final_text.push_str("\n\n");
    }
    let text = final_text.trim().to_string();
    if !text.is_empty() { save(st, &s.media_id, "assistant", json!({ "text": text }), cue_idx).await; }
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_totals_count_cache_and_the_last_context() {
        let rows = [(100, 900, 0, 50, Some(0.01)), (200, 1800, 0, 70, None)];
        let (input, output, context, usd, partial) = totals(&rows);
        assert_eq!((input, output, context), (3000, 120, 2070));
        assert_eq!(usd, Some(0.01));
        assert!(partial);
        assert_eq!(totals(&[]), (0, 0, 0, None, false));
    }

    #[test]
    fn history_is_one_thread_per_film_and_keeps_legacy_cues() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init(&c).unwrap();
        let add = |m: &str, cue: u32, role: &str, j: &str| {
            c.execute("INSERT INTO chat_message(media_id,cue_idx,role,json,created_at) VALUES(?1,?2,?3,?4,0)", params![m, cue, role, j]).unwrap();
        };
        add("film", 12, "user", r#"{"text":"old"}"#);
        add("film", 12, "assistant", r#"{"text":"old answer"}"#);
        add("other", 3, "user", r#"{"text":"another film"}"#);
        add("film", 40, "user", r#"{"text":"new","cue":40,"at":125.5}"#);
        add("film", 0, "user", r#"{"text":"before cues","cue":null,"at":2.0}"#);
        let h = load_history(&c, "film").unwrap();
        let got: Vec<_> = h.iter().map(|m| (m.text.as_str(), m.cue_idx, m.at)).collect();
        assert_eq!(got, vec![
            ("old", Some(12), None),
            ("old answer", Some(12), None),
            ("new", Some(40), Some(125.5)),
            ("before cues", None, Some(2.0)),
        ]);
    }
}
