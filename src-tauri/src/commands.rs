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

/// Providers already configured in other coding agents, with their declared models.
#[tauri::command]
pub fn llm_providers() -> Vec<crate::llm::providers::ProviderInfo> {
    crate::llm::providers::discover(&crate::llm::providers::Roots::from_env()).into_iter().map(|f| f.info).collect()
}

/// Live model list for an unsaved draft, so a manual baseUrl/key can be listed before saving.
#[tauri::command]
pub async fn llm_models(st: St<'_>, llm: crate::config::Llm) -> Res<Vec<String>> {
    crate::llm::providers::list_models(&st.llm_http, &crate::llm::providers::Roots::from_env(), &llm).await
}

/// Display name, context window and price of one model: the settings hints and the chat footer.
#[tauri::command]
pub async fn llm_model_info(st: St<'_>, source: String, provider: String, base_url: String, model: String) -> Res<crate::llm::catalog::ModelInfo> {
    Ok(crate::llm::catalog::model_info(&st, &source, &provider, &base_url, &model).await)
}

/// One tiny request with the draft connection: does the provider answer with this model at all?
#[tauri::command]
pub async fn llm_ping(st: St<'_>, llm: crate::config::Llm, model: String) -> Res<crate::llm::client::Ping> {
    if model.trim().is_empty() {
        return Err("Выберите модель".into());
    }
    let roots = crate::llm::providers::Roots::from_env();
    let endpoint = crate::llm::providers::endpoint_for(&roots, &llm).ok_or_else(|| format!("Провайдер {}/{} не найден", llm.source, llm.provider))?;
    if endpoint.api_key.is_empty() {
        return Err("Нет API-ключа".into());
    }
    let t = crate::llm::tasks::Target {
        task: crate::llm::tasks::Task::Chat,
        source: llm.source,
        provider: llm.provider,
        model,
        effort: crate::llm::tasks::Effort::Off,
        endpoint,
    };
    crate::llm::client::ping(&st.llm_http, &t).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn config_get(st: St<'_>) -> crate::config::Config { (*st.cfg()).clone() }

#[tauri::command]
pub fn setup_status(st: St<'_>) -> crate::setup::SetupStatus { crate::setup::status(&st.cfg(), st.listen_port) }

/// System tools the app needs; the UI warns about missing required ones on start.
#[tauri::command]
pub fn deps_check() -> crate::deps::DepsStatus { crate::deps::status() }

/// Saves and applies the config at once. Returns true when the change needs an app restart (server port).
#[tauri::command]
pub async fn config_save(st: St<'_>, cfg: crate::config::Config) -> Res<bool> {
    crate::setup::apply(st.inner(), cfg, crate::setup::By::App).await
}

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
    Ok(OpenStream { url: format!("http://127.0.0.1:{}/media/{}/stream?start={}&audio={}&gen={}", st.cfg().server.port, s.id, at.max(0.0), audio_index, gen) })
}

/// Peers, speed and buffer health of a TorrServer stream; `None` for other sources and while the
/// server does not answer. Polled by the player every two seconds.
#[tauri::command]
pub async fn media_torrent_health(st: St<'_>, session_id: String) -> Res<Option<crate::subs::torrserver::TorrentHealth>> {
    let Some(s) = st.sessions.get(&session_id) else { return Ok(None) };
    if crate::subs::torrserver::target(&s.src).is_none() { return Ok(None); }
    Ok(crate::subs::torrserver::health(&st, &s.src).await)
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
    /// `noSubs` | `off` | `new` | `partial` | `done` | `failed`; see `annot_badge`.
    pub annot: String,
    pub annot_done: u32,
    pub annot_total: u32,
    pub poster_url: Option<String>,
}

/// Badge of a film's dialog analysis on the home screen.
fn annot_badge(cues: u32, consent: Option<&str>, done: u32, failed: u32) -> &'static str {
    let total = cues.div_ceil(crate::llm::annotate::BATCH);
    if cues == 0 { return "noSubs"; }
    if consent == Some("off") { return "off"; }
    if done >= total { return "done"; }
    if consent.is_none() { return "new"; }
    if done + failed >= total && failed > 0 { return "failed"; }
    "partial"
}

#[tauri::command]
pub async fn media_recent(st: St<'_>) -> Res<Vec<RecentMedia>> {
    let port = st.listen_port;
    st.db(move |c| {
        let mut q = c.prepare(
            "SELECT id,title,original_title,season,episode,duration,last_position,source_url,kind,\
                    (SELECT count(*) FROM cue WHERE media_id=media.id),\
                    annot,\
                    (SELECT count(*) FROM annot_batch WHERE media_id=media.id AND status='done'),\
                    (SELECT count(*) FROM annot_batch WHERE media_id=media.id AND status='failed')\
             FROM media WHERE hidden=0 ORDER BY updated_at DESC LIMIT 20",
        )?;
        let rows = q.query_map([], |r| {
            let media_id: String = r.get(0)?;
            let cues: u32 = r.get(9)?;
            let consent: Option<String> = r.get(10)?;
            let done: u32 = r.get(11)?;
            let failed: u32 = r.get(12)?;
            Ok(RecentMedia {
                poster_url: crate::poster::poster_path(&media_id).exists().then(|| crate::poster::url(port, &media_id)),
                media_id, title: r.get(1)?, original_title: r.get(2)?, season: r.get(3)?, episode: r.get(4)?,
                duration: r.get(5)?, last_position: r.get(6)?, source_url: r.get(7)?, kind: r.get(8)?,
                annot: annot_badge(cues, consent.as_deref(), done, failed).into(),
                annot_done: done,
                annot_total: cues.div_ceil(crate::llm::annotate::BATCH),
            })
        })?;
        rows.collect()
    }).await
}

/// Forgets the consent of one film, so reopening it asks again (`block` badge in «Недавних»).
#[tauri::command]
pub async fn media_reset_annot(st: St<'_>, media_id: String) -> Res<()> {
    st.db(move |c| { c.execute("UPDATE media SET annot=NULL WHERE id=?1", [&media_id])?; Ok(()) }).await
}

/// Removes a film from «Недавних» (`hidden=true`) or puts it back (the snackbar's «Отменить»).
/// Nothing else is deleted: the analysis, the chat and the position are kept, and opening the film
/// again shows it in the list once more.
#[tauri::command]
pub async fn media_set_hidden(st: St<'_>, media_id: String, hidden: bool) -> Res<()> {
    st.db(move |c| { c.execute("UPDATE media SET hidden=?1 WHERE id=?2", rusqlite::params![hidden, media_id])?; Ok(()) }).await
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
    crate::subs::acquire::install(
        &st,
        &s,
        "sidecar",
        label,
        true,
        format!("file:{path}"),
        path.into(),
        crate::subs::parse::decode(&bytes),
    )
    .await
    .map(|_| ())
}

/// Every English subtitle the sources can offer for this film, with the ones already installed marked.
#[tauri::command]
pub async fn subs_candidates(st: St<'_>, media_id: String) -> Res<SubsCandidates> {
    let s = current_for(&st, &media_id)?;
    crate::subs::choose::candidates(&st, &s).await
}

#[tauri::command]
pub async fn subs_select(st: St<'_>, media_id: String, candidate: SubCandidate) -> Res<()> {
    let s = current_for(&st, &media_id)?;
    crate::subs::choose::select(&st, &s, candidate).await
}

/// The embedded-subtitles load of this film, `null` when none is running or waiting for an answer.
#[tauri::command]
pub async fn subs_embedded_state(st: St<'_>, media_id: String) -> Res<Option<EmbeddedState>> {
    Ok(current_for(&st, &media_id)?.embedded.lock().unwrap().clone())
}

/// The confirmation modal's answer: `true` reads the track, `false` lets the next source try.
#[tauri::command]
pub async fn subs_embedded_decide(st: St<'_>, media_id: String, accept: bool) -> Res<()> {
    let s = current_for(&st, &media_id)?;
    let tx = s.embedded_decision.lock().unwrap().take();
    if let Some(tx) = tx {
        let _ = tx.send(accept);
    }
    Ok(())
}

#[tauri::command]
pub async fn annot_prioritize(st: St<'_>, media_id: String, cue_idx: u32) -> Res<()> {
    crate::llm::annotate::prioritize(&*current_for(&st, &media_id)?, cue_idx);
    Ok(())
}

#[tauri::command]
pub async fn annot_status(st: St<'_>, media_id: String) -> Res<AnnotStatus> {
    crate::llm::annotate::status(&st, &media_id).await
}

#[tauri::command]
pub async fn annot_estimate(st: St<'_>, media_id: String) -> Res<AnnotEstimate> {
    let s = current_for(&st, &media_id)?;
    crate::llm::annotate::estimate(&st, &s).await
}

#[tauri::command]
pub async fn annot_cost(st: St<'_>, media_id: String) -> Res<crate::llm::cost::AnnotCost> {
    let s = current_for(&st, &media_id)?;
    let e = crate::llm::annotate::estimate(&st, &s).await?;
    crate::llm::cost::estimate_cost(&st, &media_id, &e).await
}

/// Records the user's choice for this film and starts (or stops) the background analysis right away.
/// `remember` also stops asking for as long as the annotate model stays the same.
#[tauri::command]
pub async fn annot_set(st: St<'_>, media_id: String, on: bool, remember: bool) -> Res<()> {
    let s = current_for(&st, &media_id)?;
    if on && remember {
        // A config change, saved before the per-film consent it replaces.
        let mut cfg = (*st.cfg()).clone();
        let key = cfg.annot_model_key();
        cfg.annot.remembered_model = key;
        cfg.annot.auto = true;
        let _ = crate::setup::apply(st.inner(), cfg, crate::setup::By::App).await?;
    }
    let value = if on { "on" } else { "off" };
    let mid = media_id.clone();
    st.db(move |c| {
        c.execute("UPDATE media SET annot=?1 WHERE id=?2", rusqlite::params![value, mid])?;
        Ok(())
    })
    .await?;
    crate::llm::annotate::restart(&st, &s);
    crate::llm::annotate::emit_status(&st, &media_id).await;
    Ok(())
}

/// The model the analysis would run on, and whether its consent is remembered.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotModel {
    pub key: String,
    pub auto: bool,
}

