use crate::{
    db::now,
    session::{self, file_request},
    state::AppState,
    types::*,
};
use std::sync::{atomic::Ordering, Arc};
use tauri::State;

type St<'a> = State<'a, Arc<AppState>>;
type Res<T> = Result<T, String>;

#[tauri::command]
pub fn theme_current() -> Option<crate::theme::InirTheme> { crate::theme::load() }

#[tauri::command]
pub async fn session_current(st: St<'_>) -> Res<Option<SessionState>> {
    match st.sessions.current() {
        Some(s) => session::build_state(&st, &s).await,
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn session_close(st: St<'_>) -> Res<()> {
    st.sessions.close().await;
    Ok(())
}

#[tauri::command]
pub async fn session_open_file(st: St<'_>, path: String) -> Res<String> {
    let (req, size) = file_request(&path)?;
    session::open(&st, req, Some(size)).await
}

#[tauri::command]
pub async fn session_open_playlist_item(st: St<'_>, index: usize) -> Res<String> {
    let cur = st.sessions.current().ok_or("нет активной сессии")?;
    let item = cur.req.playlist.get(index).ok_or("нет такого элемента плейлиста")?.clone();
    let req = SessionRequest {
        url: item.url,
        title: item.title,
        path: item.path,
        subtitles: item.subtitles,
        resume_at: None,
        card: cur.req.card.clone(),
        season: None,
        episode: None,
        episodes: cur.req.episodes.clone(),
        playlist: cur.req.playlist.clone(),
    };
    session::open(&st, req, None).await
}

#[tauri::command]
pub async fn media_open_stream(st: St<'_>, session_id: String, at: f64, audio_index: u32) -> Res<OpenStream> {
    let s = st.sessions.get(&session_id).ok_or("сессия закрыта")?;
    s.mode(st.vaapi_ok.load(Ordering::Relaxed)).ok_or("ffprobe ещё не завершён")?;
    let gen = s.gen.fetch_add(1, Ordering::Relaxed) + 1;
    Ok(OpenStream { url: format!("http://127.0.0.1:{}/media/{}/stream?start={}&audio={}&gen={}", st.cfg.server.port, s.id, at.max(0.0), audio_index, gen) })
}

#[tauri::command]
pub async fn media_save_position(st: St<'_>, media_id: String, t: f64) -> Res<()> {
    st.db(move |c| { c.execute("UPDATE media SET last_position=?1, updated_at=?2 WHERE id=?3", rusqlite::params![t, now(), media_id])?; Ok(()) }).await
}

#[tauri::command]
pub async fn media_set_audio(st: St<'_>, media_id: String, index: u32) -> Res<()> {
    if let Some(s) = st.sessions.current().filter(|s| s.media_id == media_id) {
        *s.audio_index.lock().unwrap() = index;
    }
    st.db(move |c| { c.execute("UPDATE media SET audio_index=?1 WHERE id=?2", rusqlite::params![index, media_id])?; Ok(()) }).await
}

#[tauri::command]
pub async fn media_set_sub_offset(st: St<'_>, media_id: String, sec: f64) -> Res<()> {
    st.db(move |c| { c.execute("UPDATE media SET sub_offset=?1 WHERE id=?2", rusqlite::params![sec, media_id])?; Ok(()) }).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentMedia {
    pub media_id: String,
    pub title: String,
    pub original_title: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub duration: Option<f64>,
    pub last_position: f64,
    pub source_url: String,
    pub kind: String,
}

#[tauri::command]
pub async fn media_recent(st: St<'_>) -> Res<Vec<RecentMedia>> {
    st.db(|c| {
        let mut q = c.prepare("SELECT id,title,original_title,season,episode,duration,last_position,source_url,kind FROM media ORDER BY updated_at DESC LIMIT 20")?;
        let rows = q.query_map([], |r| Ok(RecentMedia {
            media_id: r.get(0)?, title: r.get(1)?, original_title: r.get(2)?, season: r.get(3)?, episode: r.get(4)?,
            duration: r.get(5)?, last_position: r.get(6)?, source_url: r.get(7)?, kind: r.get(8)?,
        }))?;
        rows.collect()
    }).await
}

#[tauri::command]
pub async fn session_reopen(st: St<'_>, media_id: String) -> Res<String> {
    type Row = (String, String, String, Option<String>, Option<i32>, Option<i64>, Option<String>, Option<String>, Option<u32>, Option<u32>);
    let row: Row = st.db(move |c| c.query_row(
        "SELECT kind,source_url,title,original_title,year,tmdb_id,tmdb_type,imdb_id,season,episode FROM media WHERE id=?1",
        [&media_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
    )).await?;
    let (kind, url, title, original_title, year, tmdb_id, tmdb_type, imdb_id, season, episode) = row;
    if kind == "file" {
        let path = url::Url::parse(&url).ok().and_then(|u| u.to_file_path().ok()).ok_or("битый путь")?;
        let (req, size) = file_request(&path.to_string_lossy())?;
        return session::open(&st, req, Some(size)).await;
    }
    let card = (original_title.is_some() || tmdb_id.is_some()).then(|| Card {
        tmdb_id: tmdb_id.unwrap_or(0),
        kind: tmdb_type.unwrap_or_else(|| "movie".into()),
        title: title.clone(),
        original_title,
        year,
        imdb_id,
        poster: None,
    });
    let req = SessionRequest { url, title, path: None, subtitles: vec![], resume_at: None, card, season, episode, episodes: vec![], playlist: vec![] };
    session::open(&st, req, None).await
}

fn current_for(st: &AppState, media_id: &str) -> Res<Arc<session::Session>> {
    st.sessions.current().filter(|s| s.media_id == media_id).ok_or_else(|| "сессия закрыта".to_string())
}

#[tauri::command]
pub async fn subs_list(st: St<'_>, media_id: String) -> Res<SubsList> {
    st.db(move |c| crate::subs::store::list(c, &media_id)).await
}

#[tauri::command]
pub async fn subs_load_file(st: St<'_>, media_id: String, path: String) -> Res<()> {
    let s = current_for(&st, &media_id)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let label = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    crate::subs::acquire::install(&st, &s, "sidecar", label, true, path.into(), crate::subs::parse::decode(&bytes)).await.map(|_| ())
}

#[tauri::command]
pub async fn annot_prioritize(st: St<'_>, media_id: String, cue_idx: u32) -> Res<()> {
    crate::llm::annotate::prioritize(&*current_for(&st, &media_id)?, cue_idx);
    Ok(())
}

#[tauri::command]
pub async fn annot_retry(st: St<'_>, media_id: String, first_idx: u32) -> Res<()> {
    let s = current_for(&st, &media_id)?;
    let st2 = st.inner().clone();
    tauri::async_runtime::spawn(async move { crate::llm::annotate::retry(&st2, &s, first_idx).await });
    Ok(())
}

#[tauri::command]
pub async fn llm_explain(st: St<'_>, media_id: String, cue_idx: u32, span: String) -> Res<crate::llm::explain::Explanation> {
    let s = current_for(&st, &media_id)?;
    crate::llm::explain::explain(&st, &s, cue_idx, span).await
}

#[tauri::command]
pub async fn agent_send(st: St<'_>, media_id: String, cue_idx: Option<u32>, at: f64, text: String) -> Res<()> {
    let s = current_for(&st, &media_id)?;
    crate::llm::agent::send(&st, &s, cue_idx, at, text).await
}

#[tauri::command]
pub async fn agent_history(st: St<'_>, media_id: String) -> Res<Vec<crate::llm::agent::ChatMessage>> {
    crate::llm::agent::history(&st, &media_id).await
}

#[tauri::command]
pub async fn cards_draft(st: St<'_>, media_id: String, cue_idx: u32, span: Option<String>) -> Res<crate::tutor::cards::WordDraft> {
    let s = current_for(&st, &media_id)?;
    crate::llm::explain::draft(&st, &s, cue_idx, span).await
}

#[tauri::command]
pub async fn cards_create_proposal(st: St<'_>, media_id: String, cue_idx: u32, words: Vec<crate::tutor::cards::WordDraft>) -> Res<i64> {
    crate::tutor::cards::create_proposal(&st, &media_id, cue_idx, &words).await
}

/// Queues the words for Anki and returns at once; the outcome arrives as `cards:result`.
#[tauri::command]
pub async fn cards_add(st: St<'_>, proposal_id: i64, indices: Vec<usize>) -> Res<()> {
    crate::tutor::cards::enqueue(&st, proposal_id, indices).await
}

#[tauri::command]
pub async fn cards_dismiss(st: St<'_>, proposal_id: i64) -> Res<()> {
    crate::tutor::cards::set_status(&st, proposal_id, "dismissed", None).await;
    Ok(())
}

#[tauri::command]
pub async fn anki_refresh(st: St<'_>) -> Res<()> {
    crate::tutor::anki_index::refresh(&st).await;
    Ok(())
}

#[tauri::command]
pub async fn tutor_import_script(st: St<'_>, media_id: String) -> Res<TutorImport> {
    crate::tutor::api::import_script(&st, &media_id).await.map(|id| TutorImport { id }).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct TutorImport { pub id: i64 }

#[tauri::command]
pub async fn patterns_exposure(st: St<'_>, media_id: String, cue_idx: u32) -> Res<()> {
    st.db(move |c| {
        c.execute("INSERT OR IGNORE INTO exposure(pattern_id,media_id,cue_idx,seen_at) SELECT pattern_id,media_id,cue_idx,?3 FROM cue_pattern WHERE media_id=?1 AND cue_idx=?2", rusqlite::params![media_id, cue_idx, now()])?;
        Ok(())
    }).await
}

#[derive(serde::Serialize)]
pub struct PatternStat { pub id: String, pub count: i64, pub status: Option<String> }

#[tauri::command]
pub async fn patterns_stats(st: St<'_>) -> Res<Vec<PatternStat>> {
    st.db(|c| {
        let mut counts = std::collections::HashMap::new();
        for r in c.prepare("SELECT pattern_id,count(*) FROM exposure GROUP BY pattern_id")?.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (k, v) = r?;
            counts.insert(k, v);
        }
        let mut states = std::collections::HashMap::new();
        for r in c.prepare("SELECT pattern_id,status FROM pattern_state")?.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (k, v) = r?;
            states.insert(k, v);
        }
        Ok(crate::patterns::PATTERNS.iter().map(|p| PatternStat { id: p.id.clone(), count: counts.get(&p.id).copied().unwrap_or(0), status: states.get(&p.id).cloned() }).collect())
    }).await
}

#[tauri::command]
pub async fn patterns_set_status(st: St<'_>, id: String, status: String) -> Res<()> {
    if status != "learning" && status != "known" { return Err("status: learning|known".into()); }
    st.db(move |c| { c.execute("INSERT OR REPLACE INTO pattern_state VALUES(?1,?2,?3)", rusqlite::params![id, status, now()])?; Ok(()) }).await
}

#[derive(serde::Serialize)]
pub struct Occurrence { pub idx: u32, pub text: String }

#[tauri::command]
pub async fn patterns_occurrences(st: St<'_>, media_id: String, pattern_id: String) -> Res<Vec<Occurrence>> {
    st.db(move |c| {
        c.prepare("SELECT c.idx,c.text FROM cue_pattern p JOIN cue c ON c.media_id=p.media_id AND c.idx=p.cue_idx WHERE p.media_id=?1 AND p.pattern_id=?2 ORDER BY c.idx")?
            .query_map(rusqlite::params![media_id, pattern_id], |r| Ok(Occurrence { idx: r.get(0)?, text: r.get(1)? }))?
            .collect()
    }).await
}
