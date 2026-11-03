use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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
pub struct Llm { pub base_url: String, pub api_key: String, pub model: String }
impl Default for Llm {
    fn default() -> Self {
        Self { base_url: "https://api.deepseek.com".into(), api_key: String::new(), model: "deepseek-flash".into() }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenSubtitles { pub api_key: String, pub username: String, pub password: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Tutor { pub root: String, pub api_url: String, pub deck: String }
impl Default for Tutor {
    fn default() -> Self {
        Self {
            root: dirs::home_dir().unwrap_or_default().join("tutor").to_string_lossy().into_owned(),
            api_url: "http://127.0.0.1:4820".into(),
            deck: "Learning English".into(),
        }
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
    pub opensubtitles: OpenSubtitles,
    pub tutor: Tutor,
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
        if cfg.llm.api_key.is_empty() {
            cfg.llm.api_key = std::env::var("DEEPSEEK_API_KEY").unwrap_or_default();
        }
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

    pub fn llm_enabled(&self) -> bool { !self.llm.api_key.is_empty() }
    pub fn opensubtitles_enabled(&self) -> bool { !self.opensubtitles.api_key.is_empty() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_json_fills_defaults() {
        let c: Config = serde_json::from_str(r#"{"llm":{"apiKey":"k"}}"#).unwrap();
        assert_eq!(c.llm.api_key, "k");
        assert_eq!(c.llm.model, "deepseek-flash");
        assert_eq!(c.server.port, 47800);
        assert!(c.llm_enabled());
        assert!(!c.opensubtitles_enabled());
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