#[tauri::command]
pub fn annot_model(st: St<'_>) -> AnnotModel {
    let cfg = st.cfg();
    let key = cfg.annot_model_key();
    AnnotModel { auto: cfg.annot.auto && !cfg.annot.remembered_model.is_empty() && cfg.annot.remembered_model == key, key }
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

/// Model, effort and the film chat's running token/dollar totals, for the footer under the input.
#[tauri::command]
pub async fn agent_usage(st: St<'_>, media_id: String) -> Res<crate::llm::agent::ChatUsage> {
    crate::llm::agent::usage(&st, &media_id).await
}

/// Queues the chosen words of a proposal for Anki; jobs own their cards from here on.
#[tauri::command]
pub async fn cards_add(st: St<'_>, proposal_id: i64, indices: Vec<usize>) -> Res<()> {
    crate::anki::jobs::enqueue_proposal(&st, proposal_id, indices).await
}

/// Cancels the jobs a dismissed proposal still owns.
#[tauri::command]
pub async fn cards_dismiss(st: St<'_>, proposal_id: i64) -> Res<()> {
    crate::anki::jobs::dismiss_proposal(&st, proposal_id).await
}

#[tauri::command]
pub async fn cards_job_create(
    st: St<'_>,
    media_id: String,
    cue_idx: u32,
    span: Option<String>,
    audio_index: u32,
    sub_offset: f64,
    mode: String,
) -> Res<crate::anki::jobs::CardJob> {
    crate::anki::jobs::cards_job_create(&st, media_id, cue_idx, span, audio_index, sub_offset, mode).await
}

#[tauri::command]
pub async fn cards_jobs(st: St<'_>, cursor: Option<crate::anki::jobs::JobCursor>) -> Res<crate::anki::jobs::CardJobPage> {
    crate::anki::jobs::cards_jobs(&st, cursor).await
}

#[tauri::command]
pub async fn cards_job_get(st: St<'_>, job_id: String) -> Res<crate::anki::jobs::CardJob> {
    crate::anki::jobs::cards_job_get(&st, job_id).await
}

#[tauri::command]
pub async fn cards_job_hold(st: St<'_>, job_id: String, client_id: String, held: bool) -> Res<crate::anki::jobs::CardJob> {
    crate::anki::jobs::cards_job_hold(&st, job_id, client_id, held).await
}

#[tauri::command]
pub async fn cards_job_cancel(st: St<'_>, job_id: String, revision: u64) -> Res<crate::anki::jobs::CardJob> {
    crate::anki::jobs::cards_job_cancel(&st, job_id, revision).await
}

#[tauri::command]
pub async fn cards_job_edit(st: St<'_>, job_id: String, refresh: bool) -> Res<crate::anki::jobs::CardJobEditor> {
    crate::anki::jobs::cards_job_edit(&st, job_id, refresh).await
}

#[tauri::command]
pub async fn cards_job_preview(
    st: St<'_>,
    job_id: String,
    revision: u64,
    draft: crate::anki::cards::WordDraft,
    field_values: Option<std::collections::BTreeMap<String, String>>,
) -> Res<crate::anki::preview::CardPreview> {
    crate::anki::jobs::cards_job_preview(&st, job_id, revision, draft, field_values).await
}

#[tauri::command]
pub async fn cards_job_image(st: St<'_>, job_id: String, revision: u64, prompt: String) -> Res<crate::anki::jobs::CardJobEditor> {
    crate::anki::jobs::cards_job_image(&st, job_id, revision, prompt).await
}

#[tauri::command]
pub async fn cards_job_save(
    st: St<'_>,
    job_id: String,
    revision: u64,
    draft: crate::anki::cards::WordDraft,
    field_values: Option<std::collections::BTreeMap<String, String>>,
    baseline_fields: Option<std::collections::BTreeMap<String, String>>,
) -> Res<crate::anki::jobs::CardJob> {
    crate::anki::jobs::cards_job_save(&st, job_id, revision, draft, field_values, baseline_fields).await
}

#[tauri::command]
pub async fn cards_job_delete(st: St<'_>, job_id: String) -> Res<crate::anki::jobs::CardJob> {
    crate::anki::jobs::cards_job_delete(&st, job_id).await
}

#[tauri::command]
pub async fn cards_job_retry(st: St<'_>, job_id: String) -> Res<crate::anki::jobs::CardJob> {
    crate::anki::jobs::cards_job_retry(&st, job_id).await
}

#[tauri::command]
pub async fn anki_refresh(st: St<'_>) -> Res<()> {
    crate::anki::index::refresh(&st).await;
    Ok(())
}

/// Decks with card counts and note types with their fields, for the settings dialog's lists.
#[tauri::command]
pub async fn anki_catalog(st: St<'_>) -> Res<crate::anki::connect::Catalog> {
    let url = st.cfg().anki.url.clone();
    let client = crate::anki::connect::Client::new(&st.http, &url);
    client.catalog().await.map_err(|e| {
        crate::logs::log("app", &crate::logs::redact(&format!("anki catalog: {e}")));
        "Anki не запущен или не отвечает".into()
    })
}

/// Note types the known-words index reads, with the fields it picked. Refreshed on every `anki:index`.
#[tauri::command]
pub fn anki_index_models(st: St<'_>) -> Vec<crate::anki::index::IndexModel> {
    st.anki.lock().unwrap().models.clone()
}

/// Fields, template and CSS of one note type; the built-in constants when Anki does not have it yet.
#[tauri::command]
pub async fn anki_note_type(st: St<'_>, name: String) -> Res<crate::anki::note_type::NoteTypeView> {
    let url = st.cfg().anki.url.clone();
    let client = crate::anki::connect::Client::new(&st.http, &url);
    crate::anki::note_type::view(&client, &name).await.map_err(|e| format!("{e:#}"))
}

/// The sample draft the settings dialog previews when no card is being made.
fn sample_draft() -> crate::anki::cards::WordDraft {
    crate::anki::cards::WordDraft {
        word: "bring".into(),
        translation: "доставить, принести".into(),
        word_type: "verb".into(),
        cloze_sentence: "It'll {{c1::bring}} him joy.".into(),
        full_sentence: "It'll bring him joy.".into(),
        sentence_translation: "Это доставит ему радость.".into(),
        image_prompt: "A smiling man receiving a gift".into(),
    }
}

/// Preview of one card: unsaved `anki`/`draft`/`images`/`tutor` are allowed, so the settings dialog
/// and the add-card modal see exactly the route that saving would use.
#[tauri::command]
pub async fn cards_preview(
    st: St<'_>,
    anki: Option<crate::config::Anki>,
    draft: Option<crate::anki::cards::WordDraft>,
    media_id: Option<String>,
    cue_idx: Option<u32>,
    images: Option<crate::config::Images>,
    tutor: Option<crate::config::Tutor>,
) -> Res<crate::anki::preview::CardPreview> {
    let cfg = st.cfg();
    let anki = anki.unwrap_or_else(|| cfg.anki.clone());
    let draft = draft.unwrap_or_else(sample_draft);
    let images_cfg = images.unwrap_or_else(|| cfg.images.clone());
    let tutor_cfg = tutor.unwrap_or_else(|| cfg.tutor.clone());
    let client = crate::anki::connect::Client::new(&st.http, &anki.url);
    let route = crate::anki::images::resolve_route(&st, &images_cfg, &tutor_cfg).await.map_err(|e| e.public_text())?;
    let media = match (media_id, cue_idx) {
        (Some(m), Some(ci)) => Some(crate::anki::jobs::preview_context(&st, &m, ci).await?),
        (None, None) => None,
        _ => return Err("Укажите фильм и реплику вместе".into()),
    };
    let media_ref = media.as_ref().map(|(m, c)| (m, c));
    crate::anki::preview::build(&st, &client, &anki, &draft, media_ref, &route).await
}

/// The enabled providers, in order, without credentials: what the settings dialog shows and tests.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    pub key: String,
    pub data_url: String,
    pub provider: String,
    pub model: String,
}

