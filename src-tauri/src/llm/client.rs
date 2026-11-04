use super::providers::{anthropic_url, Api, Auth, Endpoint};
use super::tasks::{Effort, Target};
use super::usage::{self, Usage};
use crate::{logs, state::AppState};
use anyhow::{anyhow, bail};
use futures_util::StreamExt;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

/// Client for LLM traffic: reqwest strips `Authorization` but not `x-api-key` when a redirect
/// changes host, so only same-host hops are followed.
pub fn http_client() -> anyhow::Result<reqwest::Client> {
    let policy = reqwest::redirect::Policy::custom(|a| {
        let same = a.previous().last().is_some_and(|p| p.host_str() == a.url().host_str() && p.port_or_known_default() == a.url().port_or_known_default());
        if same && a.previous().len() < 5 { a.follow() } else { a.stop() }
    });
    Ok(reqwest::Client::builder().redirect(policy).build()?)
}

/// Applies the provider's auth scheme; Anthropic also needs its version header.
pub(crate) fn authed(rb: reqwest::RequestBuilder, ep: &Endpoint) -> reqwest::RequestBuilder {
    let rb = match ep.auth {
        Auth::Bearer => rb.bearer_auth(&ep.api_key),
        Auth::XApiKey => rb.header("x-api-key", &ep.api_key),
    };
    if ep.api == Api::Anthropic { rb.header("anthropic-version", "2023-06-01") } else { rb }
}

fn body(t: &Target, messages: &[Value], max_tokens: u32, json_mode: bool) -> Value {
    let extra = t.effort.extra_tokens();
    let deepseek = t.endpoint.base_url.contains("deepseek.com");
    let mut b = if t.effort == Effort::Off {
        json!({
            "model": t.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0.3,
        })
    } else if deepseek {
        // DeepSeek switches thinking with its own field and rejects `temperature` in that mode.
        json!({
            "model": t.model,
            "messages": messages,
            "max_tokens": max_tokens + extra,
            "thinking": { "type": "enabled" },
        })
    } else {
        json!({
            "model": t.model,
            "messages": messages,
            "max_completion_tokens": max_tokens + extra,
            "reasoning_effort": t.effort.as_str(),
        })
    };
    // A DeepSeek-only field: OpenAI and most gateways reject unknown parameters.
    if t.effort == Effort::Off && deepseek { b["thinking"] = json!({ "type": "disabled" }); }
    if json_mode { b["response_format"] = json!({ "type": "json_object" }); }
    b
}

