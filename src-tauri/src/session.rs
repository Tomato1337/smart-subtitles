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
    pub from_start: bool,
    pub seek_at: Option<f64>,
    /// req.url with credentials applied; used for every ffmpeg/ffprobe/HTTP read.
    pub src: String,
    pub probe: OnceLock<Probe>,
    pub audio_index: Mutex<u32>,
    pub ffmpeg: tokio::sync::Mutex<Option<(u64, Child)>>,
    pub gen: AtomicU64,
    /// Byte-flow gate of the current stream `(gen, paused)`: set by `/media/{sid}/flow`, read by the body stream.
    pub flow: Mutex<Option<(u64, Arc<std::sync::atomic::AtomicBool>)>>,
    pub cancel: CancellationToken,
    /// Cached LLM prompt prefix (system, film+script, OK); cleared whenever the cue set changes.
    pub prefix: Mutex<Option<Arc<Vec<serde_json::Value>>>>,
    pub annot_run: Mutex<Arc<crate::llm::annotate::Run>>,
    pub annot_priority: std::sync::atomic::AtomicU32,
    /// Embedded subtitles being read out of the video file; `None` when no load is running.
    pub embedded: Mutex<Option<EmbeddedState>>,
    /// The modal's answer: `true` = load, `false` = decline. Dropped means declined too.
    pub embedded_decision: Mutex<Option<tokio::sync::oneshot::Sender<bool>>>,
    /// The file's Matroska structure and the chosen track's cues, read once per session.
    pub embedded_index: tokio::sync::OnceCell<Result<Arc<crate::subs::embedded::Index>, String>>,
    /// Cancels the running loader; replaced by every new load, a child of `cancel`.
    pub embedded_cancel: Mutex<CancellationToken>,
    /// Nudges the analysis scheduler whenever another batch of cues has been appended.
    pub cues_grew: tokio::sync::Notify,
}

impl Session {
    pub fn mode(&self, vaapi_ok: bool) -> Option<VideoMode> {
        self.probe.get().map(|p| video_mode(p, vaapi_ok))
    }
    pub async fn kill_ffmpeg(&self) {
        if let Some((_, mut c)) = self.ffmpeg.lock().await.take() {
            let _ = c.start_kill();
            let _ = c.wait().await;
        }
    }

