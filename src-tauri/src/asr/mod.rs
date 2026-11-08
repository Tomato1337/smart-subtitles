//! Speech recognition: faster-whisper in an app-managed uv venv, fed raw PCM fragments.

pub mod align;

use crate::{logs, media::TempFile, state::AppState};
use anyhow::{anyhow, bail};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;
use tokio::process::Command;

/// Embedded once the venv is ready; rewriting it each run keeps script and Rust in step.
const ASR_PY: &str = include_str!("asr.py");
const REQUIREMENT: &str = "faster-whisper==1.2.1";
const MODEL: &str = "base.en";
const THREADS: u32 = 4;

/// One recognised word with times relative to the fragment it came from.
#[derive(Deserialize, Clone, Debug)]
pub struct Word {
    #[serde(rename = "w")]
    pub text: String,
    #[serde(rename = "s")]
    pub start: f64,
    #[serde(rename = "e")]
    pub end: f64,
}

pub fn asr_dir() -> PathBuf {
    crate::config::cache_dir().join("asr")
}

/// A temp PCM file inside the cache, removed on drop.
pub fn pcm_temp() -> anyhow::Result<TempFile> {
    let dir = asr_dir().join("tmp");
    std::fs::create_dir_all(&dir)?;
    Ok(TempFile(dir.join(format!("{}.f32", uuid::Uuid::new_v4()))))
}

/// `uv` from PATH, then the two usual install locations.
pub(crate) fn find_uv() -> Option<PathBuf> {
    crate::proc::find("uv")
}

async fn output(cmd: Command, secs: u64, cancel: &tokio_util::sync::CancellationToken) -> anyhow::Result<Output> {
    crate::proc::output_cancellable(cmd, Duration::from_secs(secs), cancel)
        .await
        .map_err(|e| match e {
            crate::proc::ProcessError::Cancelled => anyhow!("отменено"),
            crate::proc::ProcessError::TimedOut => anyhow!("таймаут {secs} с"),
            other => anyhow!("{other}"),
        })
}

/// `uv` stderr tail, logged in full so a failed install can be diagnosed from the app log.
fn failure(o: &Output) -> String {
    let e = String::from_utf8_lossy(&o.stderr).into_owned();
    logs::log("asr", &format!("command failed: {e}"));
    e.trim().lines().last().unwrap_or("ошибка").to_string()
}

/// Interpreter of the venv, installing faster-whisper once (marker file records the requirement).
async fn ensure_env(st: &AppState, cancel: &tokio_util::sync::CancellationToken) -> anyhow::Result<PathBuf> {
    let venv = asr_dir().join("venv");
    // uv lays a venv out the way Python does on this OS.
    let python = if cfg!(windows) { venv.join("Scripts").join("python.exe") } else { venv.join("bin").join("python") };
    let marker = venv.join(".smartsubs-ready");
    if std::fs::read_to_string(&marker).is_ok_and(|m| m.trim() == REQUIREMENT) {
        return Ok(python);
    }
    let uv = match find_uv() {
        Some(uv) => uv,
        None => bail!("uv не найден — установите uv: https://docs.astral.sh/uv/"),
    };
    crate::notify::info(st, "Устанавливаю распознавание речи (один раз, ~450 МБ)…");
    std::fs::create_dir_all(asr_dir())?;

    let mut c = crate::proc::command(&uv);
    c.args(["venv", "--allow-existing"]).arg(&venv);
    match output(c, 300, cancel).await {
        Ok(o) if o.status.success() => {}
        Ok(o) => bail!("uv: {}", failure(&o)),
        Err(e) => bail!("uv: {e}"),
    }

    let mut c = crate::proc::command(&uv);
    c.args(["pip", "install", "--python"]).arg(&python).arg(REQUIREMENT);
    match output(c, 900, cancel).await {
        Ok(o) if o.status.success() => {}
        Ok(o) => bail!("uv: {}", failure(&o)),
        Err(e) => bail!("uv: {e}"),
    }

    std::fs::write(&marker, REQUIREMENT)?;
    logs::log("asr", &format!("venv ready: {REQUIREMENT}"));
    Ok(python)
}

