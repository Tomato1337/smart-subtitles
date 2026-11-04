use crate::types::AudioTrack;
use anyhow::{anyhow, Context};
use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct VideoInfo {
    pub index: u32,
    pub codec: String,
    pub pix_fmt: String,
    pub width: u32,
    pub hdr: bool,
}

#[derive(Debug, Clone)]
pub struct Probe {
    pub duration: f64,
    pub video: VideoInfo,
    pub audio: Vec<AudioTrack>,
}

#[derive(Deserialize, Default)]
struct RawTags { language: Option<String>, title: Option<String> }

#[derive(Deserialize)]
struct RawStream {
    index: u32,
    codec_type: Option<String>,
    codec_name: Option<String>,
    pix_fmt: Option<String>,
    width: Option<u32>,
    color_transfer: Option<String>,
    channels: Option<u32>,
    #[serde(default)]
    tags: RawTags,
}

#[derive(Deserialize, Default)]
struct RawFormat { duration: Option<String> }

#[derive(Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    #[serde(default)]
    format: RawFormat,
}

pub fn parse_probe(json: &[u8]) -> anyhow::Result<Probe> {
    let raw: RawProbe = serde_json::from_slice(json).context("ffprobe json")?;
    let duration = raw.format.duration.as_deref().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let mut video = None;
    let mut audio = vec![];
    for s in raw.streams {
        let codec = s.codec_name.clone().unwrap_or_default();
        match s.codec_type.as_deref() {
            Some("video") if video.is_none() && s.width.is_some() => {
                let ct = s.color_transfer.as_deref().unwrap_or("");
                video = Some(VideoInfo {
                    index: s.index,
                    codec,
                    pix_fmt: s.pix_fmt.unwrap_or_default(),
                    width: s.width.unwrap_or(0),
                    hdr: ct == "smpte2084" || ct == "arib-std-b67",
                });
            }
            Some("audio") => audio.push(AudioTrack {
                index: s.index,
                codec,
                lang: s.tags.language,
                title: s.tags.title,
                channels: s.channels.unwrap_or(2),
            }),
            _ => {}
        }
    }
    Ok(Probe { duration, video: video.ok_or_else(|| anyhow!("В файле нет видео"))?, audio })
}

pub async fn probe(url: &str) -> anyhow::Result<Probe> {
    let fut = crate::proc::command("ffprobe")
        .args(["-v", "error", "-show_format", "-show_streams", "-of", "json"])
        .arg(super::input(url))
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(120), fut)
        .await
        .map_err(|_| anyhow!("ffprobe: таймаут 120 с"))??;
    if !out.status.success() {
        return Err(anyhow!("ffprobe: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    parse_probe(&out.stdout)
}

/// First `eng` track, else the first track at all.
pub fn default_audio(audio: &[AudioTrack]) -> Option<u32> {
    audio
        .iter()
        .find(|a| a.lang.as_deref() == Some("eng"))
        .or_else(|| audio.first())
        .map(|a| a.index)
}

#[cfg(test)]
mod tests {
    use super::*;
    const J: &str = r#"{"streams":[
      {"index":0,"codec_type":"video","codec_name":"hevc","pix_fmt":"yuv420p10le","width":3840,"height":2160,"color_transfer":"smpte2084"},
      {"index":1,"codec_type":"audio","codec_name":"ac3","channels":6,"tags":{"language":"rus"}},
      {"index":2,"codec_type":"audio","codec_name":"eac3","channels":6,"tags":{"language":"eng"}},
      {"index":5,"codec_type":"subtitle","codec_name":"subrip","tags":{"language":"eng","title":"SDH"}}],
      "format":{"duration":"3600.5"}}"#;
    #[test]
    fn parses_streams() {
        let p = parse_probe(J.as_bytes()).unwrap();
        assert!(p.video.hdr);
        assert_eq!(p.duration, 3600.5);
        assert_eq!(p.audio.len(), 2);
        assert_eq!(default_audio(&p.audio), Some(2));
    }
    #[test]
    fn no_video_is_error() {
        let e = parse_probe(br#"{"streams":[],"format":{}}"#).unwrap_err();
        assert_eq!(e.to_string(), "В файле нет видео");
    }
}
