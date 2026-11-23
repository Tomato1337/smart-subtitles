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

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsageRow {
    pub task: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
    pub usd: f64,
    pub partial: bool,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageRow {
    pub model: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
    pub usd: f64,
    pub partial: bool,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyUsage {
    pub days: u32,
    pub requests: u64,
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
    pub total_usd: f64,
    pub partial: bool,
    pub by_task: Vec<TaskUsageRow>,
    pub by_model: Vec<ModelUsageRow>,
}

struct AggRow {
    key: String,
    requests: u64,
    input_tokens: u64,
    cached_tokens: u64,
    output_tokens: u64,
    usd: f64,
    partial: bool,
}

fn query_grouped(conn: &rusqlite::Connection, col: &str, since: i64) -> rusqlite::Result<Vec<AggRow>> {
    let sql = format!(
        "SELECT {col}, COUNT(*), COALESCE(SUM(input + cache_write), 0), COALESCE(SUM(cache_read), 0), \
                COALESCE(SUM(output), 0), COALESCE(SUM(usd), 0.0), \
                MAX(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) \
         FROM llm_usage WHERE created_at >= ?1 \
         GROUP BY {col} \
         ORDER BY COALESCE(SUM(usd), 0.0) DESC, COUNT(*) DESC, {col} ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([since], |r| {
        Ok(AggRow {
            key: r.get(0)?,
            requests: r.get::<_, i64>(1)?.max(0) as u64,
            input_tokens: r.get::<_, i64>(2)?.max(0) as u64,
            cached_tokens: r.get::<_, i64>(3)?.max(0) as u64,
            output_tokens: r.get::<_, i64>(4)?.max(0) as u64,
            usd: r.get(5)?,
            partial: r.get::<_, i64>(6)? != 0,
        })
    })?;
    rows.collect()
}

/// Aggregates LLM token and USD spend over the last `days` (clamped to 1..=365), grouped by task and model.
pub fn query_monthly(conn: &rusqlite::Connection, days: u32) -> rusqlite::Result<MonthlyUsage> {
    let days = days.clamp(1, 365);
    let since = crate::db::now() - (days as i64) * 86400;
    let by_task: Vec<TaskUsageRow> = query_grouped(conn, "task", since)?
        .into_iter()
        .map(|r| TaskUsageRow {
            task: r.key,
            requests: r.requests,
            input_tokens: r.input_tokens,
            cached_tokens: r.cached_tokens,
            output_tokens: r.output_tokens,
            usd: r.usd,
            partial: r.partial,
        })
        .collect();
    let by_model: Vec<ModelUsageRow> = query_grouped(conn, "model", since)?
        .into_iter()
        .map(|r| ModelUsageRow {
            model: r.key,
            requests: r.requests,
            input_tokens: r.input_tokens,
            cached_tokens: r.cached_tokens,
            output_tokens: r.output_tokens,
            usd: r.usd,
            partial: r.partial,
        })
        .collect();
    let requests = by_task.iter().map(|r| r.requests).sum();
    let input_tokens = by_task.iter().map(|r| r.input_tokens).sum();
    let cached_tokens = by_task.iter().map(|r| r.cached_tokens).sum();
    let output_tokens = by_task.iter().map(|r| r.output_tokens).sum();
    let total_usd = by_task.iter().map(|r| r.usd).sum();
    let partial = by_task.iter().any(|r| r.partial);
    Ok(MonthlyUsage {
        days,
        requests,
        input_tokens,
        cached_tokens,
        output_tokens,
        total_usd,
        partial,
        by_task,
        by_model,
    })
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

    fn insert_usage(
        conn: &rusqlite::Connection,
        task: &str,
        model: &str,
        input: i64,
        cache_read: i64,
        cache_write: i64,
        output: i64,
        usd: Option<f64>,
        created_at: i64,
    ) {
        conn.execute(
            "INSERT INTO llm_usage(media_id,task,model,input,cache_read,cache_write,output,usd,created_at) VALUES('m',?1,?2,?3,?4,?5,?6,?7,?8)",
            params![task, model, input, cache_read, cache_write, output, usd, created_at],
        )
        .unwrap();
    }

    #[test]
    fn monthly_usage_filters_window_tracks_partial_and_sorts() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();
        let now = crate::db::now();

        // Empty DB returns zero totals and empty breakdowns.
        let empty = query_monthly(&conn, 30).unwrap();
        assert_eq!(empty.days, 30);
        assert_eq!(empty.requests, 0);
        assert_eq!(empty.total_usd, 0.0);
        assert!(!empty.partial);
        assert!(empty.by_task.is_empty());
        assert!(empty.by_model.is_empty());

        // Old rows (> 30d), including an unpriced one that must not taint the 30-day window.
        insert_usage(&conn, "annotate", "old-model", 5000, 1000, 0, 500, None, now - 31 * 86400);
        insert_usage(&conn, "chat", "old-model", 1000, 0, 0, 200, Some(9.99), now - 40 * 86400);

        // Recent rows within 30 days.
        insert_usage(&conn, "annotate", "deepseek-flash", 200, 800, 0, 50, Some(0.10), now - 3600);
        insert_usage(&conn, "annotate", "deepseek-flash", 300, 1200, 0, 70, Some(0.20), now - 1800);
        insert_usage(&conn, "chat", "claude-sonnet", 400, 100, 50, 90, Some(0.50), now - 1200);
        // Unpriced row makes its task, its model, and the overall summary partial.
        insert_usage(&conn, "explain", "local-model", 100, 20, 0, 30, None, now - 600);
        // Second request for explain with equal $0.00 to verify sorting tie-break by requests DESC.
        insert_usage(&conn, "draft", "deepseek-flash", 10, 0, 0, 5, Some(0.0), now - 300);
        insert_usage(&conn, "explain", "local-model", 150, 40, 0, 45, Some(0.0), now - 100);

        let m30 = query_monthly(&conn, 30).unwrap();
        assert_eq!(m30.days, 30);
        assert_eq!(m30.requests, 6);
        assert_eq!(m30.input_tokens, 200 + 300 + (400 + 50) + 100 + 10 + 150);
        assert_eq!(m30.cached_tokens, 800 + 1200 + 100 + 20 + 40);
        assert_eq!(m30.output_tokens, 50 + 70 + 90 + 30 + 5 + 45);
        assert!((m30.total_usd - 0.80).abs() < 1e-9);
        assert!(m30.partial);

        // by_task sorted by usd DESC, requests DESC: chat ($0.50, 1), annotate ($0.30, 2), explain ($0.0, 2), draft ($0.0, 1).
        let tasks: Vec<&str> = m30.by_task.iter().map(|r| r.task.as_str()).collect();
        assert_eq!(tasks, vec!["chat", "annotate", "explain", "draft"]);
        assert_eq!(m30.by_task[0].input_tokens, 450);
        assert!(!m30.by_task[0].partial);
        assert!(!m30.by_task[1].partial);
        assert!(m30.by_task[2].partial);
        assert_eq!(m30.by_task[2].requests, 2);
        assert!(!m30.by_task[3].partial);

        // by_model sorted by usd DESC, requests DESC: claude-sonnet ($0.50, 1), deepseek-flash ($0.30, 3), local-model ($0.0, 2).
        let models: Vec<&str> = m30.by_model.iter().map(|r| r.model.as_str()).collect();
        assert_eq!(models, vec!["claude-sonnet", "deepseek-flash", "local-model"]);
        assert_eq!(m30.by_model[0].input_tokens, 450);
        assert!(!m30.by_model[0].partial);
        assert!(!m30.by_model[1].partial);
        assert_eq!(m30.by_model[1].requests, 3);
        assert!(m30.by_model[2].partial);

        // Clamping: 0 -> 1 day (still includes recent rows from last hour), 500 -> 365 days (includes old rows).
        let clamped_min = query_monthly(&conn, 0).unwrap();
        assert_eq!(clamped_min.days, 1);
        assert_eq!(clamped_min.requests, 6);

        let clamped_max = query_monthly(&conn, 500).unwrap();
        assert_eq!(clamped_max.days, 365);
        assert_eq!(clamped_max.requests, 8);
        assert!((clamped_max.total_usd - 10.79).abs() < 1e-9);
        assert!(clamped_max.partial);
    }

    #[test]
    fn monthly_usage_is_not_partial_when_only_older_rows_lack_usd() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();
        let now = crate::db::now();

        insert_usage(&conn, "annotate", "m", 100, 0, 0, 20, None, now - 35 * 86400);
        insert_usage(&conn, "annotate", "m", 100, 0, 0, 20, Some(0.12), now - 60);

        let m = query_monthly(&conn, 30).unwrap();
        assert_eq!(m.requests, 1);
        assert!(!m.partial);
        assert!(!m.by_task[0].partial);
        assert!(!m.by_model[0].partial);
        assert!((m.total_usd - 0.12).abs() < 1e-9);
    }
}