/// One fragment of the media's audio as mono 16 kHz float32 PCM, so ASR never touches the network
/// stream itself. The cancellation token kills the whole ffmpeg process group.
pub async fn extract_pcm_cancellable(
    src: &str,
    audio_index: u32,
    start: f64,
    dur: f64,
    out: &Path,
    cancel: &tokio_util::sync::CancellationToken,
) -> anyhow::Result<()> {
    let mut a: Vec<String> = ["-hide_banner", "-v", "error", "-y", "-ss"].iter().map(|s| s.to_string()).collect();
    a.push(format!("{start:.3}"));
    a.extend(["-t".into(), format!("{dur:.3}"), "-i".into(), crate::media::input(src)]);
    a.extend(["-map".into(), format!("0:{audio_index}"), "-vn".into()]);
    a.extend(["-ac", "1", "-ar", "16000", "-f", "f32le"].map(String::from));
    a.push(out.to_string_lossy().into_owned());
    let mut cmd = crate::proc::background("ffmpeg");
    cmd.args(&a);
    let o = output(cmd, 180, cancel).await?;
    if !o.status.success() {
        let e = String::from_utf8_lossy(&o.stderr).into_owned();
        logs::log("ffmpeg", &format!("pcm failed: {e}"));
        bail!("ffmpeg: {}", e.trim().lines().last().unwrap_or("ошибка"));
    }
    Ok(())
}

/// Compatibility wrapper for callers without a cancellation token.
pub async fn extract_pcm(src: &str, audio_index: u32, start: f64, dur: f64, out: &Path) -> anyhow::Result<()> {
    extract_pcm_cancellable(src, audio_index, start, dur, out, &tokio_util::sync::CancellationToken::new()).await
}

/// Words for every file, in file order. Times are relative to their file.
pub async fn transcribe_cancellable(
    st: &AppState,
    files: &[PathBuf],
    cancel: &tokio_util::sync::CancellationToken,
) -> anyhow::Result<Vec<Vec<Word>>> {
    let _turn = tokio::select! {
        _ = cancel.cancelled() => bail!("отменено"),
        turn = st.asr.lock() => turn,
    };
    let python = ensure_env(st, cancel).await?;
    let dir = asr_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let script = dir.join("asr.py");
    tokio::fs::write(&script, ASR_PY).await?;

    let threads = THREADS.to_string();
    let mut c = crate::proc::background(&python);
    c.arg(&script).args([MODEL, &threads]).args(files);
    c.env("HF_HUB_DISABLE_TELEMETRY", "1");
    let o = output(c, 600, cancel).await.map_err(|e| anyhow!("распознавание речи: {e}"))?;
    if !o.status.success() {
        bail!("распознавание речи: {}", failure(&o));
    }
    let stdout = String::from_utf8_lossy(&o.stdout);
    let last = stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    serde_json::from_str(last).map_err(|e| anyhow!("распознавание речи: {e}"))
}

/// Compatibility wrapper for callers without a cancellation token.
pub async fn transcribe(st: &AppState, files: &[PathBuf]) -> anyhow::Result<Vec<Vec<Word>>> {
    transcribe_cancellable(st, files, &tokio_util::sync::CancellationToken::new()).await
}

/// The house spelling of a subtitle/ASR word: lowercase, quotes and punctuation trimmed off the ends.
pub fn norm_word(w: &str) -> String {
    w.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'').trim_matches('\'').to_lowercase()
}

/// Comparable tokens of a cue: punctuation stripped, empty pieces dropped.
pub fn tokens(text: &str) -> Vec<String> {
    text.split_whitespace().map(norm_word).filter(|t| !t.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_strip_punctuation_and_apostrophe_edges() {
        assert_eq!(tokens("-Yeah, you're a lucky lady.\n-Oh, I'm excited."), ["yeah", "you're", "a", "lucky", "lady", "oh", "i'm", "excited"]);
        assert_eq!(tokens(" 'quoted' — 9am? "), ["quoted", "9am"]);
        assert_eq!(tokens("..."), Vec::<String>::new());
    }
}