#[tauri::command]
pub async fn images_route(
    st: St<'_>,
    images: Option<crate::config::Images>,
    tutor: Option<crate::config::Tutor>,
) -> Res<crate::anki::images::ImageRouteView> {
    let cfg = st.cfg();
    let images = images.unwrap_or_else(|| cfg.images.clone());
    let tutor = tutor.unwrap_or_else(|| cfg.tutor.clone());
    let route = crate::anki::images::resolve_route(&st, &images, &tutor).await.map_err(|e| e.public_text())?;
    Ok(crate::anki::images::ImageRouteView::of(&route))
}

/// Generates one picture through the whole unsaved route; it lands in the same cache the add uses.
#[tauri::command]
pub async fn images_generate(
    st: St<'_>,
    prompt: String,
    images: Option<crate::config::Images>,
    tutor: Option<crate::config::Tutor>,
) -> Res<GeneratedImage> {
    let cfg = st.cfg();
    let images = images.unwrap_or_else(|| cfg.images.clone());
    let tutor = tutor.unwrap_or_else(|| cfg.tutor.clone());
    if prompt.trim().is_empty() {
        return Err("Укажите промпт картинки".into());
    }
    let route = crate::anki::images::resolve_route(&st, &images, &tutor).await.map_err(|e| e.public_text())?;
    let cancel = tokio_util::sync::CancellationToken::new();
    let asset = crate::anki::images::generate(&st, &route, &prompt, &cancel, None).await.map_err(|e| e.public_text())?;
    let data_url = crate::anki::images::data_url(&asset.path)?;
    Ok(GeneratedImage { key: asset.key, data_url, provider: asset.provider, model: asset.model })
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

#[tauri::command]
pub async fn notifications_list(st: St<'_>) -> Res<Vec<crate::notify::Notification>> {
    crate::notify::list(&st).await
}

#[tauri::command]
pub fn notifications_push(st: St<'_>, level: crate::notify::Level, message: String) -> Res<crate::notify::Notification> {
    crate::notify::push(&st, level, message)
}

#[tauri::command]
pub async fn notifications_remove(st: St<'_>, id: i64) -> Res<()> {
    crate::notify::remove(&st, id).await?;
    crate::logs::log("events", &format!("notify removed #{id}"));
    Ok(())
}

#[tauri::command]
pub async fn notifications_clear(st: St<'_>) -> Res<()> {
    crate::notify::clear(&st).await?;
    crate::logs::log("events", "notify cleared");
    Ok(())
}

/// Interaction log lines batched by the frontend; same file and timestamp format as the backend's own.
#[tauri::command]
pub fn log_events(lines: Vec<String>) {
    for l in &lines {
        crate::logs::log("events", l);
    }
}

#[cfg(test)]
mod tests {
    use super::annot_badge;

    #[test]
    fn annot_badge_rules() {
        assert_eq!(annot_badge(0, None, 0, 0), "noSubs");
        assert_eq!(annot_badge(100, Some("off"), 3, 0), "off");
        assert_eq!(annot_badge(100, Some("on"), 3, 0), "done");
        assert_eq!(annot_badge(100, None, 0, 0), "new");
        assert_eq!(annot_badge(100, Some("on"), 2, 1), "failed");
        assert_eq!(annot_badge(100, Some("on"), 1, 0), "partial");
    }
}
