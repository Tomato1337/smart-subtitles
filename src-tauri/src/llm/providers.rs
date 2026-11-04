//! LLM providers already configured in other coding agents.
//!
//! config.json keeps only a reference (`source` + `provider`); base URL, key and protocol are
//! re-read from the agent's own files on every app start and on every settings save, so a rotated
//! key is picked up automatically. Only API keys are imported: OAuth and subscription logins
//! (ChatGPT, Copilot, Claude Pro, Google) are skipped.

use crate::config::Llm;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Api {
    #[default]
    Openai,
    Anthropic,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum Auth {
    #[default]
    Bearer,
    XApiKey,
}

/// Effective connection, never serialized (holds the key).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Endpoint {
    pub api: Api,
    pub base_url: String,
    pub api_key: String,
    pub auth: Auth,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    /// "omp" | "opencode" | "claude" | "codex" | "crush" | "qwen" | "goose" | "gemini".
    pub source: &'static str,
    pub source_label: &'static str,
    pub id: String,
    pub label: String,
    pub api: Api,
    pub base_url: String,
    pub has_key: bool,
    /// Config file shown in the UI, with $HOME replaced by "~".
    pub file: String,
    /// Declared in the agent's config, in file order, deduped.
    pub models: Vec<String>,
}

pub struct Found {
    pub info: ProviderInfo,
    pub endpoint: Endpoint,
}

pub struct Roots {
    pub home: PathBuf,
    pub xdg_config: PathBuf,
    pub xdg_data: PathBuf,
    pub codex: PathBuf,
    pub claude: PathBuf,
    pub env: HashMap<String, String>,
}

impl Roots {
    pub fn from_env() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let var = |name: &str| std::env::var(name).ok().filter(|s| !s.is_empty()).map(PathBuf::from);
        Self {
            xdg_config: var("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")),
            xdg_data: var("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share")),
            codex: var("CODEX_HOME").unwrap_or_else(|| home.join(".codex")),
            claude: var("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude")),
            env: std::env::vars().collect(),
            home,
        }
    }

    #[cfg(test)]
    fn under(home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
            xdg_config: home.join(".config"),
            xdg_data: home.join(".local/share"),
            codex: home.join(".codex"),
            claude: home.join(".claude"),
            env: HashMap::new(),
        }
    }
}

fn auth_for(api: Api) -> Auth {
    match api {
        Api::Anthropic => Auth::XApiKey,
        Api::Openai => Auth::Bearer,
    }
}

/// `KEY=VALUE` lines of a dotenv file; a missing file is an empty map.
pub(crate) fn dotenv(path: &Path) -> HashMap<String, String> {
    let mut m = HashMap::new();
    let Ok(text) = std::fs::read_to_string(path) else {
        return m;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let (k, v) = (k.trim(), v.trim());
        let v = ["\"", "'"].iter().find(|q| v.len() >= 2 && v.starts_with(**q) && v.ends_with(**q)).map(|_| &v[1..v.len() - 1]).unwrap_or(v);
        if !k.is_empty() {
            m.insert(k.to_string(), v.to_string());
        }
    }
    m
}

/// The process env wins; otherwise the first dotenv file that has a non-empty value.
fn env_lookup(r: &Roots, name: &str, dotenv_files: &[PathBuf]) -> String {
    if name.is_empty() {
        return String::new();
    }
    if let Some(v) = r.env.get(name).filter(|v| !v.is_empty()) {
        return v.clone();
    }
    for f in dotenv_files {
        if let Some(v) = dotenv(f).get(name).filter(|v| !v.is_empty()) {
            return v.clone();
        }
    }
    String::new()
}

/// Built-in providers that may have a key but no base URL in the agent's config.
const KNOWN: [(&str, &str, Api, &str); 9] = [
    ("deepseek", "https://api.deepseek.com", Api::Openai, "DEEPSEEK_API_KEY"),
    ("openai", "https://api.openai.com/v1", Api::Openai, "OPENAI_API_KEY"),
    ("anthropic", "https://api.anthropic.com", Api::Anthropic, "ANTHROPIC_API_KEY"),
    ("openrouter", "https://openrouter.ai/api/v1", Api::Openai, "OPENROUTER_API_KEY"),
    ("groq", "https://api.groq.com/openai/v1", Api::Openai, "GROQ_API_KEY"),
    ("mistral", "https://api.mistral.ai/v1", Api::Openai, "MISTRAL_API_KEY"),
    ("xai", "https://api.x.ai/v1", Api::Openai, "XAI_API_KEY"),
    ("moonshotai", "https://api.moonshot.ai/v1", Api::Openai, "MOONSHOT_API_KEY"),
    ("google", "https://generativelanguage.googleapis.com/v1beta/openai", Api::Openai, "GEMINI_API_KEY"),
];

fn known(id: &str) -> Option<(&'static str, Api, &'static str)> {
    KNOWN.iter().find(|k| k.0 == id).map(|k| (k.1, k.2, k.3))
}

