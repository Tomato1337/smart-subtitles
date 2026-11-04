//! AI pictures for the cards, ported from tutor's `anki/flashcards.py`: four backends behind one
//! `generate`, a disk cache keyed by the settings and the prompt, and a WebP downscale.

use crate::{config, logs, state::AppState};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use regex::Regex;
use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

/// Tutor's negative prompt: the cards must not carry any lettering.
const NEGATIVE_PROMPT: &str = "text, words, letters, writing, typography, watermark, signature, \
label, caption, title, subtitle, number, digit, symbol, logo, \
brand, stamp, badge, banner, overlay, annotation, handwriting";
/// Added to every backend but Runware, which takes the negative prompt instead.
const NO_TEXT: &str = ". No text, letters or signs in the image.";
const OMP_OVERLAY: &str = include_str!("builtin/omp-image-overlay.yml");
/// The card shows images at ≤320 CSS px; 768 covers 2× screens.
const MAX_SIDE: u32 = 768;

static OMP_PATH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(/[^"\s]*omp-image-[0-9A-Za-z]+\.(?:png|jpe?g|webp|gif))"#).unwrap());

/// Fully resolved image settings: what the cache key hashes and what a backend call needs.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    /// "none" | "openai" | "runware" | "gemini" | "omp"
    pub backend: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub size: String,
    /// Model of the agent that calls the generate_image tool (omp only).
    pub agent_model: String,
}

impl Spec {
    pub fn none() -> Self {
        Self { backend: "none".into(), model: String::new(), base_url: String::new(), api_key: String::new(), size: String::new(), agent_model: String::new() }
    }

    fn from_images(i: &config::Images) -> Self {
        let backend = i.backend.as_str();
        match backend {
            "openai" => Self {
                backend: backend.into(),
                model: i.openai.model.clone(),
                base_url: i.openai.base_url.clone(),
                api_key: i.openai.api_key.clone(),
                size: i.openai.size.clone(),
                agent_model: String::new(),
            },
            "runware" => Self { backend: backend.into(), model: i.runware.model.clone(), api_key: i.runware.api_key.clone(), ..Self::none() },
            "gemini" => Self { backend: backend.into(), model: i.gemini.model.clone(), api_key: i.gemini.api_key.clone(), ..Self::none() },
            "omp" => Self { backend: backend.into(), model: i.omp.model.clone(), agent_model: i.omp.agent_model.clone(), ..Self::none() },
            _ => Self::none(),
        }
    }
}

/// The settings actually used: tutor's own when it is enabled and owns the image settings, else the app's.
pub async fn effective(st: &AppState, images: &config::Images) -> Spec {
    let cfg = st.cfg();
    if cfg.tutor.enabled && cfg.tutor.use_image_settings {
        if let Some(s) = crate::tutor::api::settings(st).await {
            return match s["cards.imageBackend"].as_str().unwrap_or("omp") {
                "none" => Spec::none(),
                "runware" => Spec {
                    backend: "runware".into(),
                    model: images.runware.model.clone(),
                    // Tutor keeps the Runware key in its own .env, not in its settings document.
                    api_key: crate::llm::providers::dotenv(&Path::new(&cfg.tutor.root).join(".env")).remove("RUNWARE").unwrap_or_default(),
                    ..Spec::none()
                },
                // Tutor's default backend, with the image-role model.
                _ => Spec {
                    backend: "omp".into(),
                    model: s["cards.ompImageModel"].as_str().unwrap_or("").to_string(),
                    agent_model: images.omp.agent_model.clone(),
                    ..Spec::none()
                },
            };
        }
    }
    Spec::from_images(images)
}

/// The prompt sent to the backend: the draft's own prompt plus the house style.
pub fn prompt(raw: &str, style: &str, backend: &str) -> String {
    let mut p = raw.trim().to_string();
    if !style.trim().is_empty() {
        p.push_str(&format!(". Style: {}", style.trim()));
    }
    if backend != "runware" {
        p.push_str(NO_TEXT);
    }
    p
}

/// Same settings and prompt — same file: the preview and the add share one generated image.
pub fn cache_key(spec: &Spec, prompt: &str) -> String {
    let json = serde_json::to_string(spec).unwrap_or_default();
    hex::encode(Sha256::digest(format!("{json}\n{prompt}").as_bytes()))[..16].to_string()
}

pub fn dir() -> PathBuf {
    config::cache_dir().join("card-images")
}

fn cached_file(key: &str) -> Option<PathBuf> {
    ["webp", "png", "jpg", "jpeg", "gif"].iter().map(|e| dir().join(format!("{key}.{e}"))).find(|p| p.is_file())
}

/// The image `generate` would return, without generating anything (the settings preview uses it).
pub fn cached(spec: &Spec, prompt: &str) -> Option<PathBuf> {
    cached_file(&cache_key(spec, prompt))
}

/// `data:image/webp;base64,…` for an `<img src>` in the preview.
pub fn data_url(path: &Path) -> String {
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    let mime = crate::poster::image_mime(&bytes);
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Cached file if there is one, otherwise the backend call, then a WebP copy on disk.
pub async fn generate(st: &AppState, spec: &Spec, prompt: &str) -> Result<PathBuf, String> {
    if spec.backend == "none" {
        return Err("генерация картинок выключена".into());
    }
    let key = cache_key(spec, prompt);
    if let Some(p) = cached_file(&key) {
        return Ok(p);
    }
    std::fs::create_dir_all(dir()).map_err(|e| format!("{}: {e}", dir().display()))?;
    let bytes = match spec.backend.as_str() {
        "openai" => openai(st, spec, prompt).await?,
        "runware" => runware(st, spec, prompt).await?,
        "gemini" => gemini(st, spec, prompt).await?,
        "omp" => omp_image(spec, prompt).await?,
        other => return Err(format!("неизвестный бэкенд картинок «{other}»")),
    };
    store(&key, &bytes).await
}

/// Writes the bytes as `{key}.webp`, or as the original file when ffmpeg is missing or fails.
async fn store(key: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let mime = crate::poster::image_mime(bytes);
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return Err("бэкенд вернул не изображение".into()),
    };
    let src = dir().join(format!("{key}.src.{ext}"));
    std::fs::write(&src, bytes).map_err(|e| format!("{}: {e}", src.display()))?;
    let dest = dir().join(format!("{key}.webp"));
    let vf = format!("scale='if(gt(iw,ih),min({MAX_SIDE},iw),-2)':'if(gt(iw,ih),-2,min({MAX_SIDE},ih))'");
    // Lower priority: playback must not stutter while a card is built.
    let o = tokio::time::timeout(
        Duration::from_secs(120),
        crate::proc::background("ffmpeg")
            .args(["-v", "error", "-y", "-i"])
            .arg(&src)
            .args(["-vf", &vf, "-c:v", "libwebp", "-quality", "82"])
            .arg(&dest)
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let ok = matches!(&o, Ok(Ok(o)) if o.status.success());
    if ok {
        let _ = std::fs::remove_file(&src);
        return Ok(dest);
    }
    // ffmpeg failed: the original bytes are still a usable image.
    let _ = std::fs::remove_file(&dest);
    let fallback = dir().join(format!("{key}.{ext}"));
    std::fs::rename(&src, &fallback).map_err(|e| format!("{}: {e}", fallback.display()))?;
    logs::log("app", &format!("cards: webp conversion failed, keeping {ext}"));
    Ok(fallback)
}

async fn openai(st: &AppState, spec: &Spec, prompt: &str) -> Result<Vec<u8>, String> {
    if spec.api_key.is_empty() {
        return Err("нет API-ключа openai".into());
    }
    let url = format!("{}/images/generations", spec.base_url.trim_end_matches('/'));
    let r = st
        .http
        .post(&url)
        .bearer_auth(&spec.api_key)
        .timeout(Duration::from_secs(180))
        .json(&json!({ "model": spec.model, "prompt": prompt, "size": spec.size, "n": 1 }))
        .send()
        .await
        .map_err(|e| format!("openai: {e}"))?;
    let ok = r.status().is_success();
    let v: Value = r.json().await.map_err(|e| format!("openai: {e}"))?;
    if !ok {
        return Err(format!("openai: {}", v["error"]["message"].as_str().unwrap_or("ошибка")));
    }
    if let Some(b64) = v["data"][0]["b64_json"].as_str() {
        return base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("openai: {e}"));
    }
    match v["data"][0]["url"].as_str() {
        Some(u) => download(st, u).await.map_err(|e| format!("openai: {e}")),
        None => Err("openai: в ответе нет картинки".into()),
    }
}

async fn runware(st: &AppState, spec: &Spec, prompt: &str) -> Result<Vec<u8>, String> {
    if spec.api_key.is_empty() {
        return Err("нет API-ключа runware".into());
    }
    let task = json!([{
        "taskType": "imageInference",
        "taskUUID": uuid::Uuid::new_v4().to_string(),
        "model": spec.model,
        "positivePrompt": prompt,
        "negativePrompt": NEGATIVE_PROMPT,
        "width": 512,
        "height": 512,
        "steps": 4,
        "outputFormat": "WEBP",
        "outputType": "URL",
        "deliveryMethod": "sync",
        "numberResults": 1,
    }]);
    let r = st
        .http
        .post("https://api.runware.ai/v1")
        .bearer_auth(&spec.api_key)
        .timeout(Duration::from_secs(120))
        .json(&task)
        .send()
        .await
        .map_err(|e| format!("runware: {e}"))?;
    let status = r.status();
    let v: Value = r.json().await.map_err(|e| format!("runware: {e}"))?;
    if let Some(e) = v["errors"].as_array().and_then(|a| a.first()) {
        return Err(format!("runware: {}", e["message"].as_str().unwrap_or("ошибка")));
    }
    if !status.is_success() {
        return Err(format!("runware: HTTP {}", status.as_u16()));
    }
    let url = v["data"][0]["imageURL"].as_str().ok_or("runware: в ответе нет картинки")?;
    download_retry(st, url).await.map_err(|e| format!("runware: {e}"))
}

/// Runware hands out CDN links that sometimes 404 for a moment: 3 attempts, 2 s and 4 s apart.
async fn download_retry(st: &AppState, url: &str) -> Result<Vec<u8>, String> {
    let mut last = String::new();
    for attempt in 1..=3 {
        match download(st, url).await {
            Ok(b) => return Ok(b),
            Err(e) => {
                last = e;
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
                }
            }
        }
    }
    Err(last)
}

