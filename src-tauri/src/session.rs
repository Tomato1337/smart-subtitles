use crate::{
    db::now,
    media::{probe::{self, Probe}, stream::{video_mode, VideoMode}},
    state::AppState,
    types::*,
};
use regex::Regex;
use sha1::{Digest, Sha1};
use std::sync::{atomic::AtomicU64, Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager};
use tokio::process::Child;
use tokio_util::sync::CancellationToken;

pub struct Session {
    pub id: String,
    pub media_id: String,
    pub req: SessionRequest,
    /// req.url with credentials applied; used for every ffmpeg/ffprobe/HTTP read.
    pub src: String,
    pub probe: OnceLock<Probe>,
    pub audio_index: Mutex<u32>,
    pub ffmpeg: tokio::sync::Mutex<Option<Child>>,
    pub gen: AtomicU64,
    /// Byte-flow gate of the current stream `(gen, paused)`: set by `/media/{sid}/flow`, read by the body stream.
    pub flow: Mutex<Option<(u64, Arc<std::sync::atomic::AtomicBool>)>>,
    pub cancel: CancellationToken,
    /// Cached LLM prompt prefix (system, film+script, OK); cleared whenever the cue set changes.
    pub prefix: Mutex<Option<Arc<Vec<serde_json::Value>>>>,
    pub annot_cancel: Mutex<CancellationToken>,
    pub annot_priority: std::sync::atomic::AtomicU32,
}

impl Session {
    pub fn mode(&self, vaapi_ok: bool) -> Option<VideoMode> {
        self.probe.get().map(|p| video_mode(p, vaapi_ok))
    }
    pub async fn kill_ffmpeg(&self) {
        if let Some(mut c) = self.ffmpeg.lock().await.take() {
            let _ = c.start_kill();
            let _ = c.wait().await;
        }
    }
}

#[derive(Default)]
pub struct SessionManager { current: Mutex<Option<Arc<Session>>> }

impl SessionManager {
    pub fn current(&self) -> Option<Arc<Session>> { self.current.lock().unwrap().clone() }
    pub fn get(&self, id: &str) -> Option<Arc<Session>> { self.current().filter(|s| s.id == id) }
    fn replace(&self, s: Option<Arc<Session>>) -> Option<Arc<Session>> {
        std::mem::replace(&mut *self.current.lock().unwrap(), s)
    }
    pub async fn close(&self) {
        if let Some(old) = self.replace(None) {
            old.cancel.cancel();
            old.kill_ffmpeg().await;
        }
    }
}

fn sha1_hex(s: &str) -> String { hex::encode(Sha1::digest(s.as_bytes())) }

pub fn media_id_for(url: &str, file_size: Option<u64>) -> String {
    if let Ok(u) = url::Url::parse(url) {
        if u.scheme() == "file" {
            let p = u.to_file_path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            return format!("file:{}", sha1_hex(&format!("{p}:{}", file_size.unwrap_or(0))));
        }
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        if let (Some(link), Some(index)) = (q.get("link"), q.get("index")) {
            return format!("ts:{link}:{index}");
        }
    }
    format!("url:{}", sha1_hex(url))
}

pub fn parse_season_episode(s: &str) -> Option<(u32, u32)> {
    static A: OnceLock<Regex> = OnceLock::new();
    static B: OnceLock<Regex> = OnceLock::new();
    let a = A.get_or_init(|| Regex::new(r"(?i)S(\d{1,2})E(\d{1,3})").unwrap());
    let b = B.get_or_init(|| Regex::new(r"(\d{1,2})x(\d{2,3})").unwrap());
    let c = a.captures(s).or_else(|| b.captures(s))?;
    Some((c[1].parse().ok()?, c[2].parse().ok()?))
}

fn resume_position(last: f64, from_req: Option<f64>, duration: f64) -> f64 {
    let t = last.max(from_req.unwrap_or(0.0));
    if duration > 0.0 && t > duration - 60.0 { 0.0 } else { t }
}

