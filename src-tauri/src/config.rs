use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Server { pub port: u16 }
impl Default for Server { fn default() -> Self { Self { port: 47800 } } }

/// Origins of Lampa instances allowed to POST /api/session; empty until the user adds their own.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Lampa { pub origins: Vec<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Llm {
    /// "" = manual (baseUrl/apiKey/api below); otherwise a ProviderInfo.source.
    pub source: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub api: crate::llm::providers::Api,
    /// Resolved at load/save from the source; never written to config.json or sent to the UI.
    #[serde(skip)]
    pub endpoint: crate::llm::providers::Endpoint,
}
impl Default for Llm {
    fn default() -> Self {
        Self {
            source: String::new(),
            provider: String::new(),
            model: "deepseek-flash".into(),
            base_url: "https://api.deepseek.com".into(),
            api_key: String::new(),
            api: Default::default(),
            endpoint: Default::default(),
        }
    }
}

/// One task's connection: empty `source` means the main `llm` settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TaskLlm {
    pub source: String,
    pub provider: String,
    /// Empty = `llm.model`; allowed only on the main connection.
    pub model: String,
    pub effort: crate::llm::tasks::Effort,
    #[serde(skip)]
    pub endpoint: crate::llm::providers::Endpoint,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LlmTasks {
    pub annotate: TaskLlm,
    pub explain: TaskLlm,
    pub draft: TaskLlm,
    pub chat: TaskLlm,
    pub cost: TaskLlm,
}
impl LlmTasks {
    pub fn get(&self, t: crate::llm::tasks::Task) -> &TaskLlm {
        use crate::llm::tasks::Task;
        match t {
            Task::Annotate => &self.annotate,
            Task::Explain => &self.explain,
            Task::Draft => &self.draft,
            Task::Chat => &self.chat,
            Task::Cost => &self.cost,
        }
    }

