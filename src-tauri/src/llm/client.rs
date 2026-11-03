use crate::{logs, state::AppState};
use anyhow::{anyhow, bail};
use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::time::Duration;

fn body(st: &AppState, messages: &[Value], max_tokens: u32, json_mode: bool) -> Value {
    let mut b = json!({
        "model": st.cfg.llm.model,
        "messages": messages,
        "max_tokens": max_tokens,
        "thinking": { "type": "disabled" },
        "temperature": 0.3,
    });
    if json_mode { b["response_format"] = json!({ "type": "json_object" }); }
    b
}

fn log_usage(tag: &str, v: &Value) {
    let u = &v["usage"];
    logs::log("llm", &format!(
        "{tag} prompt={} cache_hit={} completion={}",
        u["prompt_tokens"], u["prompt_cache_hit_tokens"], u["completion_tokens"]
    ));
}

async fn post(st: &AppState, b: &Value, timeout: Duration) -> anyhow::Result<reqwest::Response> {
    let url = format!("{}/chat/completions", st.cfg.llm.base_url.trim_end_matches('/'));
    let mut last = anyhow!("нет попыток");
    for delay in [0u64, 2, 8] {
        if delay > 0 { tokio::time::sleep(Duration::from_secs(delay)).await; }
        match st.http.post(&url).bearer_auth(&st.cfg.llm.api_key).timeout(timeout).json(b).send().await {
            Ok(r) if r.status().is_success() => return Ok(r),
            Ok(r) if r.status().is_server_error() || r.status().as_u16() == 429 => last = anyhow!("LLM HTTP {}", r.status()),
            Ok(r) => {
                let s = r.status();
                bail!("LLM HTTP {s}: {}", r.text().await.unwrap_or_default().chars().take(300).collect::<String>())
            }
            Err(e) => last = e.into(),
        }
    }
    Err(last)
}

/// JSON-mode completion. One extra attempt if the reply is not valid JSON for `T`.
pub async fn chat_json<T: DeserializeOwned>(st: &AppState, tag: &str, messages: &[Value], max_tokens: u32) -> anyhow::Result<T> {
    if !st.cfg.llm_enabled() { bail!("нет ключа DeepSeek"); }
    let b = body(st, messages, max_tokens, true);
    let mut err = anyhow!("пустой ответ");
    for _ in 0..2 {
        let v: Value = post(st, &b, Duration::from_secs(120)).await?.json().await?;
        log_usage(tag, &v);
        let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("");
        match serde_json::from_str::<T>(content) {
            Ok(t) => return Ok(t),
            Err(e) => err = anyhow!("ответ не JSON: {e}"),
        }
    }
    Err(err)
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolCall { pub id: String, pub name: String, pub arguments: String }

#[derive(Debug, Default)]
pub struct Turn { pub content: String, pub tool_calls: Vec<ToolCall> }

/// Accumulates SSE `data:` lines of a streamed chat completion into one assistant turn.
#[derive(Default)]
pub struct SseAccumulator { pub turn: Turn, pub done: bool, pub usage: Option<Value> }

impl SseAccumulator {
    /// Returns the text delta carried by this line, if any.
    pub fn feed(&mut self, line: &str) -> Option<String> {
        let data = line.strip_prefix("data:")?.trim();
        if data == "[DONE]" { self.done = true; return None; }
        let v: Value = serde_json::from_str(data).ok()?;
        if v.get("usage").is_some_and(|u| !u.is_null()) { self.usage = Some(v.clone()); }
        let d = &v["choices"][0]["delta"];
        if let Some(tcs) = d["tool_calls"].as_array() {
            for tc in tcs {
                let i = tc["index"].as_u64().unwrap_or(0) as usize;
                while self.turn.tool_calls.len() <= i { self.turn.tool_calls.push(ToolCall::default()); }
                let slot = &mut self.turn.tool_calls[i];
                if let Some(id) = tc["id"].as_str() { slot.id = id.to_string(); }
                if let Some(n) = tc["function"]["name"].as_str() { slot.name.push_str(n); }
                if let Some(a) = tc["function"]["arguments"].as_str() { slot.arguments.push_str(a); }
            }
        }
        let text = d["content"].as_str().filter(|t| !t.is_empty())?;
        self.turn.content.push_str(text);
        Some(text.to_string())
    }
}

/// Streaming completion with tools; `on_text` receives each text delta as it arrives.
pub async fn chat_stream(st: &AppState, tag: &str, messages: &[Value], tools: &[Value], mut on_text: impl FnMut(&str)) -> anyhow::Result<Turn> {
    if !st.cfg.llm_enabled() { bail!("нет ключа DeepSeek"); }
    let mut b = body(st, messages, 2000, false);
    b["stream"] = json!(true);
    b["stream_options"] = json!({ "include_usage": true });
    if !tools.is_empty() { b["tools"] = json!(tools); }
    let resp = post(st, &b, Duration::from_secs(180)).await?;
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut acc = SseAccumulator::default();
    while let Some(chunk) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk?));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            if let Some(t) = acc.feed(line.trim()) { on_text(&t); }
        }
    }
    if let Some(u) = &acc.usage { log_usage(tag, u); }
    Ok(acc.turn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_text_and_split_tool_calls() {
        let mut a = SseAccumulator::default();
        assert_eq!(a.feed(r#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#).as_deref(), Some("Hel"));
        a.feed(r#"data: {"choices":[{"delta":{"content":"lo"}}]}"#);
        a.feed(r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"anki_words","arguments":"{\"wo"}}]}}]}"#);
        a.feed(r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"rd\":\"bring\"}"}}]}}]}"#);
        a.feed(r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"pattern_ref","arguments":"{}"}}]}}]}"#);
        a.feed("data: [DONE]");
        assert!(a.done);
        assert_eq!(a.turn.content, "Hello");
        assert_eq!(a.turn.tool_calls.len(), 2);
        assert_eq!(a.turn.tool_calls[0], ToolCall { id: "c1".into(), name: "anki_words".into(), arguments: r#"{"word":"bring"}"#.into() });
        assert_eq!(a.turn.tool_calls[1].name, "pattern_ref");
    }

    #[test]
    fn ignores_non_data_lines() {
        let mut a = SseAccumulator::default();
        assert!(a.feed(": keep-alive").is_none());
        assert!(a.feed("").is_none());
        assert!(a.turn.content.is_empty());
    }
}