pub fn state_of(st: &AppState, s: &Session, p: &Probe, resume_at: f64, sub_offset: f64) -> SessionState {
    let (season, episode) = season_episode_of(&s.req);
    let episode_title = episode.and_then(|e| {
        s.req.episodes.iter().find(|x| x.episode == e).and_then(|x| x.name_en.clone().or_else(|| x.name_ru.clone()))
    });
    let url = &s.req.url;
    let has_poster = s.req.card.as_ref().and_then(|c| c.poster.as_ref()).is_some()
        || crate::poster::poster_path(&s.media_id).exists();
    let poster_url = has_poster
        .then(|| format!("http://127.0.0.1:{}/media/poster/{}", st.cfg.server.port, crate::poster::poster_key(&s.media_id)));
    SessionState {
        session_id: s.id.clone(),
        media_id: s.media_id.clone(),
        title: s.req.card.as_ref().map(|c| c.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| s.req.title.clone()),
        original_title: s.req.card.as_ref().and_then(|c| c.original_title.clone()),
        year: s.req.card.as_ref().and_then(|c| c.year),
        season,
        episode,
        episode_title,
        poster_url,
        duration: p.duration,
        audio_tracks: p.audio.clone(),
        audio_index: *s.audio_index.lock().unwrap(),
        resume_at,
        sub_offset,
        playlist: s.req.playlist.iter().map(|i| PlaylistTitle { title: i.title.clone() }).collect(),
        playlist_index: s.req.playlist.iter().position(|i| &i.url == url),
        llm_enabled: st.cfg.llm_enabled(),
    }
}

pub fn season_episode_of(r: &SessionRequest) -> (Option<u32>, Option<u32>) {
    if r.season.is_some() || r.episode.is_some() {
        return (r.season, r.episode);
    }
    r.path.as_deref().and_then(parse_season_episode)
        .or_else(|| parse_season_episode(&r.title))
        .map(|(s, e)| (Some(s), Some(e)))
        .unwrap_or((None, None))
}

pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn bad(msg: &str) -> String { msg.to_string() }

pub async fn open(st: &Arc<AppState>, req: SessionRequest, file_size: Option<u64>) -> Result<String, String> {
    if !(req.url.starts_with("http://") || req.url.starts_with("https://") || req.url.starts_with("file://")) {
        return Err(bad("url должен быть http(s)"));
    }
    if req.title.trim().is_empty() {
        return Err(bad("title не может быть пустым"));
    }
    st.sessions.close().await;

    let media_id = media_id_for(&req.url, file_size);
    let kind = if req.url.starts_with("file://") { "file" } else { "lampa" };
    let (season, episode) = season_episode_of(&req);
    let ep_title = episode.and_then(|e| req.episodes.iter().find(|x| x.episode == e).and_then(|x| x.name_en.clone().or_else(|| x.name_ru.clone())));
    {
        let (mid, r) = (media_id.clone(), req.clone());
        st.db(move |c| {
            let card = r.card.as_ref();
            c.execute(
                "INSERT INTO media(id,kind,source_url,title,original_title,year,tmdb_id,tmdb_type,imdb_id,season,episode,episode_title,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
                 ON CONFLICT(id) DO UPDATE SET source_url=excluded.source_url,title=excluded.title,original_title=excluded.original_title,
                   year=excluded.year,tmdb_id=excluded.tmdb_id,tmdb_type=excluded.tmdb_type,imdb_id=excluded.imdb_id,
                   season=excluded.season,episode=excluded.episode,episode_title=excluded.episode_title,updated_at=excluded.updated_at",
                rusqlite::params![
                    mid, kind, r.url,
                    card.map(|c| c.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| r.title.clone()),
                    card.and_then(|c| c.original_title.clone()), card.and_then(|c| c.year),
                    card.map(|c| c.tmdb_id).filter(|i| *i != 0), card.map(|c| c.kind.clone()), card.and_then(|c| c.imdb_id.clone()),
                    season, episode, ep_title, now()
                ],
            )?;
            Ok(())
        }).await?;
    }

    let session = Arc::new(Session {
        id: uuid::Uuid::new_v4().to_string(),
        media_id: media_id.clone(),
        req: req.clone(),
        src: st.cfg.with_auth(&req.url),
        probe: OnceLock::new(),
        audio_index: Mutex::new(0),
        ffmpeg: Default::default(),
        gen: AtomicU64::new(0),
        flow: Mutex::new(None),
        cancel: CancellationToken::new(),
        prefix: Mutex::new(None),
        annot_cancel: Mutex::new(CancellationToken::new()),
        annot_priority: Default::default(),
    });
    st.sessions.replace(Some(session.clone()));
    let _ = st.app.emit("session:loading", serde_json::json!({ "title": req.title }));
    show_main_window(&st.app);

    let st2 = st.clone();
    let s2 = session.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = finish_open(&st2, &s2).await {
            crate::logs::log("app", &format!("open failed: {e}"));
            let _ = st2.app.emit("player:error", serde_json::json!({ "message": e }));
        }
    });
    Ok(session.id.clone())
}