async fn download(st: &AppState, url: &str) -> Result<Vec<u8>, String> {
    let r = st
        .http
        .get(url)
        .header("User-Agent", "smart-subtitle/1.0")
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("HTTP {}", r.status().as_u16()));
    }
    let b = r.bytes().await.map_err(|e| e.to_string())?;
    Ok(b.to_vec())
}

async fn gemini(st: &AppState, spec: &Spec, prompt: &str) -> Result<Vec<u8>, String> {
    if spec.api_key.is_empty() {
        return Err("нет API-ключа gemini".into());
    }
    let base = format!("https://generativelanguage.googleapis.com/v1beta/models/{}", spec.model);
    let imagen = spec.model.starts_with("imagen");
    let (url, body) = if imagen {
        (
            format!("{base}:predict"),
            json!({ "instances": [{ "prompt": prompt }], "parameters": { "sampleCount": 1, "aspectRatio": "1:1" } }),
        )
    } else {
        (
            format!("{base}:generateContent"),
            json!({
                "contents": [{ "parts": [{ "text": prompt }] }],
                "generationConfig": { "responseModalities": ["IMAGE"], "imageConfig": { "aspectRatio": "1:1" } },
            }),
        )
    };
    let r = st
        .http
        .post(&url)
        .header("x-goog-api-key", &spec.api_key)
        .timeout(Duration::from_secs(180))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("gemini: {e}"))?;
    let ok = r.status().is_success();
    let v: Value = r.json().await.map_err(|e| format!("gemini: {e}"))?;
    if !ok {
        return Err(format!("gemini: {}", v["error"]["message"].as_str().unwrap_or("ошибка")));
    }
    let b64 = if imagen {
        v["predictions"][0]["bytesBase64Encoded"].as_str()
    } else {
        v["candidates"][0]["content"]["parts"]
            .as_array()
            .and_then(|a| a.iter().find_map(|p| p["inlineData"]["data"].as_str()))
    };
    let b64 = b64.ok_or_else(|| format!("gemini: в ответе нет картинки ({})", v.to_string().chars().take(300).collect::<String>()))?;
    base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("gemini: {e}"))
}

