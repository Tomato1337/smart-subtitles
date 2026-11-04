use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubRef { pub label: String, pub url: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub tmdb_id: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub original_title: Option<String>,
    pub year: Option<i32>,
    pub imdb_id: Option<String>,
    #[serde(default)]
    pub poster: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeInfo { pub episode: u32, pub name_ru: Option<String>, pub name_en: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistItem {
    pub title: String,
    pub url: String,
    pub path: Option<String>,
    #[serde(default)]
    pub subtitles: Vec<SubRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub url: String,
    pub title: String,
    pub path: Option<String>,
    #[serde(default)]
    pub subtitles: Vec<SubRef>,
    pub resume_at: Option<f64>,
    pub card: Option<Card>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    #[serde(default)]
    pub episodes: Vec<EpisodeInfo>,
    #[serde(default)]
    pub playlist: Vec<PlaylistItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    pub index: u32,
    pub codec: String,
    pub lang: Option<String>,
    pub title: Option<String>,
    pub channels: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTitle { pub title: String }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub session_id: String,
    pub media_id: String,
    pub title: String,
    pub original_title: Option<String>,
    pub year: Option<i32>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub episode_title: Option<String>,
    pub poster_url: Option<String>,
    pub duration: f64,
    pub audio_tracks: Vec<AudioTrack>,
    pub audio_index: u32,
    pub resume_at: f64,
    pub sub_offset: f64,
    pub playlist: Vec<PlaylistTitle>,
    pub playlist_index: Option<usize>,
    pub llm_enabled: bool,
    /// The source is a TorrServer stream: the player can show its peers, speed and buffer signal.
    pub torrent: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenStream { pub url: String }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue { pub idx: u32, pub start: f64, pub end: f64, pub text: String, pub ru: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk { pub start_char: u32, pub end_char: u32, pub text: String, pub kind: String, pub ru: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuePattern { pub pattern_id: String, pub start_char: u32, pub end_char: u32 }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueAnnotation { pub idx: u32, pub ru: String, pub chunks: Vec<Chunk>, pub patterns: Vec<CuePattern> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsList { pub cues: Vec<Cue>, pub annotations: Vec<CueAnnotation> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsStatus {
    pub media_id: String,
    pub state: &'static str,
    pub source: Option<&'static str>,
    pub exact: Option<bool>,
    pub progress: Option<f64>,
    pub message: Option<String>,
}

impl SubsStatus {
    pub fn new(media_id: &str, state: &'static str) -> Self {
        Self { media_id: media_id.to_string(), state, source: None, exact: None, progress: None, message: None }
    }
    pub fn msg(mut self, m: impl Into<String>) -> Self { self.message = Some(m.into()); self }
}

/// One English subtitle file the user can switch to; `source` is the JSON tag.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "lowercase")]
pub enum SubCandidate {
    Torrserver { track: u32, title: String, lang: String },
    Sidecar { url: String, label: String },
    /// A text track inside the video file itself; `bytes` is the download the estimate promises.
    #[serde(rename_all = "camelCase")]
    Embedded { track: u64, title: String, cues: u32, bytes: u64 },
    #[serde(rename_all = "camelCase")]
    Opensubtitles { file_id: i64, release: String, exact: bool, hearing_impaired: bool, downloads: i64, cached: bool },
}

impl SubCandidate {
    /// Stable id stored in `subtitle_source.ref`.
    pub fn key(&self) -> String {
        match self {
            Self::Torrserver { track, .. } => format!("torrserver:{track}"),
            Self::Sidecar { url, .. } => format!("sidecar:{url}"),
            Self::Embedded { track, .. } => format!("embedded:{track}"),
            Self::Opensubtitles { file_id, .. } => format!("opensubtitles:{file_id}"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateEntry { pub key: String, pub candidate: SubCandidate }

/// A source that was tried but gave no candidates, with the reason shown under its group.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceNote { pub source: &'static str, pub message: String }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsCandidates { pub active_key: Option<String>, pub active_label: Option<String>, pub items: Vec<CandidateEntry>, pub notes: Vec<SourceNote> }

/// Background dialog analysis of one media: consent plus batch counters for the progress chip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotStatus { pub media_id: String, pub consent: Option<String>, pub total: u32, pub done: u32, pub failed: u32 }

/// Token estimate of the remaining analysis, computed without any LLM request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotEstimate {
    pub cues: u32,
    pub batches: u32,
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
    /// The cues are still being read out of the video file: the numbers cover the whole film.
    pub partial: bool,
}

/// One embedded (in-file) subtitle load: the confirmation modal, the hold on playback and the
/// load line under the timeline all read it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedState {
    /// `confirm` | `loading` | `done` | `failed`.
    pub phase: &'static str,
    /// Track label, e.g. `ENG · US`.
    pub track: String,
    pub total_cues: u32,
    pub loaded_cues: u32,
    /// Every cue that starts before this second is stored.
    pub loaded_until: f64,
    /// Playback may start once `loaded_until >= head_until`.
    pub head_until: f64,
    pub est_bytes: u64,
    pub head_bytes: u64,
    pub piece_bytes: u64,
    pub message: Option<String>,
}

/// Stores the load state on the session and tells the UI about it; `None` closes the modal.
pub fn set_state(st: &crate::state::AppState, s: &crate::session::Session, state: Option<EmbeddedState>) {
    use tauri::Emitter;
    *s.embedded.lock().unwrap() = state.clone();
    let _ = st.app.emit("subs:embedded", serde_json::json!({ "mediaId": s.media_id, "state": state }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_serde_round_trip() {
        let c = SubCandidate::Opensubtitles { file_id: 42, release: "Some.Release".into(), exact: true, hearing_impaired: false, downloads: 7, cached: true };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["source"], "opensubtitles");
        assert_eq!(v["fileId"], 42);
        assert_eq!(v["hearingImpaired"], false);
        assert_eq!(v["downloads"], 7);
        let back: SubCandidate = serde_json::from_value(v).unwrap();
        assert_eq!(back.key(), "opensubtitles:42");
    }

    #[test]
    fn candidate_tags_and_keys() {
        let tor = SubCandidate::Torrserver { track: 2, title: "t".into(), lang: "und".into() };
        assert_eq!(serde_json::to_value(&tor).unwrap(), serde_json::json!({ "source": "torrserver", "track": 2, "title": "t", "lang": "und" }));
        assert_eq!(tor.key(), "torrserver:2");
        let side = SubCandidate::Sidecar { url: "http://x/a.srt".into(), label: "a".into() };
        assert_eq!(serde_json::to_value(&side).unwrap(), serde_json::json!({ "source": "sidecar", "url": "http://x/a.srt", "label": "a" }));
        assert_eq!(side.key(), "sidecar:http://x/a.srt");
        let emb = SubCandidate::Embedded { track: 3, title: "ENG · US".into(), cues: 916, bytes: 1_932_735_283 };
        assert_eq!(
            serde_json::to_value(&emb).unwrap(),
            serde_json::json!({ "source": "embedded", "track": 3, "title": "ENG · US", "cues": 916, "bytes": 1_932_735_283u64 })
        );
        assert_eq!(emb.key(), "embedded:3");
    }
}