/// The built-in provider a manual base URL belongs to, for the price catalog; `None` for gateways.
pub fn known_id_for_url(base_url: &str) -> Option<&'static str> {
    let host = url::Url::parse(base_url).ok()?.host_str()?.to_lowercase();
    KNOWN
        .iter()
        .find(|k| url::Url::parse(k.1).ok().and_then(|u| u.host_str().map(str::to_string)).is_some_and(|h| h == host))
        .map(|k| k.0)
}

fn is_env_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn tilde(r: &Roots, p: &Path) -> String {
    let s = p.display().to_string();
    match s.strip_prefix(&r.home.display().to_string()) {
        Some(rest) if rest.starts_with('/') => format!("~{rest}"),
        _ => s,
    }
}

fn find_file(names: &[&str], dir: &Path) -> Option<PathBuf> {
    names.iter().map(|n| dir.join(n)).find(|p| p.exists())
}

fn read_json5(path: &Path) -> anyhow::Result<Value> {
    Ok(json5::from_str::<Value>(&std::fs::read_to_string(path)?)?)
}

fn read_json(path: &Path) -> Value {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
}

/// Reads a small regular file as trimmed text; anything else is treated as missing.
/// A config-chosen path must not turn into an unbounded read (`/dev/zero`) or a directory walk.
fn read_small_file(p: &Path) -> Option<String> {
    const MAX: u64 = 8 * 1024;
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() > MAX {
        return None;
    }
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

/// Hides `user:pass@` before a base URL reaches the UI; the endpoint keeps the real value.
fn mask_userinfo(u: &str) -> String {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"://[^/@\s]+@").unwrap());
    RE.replace_all(u, "://***@").into_owned()
}

/// Goose stores the full request URL for the OpenAI engine (`…/v1/chat/completions`); the client
/// appends the path itself, so the suffix is dropped.
fn strip_chat_path(base: &str, api: Api) -> String {
    let b = base.trim_end_matches('/');
    match api {
        Api::Openai => b.strip_suffix("/chat/completions").unwrap_or(b).trim_end_matches('/').to_string(),
        Api::Anthropic => b.strip_suffix("/v1/messages").or_else(|| b.strip_suffix("/messages")).unwrap_or(b).trim_end_matches('/').to_string(),
    }
}

fn dedup(mut v: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    v.retain(|s| !s.is_empty() && seen.insert(s.clone()));
    v
}

fn label_of(source: &str) -> &'static str {
    match source {
        "omp" => "omp",
        "opencode" => "opencode",
        "claude" => "Claude Code",
        "codex" => "Codex",
        "crush" => "Crush",
        "qwen" => "Qwen Code",
        "goose" => "Goose",
        _ => "Gemini CLI",
    }
}

/// What a parser knows about one provider; source and file are added by `found`.
struct Draft {
    id: String,
    label: String,
    api: Api,
    base_url: String,
    api_key: String,
    models: Vec<String>,
}

fn found(source: &'static str, file: String, d: Draft) -> Found {
    let has_key = !d.api_key.is_empty();
    Found {
        info: ProviderInfo { source, source_label: label_of(source), id: d.id, label: d.label, api: d.api, base_url: mask_userinfo(&d.base_url), has_key, file, models: dedup(d.models) },
        endpoint: Endpoint { api: d.api, base_url: d.base_url, api_key: d.api_key, auth: auth_for(d.api) },
    }
}

fn omp(r: &Roots) -> anyhow::Result<Vec<Found>> {
    let dir = r.home.join(".omp/agent");
    let path = dir.join("models.yml");
    if !path.exists() {
        return Ok(vec![]);
    }
    let v: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string(&path)?)?;
    let Some(providers) = v.get("providers").and_then(|p| p.as_mapping()) else {
        return Ok(vec![]);
    };
    let file = tilde(r, &path);
    let mut out = vec![];
    for (id, p) in providers {
        let Some(id) = id.as_str() else { continue };
        let api = match p.get("api").and_then(|a| a.as_str()) {
            Some("openai-completions") => Api::Openai,
            Some("anthropic-messages") => Api::Anthropic,
            _ => continue,
        };
        let base_url = p.get("baseUrl").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let raw = p.get("apiKey").and_then(|x| x.as_str()).unwrap_or("");
        let api_key = if is_env_name(raw) {
            env_lookup(r, raw, &[dir.join(".env")])
        } else if raw.starts_with('!') {
            // A shell command; commands are never executed.
            String::new()
        } else {
            raw.to_string()
        };
        let models = p
            .get("models")
            .and_then(|m| m.as_sequence())
            .map(|s| s.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string)).collect())
            .unwrap_or_default();
        out.push(found("omp", file.clone(), Draft { id: id.to_string(), label: id.to_string(), api, base_url, api_key, models }));
    }
    Ok(out)
}