/// Converts the OpenAI-shaped messages the callers build into an Anthropic Messages request.
pub(crate) fn anthropic_body(model: &str, effort: Effort, messages: &[Value], tools: &[Value], max_tokens: u32, stream: bool) -> Value {
    let mut system: Vec<Value> = vec![];
    let mut out: Vec<Value> = vec![];
    let mut cache_marked = false;
    for m in messages {
        match m["role"].as_str().unwrap_or("") {
            "system" => system.push(json!({ "type": "text", "text": m["content"].as_str().unwrap_or("") })),
            "user" => {
                let block = json!({ "type": "text", "text": m["content"].as_str().unwrap_or("") });
                let mut blocks = vec![block];
                // Cache breakpoint on the film+script prefix: the one message every request shares.
                if !cache_marked {
                    blocks[0]["cache_control"] = json!({ "type": "ephemeral" });
                    cache_marked = true;
                }
                out.push(json!({ "role": "user", "content": blocks }));
            }
            "assistant" => {
                let mut blocks: Vec<Value> = vec![];
                // Thinking blocks must be replayed first when a tool loop continues a reasoned turn.
                if let Some(thinking) = m["anthropic_thinking"].as_array() {
                    blocks.extend(thinking.iter().cloned());
                }
                let text = m["content"].as_str().unwrap_or("");
                if !text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                if let Some(calls) = m["tool_calls"].as_array() {
                    for c in calls {
                        let input = serde_json::from_str::<Value>(c["function"]["arguments"].as_str().unwrap_or("")).unwrap_or(json!({}));
                        blocks.push(json!({ "type": "tool_use", "id": c["id"], "name": c["function"]["name"], "input": input }));
                    }
                }
                if !blocks.is_empty() {
                    out.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
            "tool" => {
                let block = json!({ "type": "tool_result", "tool_use_id": m["tool_call_id"], "content": m["content"] });
                let append = out.last().is_some_and(|last: &Value| {
                    last["role"] == "user" && last["content"].as_array().and_then(|a| a.last()).is_some_and(|b| b["type"] == "tool_result")
                });
                if append {
                    out.last_mut().and_then(|m| m["content"].as_array_mut()).unwrap().push(block);
                } else {
                    out.push(json!({ "role": "user", "content": [block] }));
                }
            }
            _ => {}
        }
    }
    let mut b = if effort == Effort::Off {
        json!({ "model": model, "max_tokens": max_tokens, "temperature": 0.3, "system": system, "messages": out })
    } else {
        json!({
            "model": model,
            "max_tokens": max_tokens + effort.extra_tokens(),
            "thinking": { "type": "adaptive" },
            "output_config": { "effort": effort.as_str() },
            "system": system,
            "messages": out,
        })
    };
    if stream { b["stream"] = json!(true); }
    if !tools.is_empty() {
        b["tools"] = json!(tools
            .iter()
            .map(|t| json!({ "name": t["function"]["name"], "description": t["function"]["description"], "input_schema": t["function"]["parameters"] }))
            .collect::<Vec<_>>());
    }
    b
}

/// Some gateways predate adaptive thinking: the same request in budget mode still reasons.
fn anthropic_budget_fallback(b: &mut Value, effort: Effort) {
    b["thinking"] = json!({ "type": "enabled", "budget_tokens": effort.extra_tokens() });
    if let Some(o) = b.as_object_mut() {
        o.remove("output_config");
    }
}

/// Parses a JSON reply that may be wrapped in a Markdown fence, which Claude often adds.
pub(crate) fn extract_json(text: &str) -> String {
    let t = text.trim();
    match (t.find('{'), t.rfind('}')) {
        (Some(a), Some(b)) if a < b => t[a..=b].to_string(),
        _ => t.to_string(),
    }
}

fn log_usage(tag: &str, u: &Usage) {
    logs::log("llm", &format!("{tag} prompt={} cache_hit={} completion={}", u.prompt(), u.cache_read, u.output));
}

fn chat_url(ep: &Endpoint) -> String {
    match ep.api {
        Api::Openai => format!("{}/chat/completions", ep.base_url.trim_end_matches('/')),
        Api::Anthropic => anthropic_url(&ep.base_url, "/messages"),
    }
}

async fn post(http: &reqwest::Client, ep: &Endpoint, b: &Value, timeout: Duration) -> anyhow::Result<reqwest::Response> {
    let url = chat_url(ep);
    let mut last = anyhow!("нет попыток");
    for delay in [0u64, 2, 8] {
        if delay > 0 { tokio::time::sleep(Duration::from_secs(delay)).await; }
        match authed(http.post(&url), ep).timeout(timeout).json(b).send().await {
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

/// `post`, retrying once in budget mode when the gateway does not know adaptive thinking.
async fn send(http: &reqwest::Client, t: &Target, b: &mut Value, timeout: Duration) -> anyhow::Result<reqwest::Response> {
    match post(http, &t.endpoint, b, timeout).await {
        Err(e) if t.endpoint.api == Api::Anthropic && t.effort != Effort::Off && format!("{e:#}").contains("adaptive thinking is not supported") => {
            logs::log("llm", "anthropic: adaptive thinking unsupported, retrying in budget mode");
            anthropic_budget_fallback(b, t.effort);
            post(http, &t.endpoint, b, timeout).await
        }
        r => r,
    }
}

/// Outcome of `ping`: how long the model took and what it answered.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ping {
    pub ms: u64,
    pub reply: String,
}

/// One minimal completion with the same body shape a real call sends, to check that the
/// provider answers with this model at all. Not recorded in `llm_usage` and never retried.
pub async fn ping(http: &reqwest::Client, t: &Target) -> anyhow::Result<Ping> {
    let messages = vec![json!({ "role": "user", "content": "ping" })];
    let b = match t.endpoint.api {
        Api::Openai => body(t, &messages, 8, false),
        Api::Anthropic => anthropic_body(&t.model, Effort::Off, &messages, &[], 8, false),
    };
    let started = std::time::Instant::now();
    let r = authed(http.post(chat_url(&t.endpoint)), &t.endpoint).timeout(Duration::from_secs(20)).json(&b).send().await?;
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("LLM HTTP {status}: {}", text.chars().take(300).collect::<String>());
    }
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let reply = match t.endpoint.api {
        Api::Openai => v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string(),
        Api::Anthropic => v["content"]
            .as_array()
            .map(|a| a.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<String>())
            .unwrap_or_default(),
    };
    Ok(Ping { ms: started.elapsed().as_millis() as u64, reply: reply.trim().chars().take(120).collect() })
}

/// JSON-mode completion. One extra attempt if the reply is not valid JSON for `T`.
pub(crate) async fn json_completion<T: DeserializeOwned>(http: &reqwest::Client, t: &Target, tag: &str, messages: &[Value], max_tokens: u32, usage: &mut Usage) -> anyhow::Result<T> {
    if t.endpoint.api_key.is_empty() { bail!("LLM не настроен"); }
    let mut b = match t.endpoint.api {
        Api::Openai => body(t, messages, max_tokens, true),
        Api::Anthropic => anthropic_body(&t.model, t.effort, messages, &[], max_tokens, false),
    };
    let mut err = anyhow!("пустой ответ");
    for _ in 0..2 {
        let v: Value = send(http, t, &mut b, Duration::from_secs(120)).await?.json().await?;
        let round = Usage::from_api(t.endpoint.api, &v["usage"]);
        usage.add(round);
        log_usage(tag, &round);
        let text = match t.endpoint.api {
            Api::Openai => v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string(),
            Api::Anthropic => v["content"]
                .as_array()
                .map(|a| a.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<String>())
                .unwrap_or_default(),
        };
        match serde_json::from_str::<T>(&extract_json(&text)) {
            Ok(out) => return Ok(out),
            Err(e) => err = anyhow!("ответ не JSON: {e}"),
        }
    }
    Err(err)
}

/// JSON-mode completion against the live config; the paid tokens land in `llm_usage` either way.
pub async fn chat_json<T: DeserializeOwned>(st: &AppState, task: super::tasks::Task, media_id: &str, tag: &str, messages: &[Value], max_tokens: u32) -> anyhow::Result<T> {
    let t = st.cfg().target(task);
    let mut u = Usage::default();
    let r = json_completion::<T>(&st.llm_http, &t, tag, messages, max_tokens, &mut u).await;
    usage::record(st, media_id, &t, u).await;
    r
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolCall { pub id: String, pub name: String, pub arguments: String }

#[derive(Debug, Default)]
pub struct Turn {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    /// OpenAI-style reasoning (`reasoning_content`), replayed in a DeepSeek tool loop.
    pub reasoning: String,
    /// Anthropic thinking blocks, replayed in an Anthropic tool loop.
    pub thinking: Vec<Value>,
}

/// Accumulates SSE `data:` lines of a streamed completion into one assistant turn.
#[derive(Default)]
pub struct SseAccumulator {
    pub turn: Turn,
    pub done: bool,
    /// The protocol's usage object, as it arrived.
    pub usage: Option<Value>,
    pub api: Api,
    pub error: Option<String>,
    /// Anthropic content-block index → position in `turn.tool_calls`.
    blocks: HashMap<u64, usize>,
    /// Anthropic content-block index → position in `turn.thinking`.
    thinking_blocks: HashMap<u64, usize>,
}

impl SseAccumulator {
    /// Returns the text delta carried by this line, if any.
    pub fn feed(&mut self, line: &str) -> Option<String> {
        let data = line.strip_prefix("data:")?.trim();
        if data == "[DONE]" { self.done = true; return None; }
        let v: Value = serde_json::from_str(data).ok()?;
        match self.api {
            Api::Openai => self.feed_openai(&v),
            Api::Anthropic => self.feed_anthropic(&v),
        }
    }

    fn feed_openai(&mut self, v: &Value) -> Option<String> {
        if v.get("usage").is_some_and(|u| !u.is_null()) { self.usage = Some(v["usage"].clone()); }
        let d = &v["choices"][0]["delta"];
        if let Some(r) = d["reasoning_content"].as_str() { self.turn.reasoning.push_str(r); }
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

    fn feed_anthropic(&mut self, v: &Value) -> Option<String> {
        match v["type"].as_str().unwrap_or("") {
            "message_start" => {
                if let Some(u) = v.pointer("/message/usage").filter(|u| !u.is_null()) { self.usage = Some(u.clone()); }
                None
            }
            "content_block_start" => {
                let index = v["index"].as_u64().unwrap_or(0);
                let cb = &v["content_block"];
                match cb["type"].as_str().unwrap_or("") {
                    "tool_use" => {
                        let i = self.turn.tool_calls.len();
                        self.turn.tool_calls.push(ToolCall {
                            id: cb["id"].as_str().unwrap_or("").to_string(),
                            name: cb["name"].as_str().unwrap_or("").to_string(),
                            arguments: String::new(),
                        });
                        self.blocks.insert(index, i);
                    }
                    "thinking" => {
                        let i = self.turn.thinking.len();
                        self.turn.thinking.push(json!({ "type": "thinking", "thinking": "", "signature": "" }));
                        self.thinking_blocks.insert(index, i);
                    }
                    "redacted_thinking" => self.turn.thinking.push(cb.clone()),
                    _ => {}
                }
                None
            }
            "content_block_delta" => {
                let d = &v["delta"];
                let index = v["index"].as_u64().unwrap_or(0);
                match d["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let t = d["text"].as_str().filter(|t| !t.is_empty())?;
                        self.turn.content.push_str(t);
                        Some(t.to_string())
                    }
                    "input_json_delta" => {
                        if let Some(i) = self.blocks.get(&index).copied() {
                            if let Some(a) = d["partial_json"].as_str() { self.turn.tool_calls[i].arguments.push_str(a); }
                        }
                        None
                    }
                    "thinking_delta" => {
                        if let Some(i) = self.thinking_blocks.get(&index).copied() {
                            if let Some(t) = d["thinking"].as_str() {
                                if let Some(Value::String(out)) = self.turn.thinking.get_mut(i).and_then(|b| b.get_mut("thinking")) {
                                    out.push_str(t);
                                }
                            }
                        }
                        None
                    }
                    "signature_delta" => {
                        if let Some(i) = self.thinking_blocks.get(&index).copied() {
                            if let Some(s) = d["signature"].as_str() {
                                if let Some(b) = self.turn.thinking.get_mut(i) { b["signature"] = json!(s); }
                            }
                        }
                        None
                    }
                    _ => None,
                }
            }
            "message_delta" => {
                if let Some(out) = v.pointer("/usage/output_tokens").filter(|t| t.is_number()) {
                    match &mut self.usage {
                        Some(Value::Object(m)) => { m.insert("output_tokens".into(), out.clone()); }
                        _ => self.usage = Some(json!({ "output_tokens": out })),
                    }
                }
                None
            }
            "message_stop" => { self.done = true; None }
            "error" => {
                self.error = Some(v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("stream error").to_string());
                None
            }
            _ => None,
        }
    }
}

/// Streaming completion with tools; `on_text` receives each text delta as it arrives.
pub(crate) async fn stream_completion(http: &reqwest::Client, t: &Target, tag: &str, messages: &[Value], tools: &[Value], usage: &mut Usage, mut on_text: impl FnMut(&str)) -> anyhow::Result<Turn> {
    if t.endpoint.api_key.is_empty() { bail!("LLM не настроен"); }
    let max_tokens = 2000 + t.effort.extra_tokens();
    let mut b = match t.endpoint.api {
        Api::Openai => {
            let mut b = body(t, messages, max_tokens, false);
            b["stream"] = json!(true);
            b["stream_options"] = json!({ "include_usage": true });
            if !tools.is_empty() { b["tools"] = json!(tools); }
            b
        }
        Api::Anthropic => anthropic_body(&t.model, t.effort, messages, tools, max_tokens, true),
    };
    let resp = send(http, t, &mut b, Duration::from_secs(180)).await?;
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut acc = SseAccumulator { api: t.endpoint.api, ..Default::default() };
    while let Some(chunk) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk?));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            if let Some(t) = acc.feed(line.trim()) { on_text(&t); }
        }
    }
    if let Some(u) = &acc.usage {
        *usage = Usage::from_api(t.endpoint.api, u);
        log_usage(tag, usage);
    }
    if let Some(e) = &acc.error { bail!("LLM: {e}"); }
    Ok(acc.turn)
}

