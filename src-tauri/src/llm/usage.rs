//! Token accounting of one LLM reply, in either protocol's shape, and the per-film usage table.

use super::{catalog, tasks::Target};
use crate::llm::providers::Api;
use crate::state::AppState;
use rusqlite::params;
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Usage {
    /// Prompt tokens that were not served from the provider cache.
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
}

impl Usage {
    pub fn from_api(api: Api, u: &Value) -> Usage {
        if !u.is_object() {
            return Usage::default();
        }
        let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        match api {
            Api::Openai => {
                // DeepSeek reports the hit count next to prompt_tokens; OpenAI nests it in details.
                let cached = u
                    .pointer("/prompt_tokens_details/cached_tokens")
                    .and_then(Value::as_u64)
                    .or_else(|| u.get("prompt_cache_hit_tokens").and_then(Value::as_u64))
                    .unwrap_or(0);
                Usage { input: n("prompt_tokens").saturating_sub(cached), cache_read: cached, cache_write: 0, output: n("completion_tokens") }
            }
            Api::Anthropic => Usage {
                input: n("input_tokens"),
                cache_read: n("cache_read_input_tokens"),
                cache_write: n("cache_creation_input_tokens"),
                output: n("output_tokens"),
            },
        }
    }

    /// All prompt tokens, cached or not: what the context window is filled with.
    pub fn prompt(&self) -> u64 {
        self.input + self.cache_read + self.cache_write
    }

    pub fn add(&mut self, o: Usage) {
        self.input += o.input;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
        self.output += o.output;
    }
}

/// Writes one request into `llm_usage`; the dollar figure is local when the catalog knows a price.
pub async fn record(st: &AppState, media_id: &str, t: &Target, u: Usage) {
    if u == Usage::default() {
        return;
    }
    let usd = catalog::model_info_for(st, t).await.price.map(|p| catalog::cost_usd(&p, &u));
    let (m, task, model) = (media_id.to_string(), t.task.key().to_string(), t.model.clone());
    let r = st
        .db(move |c| {
            c.execute(
                "INSERT INTO llm_usage(media_id,task,model,input,cache_read,cache_write,output,usd,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![m, task, model, u.input as i64, u.cache_read as i64, u.cache_write as i64, u.output as i64, usd, crate::db::now()],
            )?;
            Ok(())
        })
        .await;
    if let Err(e) = r {
        crate::logs::log("llm", &format!("usage: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openai_cached_tokens_are_carved_out_of_the_prompt() {
        let u = Usage::from_api(Api::Openai, &json!({
            "prompt_tokens": 1000,
            "completion_tokens": 50,
            "prompt_tokens_details": { "cached_tokens": 800 }
        }));
        assert_eq!(u, Usage { input: 200, cache_read: 800, cache_write: 0, output: 50 });
        assert_eq!(u.prompt(), 1000);
    }

    #[test]
    fn deepseek_cache_hit_is_carved_out_of_the_prompt() {
        let u = Usage::from_api(Api::Openai, &json!({
            "prompt_tokens": 1200,
            "prompt_cache_hit_tokens": 900,
            "completion_tokens": 30
        }));
        assert_eq!(u, Usage { input: 300, cache_read: 900, cache_write: 0, output: 30 });
    }

    #[test]
    fn anthropic_keeps_both_cache_fields() {
        let u = Usage::from_api(Api::Anthropic, &json!({
            "input_tokens": 12,
            "cache_read_input_tokens": 300,
            "cache_creation_input_tokens": 40,
            "output_tokens": 7
        }));
        assert_eq!(u, Usage { input: 12, cache_read: 300, cache_write: 40, output: 7 });
        assert_eq!(u.prompt(), 352);
    }

    #[test]
    fn missing_usage_is_zero() {
        assert_eq!(Usage::from_api(Api::Openai, &Value::Null), Usage::default());
        assert_eq!(Usage::from_api(Api::Anthropic, &json!({})), Usage::default());
    }
}
