use super::{embedded, local, opensubtitles as os, parse, sidecar, store, torrserver};
use crate::{notify::{self, Level}, session::Session, state::AppState, types::SubsStatus};
use sha1::{Digest, Sha1};
use std::{path::PathBuf, sync::Arc};
use tauri::Emitter;

pub(super) fn status(st: &AppState, e: SubsStatus) { let _ = st.app.emit("subs:status", e); }

/// A source in the chain gave nothing: a persistent warning naming the film, unless the film was closed.
pub(super) fn warn(st: &AppState, s: &Session, why: impl std::fmt::Display) {
    if s.cancel.is_cancelled() { return; }
    let title = s.req.card.as_ref().map(|c| c.title.as_str()).filter(|t| !t.is_empty()).unwrap_or(&s.req.title);
    let _ = notify::push(st, Level::Warn, format!("Субтитры «{title}»: {why}"));
}

fn cache_file(media_id: &str, key: &str, ext: &str) -> PathBuf {
    let name = hex::encode(Sha1::digest(format!("{media_id}\n{key}").as_bytes()));
    crate::config::cache_dir().join("subs").join(format!("{name}.{ext}"))
}

/// Parses, normalizes and stores subtitles for the session's media, then announces them.
/// `key` is `SubCandidate::key` (or `file:{path}` for a manual file) and becomes `subtitle_source.ref`.
pub async fn install(
    st: &Arc<AppState>,
    s: &Arc<Session>,
    kind: &'static str,
    label: String,
    exact: bool,
    key: String,
    path: PathBuf,
    text: String,
) -> Result<usize, String> {
    let cues = store::normalize(parse::parse(&text));
    if cues.is_empty() {
        return Err("в файле нет реплик".into());
    }
    // Another cue set ends any embedded load: the running loader must not append to it.
    s.embedded_cancel.lock().unwrap().cancel();
    let n = cues.len();
    let (mid, p) = (s.media_id.clone(), path.to_string_lossy().into_owned());
    st.db(move |c| {
        store::replace_cues(c, &mid, &cues)?;
        // A new cue set means a new analysis: drop the old consent so the estimate dialog is shown again.
        c.execute("UPDATE media SET annot=NULL WHERE id=?1", rusqlite::params![mid])?;
        // The manual shift belongs to the old file; the auto-sync recomputes one for the new subtitles.
        c.execute("UPDATE media SET sub_offset=0 WHERE id=?1", rusqlite::params![mid])?;
        store::set_source(c, &mid, kind, &label, exact, &p, &key)
    })
    .await?;
    // `replace_cues` just dropped the embedded_load row, so nothing is being loaded any more.
    crate::types::set_state(st, s, None);
    let mut e = SubsStatus::new(&s.media_id, "ready");
    e.source = Some(kind);
    e.exact = Some(exact);
    status(st, e);
    let _ = st.app.emit("subs:offset", serde_json::json!({ "mediaId": s.media_id, "offset": 0.0 }));
    let _ = st.app.emit("subs:updated", serde_json::json!({ "mediaId": s.media_id }));
    crate::llm::annotate::restart(st, s);
    // A track of the video file itself is already in time with it.
    if kind != "embedded" {
        super::sync::spawn(st, s);
    }
    Ok(n)
}

pub(super) async fn save_cache(s: &Session, key: &str, text: &str) -> PathBuf {
    let ext = match parse::sniff(text) { parse::Format::Vtt => "vtt", parse::Format::Ass => "ass", parse::Format::Srt => "srt" };
    let p = cache_file(&s.media_id, key, ext);
    if let Some(d) = p.parent() { let _ = tokio::fs::create_dir_all(d).await; }
    let _ = tokio::fs::write(&p, text).await;
    p
}

/// Silent when Lampa passed no subtitle files; warns when the files it passed were unusable.
async fn try_sidecar(st: &Arc<AppState>, s: &Arc<Session>) -> Option<()> {
    let refs = &s.req.subtitles;
    if refs.is_empty() { return None; }
    let mut cands: Vec<_> = refs.iter().filter(|r| sidecar::is_english_ref(&r.label, &r.url)).collect();
    let lone_unlabelled = cands.is_empty() && refs.len() == 1;
    if lone_unlabelled { cands.push(&refs[0]); }
    if cands.is_empty() {
        warn(st, s, "среди субтитров от Lampa нет английских");
        return None;
    }
    let mut last = None;
    for r in cands {
        let bytes = match sidecar::read_ref(st, &r.url).await {
            Ok(b) => b,
            Err(e) => { last = Some(e.to_string()); continue; }
        };
        let text = parse::decode(&bytes);
        if lone_unlabelled && !sidecar::looks_english(&text) { continue; }
        let key = format!("sidecar:{}", r.url);
        let path = save_cache(s, &key, &text).await;
        match install(st, s, "sidecar", r.label.clone(), true, key, path, text).await {
            Ok(_) => return Some(()),
            Err(e) => last = Some(e),
        }
    }
    warn(st, s, match last {
        Some(e) => format!("субтитры от Lampa не загрузились: {e}"),
        None => "субтитры от Lampa оказались не английскими".into(),
    });
    None
}

