use crate::{logs, proc};
use anyhow::{anyhow, bail, Context};
use serde::Deserialize;
use std::{collections::HashMap, io::ErrorKind, path::{Path, PathBuf}, sync::{Arc, LazyLock}, time::Duration};
use tokio_util::sync::CancellationToken;

pub struct ClipSpec<'a> {
    pub src: &'a str,
    pub video_index: u32,
    pub audio_index: u32,
    /// cue start/end with the user's subtitle offset already applied
    pub start: f64,
    pub end: f64,
    pub hdr: bool,
    pub source_duration: Option<f64>,
}

fn window(c: &ClipSpec<'_>) -> (f64, f64) {
    let start = (c.start - 0.5).max(0.0);
    let mut duration = (c.end - c.start + 1.0).min(12.0);
    if let Some(end) = c.source_duration.filter(|end| end.is_finite() && *end > 0.0) {
        duration = duration.min(end - start);
    }
    (start, duration)
}

/// Phone-sized clip: ≤640 px wide, ≤24 fps, VP9 CRF 40 (`good`, cpu-used 5), mono Opus 32k, ≤12 s.
/// About 2.5× smaller than 854 px / CRF 36 realtime / stereo 64k at the same look on a phone screen.
pub fn clip_args(c: &ClipSpec, out: &Path) -> Vec<String> {
    let (ss, t) = window(c);
    let scale = "fps='min(24,source_fps)',scale='min(640,iw)':-2";
    let vf = if c.hdr { format!("zscale=t=linear:npl=100,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,{scale}") } else { scale.to_string() };
    let mut a: Vec<String> = ["-hide_banner", "-v", "error", "-y", "-xerror", "-ss"].map(String::from).to_vec();
    // Limit the output timeline, not how long the demuxer is allowed to read around the seek.
    a.push(format!("{ss:.3}"));
    super::push_input(&mut a, c.src);
    a.extend(["-t".into(), format!("{t:.3}")]);
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

const MAX_BYTES: u64 = 20 * 1024 * 1024;
const TIMING_TOLERANCE: f64 = 0.25;

#[derive(Deserialize)]
struct ClipProbe {
    format: ClipFormat,
    packets: Vec<Packet>,
}

#[derive(Deserialize)]
struct ClipFormat {
    format_name: String,
    duration: String,
}

#[derive(Deserialize)]
struct Packet {
    codec_type: String,
    pts_time: Option<String>,
    duration_time: Option<String>,
}

#[derive(Default)]
struct Timing(Option<(f64, f64)>);

impl Timing {
    fn add(&mut self, pts: f64, end: f64) {
        self.0 = Some(match self.0 {
            Some((first, last)) => (first.min(pts), last.max(end)),
            None => (pts, end),
        });
    }

    fn spans(&self, duration: f64) -> bool {
        let tol = TIMING_TOLERANCE.min((duration * 0.5).max(0.05));
        self.0.is_some_and(|(first, last)| last > first && first.abs() <= tol && (last - duration).abs() <= tol)
    }
}

fn seconds(value: &str) -> Option<f64> {
    value.parse::<f64>().ok().filter(|x| x.is_finite())
}

/// `expected` is absent only when restoring a clip that was already checked before upload.
pub(crate) async fn validate(path: &Path, expected: Option<f64>, cancel: &CancellationToken) -> anyhow::Result<()> {
    if !(1..=MAX_BYTES).contains(&tokio::fs::metadata(path).await?.len()) {
        bail!("клип пустой или больше 20 МБ");
    }
    let mut cmd = proc::command("ffprobe");
    cmd.args(["-v", "error", "-show_packets", "-show_format", "-show_entries",
        "format=format_name,duration:packet=codec_type,pts_time,duration_time", "-of", "json"])
        .arg(path);
    let output = proc::output_cancellable(cmd, Duration::from_secs(10), cancel).await
        .map_err(|e| anyhow!("ffprobe: {e}"))?;
    if !output.status.success() || !output.stderr.is_empty() {
        bail!("ffprobe: клип не читается");
    }
    let clip: ClipProbe = serde_json::from_slice(&output.stdout).context("ffprobe: данные о клипе")?;
    let duration = seconds(&clip.format.duration).ok_or_else(|| anyhow!("клип без длительности"))?;
    if clip.format.format_name != "matroska,webm" || !(0.0 < duration && duration <= 12.0 + TIMING_TOLERANCE) {
        bail!("неверный формат или длительность клипа ({duration:.3} с)");
    }
    if let Some(t) = expected {
        if (duration - t).abs() > TIMING_TOLERANCE {
            bail!("длительность клипа {duration:.3} с вместо {t:.3} с");
        }
    }
    let (mut audio, mut video) = (Timing::default(), Timing::default());
    for packet in clip.packets {
        let timing = match packet.codec_type.as_str() {
            "audio" => &mut audio,
            "video" => &mut video,
            _ => continue,
        };
        let pts = packet.pts_time.as_deref().and_then(seconds).ok_or_else(|| anyhow!("пакет без PTS"))?;
        let len = packet.duration_time.as_deref().and_then(seconds).unwrap_or(0.0);
        timing.add(pts, pts + len);
    }
    let target = expected.unwrap_or(duration);
    if !video.spans(target) || !audio.spans(target) {
        bail!("аудио или видео не покрывает окно клипа ({target:.3} с)");
    }
    Ok(())
}

/// Cuts the scene around a cue into a small .webm (kept in the cache: the file name is a hash of the
/// captured cue inputs). Runs at low CPU priority so playback keeps its share; cancellation and
/// timeout kill the whole ffmpeg group and remove this attempt's partial file.
pub async fn make(c: &ClipSpec<'_>, file_name: &str, cancel: &CancellationToken) -> anyhow::Result<PathBuf> {
    let dir = clips_dir();
    make_in(c, &dir, file_name, cancel).await
}

async fn make_in(c: &ClipSpec<'_>, dir: &Path, file_name: &str, cancel: &CancellationToken) -> anyhow::Result<PathBuf> {
    let (_, duration) = window(c);
    if !duration.is_finite() || duration < 0.001 {
        bail!("окно клипа за пределами видео");
    }
    tokio::fs::create_dir_all(dir).await?;
    let out = dir.join(file_name);
    let lock = file_lock(file_name).await;
    let _guard = tokio::select! {
        _ = cancel.cancelled() => return Err(anyhow!("отменено")),
        guard = lock.lock() => guard,
    };
    if cancel.is_cancelled() {
        return Err(anyhow!("отменено"));
    }
    if validate(&out, Some(duration), cancel).await.is_ok() {
        return Ok(out);
    }
    if cancel.is_cancelled() {
        bail!("отменено");
    }
    match tokio::fs::remove_file(&out).await {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    const RETRY_DELAY: Duration = Duration::from_secs(1);
    if let Err(e) = cut(c, &out, duration, cancel).await {
        if cancel.is_cancelled() {
            return Err(e);
        }
        logs::log("ffmpeg", &format!("clip rejected, reopening source: {e:#}"));
        tokio::select! {
            _ = cancel.cancelled() => return Err(anyhow!("отменено")),
            _ = tokio::time::sleep(RETRY_DELAY) => {}
        }
        cut(c, &out, duration, cancel).await?;
    }
    Ok(out)
}

fn has_fatal_stderr(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    [
        "invalid as first byte of an ebml",
        "ebml header parsing failed",
        "read error",
        "i/o error",
        "input/output error",
        "invalid data found",
        "truncated",
        "corrupt",
        "server returned 4",
        "server returned 5",
        "connection reset",
        "connection timed out",
        "broken pipe",
        "premature end",
        "end of file",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

async fn cut(c: &ClipSpec<'_>, out: &Path, duration: f64, cancel: &CancellationToken) -> anyhow::Result<()> {
    let part = out.with_extension(format!("part-{}.webm", uuid::Uuid::new_v4()));
    let result = async {
        let mut cmd = proc::background("ffmpeg");
        cmd.args(clip_args(c, &part));
        let output = proc::output_cancellable(cmd, Duration::from_secs(180), cancel).await
            .map_err(|e| anyhow!("ffmpeg: {e}"))?;
        let error = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() || has_fatal_stderr(&error) {
            logs::log("ffmpeg", &format!("clip failed: {error}"));
            bail!("ffmpeg: {}", error.trim().lines().last().unwrap_or("ошибка"));
        }
        validate(&part, Some(duration), cancel).await?;
        if cancel.is_cancelled() {
            bail!("отменено");
        }
        tokio::fs::rename(&part, out).await?;
        Ok(())
    }.await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires ffmpeg with libvpx-vp9/libopus and ffprobe"]
    async fn replaces_cached_webm_with_short_audio_and_never_publishes_a_bad_cut() {
        use axum::{body::Bytes, http::{header, HeaderMap, StatusCode}, response::IntoResponse, routing::get, Router};
        use std::sync::atomic::{AtomicUsize, Ordering};

        let dir = std::env::temp_dir().join(format!("smartsubs-clip-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&dir).await.unwrap();
        let bad = dir.join("short-audio.webm");
        let good = dir.join("source.webm");
        for (path, short_audio) in [(&bad, true), (&good, false)] {
            let sine = if short_audio { "sine=duration=0.77" } else { "sine=duration=2.44" };
            let output = proc::command("ffmpeg")
                .args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=2.44",
                    "-f", "lavfi", "-i", sine, "-c:v", "libvpx-vp9", "-cpu-used", "5", "-c:a", "libopus"])
                .arg(path).output().await.unwrap();
            assert!(output.status.success(), "{:?}", String::from_utf8_lossy(&output.stderr));
        }

        let out = dir.join("card.webm");
        tokio::fs::copy(&bad, &out).await.unwrap();
        let spec = ClipSpec { src: good.to_str().unwrap(), video_index: 0, audio_index: 1, start: 0.5, end: 1.94, hdr: false, source_duration: None };
        let cancel = tokio_util::sync::CancellationToken::new();
        let result = make_in(&spec, &dir, "card.webm", &cancel).await;
        let replaced = tokio::fs::read(&out).await.unwrap() != tokio::fs::read(&bad).await.unwrap();
        let bad_spec = ClipSpec { src: bad.to_str().unwrap(), ..spec };
        let failed = make_in(&bad_spec, &dir, "bad-card.webm", &cancel).await;

        // A fresh connection sees a healthy seekable source after a temporary HTTP failure.
        let source = Bytes::from(tokio::fs::read(&good).await.unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let seen = requests.clone();
        let server = Router::new().route("/", get(move |headers: HeaderMap| {
            let source = source.clone();
            let offset = headers.get(header::RANGE).and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("bytes="))
                .and_then(|s| s.split_once('-'))
                .and_then(|(start, _)| start.parse::<usize>().ok());
            let unavailable = offset.unwrap_or(0) == 0 && seen.fetch_add(1, Ordering::Relaxed) == 0;
            async move {
                if unavailable {
                    return StatusCode::SERVICE_UNAVAILABLE.into_response();
                }
                let Some(first) = offset else { return source.into_response() };
                if first >= source.len() {
                    return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                }
                let range = format!("bytes {first}-{}/{}", source.len() - 1, source.len());
                (StatusCode::PARTIAL_CONTENT, [(header::CONTENT_RANGE, range)], source.slice(first..)).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let retry = make_in(&ClipSpec { src: &url, ..spec }, &dir, "retry.webm", &cancel).await;
        server.abort();
        let attempts = requests.load(Ordering::Relaxed);

        let mut files = tokio::fs::read_dir(&dir).await.unwrap();
        let mut names = Vec::new();
        while let Some(entry) = files.next_entry().await.unwrap() {
            names.push(entry.file_name().into_string().unwrap());
        }
        drop(files);
        tokio::fs::remove_dir_all(dir).await.unwrap();
        assert_eq!(result.unwrap(), out);
        assert!(replaced, "a WebM with audio ending at 0.77 s must not be reused");
        assert!(failed.is_err(), "the bad source must not produce a successful cut");
        assert_eq!(retry.unwrap().file_name().unwrap(), "retry.webm");
        assert_eq!(attempts, 2, "a malformed first response must reopen the source exactly once");
        assert!(!names.iter().any(|name| name == "bad-card.webm" || name.contains(".part-")), "{names:?}");
    }

    #[test]
    fn args_sdr_and_hdr() {
        let c = ClipSpec { src: "U", video_index: 0, audio_index: 2, start: 100.0, end: 103.0, hdr: false, source_duration: None };
        let s = clip_args(&c, Path::new("/o.webm")).join(" ");
        assert!(s.starts_with("-hide_banner -v error -y -xerror -ss 99.500 -i U -t 4.000 -map 0:0 -map 0:2 -vf fps='min(24,source_fps)',scale='min(640,iw)':-2 -c:v libvpx-vp9"));
        assert!(s.ends_with("-c:a libopus -b:a 32k -ac 1 /o.webm"));
        let h = clip_args(&ClipSpec { hdr: true, start: 0.2, end: 60.0, ..c }, Path::new("/o.webm")).join(" ");
        assert!(h.contains("-ss 0.000 -i U -t 12.000"));
        assert!(h.contains("-vf zscale=t=linear:npl=100,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,fps="));
        let remote = clip_args(&ClipSpec { src: "https://cdn.example/v.mkv", ..c }, Path::new("/o.webm")).join(" ");
        assert!(remote.contains("-ss 99.500 -protocol_whitelist http,https,tcp,tls -i https://cdn.example/v.mkv -t 4.000"));
    }

    #[test]
    fn timing_rejects_zero_span_on_short_clips() {
        let mut zero = Timing::default();
        zero.add(0.0, 0.0);
        assert!(!zero.spans(0.20));

        let mut full = Timing::default();
        full.add(0.0, 0.20);
        assert!(full.spans(0.20));
    }

    #[test]
    fn fatal_stderr_ignores_open_gop_seek_notes_and_catches_ebml_corruption() {
        assert!(!has_fatal_stderr("[h264] mmco: unref short failure"));
        assert!(has_fatal_stderr("0x00 at pos ... invalid as first byte of an EBML number"));
        assert!(has_fatal_stderr("Error reading input: Input/output error"));
    }

    #[tokio::test]
    #[ignore = "requires ffmpeg with libvpx-vp9/libopus and ffprobe"]
    async fn cuts_valid_open_gop_h264_mkv_across_recovery_point() {
        let dir = std::env::temp_dir().join(format!("smartsubs-open-gop-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&dir).await.unwrap();
        let src = dir.join("source.mkv");
        let output = proc::command("ffmpeg")
            .args([
                "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=10",
                "-f", "lavfi", "-i", "sine=duration=10",
                "-c:v", "libx264", "-x264-params", "open-gop=1:bframes=3:keyint=48",
                "-c:a", "aac",
            ])
            .arg(&src)
            .output()
            .await
            .unwrap();
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).into_owned();
            let _ = tokio::fs::remove_dir_all(&dir).await;
            panic!("ffmpeg encode failed: {err}");
        }

        let spec = ClipSpec {
            src: src.to_str().unwrap(),
            video_index: 0,
            audio_index: 1,
            start: 8.3,
            end: 9.3,
            hdr: false,
            source_duration: None,
        };
        let cancel = CancellationToken::new();
        let out_res = make_in(&spec, &dir, "clip.webm", &cancel).await;
        let validate_res = match &out_res {
            Ok(path) => Some(validate(path, Some(2.0), &cancel).await),
            Err(_) => None,
        };
        let _ = tokio::fs::remove_dir_all(&dir).await;

        let out = out_res.unwrap();
        assert_eq!(out.file_name().unwrap(), "clip.webm");
        validate_res.unwrap().unwrap();
    }
}
