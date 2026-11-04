//! Subtitle tracks inside a video file on disk. ffmpeg reads a local file in seconds, so the
//! whole track is extracted at once: no block index, no download estimate, no confirmation.
//! Streaming sources keep the piecewise Matroska reader in `embedded.rs`.

use super::{acquire, embedded, mkv, parse, sidecar};
use crate::{session::Session, state::AppState, types::SubsStatus};
use anyhow::{anyhow, bail, Context};
use serde::Deserialize;
use std::{path::{Path, PathBuf}, process::Stdio, sync::Arc, time::Duration};

/// ffmpeg demuxes the whole file to reach every packet of one track; a large remux on a slow
/// disk takes a while, a hung read must not keep the status at "downloading" forever.
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(600);

/// Codecs ffmpeg turns into SRT; bitmap ones (PGS, VobSub, DVB) are pictures, not text.
const TEXT_CODECS: &[&str] = &["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"];

/// The file behind a `file://` source; `None` for anything streamed.
pub fn path(src: &str) -> Option<PathBuf> {
    if !src.starts_with("file://") {
        return None;
    }
    url::Url::parse(src).ok()?.to_file_path().ok()
}

#[derive(Deserialize, Default)]
struct RawTags {
    language: Option<String>,
    title: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawDisposition {
    #[serde(default)]
    forced: u8,
}

#[derive(Deserialize)]
struct RawStream {
    index: u64,
    codec_name: Option<String>,
    #[serde(default)]
    tags: RawTags,
    #[serde(default)]
    disposition: RawDisposition,
}

#[derive(Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
}

/// Subtitle streams of the file: the text ones as tracks (`number` is the ffmpeg stream index),
/// plus whether any bitmap track was skipped.
fn parse_streams(json: &[u8]) -> anyhow::Result<(Vec<mkv::TextTrack>, bool)> {
    let raw: RawProbe = serde_json::from_slice(json).context("ffprobe json")?;
    let (mut text, mut bitmap) = (Vec::new(), false);
    for s in raw.streams {
        if !TEXT_CODECS.contains(&s.codec_name.as_deref().unwrap_or("")) {
            bitmap = true;
            continue;
        }
        text.push(mkv::TextTrack {
            number: s.index,
            name: s.tags.title.unwrap_or_default(),
            lang: s.tags.language.filter(|l| !l.is_empty()).unwrap_or_else(|| "und".into()),
            forced: s.disposition.forced != 0,
        });
    }
    Ok((text, bitmap))
}

async fn streams(file: &Path) -> anyhow::Result<(Vec<mkv::TextTrack>, bool)> {
    let fut = crate::proc::command("ffprobe")
        .args(["-v", "error", "-select_streams", "s", "-show_streams", "-of", "json"])
        .arg(file)
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(60), fut).await.map_err(|_| anyhow!("ffprobe: таймаут"))??;
    if !out.status.success() {
        bail!("ffprobe: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    parse_streams(&out.stdout)
}

/// English text tracks best first; with none tagged English, a lone untagged one (`true`: its
/// text still has to look English).
fn pick(tracks: &[mkv::TextTrack]) -> (Vec<&mkv::TextTrack>, bool) {
    let english = mkv::pick_track(tracks);
    if !english.is_empty() {
        return (english, false);
    }
    match tracks {
        [t] if t.lang == "und" && !t.forced => (vec![t], true),
        _ => (Vec::new(), false),
    }
}

fn none_reason(all: &[mkv::TextTrack], bitmap: bool) -> String {
    if all.is_empty() && bitmap {
        "в файле только графические субтитры (PGS/VobSub), их нельзя прочитать как текст".into()
    } else {
        "в файле нет встроенных английских субтитров".into()
    }
}

/// Tracks the chooser offers, or why there are none.
pub async fn tracks(file: &Path) -> Result<Vec<mkv::TextTrack>, String> {
    let (all, bitmap) = streams(file).await.map_err(|e| e.to_string())?;
    let picked: Vec<_> = pick(&all).0.into_iter().cloned().collect();
    if picked.is_empty() {
        return Err(none_reason(&all, bitmap));
    }
    Ok(picked)
}

/// The track as SRT text.
async fn extract(file: &Path, index: u64, cancel: &tokio_util::sync::CancellationToken) -> Result<String, String> {
    let fut = crate::proc::background("ffmpeg")
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(file)
        .args(["-map", &format!("0:{index}"), "-f", "srt", "-"])
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::select! {
        r = tokio::time::timeout(EXTRACT_TIMEOUT, fut) => r.map_err(|_| "ffmpeg: таймаут".to_string())?.map_err(|e| format!("ffmpeg: {e}"))?,
        _ = cancel.cancelled() => return Err("фильм закрыт".into()),
    };
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr).into_owned();
        crate::logs::log("ffmpeg", &format!("subtitle extract failed: {e}"));
        return Err(format!("ffmpeg: {}", e.trim().lines().last().unwrap_or("ошибка")));
    }
    Ok(parse::decode(&out.stdout))
}