/// Silent for non-TorrServer sources; warns when the server failed or the torrent has no usable English file.
async fn try_torrserver(st: &Arc<AppState>, s: &Arc<Session>) -> Option<()> {
    let t = torrserver::target(&s.src)?;
    let tracks = match torrserver::list(st, &t).await {
        Ok(v) => v,
        Err(e) => {
            crate::logs::log("app", &format!("torrserver subs: {e}"));
            warn(st, s, format!("TorrServer не отдал список субтитров: {e}"));
            return None;
        }
    };
    let (cands, lone_und) = torrserver::pick(&tracks);
    if cands.is_empty() {
        warn(st, s, "в раздаче TorrServer нет английских субтитров");
        return None;
    }
    let mut last = None;
    for tr in cands {
        if s.cancel.is_cancelled() {
            return None;
        }
        status(st, SubsStatus::new(&s.media_id, "downloading").msg("TorrServer"));
        let bytes = match torrserver::fetch(st, &t, tr.index).await {
            Ok(b) => b,
            Err(e) => {
                crate::logs::log("app", &format!("torrserver subs: {e}"));
                last = Some(e.to_string());
                continue;
            }
        };
        let text = parse::decode(&bytes);
        if lone_und && !sidecar::looks_english(&text) {
            continue;
        }
        let key = format!("torrserver:{}", tr.index);
        let path = save_cache(s, &key, &text).await;
        match install(st, s, "sidecar", format!("TorrServer: {}", tr.title), true, key, path, text).await {
            Ok(_) => return Some(()),
            Err(e) => last = Some(e),
        }
    }
    warn(st, s, match last {
        Some(e) => format!("субтитры из TorrServer не загрузились: {e}"),
        None => "единственные субтитры в раздаче TorrServer не английские".into(),
    });
    None
}

async fn try_opensubtitles(st: &Arc<AppState>, s: &Arc<Session>) -> Option<()> {
    if !st.cfg().opensubtitles_enabled() {
        warn(st, s, "OpenSubtitles не настроен (Настройки → «Субтитры (OpenSubtitles)»)");
        return None;
    }
    status(st, SubsStatus::new(&s.media_id, "downloading").msg("OpenSubtitles"));
    match os::fetch(st, s).await {
        Ok(os::Outcome::Found(f)) => {
            let text = parse::decode(&f.bytes);
            let key = format!("opensubtitles:{}", f.file_id);
            let path = save_cache(s, &key, &text).await;
            match install(st, s, "opensubtitles", f.label, f.exact, key, path, text).await {
                Ok(_) => Some(()),
                Err(e) => { warn(st, s, format!("файл с OpenSubtitles не подошёл: {e}")); None }
            }
        }
        Ok(os::Outcome::QuotaExhausted) => {
            status(st, SubsStatus::new(&s.media_id, "searching").msg("лимит OpenSubtitles исчерпан"));
            warn(st, s, "дневной лимит OpenSubtitles исчерпан");
            None
        }
        Ok(os::Outcome::NotFound) => {
            warn(st, s, "на OpenSubtitles не найдены");
            None
        }
        Err(e) => {
            crate::logs::log("app", &format!("opensubtitles: {e}"));
            warn(st, s, format!("ошибка OpenSubtitles: {e}"));
            None
        }
    }
}

/// Tries the sources from `subtitles.sources` in order (the video itself is never downloaded for subtitles); a stored result for this media short-circuits everything.
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
        e.source = Some(match kind.as_str() { "sidecar" => "sidecar", "embedded" => "embedded", _ => "opensubtitles" });
        e.exact = Some(exact);
        status(&st, e);
        let _ = st.app.emit("subs:updated", serde_json::json!({ "mediaId": s.media_id }));
        crate::llm::annotate::restart(&st, &s);
        if kind == "embedded" {
            // A half-read track continues where it stopped: the row is the earlier consent.
            let mid = s.media_id.clone();
            let more = st
                .db(move |c| store::embedded_progress(c, &mid))
                .await
                .ok()
                .flatten()
                .is_some_and(|(_, next, total)| next < total);
            if more {
                embedded::resume(&st, &s).await;
            }
        } else {
            // The embedded track needs no timing check: it comes from the same file as the video.
            super::sync::spawn(&st, &s);
        }
        return;
    }

    status(&st, SubsStatus::new(&s.media_id, "searching"));
    let cfg = st.cfg();
    for id in &cfg.subtitles.sources {
        let got = match id.as_str() {
            "torrserver" => try_torrserver(&st, &s).await,
            "sidecar" => try_sidecar(&st, &s).await,
            "embedded" => match local::path(&s.src) {
                Some(file) => local::start(&st, &s, &file).await,
                None => embedded::start(&st, &s, None, false).await,
            },
            "opensubtitles" => try_opensubtitles(&st, &s).await,
            _ => None,
        };
        if got.is_some() || s.cancel.is_cancelled() {
            return;
        }
    }
    if s.cancel.is_cancelled() { return; }
    status(&st, SubsStatus::new(&s.media_id, "none"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_file_is_per_candidate() {
        let a = cache_file("ts:abc:1", "torrserver:2", "srt");
        let b = cache_file("ts:abc:1", "opensubtitles:1234", "srt");
        assert_ne!(a, b);
        assert_eq!(a, cache_file("ts:abc:1", "torrserver:2", "srt"));
        assert_eq!(a.extension().and_then(|e| e.to_str()), Some("srt"));
        assert_ne!(a, cache_file("ts:other:1", "torrserver:2", "srt"));
    }
}