    /// Kills the active ffmpeg process only if it still belongs to `gen`, preventing a failing
    /// older stream request from terminating a newer seek's process.
    pub async fn kill_ffmpeg_if_gen(&self, gen: u64) -> bool {
        let child = {
            let mut slot = self.ffmpeg.lock().await;
            if slot.as_ref().is_some_and(|(g, _)| *g == gen) {
                slot.take().map(|(_, c)| c)
            } else {
                None
            }
        };
        if let Some(mut c) = child {
            let _ = c.start_kill();
            let _ = c.wait().await;
            true
        } else {
            false
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

pub(crate) fn resume_position(last: f64, from_req: Option<f64>, duration: f64) -> f64 {
    let t = last.max(from_req.unwrap_or(0.0));
    if duration > 0.0 && t > duration - 60.0 { 0.0 } else { t }
}

fn display_title(req: &SessionRequest) -> String {
    req.card.as_ref().map(|c| c.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| req.title.clone())
}

fn poster_url_for(port: u16, media_id: &str, card: Option<&Card>) -> Option<String> {
    let has_poster = card.and_then(|c| c.poster.as_ref()).is_some()
        || crate::poster::poster_path(media_id).exists();
    has_poster.then(|| crate::poster::url(port, media_id))
}

pub fn state_of(st: &AppState, s: &Session, p: &Probe, resume_at: f64, sub_offset: f64) -> SessionState {
    let (season, episode) = season_episode_of(&s.req);
    let episode_title = episode.and_then(|e| {
        s.req.episodes.iter().find(|x| x.episode == e).and_then(|x| x.name_en.clone().or_else(|| x.name_ru.clone()))
    });
    let url = &s.req.url;
    SessionState {
        session_id: s.id.clone(),
        media_id: s.media_id.clone(),
        title: display_title(&s.req),
        original_title: s.req.card.as_ref().and_then(|c| c.original_title.clone()),
        year: s.req.card.as_ref().and_then(|c| c.year),
        season,
        episode,
        episode_title,
        poster_url: poster_url_for(st.listen_port, &s.media_id, s.req.card.as_ref()),
        duration: p.duration,
        audio_tracks: p.audio.clone(),
        audio_index: *s.audio_index.lock().unwrap(),
        resume_at,
        sub_offset,
        playlist: s.req.playlist.iter().map(|i| PlaylistTitle { title: i.title.clone() }).collect(),
        playlist_index: s.req.playlist.iter().position(|i| &i.url == url),
        llm_enabled: st.cfg().llm_enabled(),
        torrent: crate::subs::torrserver::target(&s.src).is_some(),
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
    open_with_options(st, req, file_size, false, None).await
}

pub async fn open_with_options(
    st: &Arc<AppState>,
    req: SessionRequest,
    file_size: Option<u64>,
    from_start: bool,
    seek_at: Option<f64>,
) -> Result<String, String> {
    if !(req.url.starts_with("http://") || req.url.starts_with("https://") || req.url.starts_with("file://")) {
        return Err(bad("url должен быть http(s)"));
    }
    if req.title.trim().is_empty() {
        return Err(bad("title не может быть пустым"));
    }
    let _open_guard = st.session_open_lock.lock().await;
    st.sessions.close().await;

    let media_id = media_id_for(&req.url, file_size);
    let kind = if req.url.starts_with("file://") { "file" } else { "lampa" };
    let (season, episode) = season_episode_of(&req);
    let title = display_title(&req);
    let original_title = req.card.as_ref().and_then(|c| c.original_title.clone());
    let poster_url = poster_url_for(st.listen_port, &media_id, req.card.as_ref());
    let ep_title = episode.and_then(|e| req.episodes.iter().find(|x| x.episode == e).and_then(|x| x.name_en.clone().or_else(|| x.name_ru.clone())));
    {
        let (mid, r, title, original_title) = (media_id.clone(), req.clone(), title.clone(), original_title.clone());
        st.db(move |c| {
            let card = r.card.as_ref();
            c.execute(
                "INSERT INTO media(id,kind,source_url,title,original_title,year,tmdb_id,tmdb_type,imdb_id,season,episode,episode_title,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
                 ON CONFLICT(id) DO UPDATE SET source_url=excluded.source_url,title=excluded.title,original_title=excluded.original_title,
                   year=excluded.year,tmdb_id=excluded.tmdb_id,tmdb_type=excluded.tmdb_type,imdb_id=excluded.imdb_id,
                   season=excluded.season,episode=excluded.episode,episode_title=excluded.episode_title,updated_at=excluded.updated_at,hidden=0",
                rusqlite::params![
                    mid, kind, r.url,
                    title,
                    original_title, card.and_then(|c| c.year),
                    card.map(|c| c.tmdb_id).filter(|i| *i != 0), card.map(|c| c.kind.clone()), card.and_then(|c| c.imdb_id.clone()),
                    season, episode, ep_title, now()
                ],
            )?;
            Ok(())
        }).await?;
    }

    let cancel = CancellationToken::new();
    let session = Arc::new(Session {
        id: uuid::Uuid::new_v4().to_string(),
        media_id: media_id.clone(),
        req: req.clone(),
        from_start,
        seek_at: seek_at.filter(|t| t.is_finite() && *t >= 0.0),
        src: st.cfg().with_auth(&req.url),
        probe: OnceLock::new(),
        audio_index: Mutex::new(0),
        ffmpeg: Default::default(),
        gen: AtomicU64::new(0),
        flow: Mutex::new(None),
        embedded_cancel: Mutex::new(cancel.child_token()),
        cancel,
        prefix: Mutex::new(None),
        annot_run: Default::default(),
        annot_priority: Default::default(),
        embedded: Mutex::new(None),
        embedded_decision: Mutex::new(None),
        embedded_index: Default::default(),
        cues_grew: Default::default(),
    });
    if let Some(displaced) = st.sessions.replace(Some(session.clone())) {
        displaced.cancel.cancel();
        displaced.kill_ffmpeg().await;
    }
    let _ = st.app.emit("session:loading", serde_json::json!({
        "title": title,
        "originalTitle": original_title,
        "season": season,
        "episode": episode,
        "posterUrl": poster_url,
        "kind": kind,
    }));
    show_main_window(&st.app);

    let st2 = st.clone();
    let s2 = session.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = finish_open(&st2, &s2).await {
            if !s2.cancel.is_cancelled() {
                crate::logs::log("app", &format!("open failed: {e}"));
                let _ = st2.app.emit("player:error", serde_json::json!({ "message": e }));
            }
        }
    });
    Ok(session.id.clone())
}

async fn resolve_and_persist_audio(
    db: &Arc<Mutex<rusqlite::Connection>>,
    media_id: &str,
    audio_tracks: &[AudioTrack],
    cancel: &CancellationToken,
) -> Result<Option<u32>, String> {
    if cancel.is_cancelled() {
        return Ok(None);
    }
    let mid = media_id.to_string();
    let saved = crate::state::db_task(db, move |c| {
        c.query_row("SELECT audio_index FROM media WHERE id=?1", [&mid], |r| r.get::<_, Option<u32>>(0))
    })
    .await?;
    if cancel.is_cancelled() {
        return Ok(None);
    }
    if let Some(idx) = saved.filter(|i| audio_tracks.iter().any(|a| a.index == *i)) {
        return Ok(Some(idx));
    }
    let default_idx = probe::default_audio(audio_tracks);
    if saved.is_none() {
        if let Some(def) = default_idx {
            let mid = media_id.to_string();
            crate::state::db_task(db, move |c| {
                c.execute("UPDATE media SET audio_index=?1 WHERE id=?2 AND audio_index IS NULL", rusqlite::params![def, mid])?;
                Ok(())
            })
            .await?;
        }
    }
    Ok(Some(default_idx.unwrap_or(0)))
}

async fn commit_probed_media(
    db: &Arc<Mutex<rusqlite::Connection>>,
    media_id: &str,
    cancel: &CancellationToken,
    duration: f64,
    from_start: bool,
) -> Result<bool, String> {
    if cancel.is_cancelled() {
        return Ok(false);
    }
    let mid = media_id.to_string();
    crate::state::db_task(db, move |c| {
        if from_start {
            c.execute("UPDATE media SET duration=?1, last_position=0 WHERE id=?2", rusqlite::params![duration, mid])?;
        } else {
            c.execute("UPDATE media SET duration=?1 WHERE id=?2", rusqlite::params![duration, mid])?;
        }
        Ok(())
    })
    .await?;
    Ok(true)
}

async fn finish_open(st: &Arc<AppState>, s: &Arc<Session>) -> Result<(), String> {
    let p = tokio::select! {
        r = probe::probe(&s.src) => r.map_err(|e| e.to_string())?,
        _ = s.cancel.cancelled() => return Ok(()),
    };
    if !commit_probed_media(&st.db, &s.media_id, &s.cancel, p.duration, s.from_start).await? {
        return Ok(());
    }
    let Some(audio) = resolve_and_persist_audio(&st.db, &s.media_id, &p.audio, &s.cancel).await? else {
        return Ok(());
    };
    *s.audio_index.lock().unwrap() = audio;
    let _ = s.probe.set(p);
    if s.cancel.is_cancelled() {
        return Ok(());
    }
    if let Some(state) = build_state(st, s).await? {
        if s.cancel.is_cancelled() {
            return Ok(());
        }
        let _ = st.app.emit("session:opened", &state);
    }
    tauri::async_runtime::spawn(crate::subs::acquire::run(st.clone(), s.clone()));
    let st3 = st.clone();
    tauri::async_runtime::spawn(async move { crate::anki::index::refresh(&st3).await });
    Ok(())
}

/// None while ffprobe has not finished yet.
pub async fn build_state(st: &Arc<AppState>, s: &Arc<Session>) -> Result<Option<SessionState>, String> {
    let Some(p) = s.probe.get() else { return Ok(None) };
    let mid = s.media_id.clone();
    let (last, off): (f64, f64) = st.db(move |c| c.query_row("SELECT last_position, sub_offset FROM media WHERE id=?1", [&mid], |r| Ok((r.get(0)?, r.get(1)?)))).await?;
    let resume = match s.seek_at.filter(|t| t.is_finite() && *t >= 0.0) {
        Some(t) if p.duration > 0.0 => t.clamp(0.0, (p.duration - 0.5).max(0.0)),
        Some(t) => t.max(0.0),
        None => resume_position(last, s.req.resume_at, p.duration),
    };
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

    #[tokio::test]
    async fn from_start_resets_position_only_after_probe_without_cancellation() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();
        conn.execute(
            "INSERT INTO media(id,kind,source_url,title,last_position,updated_at) VALUES('m1','lampa','http://x','Film',425.5,100)",
            [],
        )
        .unwrap();
        let db = Arc::new(Mutex::new(conn));

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(!commit_probed_media(&db, "m1", &cancelled, 5000.0, true).await.unwrap());
        let (pos, dur): (f64, Option<f64>) = db
            .lock()
            .unwrap()
            .query_row("SELECT last_position, duration FROM media WHERE id='m1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(pos, 425.5);
        assert_eq!(dur, None);

        let active = CancellationToken::new();
        assert!(commit_probed_media(&db, "m1", &active, 5000.0, false).await.unwrap());
        let (pos, dur): (f64, Option<f64>) = db
            .lock()
            .unwrap()
            .query_row("SELECT last_position, duration FROM media WHERE id='m1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(pos, 425.5);
        assert_eq!(dur, Some(5000.0));

        assert!(commit_probed_media(&db, "m1", &active, 5000.0, true).await.unwrap());
        let pos: f64 = db
            .lock()
            .unwrap()
            .query_row("SELECT last_position FROM media WHERE id='m1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pos, 0.0);
    }

    #[tokio::test]
    async fn default_audio_persists_only_when_null_and_not_cancelled() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();
        conn.execute(
            "INSERT INTO media(id,kind,source_url,title,updated_at) VALUES
             ('m1','lampa','http://x','Film 1',100),
             ('m2','lampa','http://y','Film 2',100)",
            [],
        )
        .unwrap();
        conn.execute("UPDATE media SET audio_index=0 WHERE id='m2'", []).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let tracks = vec![
            AudioTrack { index: 0, codec: "ac3".into(), lang: Some("rus".into()), title: None, channels: 6 },
            AudioTrack { index: 2, codec: "eac3".into(), lang: Some("eng".into()), title: None, channels: 6 },
        ];

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert_eq!(resolve_and_persist_audio(&db, "m1", &tracks, &cancelled).await.unwrap(), None);

        let active = CancellationToken::new();
        assert_eq!(resolve_and_persist_audio(&db, "m1", &tracks, &active).await.unwrap(), Some(2));
        let persisted: Option<u32> = db
            .lock()
            .unwrap()
            .query_row("SELECT audio_index FROM media WHERE id='m1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(persisted, Some(2));

        // Explicit user track 0 on m2 is preserved.
        assert_eq!(resolve_and_persist_audio(&db, "m2", &tracks, &active).await.unwrap(), Some(0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_ffmpeg_if_gen_ignores_superseded_generations() {
        let cancel = CancellationToken::new();
        let s = Session {
            id: "s1".into(),
            media_id: "m1".into(),
            req: SessionRequest {
                url: "http://x/v.mkv".into(),
                title: "Film".into(),
                path: None,
                subtitles: vec![],
                resume_at: None,
                card: None,
                season: None,
                episode: None,
                episodes: vec![],
                playlist: vec![],
            },
            from_start: false,
            seek_at: None,
            src: "http://x/v.mkv".into(),
            probe: OnceLock::new(),
            audio_index: Mutex::new(0),
            ffmpeg: tokio::sync::Mutex::new(None),
            gen: AtomicU64::new(0),
            flow: Mutex::new(None),
            embedded_cancel: Mutex::new(cancel.child_token()),
            cancel,
            prefix: Mutex::new(None),
            annot_run: Default::default(),
            annot_priority: Default::default(),
            embedded: Mutex::new(None),
            embedded_decision: Mutex::new(None),
            embedded_index: Default::default(),
            cues_grew: Default::default(),
        };
        let child = tokio::process::Command::new("sleep").arg("30").kill_on_drop(true).spawn().unwrap();
        *s.ffmpeg.lock().await = Some((2, child));

        assert!(!s.kill_ffmpeg_if_gen(1).await, "stale generation 1 must not kill generation 2");
        assert!(s.ffmpeg.lock().await.is_some());
        assert!(s.kill_ffmpeg_if_gen(2).await, "matching generation 2 must be killed");
        assert!(s.ffmpeg.lock().await.is_none());
    }
}
