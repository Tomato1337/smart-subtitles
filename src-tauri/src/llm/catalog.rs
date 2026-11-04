//! Model catalog: display names, context windows and prices.
//!
//! Prices come from `~/.omp/agent/models.yml` first (the machine's own negotiated rates), then from
//! models.dev. The context window comes from models.dev first: it holds the real model window, while
//! omp's `contextWindow` is the fallback.

use super::{
    providers::{self, Roots},
    tasks::Target,
    usage::Usage,
};
use crate::{config, logs, state::AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

const DEV_URL: &str = "https://models.dev/api.json";
const TTL: Duration = Duration::from_secs(24 * 3600);
/// providers checked after the current one's own id before scanning the whole index.
const COMMON: [&str; 7] = ["anthropic", "openai", "deepseek", "google", "xai", "mistral", "moonshotai"];

/// USD per 1M tokens.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub context_window: Option<u64>,
    pub price: Option<Price>,
    /// `~/.omp/agent/models.yml · <provider>` | `models.dev · <devProvider>/<devModel>` | "".
    pub price_source: String,
}

pub fn cost_usd(p: &Price, u: &Usage) -> f64 {
    let cached = p.cache_read.unwrap_or(p.input);
    let written = p.cache_write.unwrap_or(p.input);
    (u.input as f64 * p.input + u.cache_read as f64 * cached + u.cache_write as f64 * written + u.output as f64 * p.output) / 1e6
}

/// provider id -> model id -> model, as models.dev serves it.
pub type DevIndex = HashMap<String, HashMap<String, DevModel>>;