    fn get_mut(&mut self, t: crate::llm::tasks::Task) -> &mut TaskLlm {
        use crate::llm::tasks::Task;
        match t {
            Task::Annotate => &mut self.annotate,
            Task::Explain => &mut self.explain,
            Task::Draft => &mut self.draft,
            Task::Chat => &mut self.chat,
            Task::Cost => &mut self.cost,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenSubtitles { pub api_key: String, pub username: String, pub password: String }

/// Consent of the dialog analysis: `auto` stops asking while the annotate model stays the same.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Annot {
    pub auto: bool,
    /// `Config::annot_model_key` of the model the user trusted; empty = nothing remembered.
    pub remembered_model: String,
}
impl Default for Annot {
    fn default() -> Self { Self { auto: true, remembered_model: String::new() } }
}

/// Ids accepted in `subtitles.sources`, in the default order.
pub const SUBTITLE_SOURCES: [&str; 4] = ["torrserver", "sidecar", "embedded", "opensubtitles"];

/// Sources the automatic subtitle search tries, in order; `[]` turns the automatic search off.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Subtitles { pub sources: Vec<String> }
impl Default for Subtitles {
    fn default() -> Self { Self { sources: SUBTITLE_SOURCES.iter().map(|s| s.to_string()).collect() } }
}

/// Optional companion service: CEFR level, its own image settings, script import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Tutor { pub enabled: bool, pub root: String, pub api_url: String, pub use_image_settings: bool }
impl Default for Tutor {
    fn default() -> Self {
        Self {
            enabled: false,
            root: dirs::home_dir().unwrap_or_default().join("tutor").to_string_lossy().into_owned(),
            api_url: "http://127.0.0.1:4820".into(),
            use_image_settings: true,
        }
    }
}

/// Word/translation fields of one note type, for the known-words index.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct IndexFields { pub word: String, pub translation: String }

/// Cards are written straight into Anki through AnkiConnect, with no tutor in between.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Anki {
    pub url: String,
    /// Target deck; created on the first card.
    pub deck: String,
    pub note_type: String,
    /// Anki field name -> source id (`""` = field left empty); a missing field is auto-mapped.
    pub fields: BTreeMap<String, String>,
    /// Tags of every added card, `{film}` becomes the film slug.
    pub tags: String,
    /// Decks the known-words index reads; `["*"]` = every deck, empty = only `deck`.
    pub index_decks: Vec<String>,
    /// Note type -> index fields override; a missing note type is auto-detected.
    pub index_fields: BTreeMap<String, IndexFields>,
    /// Word audio through edge-tts.
    pub tts: bool,
    pub tts_voice: String,
    /// "none" | "clip" | "tts"
    pub sentence_audio: String,
    /// Cut the movie clip at all: off means no clip, no ClipText/ClipSource and no clip audio.
    pub clip: bool,
    pub sync_after_add: bool,
}
impl Default for Anki {
    fn default() -> Self {
        Self {
            url: "http://127.0.0.1:8765".into(),
            deck: "Learning English".into(),
            note_type: crate::anki::note_type::BUILTIN_NAME.into(),
            fields: BTreeMap::new(),
            tags: "vocab smartsubs smartsubs::{film}".into(),
            index_decks: vec!["*".into()],
            index_fields: BTreeMap::new(),
            tts: true,
            tts_voice: "en-US-GuyNeural".into(),
            sentence_audio: "none".into(),
            clip: true,
            sync_after_add: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImagesOpenai { pub base_url: String, pub api_key: String, pub model: String, pub size: String }
impl Default for ImagesOpenai {
    fn default() -> Self {
        Self { base_url: "https://api.openai.com/v1".into(), api_key: String::new(), model: "gpt-image-1".into(), size: "1024x1024".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImagesRunware { pub api_key: String, pub model: String }
impl Default for ImagesRunware {
    fn default() -> Self { Self { api_key: String::new(), model: "runware:400@2".into() } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImagesGemini { pub api_key: String, pub model: String }
impl Default for ImagesGemini {
    fn default() -> Self { Self { api_key: String::new(), model: "gemini-2.5-flash-image".into() } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImagesOmp { pub model: String, pub agent_model: String }
impl Default for ImagesOmp {
    fn default() -> Self { Self { model: String::new(), agent_model: "anthropic/claude-haiku-5-5".into() } }
}

/// AI pictures for the cards: one backend at a time, the others keep their saved settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Images {
    /// "none" | "openai" | "runware" | "gemini" | "omp"
    pub backend: String,
    /// Appended to every prompt as ". Style: {style}".
    pub style: String,
    pub openai: ImagesOpenai,
    pub runware: ImagesRunware,
    pub gemini: ImagesGemini,
    pub omp: ImagesOmp,
}
impl Default for Images {
    fn default() -> Self {
        Self { backend: "none".into(), style: String::new(), openai: Default::default(), runware: Default::default(), gemini: Default::default(), omp: Default::default() }
    }
}

/// Basic-auth credentials for a TorrServer behind a reverse proxy (e.g. https://example.com/tor).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Torrserver { pub base_url: String, pub username: String, pub password: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Ffmpeg { pub vaapi_device: String }
impl Default for Ffmpeg { fn default() -> Self { Self { vaapi_device: "/dev/dri/renderD128".into() } } }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Learner { pub cefr: String }
impl Default for Learner { fn default() -> Self { Self { cefr: "A2".into() } } }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: Server,
    pub lampa: Lampa,
    pub llm: Llm,
    /// Per-task provider/model/effort; `Config` has no `rename_all`, so the camelCase key is explicit.
    #[serde(rename = "llmTasks")]
    pub llm_tasks: LlmTasks,
    pub opensubtitles: OpenSubtitles,
    pub subtitles: Subtitles,
    pub annot: Annot,
    pub tutor: Tutor,
    pub anki: Anki,
    pub images: Images,
    pub torrserver: Torrserver,
    pub ffmpeg: Ffmpeg,
    pub learner: Learner,
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("smart-subtitle")
}
pub fn cache_dir() -> PathBuf {
    dirs::cache_dir().unwrap_or_else(|| PathBuf::from(".")).join("smart-subtitle")
}

impl Config {
    /// Loads config.json, creating it with defaults when missing.
    pub fn load() -> anyhow::Result<Self> {
        let dir = config_dir();
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("config.json");
        let mut cfg: Config = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path)?)?
        } else {
            let c = Config::default();
            std::fs::write(&path, serde_json::to_vec_pretty(&c)?)?;
            c
        };
        cfg.resolve_llm();
        Ok(cfg)
    }

    /// Writes config.json atomically, readable only by the owner (it holds API keys and passwords).
    pub fn save(&self) -> anyhow::Result<()> {
        let dir = config_dir();
        std::fs::create_dir_all(&dir)?;
        let tmp = dir.join("config.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, dir.join("config.json"))?;
        Ok(())
    }

    /// Adds Basic-auth userinfo to URLs under torrserver.baseUrl so ffmpeg/ffprobe/reqwest can read them.
    /// URLs that already carry credentials, or lie elsewhere, are returned unchanged.
    pub fn with_auth(&self, url: &str) -> String {
        let t = &self.torrserver;
        if t.base_url.is_empty() || t.username.is_empty() || !url.starts_with(t.base_url.trim_end_matches('/')) {
            return url.to_string();
        }
        match url::Url::parse(url) {
            Ok(mut u) if u.username().is_empty() => {
                if u.set_username(&t.username).is_err() || u.set_password(Some(&t.password)).is_err() {
                    return url.to_string();
                }
                u.to_string()
            }
            _ => url.to_string(),
        }
    }

    /// Re-reads the referenced provider from the agent's own files, so a rotated key is picked up.
    pub fn resolve_llm(&mut self) {
        let roots = crate::llm::providers::Roots::from_env();
        match crate::llm::providers::endpoint_for(&roots, &self.llm) {
            Some(ep) => self.llm.endpoint = ep,
            None => {
                crate::logs::log("llm", &format!("провайдер {}/{} не найден", self.llm.source, self.llm.provider));
                self.llm.endpoint = Default::default();
            }
        }
        for task in crate::llm::tasks::Task::ALL {
            let t = self.llm_tasks.get_mut(task);
            if t.source.is_empty() {
                t.endpoint = Default::default();
                continue;
            }
            let llm = Llm { source: t.source.clone(), provider: t.provider.clone(), ..Default::default() };
            match crate::llm::providers::endpoint_for(&roots, &llm) {
                Some(ep) => t.endpoint = ep,
                None => {
                    crate::logs::log("llm", &format!("провайдер {}/{} для задачи {} не найден", t.source, t.provider, task.key()));
                    t.endpoint = Default::default();
                }
            }
        }
    }

    /// Provider, model and effort one call of `task` uses; the main connection unless the task overrides it.
    pub fn target(&self, task: crate::llm::tasks::Task) -> crate::llm::tasks::Target {
        let t = self.llm_tasks.get(task);
        if t.source.is_empty() {
            crate::llm::tasks::Target {
                task,
                source: self.llm.source.clone(),
                provider: self.llm.provider.clone(),
                model: if t.model.is_empty() { self.llm.model.clone() } else { t.model.clone() },
                effort: t.effort,
                endpoint: self.llm.endpoint.clone(),
            }
        } else {
            crate::llm::tasks::Target {
                task,
                source: t.source.clone(),
                provider: t.provider.clone(),
                model: t.model.clone(),
                effort: t.effort,
                endpoint: t.endpoint.clone(),
            }
        }
    }

    pub fn llm_enabled(&self) -> bool { !self.llm.endpoint.api_key.is_empty() }
    pub fn opensubtitles_enabled(&self) -> bool { !self.opensubtitles.api_key.is_empty() }

    /// Identity of the model the annotate task uses: the remembered "analyze without asking"
    /// consent only holds while this stays the same.
    pub fn annot_model_key(&self) -> String {
        let t = self.target(crate::llm::tasks::Task::Annotate);
        if t.source.is_empty() {
            format!("{} {}", t.endpoint.base_url, t.model)
        } else {
            format!("{}/{}/{}", t.source, t.provider, t.model)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_json_fills_defaults() {
        let mut c: Config = serde_json::from_str(r#"{"llm":{"apiKey":"k"}}"#).unwrap();
        c.resolve_llm();
        assert_eq!(c.llm.api_key, "k");
        assert_eq!(c.llm.model, "deepseek-flash");
        assert_eq!(c.server.port, 47800);
        // A config.json from before per-task models: every task follows the main connection.
        let t = c.target(crate::llm::tasks::Task::Annotate);
        assert_eq!(t.model, "deepseek-flash");
        assert_eq!(t.effort, crate::llm::tasks::Effort::Off);
        assert!(c.llm_enabled());
        assert!(!c.opensubtitles_enabled());
    }

    #[test]
    fn task_settings_round_trip_in_camel_case() {
        let c: Config = serde_json::from_str(
            r#"{"llmTasks":{"chat":{"source":"omp","provider":"apinebula-claude","model":"claude-sonnet-5-5","effort":"medium"}}}"#,
        )
        .unwrap();
        assert_eq!(c.llm_tasks.chat.effort, crate::llm::tasks::Effort::Medium);
        assert_eq!(c.llm_tasks.annotate.source, "");
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["llmTasks"]["chat"]["source"], "omp");
        assert_eq!(v["llmTasks"]["chat"]["effort"], "medium");
        assert!(v["llmTasks"]["chat"].get("endpoint").is_none());
    }

    #[test]
    fn annot_consent_defaults_and_model_key() {
        let mut c: Config = serde_json::from_str(r#"{"llm":{"apiKey":"k"}}"#).unwrap();
        c.resolve_llm();
        // Nothing remembered yet, and asking is on by default.
        assert!(c.annot.auto);
        assert!(c.annot.remembered_model.is_empty());
        assert_eq!(c.annot_model_key(), "https://api.deepseek.com deepseek-flash");
        // A task-level connection is named by source/provider/model, not by its endpoint.
        let t: Config = serde_json::from_str(
            r#"{"llmTasks":{"annotate":{"source":"omp","provider":"apinebula-claude","model":"claude-sonnet-5-5"}}}"#,
        )
        .unwrap();
        assert_eq!(t.annot_model_key(), "omp/apinebula-claude/claude-sonnet-5-5");
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["annot"]["auto"], true);
        assert_eq!(v["annot"]["rememberedModel"], "");
    }

    #[test]
    fn auth_injected_only_under_base_url() {
        let c: Config = serde_json::from_str(r#"{"torrserver":{"baseUrl":"https://h.example/tor","username":"admin","password":"p$%w"}}"#).unwrap();
        let u = c.with_auth("https://h.example/tor/stream/x.mkv?link=a&index=1");
        let p = url::Url::parse(&u).unwrap();
        assert_eq!(p.username(), "admin");
        assert_eq!(percent_decode(p.password().unwrap()), "p$%w");
        assert_eq!(c.with_auth("https://other.example/tor/x"), "https://other.example/tor/x");
        assert_eq!(c.with_auth("http://127.0.0.1:8095/stream/x"), "http://127.0.0.1:8095/stream/x");
    }

    fn percent_decode(s: &str) -> String {
        url::form_urlencoded::parse(format!("k={s}").as_bytes()).next().unwrap().1.into_owned()
    }
}
