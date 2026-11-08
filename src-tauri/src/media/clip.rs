use crate::logs;
use anyhow::{anyhow, bail};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, LazyLock}, time::Duration};
use crate::proc;

pub struct ClipSpec<'a> {
    pub src: &'a str,
    pub video_index: u32,
    pub audio_index: u32,
    /// cue start/end with the user's subtitle offset already applied
    pub start: f64,
    pub end: f64,
    pub hdr: bool,
}

/// Phone-sized clip: ≤640 px wide, ≤24 fps, VP9 CRF 40 (`good`, cpu-used 5), mono Opus 32k, ≤12 s.
/// About 2.5× smaller than 854 px / CRF 36 realtime / stereo 64k at the same look on a phone screen.
pub fn clip_args(c: &ClipSpec, out: &Path) -> Vec<String> {
    let ss = (c.start - 0.5).max(0.0);
    let t = (c.end - c.start + 1.0).min(12.0);
    let scale = "fps='min(24,source_fps)',scale='min(640,iw)':-2";
    let vf = if c.hdr { format!("zscale=t=linear:npl=100,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,{scale}") } else { scale.to_string() };
    let mut a: Vec<String> = ["-hide_banner", "-v", "error", "-y", "-ss"].map(String::from).to_vec();
    a.push(format!("{ss:.3}"));
    a.extend(["-t".into(), format!("{t:.3}"), "-i".into(), super::input(c.src)]);
    a.extend(["-map".into(), format!("0:{}", c.video_index), "-map".into(), format!("0:{}", c.audio_index), "-vf".into(), vf]);
    a.extend(["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-deadline", "good", "-cpu-used", "5", "-row-mt", "1", "-c:a", "libopus", "-b:a", "32k", "-ac", "1"].map(String::from));
    a.push(out.to_string_lossy().into_owned());
    a
}

pub fn clips_dir() -> PathBuf { crate::config::cache_dir().join("clips") }

/// One cut per file name at a time: every card of a proposal shares its cue's clip, so the second
/// job must wait for the first file instead of running a duplicate ffmpeg or racing its rename.
static MAKING: LazyLock<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

async fn file_lock(file_name: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = MAKING.lock().await;
    map.entry(file_name.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
}

/// A usable clip is a nonempty WebM (EBML) file; a truncated/empty leftover is cut again.
pub fn readable(path: &Path) -> bool {
    std::fs::read(path).map(|b| is_webm(&b)).unwrap_or(false)
}

/// WebM/Matroska files start with the EBML magic.
pub fn is_webm(bytes: &[u8]) -> bool {
    bytes.len() > 4 && bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3])
}

/// Cuts the scene around a cue into a small .webm (kept in the cache: the file name is a hash of the
/// captured cue inputs). Runs at low CPU priority so playback keeps its share; cancellation and
/// timeout kill the whole ffmpeg group and remove this attempt's partial file.
pub async fn make(c: &ClipSpec<'_>, file_name: &str, cancel: &tokio_util::sync::CancellationToken) -> anyhow::Result<PathBuf> {
    let dir = clips_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let out = dir.join(file_name);
    let lock = file_lock(file_name).await;
    let _guard = tokio::select! {
        _ = cancel.cancelled() => return Err(anyhow!("отменено")),
        guard = lock.lock() => guard,
    };
    if cancel.is_cancelled() {
        return Err(anyhow!("отменено"));
    }
    if readable(&out) { return Ok(out); }
    let part = dir.join(format!("{file_name}.part-{}.webm", uuid::Uuid::new_v4()));
    let args = clip_args(c, &part);
    let mut cmd = proc::background("ffmpeg");
    cmd.args(&args);
    let o = match proc::output_cancellable(cmd, Duration::from_secs(180), cancel).await {
        Ok(o) => o,
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(match e {
                proc::ProcessError::Cancelled => anyhow!("отменено"),
                proc::ProcessError::TimedOut => anyhow!("ffmpeg: таймаут"),
                other => anyhow!("ffmpeg: {other}"),
            });
        }
    };
    if !o.status.success() {
        let _ = tokio::fs::remove_file(&part).await;
        let e = String::from_utf8_lossy(&o.stderr).into_owned();
        logs::log("ffmpeg", &format!("clip failed: {e}"));
        bail!("ffmpeg: {}", e.trim().lines().last().unwrap_or("ошибка"));
    }
    if !tokio::fs::metadata(&part).await.map(|m| m.len() > 0 && m.len() <= 20 * 1024 * 1024).unwrap_or(false) {
        let _ = tokio::fs::remove_file(&part).await;
        bail!("клип пустой или больше 20 МБ");
    }
    if let Err(e) = tokio::fs::rename(&part, &out).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e.into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_sdr_and_hdr() {
        let c = ClipSpec { src: "U", video_index: 0, audio_index: 2, start: 100.0, end: 103.0, hdr: false };
        let s = clip_args(&c, Path::new("/o.webm")).join(" ");
        assert!(s.starts_with("-hide_banner -v error -y -ss 99.500 -t 4.000 -i U -map 0:0 -map 0:2 -vf fps='min(24,source_fps)',scale='min(640,iw)':-2 -c:v libvpx-vp9"));
        assert!(s.ends_with("-c:a libopus -b:a 32k -ac 1 /o.webm"));
        let h = clip_args(&ClipSpec { hdr: true, start: 0.2, end: 60.0, ..c }, Path::new("/o.webm")).join(" ");
        assert!(h.contains("-ss 0.000 -t 12.000"));
        assert!(h.contains("-vf zscale=t=linear:npl=100,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,fps="));
    }
}
