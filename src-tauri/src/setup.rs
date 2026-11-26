//! First-run setup: the wizard's status, the agent-facing HTTP API and the shared config-apply path.

use crate::{
    config::Config,
    llm::providers::{self, Roots},
    state::AppState,
};
use axum::{
    body::Bytes,
    extract::{Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, patch},
    Json, Router,
};
use serde::Serialize;
use std::sync::{atomic::Ordering, Arc};
use tauri::Emitter;

const GUIDE: &str = include_str!("setup_guide.md");

/// Who applied the change; the UI shows a toast for agent-made edits.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum By {
    App,
    Agent,
}

const CEFR: [&str; 6] = ["A1", "A2", "B1", "B2", "C1", "C2"];

pub(crate) fn valid_http_url(raw: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty())
    })
}

pub(crate) fn validate_tts_voice(voice: &str) -> Result<(), String> {
    let ok = (1..=64).contains(&voice.len())
        && !voice.starts_with('-')
        && voice.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "anki.ttsVoice: «{voice}» — ожидается имя голоса [A-Za-z0-9_-] (1–64 символа, не с «-»)"
        ))
    }
}

pub(crate) fn validate_vaapi_device(dev: &str) -> Result<(), String> {
    if dev.is_empty() {
        return Ok(());
    }
    let rest = dev.strip_prefix("/dev/dri/").ok_or_else(|| {
        format!("ffmpeg.vaapiDevice: «{dev}» — ожидается путь вида /dev/dri/renderD128")
    })?;
    let ok = (1..=64).contains(&rest.len())
        && !rest.starts_with('-')
        && !rest.contains("..")
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
    if ok {
        Ok(())
    } else {
        Err(format!("ffmpeg.vaapiDevice: «{dev}» — недопустимое имя устройства"))
    }
}

pub(crate) fn validate_tutor_root(root: &str) -> Result<(), String> {
    if root.is_empty() {
        return Ok(());
    }
    if root.contains('\0') {
        return Err("tutor.root: недопустимый нулевой байт".into());
    }
    let p = std::path::Path::new(root);
    if !p.is_absolute() {
        return Err(format!("tutor.root: «{root}» — нужен абсолютный путь"));
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("tutor.root: «{root}» — не должен содержать «..»"));
    }
    Ok(())
}

pub(crate) fn validate_llm_conn(llm: &crate::config::Llm, require_base_if_manual: bool) -> Result<(), String> {
    if !llm.source.is_empty() && llm.provider.trim().is_empty() {
        return Err("llm.provider: выберите провайдера".into());
    }
    if !llm.base_url.is_empty() {
        if !valid_http_url(&llm.base_url) {
            return Err(format!("llm.baseUrl: «{}» — нужен http(s)-адрес", llm.base_url));
        }
    } else if require_base_if_manual && llm.source.is_empty() {
        return Err("llm.baseUrl: укажите http(s)-адрес".into());
    }
    Ok(())
}

pub(crate) fn validate_anki(anki: &crate::config::Anki) -> Result<(), String> {
    if !valid_http_url(&anki.url) {
        return Err(format!("anki.url: «{}» — нужен адрес вида http://127.0.0.1:8765", anki.url));
    }
    if anki.deck.trim().is_empty() {
        return Err("anki.deck: укажите колоду".into());
    }
    if anki.note_type.trim().is_empty() {
        return Err("anki.noteType: укажите тип заметки".into());
    }
    for (field, source) in &anki.fields {
        if source.is_empty() {
            continue;
        }
        if crate::anki::fields::Source::parse(source).is_none() {
            return Err(format!("anki.fields.{field}: неизвестный источник «{source}»"));
        }
    }
    validate_tts_voice(&anki.tts_voice)?;
    if !["none", "clip", "tts"].contains(&anki.sentence_audio.as_str()) {
        return Err(format!("anki.sentenceAudio: ожидается none, clip или tts, получено «{}»", anki.sentence_audio));
    }
    Ok(())
}

pub(crate) fn validate_tutor(tutor: &crate::config::Tutor) -> Result<(), String> {
    validate_tutor_root(&tutor.root)?;
    if !tutor.api_url.is_empty() {
        if !valid_http_url(&tutor.api_url) {
            return Err(format!("tutor.apiUrl: «{}» — нужен http(s)-адрес", tutor.api_url));
        }
    } else if tutor.enabled {
        return Err("tutor.apiUrl: укажите http(s)-адрес".into());
    }
    Ok(())
}

pub(crate) fn validate_images(images: &crate::config::Images, tutor: &crate::config::Tutor) -> Result<(), String> {
    if !["none", "openai", "runware", "gemini", "omp"].contains(&images.backend.as_str()) {
        return Err(format!("images.backend: ожидается none, openai, runware, gemini или omp, получено «{}»", images.backend));
    }
    let mut fallbacks: Vec<&str> = Vec::new();
    for b in &images.fallbacks {
        if !["openai", "runware", "gemini", "omp"].contains(&b.as_str()) {
            return Err(format!(
                "images.fallbacks: ожидается openai, runware, gemini или omp, получено «{b}»"
            ));
        }
        if fallbacks.contains(&b.as_str()) {
            return Err(format!("images.fallbacks: «{b}» указан дважды"));
        }
        fallbacks.push(b.as_str());
    }
    // Tutor owns the primary while it is enabled with its own image settings; the app's own
    // backend is then unused, so it may also sit in the fallback order.
    let tutor_primary = tutor.enabled && tutor.use_image_settings;
    if !tutor_primary && images.backend != "none" && fallbacks.contains(&images.backend.as_str()) {
        return Err(format!("images.fallbacks: «{}» уже выбран основным", images.backend));
    }
    if !images.openai.base_url.is_empty() && !valid_http_url(&images.openai.base_url) {
        return Err(format!("images.openai.baseUrl: «{}» — нужен http(s)-адрес", images.openai.base_url));
    }
    Ok(())
}

