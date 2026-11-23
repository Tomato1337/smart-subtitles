//! Word and sentence audio through edge-tts, run by `uv` like the rest of the app's Python.

use crate::asr::find_uv;
use base64::Engine;
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};
use std::time::Duration;

static PREVIEW_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn validate_preview_args<'a>(voice: &'a str, text: &'a str) -> Result<(&'a str, &'a str), String> {
    let voice = voice.trim();
    if voice.is_empty()
        || voice.len() > 80
        || voice.starts_with('-')
        || !voice.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'-'))
    {
        return Err("Некорректное имя голоса".into());
    }
    let text = text.trim();
    let text_len = text.chars().count();
    if text_len == 0 || text_len > 500 {
        return Err("Текст озвучки должен быть от 1 до 500 символов".into());
    }
    Ok((voice, text))
}

fn speak_args(voice: &str, text: &str) -> [String; 5] {
    [
        "tool".into(),
        "run".into(),
        "edge-tts".into(),
        format!("--voice={voice}"),
        format!("--text={text}"),
    ]
}

/// Cache path for a preview MP3 sample, keyed by `"{voice}\n{text}"`.
pub fn preview_path(voice: &str, text: &str) -> PathBuf {
    let key = hex::encode(Sha1::digest(format!("{voice}\n{text}").as_bytes()));
    crate::config::cache_dir().join("tts-preview").join(format!("{key}.mp3"))
}

/// Returns base64-encoded MP3 audio for `voice` speaking `text`, caching by `(voice, text)`.
pub async fn preview(voice: &str, text: &str) -> Result<String, String> {
    let (voice, text) = validate_preview_args(voice, text)?;
    let path = preview_path(voice, text);
    if !tokio::fs::metadata(&path).await.is_ok_and(|m| m.len() > 0) {
        let _guard = PREVIEW_LOCK.lock().await;
        if !tokio::fs::metadata(&path).await.is_ok_and(|m| m.len() > 0) {
            let parent = path.parent().ok_or("некорректный путь кэша")?;
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("каталог озвучки: {e}"))?;
            let tmp = path.with_extension(format!("{}.tmp.mp3", uuid::Uuid::new_v4()));
            let cancel = tokio_util::sync::CancellationToken::new();
            if let Err(e) = speak(text, voice, &tmp, &cancel).await {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(e);
            }
            if let Err(e) = tokio::fs::rename(&tmp, &path).await {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(format!("озвучка: {e}"));
            }
        }
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("озвучка: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Writes one MP3 to `out`; the caller picks the file name the card will reference.
pub async fn speak(text: &str, voice: &str, out: &Path, cancel: &tokio_util::sync::CancellationToken) -> Result<(), String> {
    let uv = find_uv().ok_or_else(|| "нет uv — озвучка выключена".to_string())?;
    let out = out.to_path_buf();
    let mut cmd = crate::proc::command(&uv);
    // `--flag=value` keeps values starting with `-` (like `"- Wait!"`) from being parsed as flags.
    cmd.args(speak_args(voice, text)).arg("--write-media").arg(&out);
    let o = crate::proc::output_cancellable(cmd, Duration::from_secs(120), cancel)
        .await
        .map_err(|e| match e {
            crate::proc::ProcessError::Cancelled => "отменено".to_string(),
            crate::proc::ProcessError::TimedOut => "edge-tts: таймаут 120 с".to_string(),
            other => format!("edge-tts: {other}"),
        })?;
    if !o.status.success() {
        let e = String::from_utf8_lossy(&o.stderr);
        return Err(format!("edge-tts: {}", e.trim().lines().last().unwrap_or("ошибка")));
    }
    if std::fs::metadata(&out).map(|m| m.len() == 0).unwrap_or(true) {
        return Err("edge-tts: пустой файл".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_path_uses_sha1_under_tts_preview() {
        let a = preview_path("en-US-GuyNeural", "It'll bring him joy.");
        let b = preview_path("en-US-GuyNeural", "It'll bring him joy.");
        let c = preview_path("en-GB-RyanNeural", "It'll bring him joy.");
        let d = preview_path("en-US-GuyNeural", "Hello");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
        assert_eq!(a.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str()), Some("tts-preview"));
        let expected = format!("{}.mp3", hex::encode(Sha1::digest(b"en-US-GuyNeural\nIt'll bring him joy.")));
        assert_eq!(a.file_name().and_then(|s| s.to_str()), Some(expected.as_str()));
    }

    #[tokio::test]
    async fn preview_validates_voice_and_text() {
        for bad_voice in ["", "   ", "-GuyNeural", "en US", "en/US", "en;id", &"a".repeat(81)] {
            assert!(preview(bad_voice, "Hello").await.is_err(), "expected {bad_voice:?} to be rejected");
        }
        for bad_text in ["", "   ", &"x".repeat(501)] {
            assert!(preview("en-US-GuyNeural", bad_text).await.is_err(), "expected text len {} to be rejected", bad_text.len());
        }
        assert_eq!(validate_preview_args("en-US-GuyNeural", "- Wait!"), Ok(("en-US-GuyNeural", "- Wait!")));
        assert_eq!(validate_preview_args(&"a:b_c-1".repeat(10), &"ж".repeat(500)).map(|(v, t)| (v.len(), t.chars().count())), Ok((70, 500)));
        assert_eq!(
            speak_args("en-US-GuyNeural", "- Wait!"),
            ["tool", "run", "edge-tts", "--voice=en-US-GuyNeural", "--text=- Wait!"]
        );
    }
}