#[derive(Debug, Clone, Deserialize)]
struct DevProvider {
    #[serde(default)]
    models: HashMap<String, DevModel>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DevModel {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    cost: Option<DevCost>,
    #[serde(default)]
    limit: Option<DevLimit>,
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
struct DevCost {
    #[serde(default)]
    input: Option<f64>,
    #[serde(default)]
    output: Option<f64>,
    #[serde(default)]
    cache_read: Option<f64>,
    #[serde(default)]
    cache_write: Option<f64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
struct DevLimit {
    #[serde(default)]
    context: Option<u64>,
}

fn parse_index(raw: &[u8]) -> DevIndex {
    let providers: HashMap<String, Value> = serde_json::from_slice(raw).unwrap_or_default();
    let mut out = DevIndex::new();
    for (id, v) in providers {
        match serde_json::from_value::<DevProvider>(v) {
            Ok(p) if !p.models.is_empty() => {
                out.insert(id, p.models);
            }
            _ => {}
        }
    }
    out
}

async fn parse(raw: Vec<u8>) -> DevIndex {
    tokio::task::spawn_blocking(move || parse_index(&raw)).await.unwrap_or_default()
}

fn fresh(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < TTL)
}

async fn fetch(http: &reqwest::Client) -> anyhow::Result<Vec<u8>> {
    let r = http.get(DEV_URL).timeout(Duration::from_secs(30)).send().await?;
    if !r.status().is_success() {
        anyhow::bail!("HTTP {}", r.status());
    }
    Ok(r.bytes().await?.to_vec())
}

/// A cached copy younger than a day, otherwise a fresh download written to `path`.
pub async fn load_index(http: &reqwest::Client, path: &Path) -> anyhow::Result<DevIndex> {
    if fresh(path) {
        if let Ok(raw) = std::fs::read(path) {
            return Ok(parse(raw).await);
        }
    }
    let raw = fetch(http).await?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(path, &raw) {
        logs::log("llm", &format!("models.dev cache: {e}"));
    }
    Ok(parse(raw).await)
}

/// The shared models.dev index; one download per day, single-flight.
pub async fn models_dev(st: &AppState) -> Arc<DevIndex> {
    let mut guard = st.models_dev.lock().await;
    if let Some((at, idx)) = guard.as_ref() {
        if at.elapsed() < TTL {
            return idx.clone();
        }
    }
    let path = config::cache_dir().join("models-dev.json");
    let idx = match load_index(&st.http, &path).await {
        Ok(i) => i,
        Err(e) => {
            logs::log("llm", &format!("models.dev: {e:#}"));
            match std::fs::read(&path) {
                Ok(raw) => parse(raw).await,
                Err(_) => DevIndex::new(),
            }
        }
    };
    let idx = Arc::new(idx);
    *guard = Some((Instant::now(), idx.clone()));
    idx
}

struct OmpModel {
    name: Option<String>,
    context_window: Option<u64>,
    price: Option<Price>,
}

/// One model of `~/.omp/agent/models.yml`, the same file `providers::omp()` reads.
fn omp_model(r: &Roots, provider: &str, model: &str) -> Option<OmpModel> {
    let path = r.home.join(".omp/agent/models.yml");
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_yaml::Value = serde_yaml::from_str(&text).ok()?;
    let m = v
        .get("providers")?
        .get(provider)?
        .get("models")?
        .as_sequence()?
        .iter()
        .find(|m| m.get("id").and_then(|i| i.as_str()) == Some(model))?;
    let cost = m.get("cost");
    let num = |k: &str| cost.and_then(|c| c.get(k)).and_then(|x| x.as_f64());
    let price = match (num("input"), num("output")) {
        // Image models are listed with a zero price: not a usable text price.
        (Some(i), Some(o)) if i > 0.0 || o > 0.0 => {
            Some(Price { input: i, output: o, cache_read: num("cacheRead"), cache_write: num("cacheWrite") })
        }
        _ => None,
    };
    Some(OmpModel {
        name: m.get("name").and_then(|n| n.as_str()).map(str::to_string),
        context_window: m.get("contextWindow").and_then(|c| c.as_u64()),
        price,
    })
}

struct DevHit {
    provider: String,
    id: String,
    model: DevModel,
}

fn hit(idx: &DevIndex, provider: &str, model: &str, norm: &str) -> Option<DevHit> {
    let models = idx.get(provider)?;
    let (id, m) = match models.get_key_value(model) {
        Some((id, m)) => (id.clone(), m),
        None => {
            let (id, m) = models.get_key_value(norm)?;
            (id.clone(), m)
        }
    };
    Some(DevHit { provider: provider.to_string(), id, model: m.clone() })
}

/// The models.dev entry for a model: the connection's own provider first, then well-known ones,
/// then every provider in alphabetical order (gateways keep vendor models under their own key).
fn dev_lookup(idx: &DevIndex, source: &str, provider: &str, base_url: &str, model: &str) -> Option<DevHit> {
    let norm = model.rsplit('/').next().unwrap_or(model).to_lowercase();
    let mut keys: Vec<String> = vec![];
    if source != "omp" && !provider.is_empty() {
        keys.push(provider.to_string());
    }
    if let Some(k) = providers::known_id_for_url(base_url) {
        if !keys.iter().any(|x| x == k) {
            keys.push(k.to_string());
        }
    }
    for k in &keys {
        if let Some(h) = hit(idx, k, model, &norm) {
            return Some(h);
        }
    }
    for k in COMMON {
        if !keys.iter().any(|x| x == k) {
            if let Some(h) = hit(idx, k, model, &norm) {
                return Some(h);
            }
        }
    }
    let mut all: Vec<&String> = idx.keys().collect();
    all.sort();
    all.into_iter().find_map(|k| hit(idx, k, model, &norm))
}

pub async fn model_info(st: &AppState, source: &str, provider: &str, base_url: &str, model: &str) -> ModelInfo {
    if model.is_empty() {
        return ModelInfo::default();
    }
    let idx = models_dev(st).await;
    let omp = if source == "omp" { omp_model(&Roots::from_env(), provider, model) } else { None };
    resolve_info(&idx, source, provider, base_url, model, omp)
}

/// The precedence rules, without the index or the config: dev window, omp price, omp name.
fn resolve_info(idx: &DevIndex, source: &str, provider: &str, base_url: &str, model: &str, omp: Option<OmpModel>) -> ModelInfo {
    let dev = dev_lookup(idx, source, provider, base_url, model);
    let mut info = ModelInfo { name: model.to_string(), ..Default::default() };
    let mut named = false;
    if let Some(o) = &omp {
        if let Some(n) = o.name.as_ref().filter(|n| !n.is_empty()) {
            info.name = n.clone();
            named = true;
        }
        info.context_window = o.context_window;
    }
    if let Some(d) = dev {
        if !named {
            if let Some(n) = d.model.name.filter(|n| !n.is_empty()) {
                info.name = n;
            }
        }
        if let Some(c) = d.model.limit.and_then(|l| l.context) {
            info.context_window = Some(c);
        }
        if let Some(cost) = d.model.cost {
            if let (Some(input), Some(output)) = (cost.input, cost.output) {
                info.price = Some(Price { input, output, cache_read: cost.cache_read, cache_write: cost.cache_write });
                info.price_source = format!("models.dev · {}/{}", d.provider, d.id);
            }
        }
    }
    // The machine's own negotiated rates beat the public list.
    if let Some(p) = omp.and_then(|o| o.price) {
        info.price = Some(p);
        info.price_source = format!("~/.omp/agent/models.yml · {provider}");
    }
    info
}

pub async fn model_info_for(st: &AppState, t: &Target) -> ModelInfo {
    model_info(st, &t.source, &t.provider, &t.endpoint.base_url, &t.model).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn index(entries: &[(&str, &str, Value)]) -> DevIndex {
        let mut idx = DevIndex::new();
        for (p, m, v) in entries {
            idx.entry(p.to_string()).or_default().insert(m.to_string(), serde_json::from_value(v.clone()).unwrap());
        }
        idx
    }

    #[test]
    fn own_provider_wins_over_the_alphabet() {
        let idx = index(&[
            ("zzz-gateway", "claude-sonnet-5-5", json!({ "name": "Gateway" })),
            ("anthropic", "claude-sonnet-5-5", json!({ "name": "Anthropic" })),
        ]);
        let h = dev_lookup(&idx, "", "zzz-gateway", "", "claude-sonnet-5-5").unwrap();
        assert_eq!(h.provider, "zzz-gateway");
        assert_eq!(h.model.name.as_deref(), Some("Gateway"));
    }

    #[test]
    fn vendor_prefix_and_known_provider_are_understood() {
        let idx = index(&[("deepseek", "deepseek-flash", json!({ "name": "DeepSeek V4.1 Flash" }))]);
        let h = dev_lookup(&idx, "", "", "https://api.deepseek.com", "deepseek/deepseek-flash").unwrap();
        assert_eq!(h.provider, "deepseek");
        assert_eq!(h.id, "deepseek-flash");
    }

    #[test]
    fn unknown_model_has_no_entry() {
        let idx = index(&[("deepseek", "deepseek-flash", json!({}))]);
        assert!(dev_lookup(&idx, "", "", "", "no-such-model").is_none());
    }

    #[test]
    fn dev_window_and_omp_price_win() {
        let idx = index(&[(
            "anthropic",
            "claude-sonnet-5-5",
            json!({ "name": "Claude Sonnet 5.5", "limit": { "context": 1_000_000 }, "cost": { "input": 2.0, "output": 10.0 } }),
        )]);
        let omp = OmpModel {
            name: Some("Claude Sonnet 5.5 (ApiNebula)".into()),
            context_window: Some(200_000),
            price: Some(Price { input: 0.37, output: 1.86, cache_read: Some(0.0075), cache_write: Some(0.467) }),
        };
        let info = resolve_info(&idx, "omp", "apinebula-claude", "", "claude-sonnet-5-5", Some(omp));
        assert_eq!(info.name, "Claude Sonnet 5.5 (ApiNebula)");
        assert_eq!(info.context_window, Some(1_000_000));
        assert_eq!(info.price.unwrap().input, 0.37);
        assert_eq!(info.price_source, "~/.omp/agent/models.yml · apinebula-claude");
    }

    #[test]
    fn cost_uses_cache_prices_and_falls_back_to_input() {
        let p = Price { input: 1.0, output: 10.0, cache_read: Some(0.1), cache_write: None };
        let u = Usage { input: 1_000_000, cache_read: 1_000_000, cache_write: 1_000_000, output: 1_000_000 };
        // 1 + 0.1 + 1 (no cache_write price: input) + 10
        assert!((cost_usd(&p, &u) - 12.1).abs() < 1e-9);
    }
}
