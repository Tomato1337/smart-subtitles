use crate::logs;
use anyhow::{anyhow, bail};
use std::{path::{Path, PathBuf}, time::Duration};
use tokio::process::Command;

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
    a.extend(["-t".into(), format!("{t:.3}"), "-i".into(), c.src.into()]);
    a.extend(["-map".into(), format!("0:{}", c.video_index), "-map".into(), format!("0:{}", c.audio_index), "-vf".into(), vf]);
    a.extend(["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-deadline", "good", "-cpu-used", "5", "-row-mt", "1", "-c:a", "libopus", "-b:a", "32k", "-ac", "1"].map(String::from));
    a.push(out.to_string_lossy().into_owned());
    a
}

pub fn clips_dir() -> PathBuf { crate::config::cache_dir().join("clips") }

/// Cuts the scene around a cue into a small .webm (kept in the cache: the file name is a hash of the cue).
/// Runs at low CPU priority so playback keeps its share.
pub async fn make(c: &ClipSpec<'_>, file_name: &str) -> anyhow::Result<PathBuf> {
    let dir = clips_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let out = dir.join(file_name);
    if tokio::fs::metadata(&out).await.is_ok_and(|m| m.len() > 0) { return Ok(out); }
    let part = dir.join(format!("{file_name}.part.webm"));
    let args = clip_args(c, &part);
    let o = tokio::time::timeout(Duration::from_secs(180), Command::new("nice").args(["-n", "10", "ffmpeg"]).args(&args).kill_on_drop(true).output())
        .await
        .map_err(|_| anyhow!("ffmpeg: таймаут"))??;
    if !o.status.success() {
        let _ = tokio::fs::remove_file(&part).await;
        let e = String::from_utf8_lossy(&o.stderr).into_owned();
        logs::log("ffmpeg", &format!("clip failed: {e}"));
        bail!("ffmpeg: {}", e.trim().lines().last().unwrap_or("ошибка"));
    }
    if tokio::fs::metadata(&part).await?.len() > 20 * 1024 * 1024 {
        let _ = tokio::fs::remove_file(&part).await;
        bail!("клип больше 20 МБ");
    }
    tokio::fs::rename(&part, &out).await?;
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