/// Streaming completion against the live config; the paid tokens land in `llm_usage` either way.
pub async fn chat_stream(st: &AppState, task: super::tasks::Task, media_id: &str, tag: &str, messages: &[Value], tools: &[Value], on_text: impl FnMut(&str)) -> anyhow::Result<Turn> {
    let t = st.cfg().target(task);
    let mut u = Usage::default();
    let r = stream_completion(&st.llm_http, &t, tag, messages, tools, &mut u, on_text).await;
    usage::record(st, media_id, &t, u).await;
    r
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

    #[test]
    fn openai_reasoning_is_collected_but_not_shown() {
        let mut a = SseAccumulator::default();
        assert_eq!(a.feed(r#"data: {"choices":[{"delta":{"reasoning_content":"think "}}]}"#), None);
        assert_eq!(a.feed(r#"data: {"choices":[{"delta":{"reasoning_content":"more"}}]}"#), None);
        assert_eq!(a.feed(r#"data: {"choices":[{"delta":{"content":"answer"}}]}"#).as_deref(), Some("answer"));
        assert_eq!(a.turn.reasoning, "think more");
        assert_eq!(a.turn.content, "answer");
    }

    #[test]
    fn anthropic_stream_replays_text_tool_and_usage() {
        let mut a = SseAccumulator { api: Api::Anthropic, ..Default::default() };
        a.feed(r#"event: message_start"#);
        a.feed(r#"data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}"#);
        a.feed(r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#);
        assert_eq!(a.feed(r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}"#).as_deref(), Some("Hel"));
        assert_eq!(a.feed(r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}"#).as_deref(), Some("lo"));
        a.feed(r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"ping"}}"#);
        a.feed(r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"a\":"}}"#);
        a.feed(r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1}"}}"#);
        a.feed(r#"data: {"type":"message_delta","usage":{"output_tokens":7}}"#);
        a.feed(r#"data: {"type":"message_stop"}"#);
        assert!(a.done);
        assert_eq!(a.turn.content, "Hello");
        assert_eq!(a.turn.tool_calls, vec![ToolCall { id: "tu1".into(), name: "ping".into(), arguments: r#"{"a":1}"#.into() }]);
        let u = a.usage.unwrap();
        assert_eq!(u["input_tokens"], 12);
        assert_eq!(u["output_tokens"], 7);
    }

    #[test]
    fn anthropic_stream_collects_thinking_and_signature() {
        let mut a = SseAccumulator { api: Api::Anthropic, ..Default::default() };
        a.feed(r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#);
        assert_eq!(a.feed(r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}"#), None);
        a.feed(r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" ok"}}"#);
        a.feed(r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}"#);
        assert!(a.turn.content.is_empty());
        assert_eq!(a.turn.thinking, vec![json!({ "type": "thinking", "thinking": "hmm ok", "signature": "sig" })]);
    }

    #[test]
    fn anthropic_stream_surfaces_errors() {
        let mut a = SseAccumulator { api: Api::Anthropic, ..Default::default() };
        a.feed(r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#);
        assert_eq!(a.error.as_deref(), Some("Overloaded"));
    }

    #[test]
    fn anthropic_body_splits_system_and_keeps_tool_results_together() {
        let messages = vec![
            json!({ "role": "system", "content": "rules" }),
            json!({ "role": "user", "content": "film+script" }),
            json!({ "role": "assistant", "content": "OK" }),
            json!({ "role": "system", "content": "chat rules" }),
            json!({ "role": "user", "content": "question" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [
                { "id": "c1", "type": "function", "function": { "name": "t", "arguments": "{\"x\":1}" } },
                { "id": "c2", "type": "function", "function": { "name": "u", "arguments": "not json" } },
            ] }),
            json!({ "role": "tool", "tool_call_id": "c1", "content": "r1" }),
            json!({ "role": "tool", "tool_call_id": "c2", "content": "r2" }),
        ];
        let tools = vec![json!({ "type": "function", "function": { "name": "t", "description": "d", "parameters": { "type": "object" } } })];
        let b = anthropic_body("claude-x", Effort::Off, &messages, &tools, 100, true);
        assert_eq!(b["system"].as_array().unwrap().len(), 2);
        assert_eq!(b["system"][1]["text"], "chat rules");
        assert!(!b["messages"].as_array().unwrap().iter().any(|m| m["role"] == "system"));
        let msgs = b["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["content"][0]["cache_control"]["type"], "ephemeral");
        assert!(msgs[2]["content"][0].get("cache_control").is_none());
        let calls = msgs[3]["content"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["type"], "tool_use");
        assert_eq!(calls[0]["input"]["x"], 1);
        assert_eq!(calls[1]["type"], "tool_use");
        assert_eq!(calls[1]["input"], json!({}));
        let results = msgs[4]["content"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["tool_use_id"], "c1");
        assert_eq!(results[1]["content"], "r2");
        assert_eq!(b["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(b["stream"], true);
        assert!(b.get("response_format").is_none());
        assert!(b.get("thinking").is_none());
    }

    #[test]
    fn anthropic_effort_adds_adaptive_thinking_and_replays_thinking_blocks() {
        let messages = vec![
            json!({ "role": "user", "content": "q" }),
            json!({ "role": "assistant", "content": "a", "anthropic_thinking": [
                { "type": "thinking", "thinking": "why", "signature": "s" }
            ], "tool_calls": [
                { "id": "c1", "type": "function", "function": { "name": "t", "arguments": "{}" } }
            ] }),
        ];
        let b = anthropic_body("m", Effort::Medium, &messages, &[], 100, false);
        assert_eq!(b["thinking"]["type"], "adaptive");
        assert_eq!(b["output_config"]["effort"], "medium");
        assert!(b.get("temperature").is_none());
        assert_eq!(b["max_tokens"], 100 + 8192);
        let blocks = b["messages"][1]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "thinking");
        assert_eq!(blocks[0]["thinking"], "why");
        assert_eq!(blocks[0]["signature"], "s");
        assert_eq!(blocks[1]["type"], "text");
        assert_eq!(blocks[2]["type"], "tool_use");
    }

    #[test]
    fn budget_fallback_replaces_adaptive_fields() {
        let mut b = json!({ "thinking": { "type": "adaptive" }, "output_config": { "effort": "medium" } });
        anthropic_budget_fallback(&mut b, Effort::Medium);
        assert_eq!(b["thinking"], json!({ "type": "enabled", "budget_tokens": 8192 }));
        assert!(b.get("output_config").is_none());
    }

    #[test]
    fn anthropic_body_drops_empty_assistant_turns() {
        let b = anthropic_body("m", Effort::Off, &[json!({ "role": "assistant", "content": "" })], &[], 10, false);
        assert!(b["messages"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn ping_reports_the_reply_of_an_openai_shaped_server() {
        use axum::{routing::post, Json, Router};
        let app = Router::new().route(
            "/v1/chat/completions",
            post(|| async { Json(json!({ "choices": [{ "message": { "content": "pong" } }] })) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let t = Target {
            task: super::super::tasks::Task::Chat,
            source: String::new(),
            provider: String::new(),
            model: "m".into(),
            effort: Effort::Off,
            endpoint: Endpoint { api: Api::Openai, base_url: format!("http://{addr}/v1"), api_key: "k".into(), auth: Auth::Bearer },
        };
        let p = ping(&reqwest::Client::new(), &t).await.unwrap();
        assert_eq!(p.reply, "pong");
        server.abort();
    }

    #[test]
    fn extract_json_unwraps_fences() {
        assert_eq!(extract_json("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(extract_json("  {\"a\":{\"b\":2}}  "), "{\"a\":{\"b\":2}}");
        assert_eq!(extract_json("нет json"), "нет json");
    }
}