/// Rejects configs that would break the app or the Lampa integration; messages go straight to the UI.
pub fn validate(cfg: &Config) -> Result<(), String> {
    if cfg.server.port == 0 {
        return Err("Порт должен быть от 1 до 65535".into());
    }
    if !CEFR.contains(&cfg.learner.cefr.as_str()) {
        return Err(format!("learner.cefr: ожидается A1–C2, получено «{}»", cfg.learner.cefr));
    }
    validate_llm_conn(&cfg.llm, false)?;
    for task in crate::llm::tasks::Task::ALL {
        let t = cfg.llm_tasks.get(task);
        if !t.source.is_empty() && t.provider.trim().is_empty() {
            return Err(format!("llmTasks.{}.provider: выберите провайдера", task.key()));
        }
        if !t.source.is_empty() && t.model.is_empty() {
            return Err(format!("llmTasks.{}.model: выберите модель", task.key()));
        }
    }
    for o in &cfg.lampa.origins {
        let ok = url::Url::parse(o).map(|u| u.origin().ascii_serialization() == *o).unwrap_or(false);
        if !ok {
            return Err(format!(
                "lampa.origins: «{o}» — не origin, нужно вида https://lampa.example.com (без пути и слеша в конце)"
            ));
        }
    }
    if !cfg.torrserver.base_url.is_empty() && !valid_http_url(&cfg.torrserver.base_url) {
        return Err(format!("torrserver.baseUrl: «{}» — нужен http(s)-адрес", cfg.torrserver.base_url));
    }
    validate_anki(&cfg.anki)?;
    validate_tutor(&cfg.tutor)?;
    validate_images(&cfg.images, &cfg.tutor)?;
    let mut seen: Vec<&str> = Vec::new();
    for s in &cfg.subtitles.sources {
        if !crate::config::SUBTITLE_SOURCES.contains(&s.as_str()) {
            return Err(format!("subtitles.sources: неизвестный источник «{s}»"));
        }
        if seen.contains(&s.as_str()) {
            return Err(format!("subtitles.sources: источник «{s}» указан дважды"));
        }
        seen.push(s.as_str());
    }
    if !cfg.subtitles.idle_opacity.is_finite() || !(0.0..=1.0).contains(&cfg.subtitles.idle_opacity) {
        return Err(format!("subtitles.idleOpacity: ожидается число от 0 до 1, получено {}", cfg.subtitles.idle_opacity));
    }
    validate_vaapi_device(&cfg.ffmpeg.vaapi_device)?;
    Ok(())
}

/// Fields that never leave the app in clear text; `MASK` in a patch means "keep the stored value".
const SECRETS: [&str; 7] = [
    "llm.apiKey",
    "opensubtitles.apiKey",
    "opensubtitles.password",
    "torrserver.password",
    "images.openai.apiKey",
    "images.runware.apiKey",
    "images.gemini.apiKey",
];
pub const MASK: &str = "***";

/// Free-form maps: their keys are Anki field names, not config fields, so `check_keys` must not
/// recurse into them (an agent patching `anki.fields` would otherwise get «неизвестное поле»).
const FREE_MAPS: [&str; 2] = ["anki.fields", "anki.indexFields"];

fn value_at<'a>(v: &'a mut serde_json::Value, path: &str) -> Option<&'a mut serde_json::Value> {
    path.split('.').try_fold(v, |v, k| v.get_mut(k))
}

fn value_at_ref<'a>(v: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    path.split('.').try_fold(v, |v, k| v.get(k))
}

fn supplied_non_masked_secret(patch: &serde_json::Value, path: &str) -> bool {
    matches!(value_at_ref(patch, path), Some(serde_json::Value::String(s)) if s != MASK)
}

fn clear_stale_secrets(old: &Config, next: &mut Config, llm_ok: bool, openai_ok: bool, torr_ok: bool) {
    if !llm_ok && (next.llm.base_url != old.llm.base_url || next.llm.source != old.llm.source) {
        next.llm.api_key.clear();
    }
    if !openai_ok && next.images.openai.base_url != old.images.openai.base_url {
        next.images.openai.api_key.clear();
    }
    if !torr_ok && next.torrserver.base_url != old.torrserver.base_url {
        next.torrserver.password.clear();
    }
}

/// The config as the agent sees it: every secret replaced by `MASK`, empty ones stay empty.
pub fn redacted(cfg: &Config) -> serde_json::Value {
    let mut v = serde_json::to_value(cfg).unwrap_or(serde_json::Value::Null);
    for path in SECRETS {
        if let Some(serde_json::Value::String(s)) = value_at(&mut v, path) {
            if !s.is_empty() {
                *s = MASK.into();
            }
        }
    }
    v
}

/// Rejects keys the config does not have, so `apikey` instead of `apiKey` fails loudly.
fn check_keys(patch: &serde_json::Value, tpl: &serde_json::Value, prefix: &str) -> Result<(), String> {
    let (Some(p), Some(t)) = (patch.as_object(), tpl.as_object()) else { return Ok(()) };
    for (k, v) in p {
        let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
        let Some(tv) = t.get(k) else { return Err(format!("неизвестное поле: {path}")) };
        if v.is_object() && tv.is_object() && !FREE_MAPS.contains(&path.as_str()) {
            check_keys(v, tv, &path)?;
        }
    }
    Ok(())
}

/// Drops `path` from `patch` when the agent echoed `MASK` back; the stored secret then survives.
fn drop_masked(v: &mut serde_json::Value, path: &str) {
    let mut parts: Vec<&str> = path.split('.').collect();
    let Some(last) = parts.pop() else { return };
    let Some(parent) = value_at(v, &parts.join(".")) else { return };
    let Some(o) = parent.as_object_mut() else { return };
    if o.get(last).and_then(|x| x.as_str()) == Some(MASK) {
        o.remove(last);
    }
}

