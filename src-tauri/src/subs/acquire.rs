use super::{opensubtitles as os, parse, sidecar, store};
use crate::{session::Session, state::AppState, types::SubsStatus};
use sha1::{Digest, Sha1};
use std::{path::PathBuf, sync::Arc};
use tauri::Emitter;

fn status(st: &AppState, e: SubsStatus) { let _ = st.app.emit("subs:status", e); }

fn cache_file(media_id: &str, ext: &str) -> PathBuf {
    crate::config::cache_dir().join("subs").join(format!("{}.{ext}", hex::encode(Sha1::digest(media_id.as_bytes()))))
}

/// Parses, normalizes and stores subtitles for the session's media, then announces them.
pub async fn install(
    st: &Arc<AppState>,
    s: &Arc<Session>,
    kind: &'static str,
    label: String,
    exact: bool,
    path: PathBuf,
    text: String,
) -> Result<usize, String> {
    let cues = store::normalize(parse::parse(&text));
    if cues.is_empty() {
        return Err("в файле нет реплик".into());
    }
    let n = cues.len();
    let (mid, p) = (s.media_id.clone(), path.to_string_lossy().into_owned());
    st.db(move |c| {
        store::replace_cues(c, &mid, &cues)?;
        store::set_source(c, &mid, kind, &label, exact, &p)
    })
    .await?;
    let mut e = SubsStatus::new(&s.media_id, "ready");
    e.source = Some(kind);
    e.exact = Some(exact);
    status(st, e);
    let _ = st.app.emit("subs:updated", serde_json::json!({ "mediaId": s.media_id }));
    crate::llm::annotate::restart(st, s);
    super::sync::spawn(st, s);
    Ok(n)
}

async fn save_cache(s: &Session, text: &str) -> PathBuf {
    let ext = match parse::sniff(text) { parse::Format::Vtt => "vtt", parse::Format::Ass => "ass", parse::Format::Srt => "srt" };
    let p = cache_file(&s.media_id, ext);
    if let Some(d) = p.parent() { let _ = tokio::fs::create_dir_all(d).await; }
    let _ = tokio::fs::write(&p, text).await;
    p
}

async fn try_sidecar(st: &Arc<AppState>, s: &Arc<Session>) -> Option<()> {
    let refs = &s.req.subtitles;
    let mut cands: Vec<_> = refs.iter().filter(|r| sidecar::is_english_ref(&r.label, &r.url)).collect();
    let lone_unlabelled = cands.is_empty() && refs.len() == 1;
    if lone_unlabelled { cands.push(&refs[0]); }
    for r in cands {
        let Ok(bytes) = sidecar::read_ref(st, &r.url).await else { continue };
        let text = parse::decode(&bytes);
        if lone_unlabelled && !sidecar::looks_english(&text) { continue; }
        let path = save_cache(s, &text).await;
        if install(st, s, "sidecar", r.label.clone(), true, path, text).await.is_ok() { return Some(()); }
    }
    None
}

async fn try_opensubtitles(st: &Arc<AppState>, s: &Arc<Session>) -> Option<()> {
    if !st.cfg.opensubtitles_enabled() { return None; }
    status(st, SubsStatus::new(&s.media_id, "downloading").msg("OpenSubtitles"));
    match os::fetch(st, s).await {
        Ok(os::Outcome::Found(f)) => {
            let text = parse::decode(&f.bytes);
            let path = save_cache(s, &text).await;
            install(st, s, "opensubtitles", f.label, f.exact, path, text).await.ok().map(|_| ())
        }
        Ok(os::Outcome::QuotaExhausted) => {
            status(st, SubsStatus::new(&s.media_id, "searching").msg("лимит OpenSubtitles исчерпан"));
            None
        }
        Ok(os::Outcome::NotFound) => None,
        Err(e) => {
            crate::logs::log("app", &format!("opensubtitles: {e}"));
            None
        }
    }
}

/// Sidecar → OpenSubtitles (the video itself is never downloaded for subtitles); a stored result for this media short-circuits everything.
pub async fn run(st: Arc<AppState>, s: Arc<Session>) {
    let mid = s.media_id.clone();
    let cached = st
        .db(move |c| {
            let n: i64 = c.query_row("SELECT count(*) FROM cue WHERE media_id=?1", [&mid], |r| r.get(0))?;
            let src: Option<(String, bool)> = c
                .query_row("SELECT kind,exact FROM subtitle_source WHERE media_id=?1", [&mid], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)))
                .ok();
            Ok(if n > 0 { src } else { None })
        })
        .await
        .ok()
        .flatten();
    if let Some((kind, exact)) = cached {
        let mut e = SubsStatus::new(&s.media_id, "ready");
        e.source = Some(match kind.as_str() { "sidecar" => "sidecar", "opensubtitles" => "opensubtitles", _ => "opensubtitles" });
        e.exact = Some(exact);
        status(&st, e);
        let _ = st.app.emit("subs:updated", serde_json::json!({ "mediaId": s.media_id }));
        crate::llm::annotate::restart(&st, &s);
        super::sync::spawn(&st, &s);
        return;
    }

    status(&st, SubsStatus::new(&s.media_id, "searching"));
    if try_sidecar(&st, &s).await.is_some() || try_opensubtitles(&st, &s).await.is_some() { return; }
    if s.cancel.is_cancelled() { return; }
    status(&st, SubsStatus::new(&s.media_id, "none"));
}