/// `{env:VAR}` and `{file:path}` placeholders of opencode's `options.apiKey`.
fn substitute(s: &str, config_dir: &Path, r: &Roots) -> String {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"\{(env|file):([^}]*)\}").unwrap());
    RE.replace_all(s, |c: &regex::Captures| -> String {
        match &c[1] {
            "env" => env_lookup(r, c[2].trim(), &[]),
            _ => {
                let raw = c[2].trim();
                let p = match raw.strip_prefix("~/") {
                    Some(rest) => r.home.join(rest),
                    None => PathBuf::from(raw),
                };
                let p = if p.is_absolute() { p } else { config_dir.join(p) };
                read_small_file(&p).unwrap_or_default()
            }
        }
    })
    .into_owned()
}

fn opencode(r: &Roots) -> anyhow::Result<Vec<Found>> {
    let dir = r.xdg_config.join("opencode");
    let Some(path) = find_file(&["opencode.json", "opencode.jsonc"], &dir) else {
        return Ok(vec![]);
    };
    let cfg = read_json5(&path)?;
    let auth = read_json(&r.xdg_data.join("opencode/auth.json"));
    let file = tilde(r, &path);

    let mut ids: Vec<String> = vec![];
    for key in ["provider", "providers"] {
        if let Some(o) = cfg.get(key).and_then(|v| v.as_object()) {
            for id in o.keys() {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
    }
    if let Some(o) = auth.as_object() {
        for (id, v) in o {
            if v["type"] == "api" && !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    }

    let mut out = vec![];
    for id in ids {
        let v1 = cfg.get("provider").and_then(|p| p.get(&id));
        let v2 = cfg.get("providers").and_then(|p| p.get(&id));
        let Some(base_url) = v1
            .and_then(|v| v.pointer("/options/baseURL"))
            .and_then(|v| v.as_str())
            .or_else(|| v2.and_then(|v| v.pointer("/settings/baseURL")).and_then(|v| v.as_str()))
            .map(str::to_string)
            .or_else(|| known(&id).map(|k| k.0.to_string()))
        else {
            continue;
        };
        let package = v1.and_then(|v| v.get("npm")).and_then(|v| v.as_str()).or_else(|| v2.and_then(|v| v.get("package")).and_then(|v| v.as_str()));
        let api = match package {
            Some(p) if p.contains("anthropic") => Api::Anthropic,
            Some(_) => Api::Openai,
            None => known(&id).map(|k| k.1).unwrap_or_default(),
        };
        let mut api_key = v1.and_then(|v| v.pointer("/options/apiKey")).and_then(|v| v.as_str()).map(|s| substitute(s, &dir, r)).unwrap_or_default();
        if api_key.is_empty() {
            if let Some(k) = auth.get(&id).filter(|a| a["type"] == "api").and_then(|a| a["key"].as_str()) {
                api_key = k.to_string();
            }
        }
        if api_key.is_empty() {
            if let Some(names) = v2.and_then(|v| v.get("env")).and_then(|e| e.as_array()) {
                for name in names {
                    api_key = env_lookup(r, name.as_str().unwrap_or(""), &[]);
                    if !api_key.is_empty() {
                        break;
                    }
                }
            }
        }
        if api_key.is_empty() {
            if let Some(k) = known(&id) {
                api_key = env_lookup(r, k.2, &[]);
            }
        }
        let label = v1
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .or_else(|| v2.and_then(|v| v.get("name")).and_then(|v| v.as_str()))
            .unwrap_or(&id)
            .to_string();
        let models = v1
            .and_then(|v| v.get("models"))
            .or_else(|| v2.and_then(|v| v.get("models")))
            .and_then(|m| m.as_object())
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        out.push(found("opencode", file.clone(), Draft { id, label, api, base_url, api_key, models }));
    }
    Ok(out)
}

fn claude(r: &Roots) -> anyhow::Result<Vec<Found>> {
    let path = r.claude.join("settings.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let cfg = read_json(&path);
    let env = cfg.get("env").cloned().unwrap_or(Value::Null);
    let var = |name: &str| -> String {
        env.get(name)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| r.env.get(name).filter(|s| !s.is_empty()).cloned())
            .unwrap_or_default()
    };
    let base_url = match var("ANTHROPIC_BASE_URL") {
        b if b.is_empty() => "https://api.anthropic.com".to_string(),
        b => b,
    };
    let (api_key, auth) = match var("ANTHROPIC_AUTH_TOKEN") {
        t if !t.is_empty() => (t, Auth::Bearer),
        _ => (var("ANTHROPIC_API_KEY"), Auth::XApiKey),
    };
    let aliases = ["default", "opus", "sonnet", "haiku", "fable", "opusplan"];
    let mut models = vec![];
    for m in [
        var("ANTHROPIC_MODEL"),
        cfg.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string(),
        var("ANTHROPIC_DEFAULT_OPUS_MODEL"),
        var("ANTHROPIC_DEFAULT_SONNET_MODEL"),
        var("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    ] {
        let m = m.strip_suffix("[1m]").unwrap_or(&m).trim().to_string();
        if !m.is_empty() && !aliases.contains(&m.as_str()) {
            models.push(m);
        }
    }
    let has_key = !api_key.is_empty();
    Ok(vec![Found {
        info: ProviderInfo {
            source: "claude",
            source_label: "Claude Code",
            id: "default".into(),
            label: "Claude Code".into(),
            api: Api::Anthropic,
            base_url: mask_userinfo(&base_url),
            has_key,
            file: tilde(r, &path),
            models: dedup(models),
        },
        endpoint: Endpoint { api: Api::Anthropic, base_url, api_key, auth },
    }])
}

fn codex(r: &Roots) -> anyhow::Result<Vec<Found>> {
    let path = r.codex.join("config.toml");
    if !path.exists() {
        return Ok(vec![]);
    }
    let cfg: toml::Value = toml::from_str(&std::fs::read_to_string(&path)?)?;
    let auth = read_json(&r.codex.join("auth.json"));
    let auth_key = auth["OPENAI_API_KEY"].as_str().unwrap_or("").to_string();
    let model = cfg.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let model_provider = cfg.get("model_provider").and_then(|v| v.as_str()).unwrap_or("openai");
    let file = tilde(r, &path);
    let models_for = |id: &str| if id == model_provider && !model.is_empty() { vec![model.clone()] } else { vec![] };

    let mut out = vec![];
    let mut has_openai = false;
    if let Some(providers) = cfg.get("model_providers").and_then(|v| v.as_table()) {
        for (id, p) in providers {
            if id == "openai" {
                has_openai = true;
            }
            let Some(base_url) = p.get("base_url").and_then(|v| v.as_str()) else { continue };
            let api_key = p
                .get("env_key")
                .and_then(|v| v.as_str())
                .map(|k| env_lookup(r, k, &[]))
                .filter(|k| !k.is_empty())
                .or_else(|| p.get("experimental_bearer_token").and_then(|v| v.as_str()).map(str::to_string).filter(|k| !k.is_empty()))
                .or_else(|| (p.get("requires_openai_auth").and_then(|v| v.as_bool()) == Some(true)).then(|| auth_key.clone()).filter(|k| !k.is_empty()))
                .unwrap_or_default();
            let label = p.get("name").and_then(|v| v.as_str()).unwrap_or(id).to_string();
            out.push(found("codex", file.clone(), Draft { id: id.clone(), label, api: Api::Openai, base_url: base_url.to_string(), api_key, models: models_for(id) }));
        }
    }
    if !has_openai && !auth_key.is_empty() {
        let base_url = cfg.get("openai_base_url").and_then(|v| v.as_str()).unwrap_or("https://api.openai.com/v1").to_string();
        let models = models_for("openai");
        out.push(found("codex", file.clone(), Draft { id: "openai".into(), label: "openai".into(), api: Api::Openai, base_url, api_key: auth_key, models }));
    }
    Ok(out)
}

fn crush_key(raw: Option<&str>, id: &str, r: &Roots) -> String {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.starts_with("${") && s.ends_with('}') => env_lookup(r, &s[2..s.len() - 1], &[]),
        Some(s) if s.starts_with('$') => {
            if s.starts_with("$(") {
                String::new()
            } else {
                env_lookup(r, s.trim_start_matches('$'), &[])
            }
        }
        Some(s) if s.contains("$(") => String::new(),
        Some(s) => s.to_string(),
        None => known(id).map(|k| env_lookup(r, k.2, &[])).unwrap_or_default(),
    }
}

fn crush(r: &Roots) -> anyhow::Result<Vec<Found>> {
    let cfg_path = r.xdg_config.join("crush/crush.json");
    let data_path = r.xdg_data.join("crush/crush.json");
    let cfg = if cfg_path.exists() { read_json5(&cfg_path)? } else { Value::Null };
    let data = if data_path.exists() { read_json5(&data_path)? } else { Value::Null };
    let file = tilde(r, &cfg_path);
    let mut ids: Vec<String> = vec![];
    for v in [&cfg, &data] {
        if let Some(o) = v.get("providers").and_then(|p| p.as_object()) {
            for id in o.keys() {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
    }
    let mut out = vec![];
    for id in ids {
        // The data file holds the keys entered in the TUI, so it wins per field.
        let mut merged = serde_json::Map::new();
        for v in [&cfg, &data] {
            if let Some(o) = v.get("providers").and_then(|p| p.get(&id)).and_then(|p| p.as_object()) {
                merged.extend(o.clone());
            }
        }
        let p = Value::Object(merged);
        let api = match p.get("type").and_then(|v| v.as_str()) {
            Some("completions" | "openai" | "openai-compat" | "litellm" | "lmstudio" | "ollama" | "llamacpp" | "omlx") => Api::Openai,
            Some("messages" | "anthropic") => Api::Anthropic,
            Some(_) => continue,
            None => match known(&id) {
                Some(k) => k.1,
                None => continue,
            },
        };
        let base_url = p
            .get("base_url")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| known(&id).map(|k| k.0.to_string()));
        let Some(base_url) = base_url else { continue };
        let api_key = crush_key(p.get("api_key").and_then(|v| v.as_str()), &id, r);
        let label = p.get("name").and_then(|v| v.as_str()).unwrap_or(&id).to_string();
        let models = p
            .get("models")
            .and_then(|m| m.as_array())
            .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string)).collect())
            .unwrap_or_default();
        out.push(found("crush", file.clone(), Draft { id, label, api, base_url, api_key, models }));
    }
    Ok(out)
}

fn qwen(r: &Roots) -> anyhow::Result<Vec<Found>> {
    let dir = r.home.join(".qwen");
    let path = dir.join("settings.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let cfg = read_json5(&path)?;
    let file = tilde(r, &path);
    let dotenv_file = dir.join(".env");
    let settings_env = cfg.get("env").cloned().unwrap_or(Value::Null);
    let mut groups: Vec<(Api, &'static str, String, String, Vec<String>)> = vec![];
    for (proto, default_base, api) in [
        ("openai", "https://api.openai.com/v1", Api::Openai),
        ("anthropic", "https://api.anthropic.com", Api::Anthropic),
    ] {
        let Some(entries) = cfg.pointer(&format!("/modelProviders/{proto}")).and_then(|e| e.as_array()) else { continue };
        for e in entries {
            let Some(id) = e.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else { continue };
            let base_url = e.get("baseUrl").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(default_base).to_string();
            let env_key = e.get("envKey").and_then(|v| v.as_str()).unwrap_or("").to_string();
            match groups.iter_mut().find(|g| g.1 == proto && g.2 == base_url && g.3 == env_key) {
                Some(g) => g.4.push(id.to_string()),
                None => groups.push((api, proto, base_url, env_key, vec![id.to_string()])),
            }
        }
    }
    let mut out = vec![];
    for (api, proto, base_url, env_key, models) in groups {
        let mut api_key = env_lookup(r, &env_key, &[]);
        if api_key.is_empty() {
            api_key = settings_env.get(&env_key).and_then(|v| v.as_str()).unwrap_or("").to_string();
        }
        if api_key.is_empty() {
            api_key = env_lookup(r, &env_key, std::slice::from_ref(&dotenv_file));
        }
        let label = url::Url::parse(&base_url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| base_url.clone());
        out.push(found("qwen", file.clone(), Draft { id: format!("{proto}:{base_url}"), label, api, base_url, api_key, models }));
    }
    Ok(out)
}

fn goose(r: &Roots) -> anyhow::Result<Vec<Found>> {
    let dir = r.xdg_config.join("goose");
    let providers = dir.join("custom_providers");
    let Ok(entries) = std::fs::read_dir(&providers) else {
        return Ok(vec![]);
    };
    let secrets: HashMap<String, String> = std::fs::read_to_string(dir.join("secrets.yaml"))
        .ok()
        .and_then(|s| serde_yaml::from_str(&s).ok())
        .unwrap_or_default();
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|e| e == "json")).collect();
    paths.sort();
    let mut out = vec![];
    for path in paths {
        let p = read_json(&path);
        let Some(id) = p.get("name").and_then(|v| v.as_str()) else { continue };
        let api = match p.get("engine").and_then(|v| v.as_str()) {
            Some("openai") => Api::Openai,
            Some("anthropic") => Api::Anthropic,
            _ => continue,
        };
        let env_key = p.get("api_key_env").and_then(|v| v.as_str()).unwrap_or("");
        let api_key = r.env.get(env_key).filter(|k| !k.is_empty()).cloned().or_else(|| secrets.get(env_key).filter(|k| !k.is_empty()).cloned()).unwrap_or_default();
        let base_url = strip_chat_path(p.get("base_url").and_then(|v| v.as_str()).unwrap_or(""), api);
        let label = p.get("display_name").and_then(|v| v.as_str()).unwrap_or(id).to_string();
        let models = p
            .get("models")
            .and_then(|m| m.as_array())
            .map(|a| a.iter().filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(str::to_string)).collect())
            .unwrap_or_default();
        let file = tilde(r, &path);
        out.push(found("goose", file, Draft { id: id.to_string(), label, api, base_url, api_key, models }));
    }
    Ok(out)
}