async fn finish_open(st: &Arc<AppState>, s: &Arc<Session>) -> Result<(), String> {
    let p = tokio::select! {
        r = probe::probe(&s.src) => r.map_err(|e| e.to_string())?,
        _ = s.cancel.cancelled() => return Ok(()),
    };
    {
        let (mid, dur) = (s.media_id.clone(), p.duration);
        st.db(move |c| { c.execute("UPDATE media SET duration=?1 WHERE id=?2", rusqlite::params![dur, mid])?; Ok(()) }).await?;
    }
    let saved = st.db({ let m = s.media_id.clone(); move |c| c.query_row("SELECT audio_index FROM media WHERE id=?1", [&m], |r| r.get::<_, Option<u32>>(0)) }).await?;
    let audio = saved.filter(|i| p.audio.iter().any(|a| a.index == *i)).or_else(|| probe::default_audio(&p.audio)).unwrap_or(0);
    *s.audio_index.lock().unwrap() = audio;
    let _ = s.probe.set(p);
    if let Some(state) = build_state(st, s).await? {
        let _ = st.app.emit("session:opened", &state);
    }
    tauri::async_runtime::spawn(crate::subs::acquire::run(st.clone(), s.clone()));
    let st3 = st.clone();
    tauri::async_runtime::spawn(async move { crate::tutor::anki_index::refresh(&st3).await });
    Ok(())
}

/// None while ffprobe has not finished yet.
pub async fn build_state(st: &Arc<AppState>, s: &Arc<Session>) -> Result<Option<SessionState>, String> {
    let Some(p) = s.probe.get() else { return Ok(None) };
    let mid = s.media_id.clone();
    let (last, off): (f64, f64) = st.db(move |c| c.query_row("SELECT last_position, sub_offset FROM media WHERE id=?1", [&mid], |r| Ok((r.get(0)?, r.get(1)?)))).await?;
    let resume = resume_position(last, s.req.resume_at, p.duration);
    Ok(Some(state_of(st, s, p, resume, off)))
}

pub fn file_request(path: &str) -> Result<(SessionRequest, u64), String> {
    let p = std::path::Path::new(path);
    let meta = std::fs::metadata(p).map_err(|e| format!("{path}: {e}"))?;
    let url = url::Url::from_file_path(p).map_err(|_| format!("Некорректный путь: {path}"))?.to_string();
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut subtitles = vec![];
    if let Some(dir) = p.parent() {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let lower = name.to_lowercase();
                if name.starts_with(&stem) && [".srt", ".vtt", ".ass"].iter().any(|x| lower.ends_with(x)) {
                    if let Ok(u) = url::Url::from_file_path(e.path()) {
                        subtitles.push(SubRef { label: name, url: u.to_string() });
                    }
                }
            }
        }
    }
    Ok((
        SessionRequest {
            url,
            title: stem,
            path: Some(path.to_string()),
            subtitles,
            resume_at: None,
            card: None,
            season: None,
            episode: None,
            episodes: vec![],
            playlist: vec![],
        },
        meta.len(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_ids() {
        assert_eq!(media_id_for("http://127.0.0.1:8095/stream/x.mkv?link=abc&index=3&play", None), "ts:abc:3");
        assert!(media_id_for("file:///tmp/a.mkv", Some(5)).starts_with("file:"));
        assert_ne!(media_id_for("file:///tmp/a.mkv", Some(5)), media_id_for("file:///tmp/a.mkv", Some(6)));
        assert!(media_id_for("http://x/y.mkv", None).starts_with("url:"));
    }

    #[test]
    fn season_episode() {
        assert_eq!(parse_season_episode("The.Boys.S05E01.Fifteen.mkv"), Some((5, 1)));
        assert_eq!(parse_season_episode("Show 2x07"), Some((2, 7)));
        assert_eq!(parse_season_episode("Marty Supreme"), None);
    }

    #[test]
    fn resume_rules() {
        assert_eq!(resume_position(100.0, Some(300.0), 3600.0), 300.0);
        assert_eq!(resume_position(3590.0, None, 3600.0), 0.0);
        assert_eq!(resume_position(0.0, None, 0.0), 0.0);
    }
}