/// Extracts `track` (or the best English one) and installs it.
async fn load(st: &Arc<AppState>, s: &Arc<Session>, file: &Path, track: Option<u64>) -> Result<(), String> {
    let (all, bitmap) = streams(file).await.map_err(|e| e.to_string())?;
    let (t, check) = match track {
        Some(n) => (all.iter().find(|t| t.number == n).ok_or("в файле нет такой дорожки субтитров")?, false),
        None => {
            let (picked, check) = pick(&all);
            let Some(t) = picked.first().copied() else { return Err(none_reason(&all, bitmap)) };
            (t, check)
        }
    };
    acquire::status(st, SubsStatus::new(&s.media_id, "downloading").msg("встроенные субтитры"));
    let text = extract(file, t.number, &s.cancel).await?;
    if check && !sidecar::looks_english(&text) {
        return Err("в файле нет встроенных английских субтитров".into());
    }
    let key = format!("embedded:{}", t.number);
    let cache = acquire::save_cache(s, &key, &text).await;
    acquire::install(st, s, "embedded", embedded::track_label(t), true, key, cache, text).await.map(|_| ())
}

/// The automatic chain's step: silent success, a warning otherwise so the next source runs.
pub async fn start(st: &Arc<AppState>, s: &Arc<Session>, file: &Path) -> Option<()> {
    match load(st, s, file, None).await {
        Ok(()) => Some(()),
        Err(e) => {
            acquire::warn(st, s, e);
            None
        }
    }
}

/// The chooser's pick of one track.
pub async fn select(st: &Arc<AppState>, s: &Arc<Session>, file: &Path, track: u64) -> Result<(), String> {
    load(st, s, file, Some(track)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const J: &str = r#"{"streams":[
      {"index":2,"codec_name":"hdmv_pgs_subtitle","tags":{"language":"eng"}},
      {"index":3,"codec_name":"subrip","tags":{"language":"rus"}},
      {"index":4,"codec_name":"subrip","tags":{"language":"eng","title":"SDH"}},
      {"index":5,"codec_name":"ass","tags":{"language":"eng","title":"Full"}},
      {"index":6,"codec_name":"subrip","tags":{"language":"eng"},"disposition":{"forced":1}}]}"#;

    #[test]
    fn bitmap_tracks_are_skipped_and_plain_english_comes_first() {
        let (all, bitmap) = parse_streams(J.as_bytes()).unwrap();
        assert!(bitmap);
        assert_eq!(all.iter().map(|t| t.number).collect::<Vec<_>>(), vec![3, 4, 5, 6]);
        let (picked, check) = pick(&all);
        assert_eq!(picked.iter().map(|t| t.number).collect::<Vec<_>>(), vec![5, 4]);
        assert!(!check);
    }

    #[test]
    fn a_lone_untagged_track_is_kept_but_must_look_english() {
        let (all, _) = parse_streams(br#"{"streams":[{"index":2,"codec_name":"mov_text"}]}"#).unwrap();
        let (picked, check) = pick(&all);
        assert_eq!(picked.len(), 1);
        assert!(check);
        // Two untagged tracks give no basis to choose.
        let (two, _) = parse_streams(br#"{"streams":[{"index":2,"codec_name":"subrip"},{"index":3,"codec_name":"subrip"}]}"#).unwrap();
        assert!(pick(&two).0.is_empty());
    }

    #[test]
    fn only_file_urls_are_local() {
        assert_eq!(path("file:///tmp/a%20b.mkv"), Some(PathBuf::from("/tmp/a b.mkv")));
        assert_eq!(path("http://127.0.0.1:8090/stream/a.mkv"), None);
    }
}