fn gemini(r: &Roots) -> anyhow::Result<Vec<Found>> {
    let dir = r.home.join(".gemini");
    // Gemini CLI's usual login is OAuth, so it is listed only when an API key actually exists.
    let api_key = env_lookup(r, "GEMINI_API_KEY", &[dir.join(".env")]);
    if api_key.is_empty() {
        return Ok(vec![]);
    }
    let path = dir.join("settings.json");
    let models = read_json(&path).pointer("/model/name").and_then(|m| m.as_str()).map(|m| vec![m.to_string()]).unwrap_or_default();
    let file = tilde(r, &path);
    let d = Draft {
        id: "default".into(),
        label: "Gemini API".into(),
        api: Api::Openai,
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai".into(),
        api_key,
        models,
    };
    Ok(vec![found("gemini", file, d)])
}

type Parser = fn(&Roots) -> anyhow::Result<Vec<Found>>;

/// Every provider found in the agents' own configs; one broken source never hides the others.
pub fn discover(r: &Roots) -> Vec<Found> {
    let parsers: [(&'static str, Parser); 8] = [
        ("omp", omp),
        ("opencode", opencode),
        ("claude", claude),
        ("codex", codex),
        ("crush", crush),
        ("qwen", qwen),
        ("goose", goose),
        ("gemini", gemini),
    ];
    let mut out = vec![];
    for (source, parse) in parsers {
        match parse(r) {
            Ok(mut f) => out.append(&mut f),
            // Only the first line: toml's message quotes the offending source line, which may hold a token.
            Err(e) => crate::logs::log("llm", &format!("providers {source}: {}", e.to_string().lines().next().unwrap_or("ошибка разбора"))),
        }
    }
    out
}

/// Resolves the referenced provider to a live endpoint; `None` when it no longer exists.
pub fn endpoint_for(r: &Roots, llm: &Llm) -> Option<Endpoint> {
    if llm.source.is_empty() {
        let api_key = if llm.api_key.is_empty() { r.env.get("DEEPSEEK_API_KEY").cloned().unwrap_or_default() } else { llm.api_key.clone() };
        return Some(Endpoint { api: llm.api, base_url: llm.base_url.clone(), api_key, auth: auth_for(llm.api) });
    }
    discover(r).into_iter().find(|f| f.info.source == llm.source && f.info.id == llm.provider).map(|f| f.endpoint)
}

/// `{base}/v1{path}` unless the base already carries the version segment.
pub fn anthropic_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}{path}")
    } else {
        format!("{base}/v1{path}")
    }
}