/// RFC 7386: objects merge, everything else (arrays included) replaces, `null` removes the key.
fn merge(t: &mut serde_json::Map<String, serde_json::Value>, p: serde_json::Map<String, serde_json::Value>) {
    for (k, v) in p {
        match v {
            serde_json::Value::Null => {
                t.remove(&k);
            }
            serde_json::Value::Object(o) => {
                if !t.get(&k).is_some_and(serde_json::Value::is_object) {
                    t.insert(k.clone(), serde_json::Value::Object(Default::default()));
                }
                if let Some(serde_json::Value::Object(tv)) = t.get_mut(&k) {
                    merge(tv, o);
                }
            }
            other => {
                t.insert(k, other);
            }
        }
    }
}

/// Applies a JSON Merge Patch to the stored config; `MASK` in a secret field keeps the current value,
/// except when the corresponding endpoint/source changes without an explicit non-masked secret.
pub fn merge_patch(cfg: &Config, patch: serde_json::Value) -> Result<Config, String> {
    if !patch.is_object() {
        return Err("Тело должно быть JSON-объектом".into());
    }
    check_keys(&patch, &serde_json::to_value(Config::default()).unwrap_or_default(), "")?;
    let llm_key_supplied = supplied_non_masked_secret(&patch, "llm.apiKey");
    let openai_key_supplied = supplied_non_masked_secret(&patch, "images.openai.apiKey");
    let torr_pass_supplied = supplied_non_masked_secret(&patch, "torrserver.password");
    let mut patch = patch;
    for path in SECRETS {
        drop_masked(&mut patch, path);
    }
    let mut base = serde_json::to_value(cfg).unwrap_or_default();
    if let (serde_json::Value::Object(t), serde_json::Value::Object(p)) = (&mut base, patch) {
        merge(t, p);
    }
    let mut next = serde_json::from_value::<Config>(base).map_err(|e| format!("некорректный конфиг: {e}"))?;
    clear_stale_secrets(cfg, &mut next, llm_key_supplied, openai_key_supplied, torr_pass_supplied);
    Ok(next)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStep {
    pub id: &'static str,
    pub title: &'static str,
    pub importance: &'static str,
    pub done: bool,
    pub hint: String,
    pub fields: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub complete: bool,
    pub port: u16,
    pub guide_url: String,
    pub config_path: String,
    pub steps: Vec<SetupStep>,
}

/// `$HOME` replaced by `~`, so the path fits in a hint and in the agent guide.
pub(crate) fn tilde(path: &std::path::Path) -> String {
    match dirs::home_dir().and_then(|h| path.strip_prefix(h).ok().map(|p| p.to_path_buf())) {
        Some(rel) => format!("~/{}", rel.display()),
        None => path.display().to_string(),
    }
}

/// The system-tools row: missing required binaries with their install command, optional gaps after.
fn deps_step(deps: &[crate::deps::Dep]) -> SetupStep {
    let required_missing: Vec<&crate::deps::Dep> = deps.iter().filter(|d| d.importance == "required" && !d.found).collect();
    let optional_missing: Vec<&crate::deps::Dep> = deps.iter().filter(|d| d.importance == "optional" && !d.found).collect();
    let mut hint = if required_missing.is_empty() {
        "ffmpeg и ffprobe найдены.".to_string()
    } else {
        required_missing.iter().map(|d| d.hint.clone()).collect::<Vec<_>>().join(" ")
    };
    if !optional_missing.is_empty() {
        let list = optional_missing.iter().map(|d| format!("{} ({})", d.title, d.install)).collect::<Vec<_>>().join(", ");
        if !hint.ends_with('.') {
            hint.push('.');
        }
        hint.push_str(&format!(" Необязательно отсутствуют: {list}."));
    }
    SetupStep {
        id: "deps",
        title: "Системные зависимости",
        importance: "required",
        done: required_missing.is_empty(),
        hint,
        fields: vec![],
    }
}

/// What the wizard and `/api/setup` show: one row per thing worth configuring, in wizard order.
pub fn status(cfg: &Config, port: u16) -> SetupStatus {
    let llm_done = cfg.llm_enabled() && !cfg.llm.model.is_empty();
    let llm_hint = if llm_done {
        format!("{} через {}", cfg.llm.model, cfg.llm.endpoint.base_url)
    } else if !cfg.llm.source.is_empty() {
        format!("Провайдер {}/{} не найден или без ключа", cfg.llm.source, cfg.llm.provider)
    } else {
        "Нужен API-ключ OpenAI-совместимого или Anthropic API (по умолчанию DeepSeek: https://platform.deepseek.com/api_keys) либо провайдер из другого агента".into()
    };
    let subs_done = cfg.opensubtitles_enabled();
    let lampa_done = !cfg.lampa.origins.is_empty();
    let backend = cfg.images.backend.as_str();
    let tutor_primary = cfg.tutor.enabled && cfg.tutor.use_image_settings;
    let enabled: Vec<&str> = if tutor_primary {
        cfg.images.fallbacks.iter().map(String::as_str).collect()
    } else if backend == "none" {
        Vec::new()
    } else {
        std::iter::once(backend).chain(cfg.images.fallbacks.iter().map(String::as_str)).collect()
    };
    let images_key_ok = tutor_primary || enabled.is_empty() || enabled.iter().any(|provider| match *provider {
        "openai" => !cfg.images.openai.api_key.is_empty(),
        "runware" => !cfg.images.runware.api_key.is_empty(),
        "gemini" => !cfg.images.gemini.api_key.is_empty(),
        "omp" => true,
        _ => false,
    });
    let anki_done = !cfg.anki.deck.trim().is_empty() && images_key_ok;
    let images_desc = if tutor_primary {
        std::iter::once("tutor (основной)").chain(enabled).collect::<Vec<_>>().join(" → ")
    } else if enabled.is_empty() {
        "выключены".into()
    } else {
        enabled.join(" → ")
    };
    let quick_desc = if cfg.anki.quick_add { "быстрое добавление" } else { "с предпросмотром" };

    let deps = crate::deps::check();
    let steps = vec![
        deps_step(&deps),
        SetupStep {
            id: "llm",
            title: "Перевод и разбор (LLM)",
            importance: "required",
            done: llm_done,
            hint: llm_hint,
            fields: vec!["llm.source", "llm.provider", "llm.model", "llm.baseUrl", "llm.apiKey", "llm.api", "learner.cefr"],
        },
        SetupStep {
            id: "opensubtitles",
            title: "Субтитры (OpenSubtitles)",
            importance: "recommended",
            done: subs_done,
            hint: if subs_done {
                "Ключ задан".into()
            } else {
                "Бесплатный ключ: https://www.opensubtitles.com/consumers. Без него субтитры только из раздачи или файла".into()
            },
            fields: vec!["opensubtitles.apiKey", "opensubtitles.username", "opensubtitles.password"],
        },
        SetupStep {
            id: "lampa",
            title: "Lampa",
            importance: "recommended",
            done: lampa_done,
            hint: if lampa_done {
                cfg.lampa.origins.join(", ")
            } else {
                format!("Origin вашей Lampa, например https://lampa.example.com. Плагин: http://127.0.0.1:{port}/lampa/smartsubs.js")
            },
            fields: vec!["lampa.origins", "torrserver.baseUrl", "torrserver.username", "torrserver.password"],
        },
        SetupStep {
            id: "anki",
            title: "Anki и карточки",
            importance: "optional",
            done: anki_done,
            hint: if images_key_ok {
                format!(
                    "Колода «{}», тип «{}», {quick_desc}, картинки: {images_desc}",
                    cfg.anki.deck, cfg.anki.note_type
                )
            } else {
                format!("Нет API-ключа для картинок ({backend})")
            },
            fields: vec!["anki.deck", "anki.noteType", "anki.quickAdd", "images.backend", "images.fallbacks", "tutor.enabled"],
        },
    ];
    let complete = steps.iter().filter(|s| s.importance == "required").all(|s| s.done);

    SetupStatus {
        complete,
        port,
        guide_url: format!("http://127.0.0.1:{port}/llms.txt"),
        config_path: tilde(&crate::config::config_dir().join("config.json")),
        steps,
    }
}

/// Saves and applies the config at once, for the UI and for agents alike. Returns true when the
/// change needs an app restart (server port).
pub async fn apply(st: &Arc<AppState>, cfg: Config, by: By) -> Result<bool, String> {
    let _guard = st.config_lock.lock().await;
    apply_locked(st, cfg, by, true).await
}

/// Caller must hold `st.config_lock`.
pub(crate) async fn apply_locked(st: &Arc<AppState>, mut cfg: Config, by: By, clear_unchanged_secrets: bool) -> Result<bool, String> {
    let old = st.cfg();
    if clear_unchanged_secrets {
        let llm_supplied = cfg.llm.api_key != old.llm.api_key;
        let openai_supplied = cfg.images.openai.api_key != old.images.openai.api_key;
        let torr_supplied = cfg.torrserver.password != old.torrserver.password;
        clear_stale_secrets(&old, &mut cfg, llm_supplied, openai_supplied, torr_supplied);
    }
    validate(&cfg)?;
    // Re-read the referenced provider off the async runtime: on macOS this may wait on a Keychain ACL prompt.
    let cfg = tokio::task::spawn_blocking(move || {
        let mut cfg = cfg;
        cfg.resolve_llm();
        cfg
    })
    .await
    .map_err(|e| format!("Не удалось проверить провайдера: {e}"))?;
    cfg.save().map_err(|e| format!("Не удалось сохранить config.json: {e}"))?;
    let vaapi_changed = old.ffmpeg.vaapi_device != cfg.ffmpeg.vaapi_device;
    // The index has to be re-read when Anki-side settings changed; Tutor connectivity is not the index's business.
    let anki_changed = old.anki.url != cfg.anki.url
        || old.anki.deck != cfg.anki.deck
        || old.anki.index_decks != cfg.anki.index_decks
        || serde_json::to_string(&old.anki.index_fields).ok() != serde_json::to_string(&cfg.anki.index_fields).ok();
    let restart = old.server.port != cfg.server.port;
    *st.config.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(cfg);
    if vaapi_changed {
        let ok = crate::vaapi_selftest(&st.cfg().ffmpeg.vaapi_device).await;
        st.vaapi_ok.store(ok, Ordering::Relaxed);
        crate::logs::log("app", &format!("vaapi_ok={ok}"));
    }
    if anki_changed {
        let s = st.clone();
        tauri::async_runtime::spawn(async move { crate::anki::index::refresh(&s).await });
    }
    let _ = st.app.emit("config:changed", serde_json::json!({ "by": by }));
    Ok(restart)
}

/// Agent-facing routes: `/llms.txt` requires loopback Host, no Origin, and no cross-site Sec-Fetch;
/// `/api/setup*` additionally requires `Authorization: Bearer <agent_token>`.
pub fn routes(st: Arc<AppState>) -> Router<Arc<AppState>> {
    let public = Router::new()
        .route("/llms.txt", get(guide))
        .route_layer(axum::middleware::from_fn_with_state(st.clone(), public_agent_only));
    let authed = Router::new()
        .route("/api/setup", get(api_setup))
        .route("/api/setup/config", patch(api_patch))
        .route("/api/setup/llm/providers", get(api_providers))
        .route("/api/setup/llm/models", get(api_models))
        .route_layer(axum::middleware::from_fn_with_state(st, agent_only));
    public.merge(authed)
}

pub(crate) fn constant_time_eq(a: &str, b: &str) -> bool {
    use sha2::{Digest, Sha256};
    let da = Sha256::digest(a.as_bytes());
    let db = Sha256::digest(b.as_bytes());
    let mut diff = 0u8;
    for (x, y) in da.iter().zip(db.iter()) {
        diff |= std::hint::black_box(*x ^ *y);
    }
    std::hint::black_box(diff) == 0 && a.len() == b.len()
}

pub(crate) fn valid_bearer(headers: &HeaderMap, expected_token: &str) -> bool {
    if expected_token.is_empty() {
        return false;
    }
    let mut all = headers.get_all(header::AUTHORIZATION).iter();
    let Some(val) = all.next() else { return false };
    if all.next().is_some() {
        return false;
    }
    let Ok(s) = val.to_str() else { return false };
    let Some((scheme, token)) = s.split_once(' ') else { return false };
    scheme.eq_ignore_ascii_case("bearer") && constant_time_eq(token, expected_token)
}

pub(crate) fn valid_loopback_host(headers: &HeaderMap, port: u16) -> bool {
    let mut all = headers.get_all(header::HOST).iter();
    let Some(val) = all.next() else { return false };
    if all.next().is_some() {
        return false;
    }
    let host = val.to_str().unwrap_or("").to_ascii_lowercase();
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

/// Rejects browser-initiated subresource/cross-site Fetch Metadata headers while allowing plain
/// CLI agents (no `Sec-Fetch-*`) and direct address-bar navigation (`Sec-Fetch-Site: none`).
pub(crate) fn sec_fetch_safe(headers: &HeaderMap) -> bool {
    let mut has_any = false;
    let mut site: Option<&str> = None;
    let mut mode: Option<&str> = None;
    let mut dest: Option<&str> = None;
    for (name, value) in headers {
        let k = name.as_str();
        if !k.starts_with("sec-fetch-") {
            continue;
        }
        has_any = true;
        let Ok(v) = value.to_str() else { return false };
        if k == "sec-fetch-site" {
            if site.is_some() {
                return false;
            }
            site = Some(v);
        } else if k == "sec-fetch-mode" {
            if mode.is_some() {
                return false;
            }
            mode = Some(v);
        } else if k == "sec-fetch-dest" {
            if dest.is_some() {
                return false;
            }
            dest = Some(v);
        }
    }
    if !has_any {
        return true;
    }
    let Some(s) = site else {
        return false;
    };
    if !s.eq_ignore_ascii_case("none") {
        return false;
    }
    if let Some(m) = mode {
        if !m.eq_ignore_ascii_case("navigate") {
            return false;
        }
    }
    if let Some(d) = dest {
        if !d.eq_ignore_ascii_case("document") {
            return false;
        }
    }
    true
}

/// Public guide/health check when no `Origin` is present: loopback `Host`, no `Origin`, safe `Sec-Fetch-*`.
pub fn agent_public_allowed(headers: &HeaderMap, port: u16) -> Result<(), &'static str> {
    if headers.contains_key(header::ORIGIN) {
        return Err("Доступ из браузера закрыт: API настройки только для локальных агентов (curl)");
    }
    if !valid_loopback_host(headers, port) {
        return Err("Host должен быть 127.0.0.1");
    }
    if !sec_fetch_safe(headers) {
        return Err("Доступ из браузера закрыт (Sec-Fetch)");
    }
    Ok(())
}

/// Authenticated setup routes: `Origin` absent, loopback `Host`, safe `Sec-Fetch-*`, valid Bearer token.
pub fn agent_allowed(headers: &HeaderMap, port: u16, expected_token: &str) -> Result<(), (StatusCode, &'static str)> {
    agent_public_allowed(headers, port).map_err(|msg| (StatusCode::FORBIDDEN, msg))?;
    if !valid_bearer(headers, expected_token) {
        return Err((StatusCode::UNAUTHORIZED, "Требуется Authorization: Bearer из agent.token"));
    }
    Ok(())
}

async fn public_agent_only(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    match agent_public_allowed(req.headers(), st.listen_port) {
        Ok(()) => next.run(req).await,
        Err(msg) => crate::server::err(StatusCode::FORBIDDEN, msg),
    }
}

async fn agent_only(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    match agent_allowed(req.headers(), st.listen_port, &st.agent_token) {
        Ok(()) => next.run(req).await,
        Err((code, msg)) => crate::server::err(code, msg),
    }
}

async fn guide(State(st): State<Arc<AppState>>) -> Response {
    let body = GUIDE.replace("{port}", &st.listen_port.to_string());
    ([(header::CONTENT_TYPE, "text/markdown; charset=utf-8")], body).into_response()
}

async fn api_setup(State(st): State<Arc<AppState>>) -> Response {
    let cfg = st.cfg();
    let mut v = match serde_json::to_value(status(&cfg, st.listen_port)) {
        Ok(v) => v,
        Err(e) => return crate::server::err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    v["config"] = redacted(&cfg);
    Json(v).into_response()
}

async fn api_patch(State(st): State<Arc<AppState>>, body: Bytes) -> Response {
    let patch: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return crate::server::err(StatusCode::BAD_REQUEST, e.to_string()),
    };
    let _guard = st.config_lock.lock().await;
    let cfg = match merge_patch(&st.cfg(), patch) {
        Ok(c) => c,
        Err(e) => return crate::server::err(StatusCode::BAD_REQUEST, e),
    };
    let restart = match apply_locked(&st, cfg, By::Agent, false).await {
        Ok(r) => r,
        Err(e) => return crate::server::err(StatusCode::BAD_REQUEST, e),
    };
    Json(serde_json::json!({ "restartRequired": restart, "status": status(&st.cfg(), st.listen_port) })).into_response()
}

async fn api_providers() -> Response {
    let list: Vec<providers::ProviderInfo> = tokio::task::spawn_blocking(|| {
        providers::discover(&Roots::from_env()).into_iter().map(|f| f.info).collect()
    })
    .await
    .unwrap_or_default();
    Json(list).into_response()
}

async fn api_models(State(st): State<Arc<AppState>>) -> Response {
    match providers::list_models(&st.llm_http, &Roots::from_env(), &st.cfg().llm).await {
        Ok(m) => Json(serde_json::json!({ "models": m })).into_response(),
        Err(e) => crate::server::err(StatusCode::BAD_GATEWAY, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    fn cfg(json: &str) -> Config { serde_json::from_str(json).unwrap() }

    #[test]
    fn unknown_field_is_rejected_with_its_path() {
        let e = merge_patch(&Config::default(), serde_json::json!({"llm":{"apikey":"x"}})).unwrap_err();
        assert_eq!(e, "неизвестное поле: llm.apikey");
    }

    #[test]
    fn masked_secret_keeps_the_stored_value() {
        let base = cfg(r#"{"opensubtitles":{"apiKey":"k","password":"p"}}"#);
        let c = merge_patch(&base, serde_json::json!({"opensubtitles":{"apiKey":"***","username":"u"}})).unwrap();
        assert_eq!(c.opensubtitles.api_key, "k");
        assert_eq!(c.opensubtitles.username, "u");
        assert_eq!(c.opensubtitles.password, "p");
    }

    #[test]
    fn free_form_field_maps_accept_any_key() {
        let c = merge_patch(&Config::default(), serde_json::json!({"anki":{"fields":{"Word":"word"},"indexFields":{"Basic":{"word":"Front","translation":"Back"}}}}))
            .unwrap();
        assert_eq!(c.anki.fields.get("Word").map(String::as_str), Some("word"));
        assert_eq!(c.anki.index_fields["Basic"].word, "Front");
        let e = merge_patch(&Config::default(), serde_json::json!({"anki":{"fieldz":1}})).unwrap_err();
        assert_eq!(e, "неизвестное поле: anki.fieldz");
    }

    #[test]
    fn anki_settings_are_validated() {
        let bad_url = cfg(r#"{"anki":{"url":"127.0.0.1:8765"}}"#);
        assert!(validate(&bad_url).unwrap_err().starts_with("anki.url:"));
        let bad_source = cfg(r#"{"anki":{"fields":{"Word":"nonsense"}}}"#);
        assert_eq!(validate(&bad_source).unwrap_err(), "anki.fields.Word: неизвестный источник «nonsense»");
        let bad_mode = cfg(r#"{"anki":{"sentenceAudio":"both"}}"#);
        assert!(validate(&bad_mode).unwrap_err().starts_with("anki.sentenceAudio:"));
        let bad_backend = cfg(r#"{"images":{"backend":"dalle"}}"#);
        assert!(validate(&bad_backend).unwrap_err().starts_with("images.backend:"));
        let empty = cfg(r#"{"anki":{"deck":" "}}"#);
        assert!(validate(&empty).is_err());
        assert!(validate(&Config::default()).is_ok());
    }

    #[test]
    fn image_fallbacks_are_known_unique_and_not_the_primary() {
        let unknown = cfg(r#"{"images":{"backend":"runware","fallbacks":["dalle"]}}"#);
        assert!(validate(&unknown).unwrap_err().starts_with("images.fallbacks:"));
        let dup = cfg(r#"{"images":{"backend":"openai","fallbacks":["runware","runware"]}}"#);
        assert!(validate(&dup).unwrap_err().starts_with("images.fallbacks:"));
        let primary = cfg(r#"{"images":{"backend":"runware","fallbacks":["gemini","runware"]}}"#);
        assert!(validate(&primary).unwrap_err().starts_with("images.fallbacks:"));
        assert!(validate(&cfg(r#"{"images":{"backend":"runware","fallbacks":["openai","gemini"]}}"#)).is_ok());
        // `none` has no image calls, so nothing can duplicate it; the list stays inert.
        assert!(validate(&cfg(r#"{"images":{"backend":"none","fallbacks":["omp"]}}"#)).is_ok());
        // Tutor owns the primary while its image settings are on; the app list is independent.
        let tutor = cfg(
            r#"{"images":{"backend":"runware","fallbacks":["runware","openai"]},"tutor":{"enabled":true,"useImageSettings":true}}"#,
        );
        assert!(validate(&tutor).is_ok());
    }

    #[test]
    fn image_keys_are_masked_like_other_secrets() {
        let c = cfg(r#"{"images":{"backend":"runware","runware":{"apiKey":"r"}}}"#);
        assert_eq!(redacted(&c)["images"]["runware"]["apiKey"], "***");
        let c = merge_patch(&c, serde_json::json!({"images":{"runware":{"apiKey":"***"}}})).unwrap();
        assert_eq!(c.images.runware.api_key, "r");
    }

    #[test]
    fn null_resets_a_section_to_defaults() {
        let base = cfg(r#"{"learner":{"cefr":"C1"}}"#);
        let c = merge_patch(&base, serde_json::json!({"learner": null})).unwrap();
        assert_eq!(c.learner.cefr, "A2");
    }

    #[test]
    fn arrays_are_replaced_whole() {
        let base = cfg(r#"{"lampa":{"origins":["https://b.example"]}}"#);
        let c = merge_patch(&base, serde_json::json!({"lampa":{"origins":["https://a.example"]}})).unwrap();
        assert_eq!(c.lampa.origins, vec!["https://a.example"]);
    }

    #[test]
    fn subtitle_sources_are_known_and_unique() {
        let unknown = cfg(r#"{"subtitles":{"sources":["stored"]}}"#);
        assert!(validate(&unknown).unwrap_err().starts_with("subtitles.sources:"));
        let dup = cfg(r#"{"subtitles":{"sources":["sidecar","sidecar"]}}"#);
        assert!(validate(&dup).unwrap_err().starts_with("subtitles.sources:"));
        assert!(validate(&cfg(r#"{"subtitles":{"sources":[]}}"#)).is_ok());
        assert_eq!(Config::default().subtitles.sources, crate::config::SUBTITLE_SOURCES);
        let c = merge_patch(&Config::default(), serde_json::json!({"subtitles":{"sources":["opensubtitles","sidecar"]}})).unwrap();
        assert_eq!(c.subtitles.sources, vec!["opensubtitles", "sidecar"]);
    }

    #[test]
    fn subtitles_idle_opacity_is_bounded() {
        for ok in [0.0, 0.36, 1.0] {
            let mut c = Config::default();
            c.subtitles.idle_opacity = ok;
            assert!(validate(&c).is_ok(), "expected {ok} to be valid");
        }
        for bad in [-0.1, 1.1, f64::NAN, f64::INFINITY] {
            let mut c = Config::default();
            c.subtitles.idle_opacity = bad;
            let err = validate(&c).unwrap_err();
            assert!(err.starts_with("subtitles.idleOpacity:"), "unexpected error for {bad}: {err}");
        }
        let custom = cfg(r#"{"subtitles":{"idleOpacity":0.5}}"#);
        let reset = merge_patch(&custom, serde_json::json!({"subtitles":{"idleOpacity":null}})).unwrap();
        assert_eq!(reset.subtitles.idle_opacity, 0.36);
    }

    #[test]
    fn non_object_patch_is_rejected() {
        assert_eq!(merge_patch(&Config::default(), serde_json::json!([])).unwrap_err(), "Тело должно быть JSON-объектом");
    }

    #[test]
    fn validate_checks_origins_and_level() {
        let bad = cfg(r#"{"lampa":{"origins":["https://lampa.example.com/"]}}"#);
        assert!(validate(&bad).unwrap_err().starts_with("lampa.origins:"));
        let good = cfg(r#"{"lampa":{"origins":["https://lampa.example.com"]}}"#);
        assert!(validate(&good).is_ok());
        assert!(validate(&cfg(r#"{"learner":{"cefr":"b2"}}"#)).is_err());
    }

    #[test]
    fn agent_allowed_requires_loopback_host_and_no_origin() {
        let tok = "test-secret-token";
        assert!(agent_public_allowed(&headers(&[("Host", "127.0.0.1:47800")]), 47800).is_ok());
        assert!(agent_public_allowed(&headers(&[("Host", "localhost:47800")]), 47800).is_ok());
        assert!(agent_public_allowed(&headers(&[("Host", "127.0.0.1:47800"), ("Sec-Fetch-Site", "none")]), 47800).is_ok());
        assert!(agent_public_allowed(&headers(&[("Host", "127.0.0.1:47800"), ("Sec-Fetch-Site", "cross-site")]), 47800).is_err());
        assert!(agent_public_allowed(&headers(&[("Host", "127.0.0.1:47800"), ("Sec-Fetch-Dest", "image")]), 47800).is_err());
        assert!(agent_public_allowed(&headers(&[("Host", "evil.example:47800")]), 47800).is_err());
        let with_origin = headers(&[("Host", "127.0.0.1:47800"), ("Origin", "https://lampa.example.com")]);
        assert!(agent_public_allowed(&with_origin, 47800).is_err());

        // Setup endpoints additionally require Authorization: Bearer <agent_token>.
        assert!(agent_allowed(&headers(&[("Host", "127.0.0.1:47800")]), 47800, tok).is_err());
        assert!(agent_allowed(&headers(&[("Host", "127.0.0.1:47800"), ("Authorization", "Bearer wrong")]), 47800, tok).is_err());
        assert!(agent_allowed(&headers(&[("Host", "127.0.0.1:47800"), ("Authorization", "Bearer test-secret-token")]), 47800, tok).is_ok());
        assert!(agent_allowed(
            &headers(&[
                ("Host", "127.0.0.1:47800"),
                ("Authorization", "Bearer test-secret-token"),
                ("Sec-Fetch-Site", "cross-site"),
            ]),
            47800,
            tok
        )
        .is_err());
    }

    #[test]
    fn changing_endpoint_or_source_clears_stale_secrets() {
        let base = cfg(r#"{"llm":{"baseUrl":"https://api.deepseek.com","apiKey":"sk-old"},"images":{"openai":{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-img"}},"torrserver":{"baseUrl":"https://ts.a.example","password":"tpw"}}"#);
        // Changing baseUrl without a new secret clears stored key even if "***" is echoed back.
        let p1 = merge_patch(&base, serde_json::json!({"llm":{"baseUrl":"https://evil.example/v1","apiKey":"***"}})).unwrap();
        assert_eq!(p1.llm.api_key, "");
        assert_eq!(p1.images.openai.api_key, "sk-img");

        // Changing llm.source clears stored manual llm.apiKey.
        let p2 = merge_patch(&base, serde_json::json!({"llm":{"source":"omp","provider":"anthropic"}})).unwrap();
        assert_eq!(p2.llm.api_key, "");

        // Explicitly supplying a new non-masked secret in the same patch keeps the new secret.
        let p3 = merge_patch(&base, serde_json::json!({"llm":{"baseUrl":"https://new.example/v1","apiKey":"sk-new"},"images":{"openai":{"baseUrl":"https://img2.example/v1"}},"torrserver":{"baseUrl":"https://ts.b.example","password":"newpw"}})).unwrap();
        assert_eq!(p3.llm.api_key, "sk-new");
        assert_eq!(p3.images.openai.api_key, "");
        assert_eq!(p3.torrserver.password, "newpw");
    }

    #[test]
    fn validate_checks_urls_providers_tts_vaapi_and_tutor_root() {
        assert!(validate(&cfg(r#"{"llm":{"baseUrl":"file:///etc/passwd"}}"#)).is_err());
        assert!(validate(&cfg(r#"{"images":{"openai":{"baseUrl":"ftp://x"}}}"#)).is_err());
        assert!(validate(&cfg(r#"{"torrserver":{"baseUrl":"javascript:alert(1)"}}"#)).is_err());
        assert!(validate(&cfg(r#"{"tutor":{"apiUrl":"not-a-url"}}"#)).is_err());
        assert!(validate(&cfg(r#"{"llm":{"source":"omp","provider":""}}"#)).is_err());
        assert!(validate(&cfg(r#"{"llmTasks":{"chat":{"source":"omp","provider":"","model":"m"}}}"#)).is_err());
        assert!(validate(&cfg(r#"{"anki":{"ttsVoice":"-bad"}}"#)).is_err());
        assert!(validate(&cfg(r#"{"anki":{"ttsVoice":"en-US;rm -rf"}}"#)).is_err());
        assert!(validate(&cfg(r#"{"anki":{"ttsVoice":"en-US-AriaNeural"}}"#)).is_ok());
        assert!(validate(&cfg(r#"{"ffmpeg":{"vaapiDevice":""}}"#)).is_ok());
        assert!(validate(&cfg(r#"{"ffmpeg":{"vaapiDevice":"/dev/dri/renderD129"}}"#)).is_ok());
        assert!(validate(&cfg(r#"{"ffmpeg":{"vaapiDevice":"/dev/dri/renderD128,format=nv12"}}"#)).is_err());
        assert!(validate(&cfg(r#"{"ffmpeg":{"vaapiDevice":"/tmp/evil"}}"#)).is_err());
        assert!(validate(&cfg(r#"{"tutor":{"root":"relative/path"}}"#)).is_err());
        assert!(validate(&cfg(r#"{"tutor":{"root":"/opt/tutor/../etc"}}"#)).is_err());
        assert!(validate(&cfg(r#"{"tutor":{"root":""}}"#)).is_ok());
        assert!(validate(&cfg(r#"{"tutor":{"root":"/opt/tutor"}}"#)).is_ok());
    }

    #[test]
    fn redacted_masks_set_secrets_and_keeps_empty_ones() {
        let c = cfg(r#"{"opensubtitles":{"apiKey":"k"}}"#);
        let v = redacted(&c);
        assert_eq!(v["opensubtitles"]["apiKey"], "***");
        assert_eq!(v["torrserver"]["password"], "");
    }

    fn test_dep(id: &'static str, importance: &'static str, found: bool, title: &'static str, hint: &'static str, install: &'static str) -> crate::deps::Dep {
        crate::deps::Dep { id, title, importance, found, purpose: "p", install: install.into(), hint: hint.into() }
    }

    #[test]
    fn deps_step_joins_required_and_optional_hints() {
        let deps = vec![
            test_dep("ffmpeg", "required", false, "ffmpeg и ffprobe", "Видео. Установите: sudo dnf install ffmpeg", "sudo dnf install ffmpeg"),
            test_dep("uv", "optional", false, "uv", "Синхронизация.", "curl uv"),
        ];
        let s = deps_step(&deps);
        assert!(!s.done);
        assert_eq!(s.hint, "Видео. Установите: sudo dnf install ffmpeg. Необязательно отсутствуют: uv (curl uv).");
        let ok = deps_step(&[test_dep("ffmpeg", "required", true, "ffmpeg и ffprobe", "Видео.", "x")]);
        assert!(ok.done);
        assert_eq!(ok.hint, "ffmpeg и ffprobe найдены.");
    }

    #[test]
    fn status_lists_the_wizard_steps_in_order() {
        let s = status(&Config::default(), 47800);
        let ids: Vec<&str> = s.steps.iter().map(|st| st.id).collect();
        assert_eq!(ids, vec!["deps", "llm", "opensubtitles", "lampa", "anki"]);
        assert_eq!(s.steps[0].importance, "required");
        let llm = s.steps.iter().find(|st| st.id == "llm").unwrap();
        assert!(!llm.done);
        assert!(!s.complete);
        assert_eq!(s.guide_url, "http://127.0.0.1:47800/llms.txt");
    }

    /// Dotted paths of every settable field; free-form maps count as one field.
    fn leaf_paths(v: &serde_json::Value, prefix: &str, out: &mut Vec<String>) {
        match v.as_object() {
            Some(o) if !FREE_MAPS.contains(&prefix) => {
                for (k, child) in o {
                    let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                    leaf_paths(child, &path, out);
                }
            }
            _ => out.push(prefix.to_string()),
        }
    }

    #[test]
    fn agent_guide_documents_every_config_field() {
        let mut paths = Vec::new();
        leaf_paths(&serde_json::to_value(Config::default()).unwrap(), "", &mut paths);
        let missing: Vec<String> = paths
            .iter()
            .map(|p| {
                let task = crate::llm::tasks::Task::ALL.iter().find(|t| p.starts_with(&format!("llmTasks.{}.", t.key())));
                match task {
                    Some(t) => p.replacen(&format!("llmTasks.{}.", t.key()), "llmTasks.<task>.", 1),
                    None => p.clone(),
                }
            })
            .filter(|p| !GUIDE.contains(&format!("| `{p}` |")))
            .collect();
        assert!(missing.is_empty(), "setup_guide.md lacks rows for: {missing:?}");
        for secret in SECRETS {
            assert!(GUIDE.contains(&format!("| `{secret}` |")), "secret {secret} is not a documented field");
        }
    }
}