/// One image through the omp agent's generate_image tool, as tutor's `_omp_image_once` does it.
async fn omp_image(spec: &Spec, prompt: &str) -> Result<Vec<u8>, String> {
    let omp = omp_bin().ok_or("omp не найден в PATH")?;
    let overlay = config::cache_dir().join("omp-image-overlay.yml");
    if let Some(parent) = overlay.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::write(&overlay, OMP_OVERLAY).map_err(|e| format!("{}: {e}", overlay.display()))?;

    let subject = prompt.replace('\\', " ").replace('"', "'");
    let model = if spec.model.is_empty() { String::new() } else { format!(", model \"{}\"", spec.model) };
    let instruction = format!(
        "Call the generate_image tool exactly once with subject \"{subject}\", aspect_ratio \"1:1\"{model}. Call no other tool. Then reply DONE."
    );
    // JSON mode first; the text mode retry only when the tool never ran (its output has no tool result).
    for extra in [vec!["--mode", "json"], vec!["--mode", "text", "--print-thoughts"]] {
        let mut cmd = crate::proc::command(&omp);
        cmd.args(["-p"])
            .args(&extra)
            .args(["--no-session", "--no-skills", "--no-rules", "--no-extensions", "--config"])
            .arg(&overlay)
            .args(["--model", &spec.agent_model, "--thinking", "off"])
            .arg(&instruction)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .env("PATH", crate::proc::without_npm_bins(&std::env::var_os("PATH").unwrap_or_default()))
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        let stdout = run_omp(cmd).await?;
        if let Some(m) = OMP_PATH_RE.captures(&stdout) {
            let path = PathBuf::from(&m[1]);
            if path.is_file() {
                return std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()));
            }
        }
        if stdout.contains("\"type\":\"tool_execution_end\"") {
            break; // json mode reports tool results: the tool really produced no image
        }
    }
    Err("omp: нет картинки в ответе".into())
}