async fn live_models(http: &reqwest::Client, ep: &Endpoint) -> anyhow::Result<Vec<String>> {
    let url = match ep.api {
        Api::Openai => format!("{}/models", ep.base_url.trim_end_matches('/')),
        Api::Anthropic => anthropic_url(&ep.base_url, "/models?limit=1000"),
    };
    let rb = super::client::authed(http.get(url), ep).timeout(Duration::from_secs(10));
    let resp = rb.send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}", resp.status());
    }
    let v: Value = resp.json().await?;
    Ok(v["data"].as_array().map(|a| a.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect()).unwrap_or_default())
}

/// The provider's declared models first, then whatever its `/models` endpoint adds.
pub async fn list_models(http: &reqwest::Client, r: &Roots, llm: &Llm) -> Result<Vec<String>, String> {
    let declared = if llm.source.is_empty() {
        vec![]
    } else {
        discover(r).into_iter().find(|f| f.info.source == llm.source && f.info.id == llm.provider).map(|f| f.info.models).unwrap_or_default()
    };
    let Some(ep) = endpoint_for(r, llm) else {
        return Err(format!("Провайдер {}/{} не найден", llm.source, llm.provider));
    };
    if ep.api_key.is_empty() {
        return if declared.is_empty() { Err("Нет ключа API".into()) } else { Ok(declared) };
    }
    match live_models(http, &ep).await {
        Ok(live) => {
            let mut seen: HashSet<String> = declared.iter().cloned().collect();
            let mut extra: Vec<String> = live.into_iter().filter(|m| seen.insert(m.clone())).collect();
            extra.sort();
            let mut out = declared;
            out.extend(extra);
            Ok(out)
        }
        Err(e) => {
            if declared.is_empty() {
                Err(format!("Не удалось получить список моделей: {e}"))
            } else {
                crate::logs::log("llm", &format!("models {}/{}: {e}", llm.source, llm.provider));
                Ok(declared)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(files: &[(&str, &str)]) -> Roots {
        let d = std::env::temp_dir().join(format!("smartsubs-prov-{}", uuid::Uuid::new_v4()));
        for (name, body) in files {
            let p = d.join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        Roots::under(&d)
    }

    fn by_id<'a>(f: &'a [Found], id: &str) -> &'a Found {
        f.iter().find(|x| x.info.id == id).unwrap_or_else(|| panic!("{id} not found"))
    }

    #[test]
    fn omp_reads_env_literal_and_command_keys() {
        let r = root(&[
            (
                ".omp/agent/models.yml",
                r#"
providers:
  k-env:
    baseUrl: https://e.example/v1
    api: openai-completions
    apiKey: MY_KEY
    models:
      - id: m1
      - id: m2
  k-literal:
    baseUrl: https://l.example/v1
    api: openai-completions
    apiKey: sk-literal
    models: [{ id: l1 }]
  k-cmd:
    baseUrl: https://c.example/v1
    api: openai-completions
    apiKey: "!secret-tool lookup x"
    models: [{ id: c1 }]
  k-claude:
    baseUrl: https://a.example/v1
    api: anthropic-messages
    apiKey: sk-ant-1
    models: [{ id: a1 }]
  k-image:
    baseUrl: https://i.example/v1
    models: [{ id: i1 }]
"#,
            ),
            (".omp/agent/.env", "# comment\nexport MY_KEY=\"from-dotenv\"\nOTHER=1\n"),
        ]);
        let f = omp(&r).unwrap();
        let env = by_id(&f, "k-env");
        assert_eq!(env.endpoint.api_key, "from-dotenv");
        assert_eq!(env.endpoint.auth, Auth::Bearer);
        assert_eq!(env.info.models, vec!["m1", "m2"]);
        assert!(env.info.file.starts_with('~'));
        assert_eq!(by_id(&f, "k-literal").endpoint.api_key, "sk-literal");
        assert!(!by_id(&f, "k-cmd").info.has_key);
        let a = by_id(&f, "k-claude");
        assert_eq!((a.info.api, a.endpoint.auth), (Api::Anthropic, Auth::XApiKey));
        assert!(!f.iter().any(|x| x.info.id == "k-image"));
    }

    #[test]
    fn opencode_parses_jsonc_and_merges_auth_and_known() {
        let mut r = root(&[
            (
                ".config/opencode/opencode.json",
                r#"{
  // the real file has comments and trailing commas
  "provider": {
    "commented": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://c.example/v1", "apiKey": "{env:K}" }, "models": { "a": { "name": "A" }, "b": {} }, },
    "google": { "models": { "g": {} } }
  },
  "providers": {
    "v2": { "package": "@ai-sdk/anthropic", "settings": { "baseURL": "https://v2.example" }, "env": ["V2_KEY"], "models": { "x": {} } }
  }
}"#,
            ),
            (".local/share/opencode/auth.json", r#"{"deepseek":{"type":"api","key":"auth-key"},"google":{"type":"oauth","access":"tok"}}"#),
        ]);
        r.env.insert("K".into(), "env-key".into());
        r.env.insert("V2_KEY".into(), "v2-key".into());
        let f = opencode(&r).unwrap();
        let c = by_id(&f, "commented");
        assert_eq!(c.endpoint.api_key, "env-key");
        assert_eq!(c.endpoint.auth, Auth::Bearer);
        assert_eq!(c.info.models, vec!["a", "b"]);
        assert_eq!(c.info.label, "commented");
        assert_eq!(by_id(&f, "v2").endpoint.api, Api::Anthropic);
        assert_eq!(by_id(&f, "v2").endpoint.api_key, "v2-key");
        assert_eq!(by_id(&f, "v2").endpoint.base_url, "https://v2.example");
        assert_eq!(by_id(&f, "deepseek").endpoint.base_url, "https://api.deepseek.com");
        assert_eq!(by_id(&f, "deepseek").endpoint.api_key, "auth-key");
        assert!(!by_id(&f, "google").info.has_key);
    }

    #[test]
    fn opencode_prefers_options_key_and_reads_file_placeholder() {
        let r = root(&[
            (
                ".config/opencode/opencode.json",
                r#"{"provider":{"f":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://f.example","apiKey":"{file:key.txt}"},"models":{}}}}"#,
            ),
            (".config/opencode/key.txt", "  file-key\n"),
        ]);
        assert_eq!(by_id(&opencode(&r).unwrap(), "f").endpoint.api_key, "file-key");
    }

    #[test]
    fn claude_uses_anthropic_env() {
        let r = root(&[(
            ".claude/settings.json",
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"tok","ANTHROPIC_MODEL":"claude-x[1m]"},"model":"opus"}"#,
        )]);
        let f = claude(&r).unwrap();
        assert_eq!(f[0].endpoint.auth, Auth::Bearer);
        assert_eq!(f[0].endpoint.base_url, "https://api.anthropic.com");
        assert_eq!(f[0].info.models, vec!["claude-x"]);

        let r = root(&[(".claude/settings.json", r#"{"env":{"ANTHROPIC_API_KEY":"k","ANTHROPIC_BASE_URL":"https://cc.example"}}"#)]);
        let f = claude(&r).unwrap();
        assert_eq!((f[0].endpoint.auth, f[0].endpoint.api_key.as_str()), (Auth::XApiKey, "k"));
        assert_eq!(f[0].endpoint.base_url, "https://cc.example");
    }

    #[test]
    fn codex_reads_providers_env_keys_and_model() {
        let r = root(&[
            (
                ".codex/config.toml",
                r#"
model = "gpt-x"
model_provider = "gw"
[model_providers.gw]
name = "Gateway"
base_url = "https://gw.example/v1"
env_key = "GW_KEY"
"#,
            ),
            (".codex/auth.json", r#"{"OPENAI_API_KEY":null}"#),
        ]);
        let f = codex(&r).unwrap();
        assert_eq!(f.len(), 1);
        assert!(!f[0].info.has_key);
        assert_eq!(f[0].info.models, vec!["gpt-x"]);
        assert_eq!(f[0].info.label, "Gateway");

        let r = root(&[
            (".codex/config.toml", "model = \"gpt-x\"\n"),
            (".codex/auth.json", r#"{"OPENAI_API_KEY":"sk-openai"}"#),
        ]);
        let f = codex(&r).unwrap();
        assert_eq!(f[0].info.id, "openai");
        assert_eq!(f[0].endpoint.base_url, "https://api.openai.com/v1");
        assert_eq!(f[0].info.models, vec!["gpt-x"]);
    }

    #[test]
    fn crush_data_dir_key_wins() {
        let r = root(&[
            (".config/crush/crush.json", r#"{"providers":{"p":{"type":"openai","base_url":"https://p.example/v1","api_key":"config-key","models":[{"id":"m1"}]}}}"#),
            (".local/share/crush/crush.json", r#"{"providers":{"p":{"api_key":"data-key"}}}"#),
        ]);
        let f = crush(&r).unwrap();
        assert_eq!(f[0].endpoint.api_key, "data-key");
        assert_eq!(f[0].endpoint.base_url, "https://p.example/v1");
        assert_eq!(f[0].info.models, vec!["m1"]);
    }

    #[test]
    fn qwen_groups_entries_by_base_url() {
        let r = root(&[(
            ".qwen/settings.json",
            r#"{"modelProviders":{"openai":[{"id":"m1","baseUrl":"https://q.example/v1","envKey":"QK"},{"id":"m2","baseUrl":"https://q.example/v1","envKey":"QK"}]}}"#,
        )]);
        let f = qwen(&r).unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].info.id, "openai:https://q.example/v1");
        assert_eq!(f[0].info.models, vec!["m1", "m2"]);
        assert_eq!(f[0].info.label, "q.example");
    }

    #[test]
    fn goose_reads_secrets_yaml() {
        let r = root(&[
            (
                ".config/goose/custom_providers/p.json",
                r#"{"name":"p","display_name":"P","engine":"anthropic","base_url":"https://g.example","api_key_env":"GK","models":[{"name":"gm"}]}"#,
            ),
            (".config/goose/secrets.yaml", "GK: secret-from-yaml\n"),
        ]);
        let f = goose(&r).unwrap();
        assert_eq!(f[0].endpoint.api_key, "secret-from-yaml");
        assert_eq!((f[0].info.api, f[0].info.label.as_str()), (Api::Anthropic, "P"));
        assert_eq!(f[0].info.models, vec!["gm"]);
    }

    #[test]
    fn gemini_needs_a_key() {
        let r = root(&[(".gemini/settings.json", r#"{"model":{"name":"gemini-3-pro"}}"#)]);
        assert!(gemini(&r).unwrap().is_empty());
        let r = root(&[(".gemini/settings.json", r#"{"model":{"name":"gemini-3-pro"}}"#), (".gemini/.env", "GEMINI_API_KEY=g-key\n")]);
        let f = gemini(&r).unwrap();
        assert_eq!(f[0].info.id, "default");
        assert_eq!(f[0].info.models, vec!["gemini-3-pro"]);
    }

    #[test]
    fn goose_strips_the_full_chat_url() {
        let r = root(&[
            (
                ".config/goose/custom_providers/p.json",
                r#"{"name":"p","engine":"openai","base_url":"https://g.example/v1/chat/completions","api_key_env":"GK","models":[{"name":"m"}]}"#,
            ),
            (".config/goose/secrets.yaml", "GK: k\n"),
        ]);
        assert_eq!(goose(&r).unwrap()[0].endpoint.base_url, "https://g.example/v1");
    }

    #[test]
    fn file_placeholder_reads_only_small_regular_files() {
        let big = "x".repeat(9000);
        let r = root(&[
            (
                ".config/opencode/opencode.json",
                r#"{"provider":{
                    "dir":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://d.example","apiKey":"{file:.}"},"models":{}},
                    "big":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://b.example","apiKey":"{file:big.txt}"},"models":{}}
                }}"#,
            ),
            (".config/opencode/big.txt", &big),
        ]);
        let f = opencode(&r).unwrap();
        assert!(!by_id(&f, "dir").info.has_key);
        assert!(!by_id(&f, "big").info.has_key);
    }

    #[test]
    fn base_url_userinfo_is_masked_for_the_ui() {
        let r = root(&[(".claude/settings.json", r#"{"env":{"ANTHROPIC_BASE_URL":"https://u:p@gw.example","ANTHROPIC_API_KEY":"k"}}"#)]);
        let f = claude(&r).unwrap();
        assert_eq!(f[0].info.base_url, "https://***@gw.example");
        assert_eq!(f[0].endpoint.base_url, "https://u:p@gw.example");
    }

    #[test]
    fn anthropic_url_keeps_one_v1() {
        assert_eq!(anthropic_url("https://x.com", "/messages"), "https://x.com/v1/messages");
        assert_eq!(anthropic_url("https://x.com/v1/", "/messages"), "https://x.com/v1/messages");
    }
}
