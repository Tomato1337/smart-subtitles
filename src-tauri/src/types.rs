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
