//! Word and sentence audio through edge-tts, run by `uv` like the rest of the app's Python.

use crate::asr::find_uv;
use std::path::Path;
use std::time::Duration;

/// Writes one MP3 to `out`; the caller picks the file name the card will reference.
pub async fn speak(text: &str, voice: &str, out: &Path) -> Result<(), String> {
    let uv = find_uv().ok_or_else(|| "нет uv — озвучка выключена".to_string())?;
    let out = out.to_path_buf();
    let o = tokio::time::timeout(
        Duration::from_secs(120),
        tokio::process::Command::new(&uv)
            .args(["tool", "run", "edge-tts", "--voice", voice, "--text", text, "--write-media"])
            .arg(&out)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "edge-tts: таймаут 120 с".to_string())?
    .map_err(|e| format!("edge-tts: {e}"))?;
    if !o.status.success() {
        let e = String::from_utf8_lossy(&o.stderr);
        return Err(format!("edge-tts: {}", e.trim().lines().last().unwrap_or("ошибка")));
    }
    if std::fs::metadata(&out).map(|m| m.len() == 0).unwrap_or(true) {
        return Err("edge-tts: пустой файл".into());
    }
    Ok(())
}