/// Runs omp, returns its stdout; a timeout kills the whole process group (on Windows only omp itself,
/// through `kill_on_drop`).
async fn run_omp(mut cmd: tokio::process::Command) -> Result<String, String> {
    let child = cmd.spawn().map_err(|e| format!("omp: {e}"))?;
    #[cfg(unix)]
    let pid = child.id();
    match tokio::time::timeout(Duration::from_secs(240), child.wait_with_output()).await {
        Ok(Ok(o)) => Ok(String::from_utf8_lossy(&o.stdout).into_owned()),
        Ok(Err(e)) => Err(format!("omp: {e}")),
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = pid {
                let _ = tokio::process::Command::new("kill").args(["-KILL", &format!("-{pid}")]).status().await;
            }
            Err("omp: таймаут 240 с".into())
        }
    }
}

/// `omp` from PATH without `node_modules/.bin`, then its usual install location.
fn omp_bin() -> Option<PathBuf> {
    let path = crate::proc::without_npm_bins(&std::env::var_os("PATH").unwrap_or_default());
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local").join("bin"));
    }
    crate::proc::find_in("omp", dirs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(backend: &str) -> Spec {
        Spec {
            backend: backend.into(),
            model: "m".into(),
            base_url: "https://api.example/v1".into(),
            api_key: "k".into(),
            size: "1024x1024".into(),
            agent_model: "anthropic/claude-haiku-5-5".into(),
        }
    }

    #[test]
    fn prompt_carries_style_and_no_text_except_for_runware() {
        assert_eq!(prompt("A dog", "", "openai"), "A dog. No text, letters or signs in the image.");
        assert_eq!(prompt("A dog", "photo", "openai"), "A dog. Style: photo. No text, letters or signs in the image.");
        assert_eq!(prompt("A dog", "photo", "runware"), "A dog. Style: photo");
    }

    #[test]
    fn cache_key_follows_settings_and_prompt() {
        let a = cache_key(&spec("openai"), "A dog");
        assert_eq!(a.len(), 16);
        assert_eq!(a, cache_key(&spec("openai"), "A dog"));
        assert_ne!(a, cache_key(&spec("openai"), "A cat"));
        assert_ne!(a, cache_key(&spec("omp"), "A dog"));
        let mut other = spec("openai");
        other.model = "other".into();
        assert_ne!(a, cache_key(&other, "A dog"));
    }

    #[test]
    fn settings_map_to_a_spec() {
        let mut i = config::Images { backend: "gemini".into(), ..Default::default() };
        i.gemini.api_key = "g".into();
        let s = Spec::from_images(&i);
        assert_eq!(s.backend, "gemini");
        assert_eq!(s.api_key, "g");
        assert_eq!(s.model, "gemini-2.5-flash-image");
        assert_eq!(Spec::from_images(&config::Images { backend: "none".into(), ..Default::default() }), Spec::none());
    }

    #[test]
    fn the_omp_overlay_is_the_tutor_one() {
        assert!(OMP_OVERLAY.contains("generate_image: {enabled: true}"));
        assert!(OMP_OVERLAY.contains("memory: {backend: \"off\"}"));
    }
}
