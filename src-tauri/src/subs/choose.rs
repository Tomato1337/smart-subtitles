//! The subtitle chooser: every English candidate the sources offer, and switching to one of them.

use super::{acquire, embedded, mkv, opensubtitles as os, parse, sidecar, store, torrserver};
use crate::{
    session::Session,
    state::AppState,
    types::{CandidateEntry, SourceNote, SubCandidate, SubsCandidates},
};
use std::sync::Arc;

fn note(source: &'static str, message: String) -> SourceNote { SourceNote { source, message } }

fn entry(candidate: SubCandidate) -> CandidateEntry { CandidateEntry { key: candidate.key(), candidate } }

/// Every English candidate for this film, grouped in a fixed order (TorrServer → Lampa → OpenSubtitles);
/// a source that was tried but gave nothing leaves a note instead of a group. The order in
/// `subtitles.sources` does not matter here: the dialog shows what exists, automatic search picks.
pub async fn candidates(st: &Arc<AppState>, s: &Arc<Session>) -> Result<SubsCandidates, String> {
    let mut side = sidecar_candidates(s);
    let (mut tor, mut emb, mut osr) = tokio::join!(
        torrserver_candidates(st, s),
        embedded_candidates(st, s),
        opensubtitles_candidates(st, s)
    );
    let mut items = Vec::new();
    let mut notes = Vec::new();
    for (list, why) in [&mut tor, &mut side, &mut emb, &mut osr] {
        items.append(list);
        notes.append(why);
    }
    let mid = s.media_id.clone();
    let (active_key, active_label) = match st.db(move |c| store::active(c, &mid)).await? {
        Some((key, label)) => (key, Some(label)),
        None => (None, None),
    };
    Ok(SubsCandidates { active_key, active_label, items, notes })
}

async fn torrserver_candidates(st: &Arc<AppState>, s: &Arc<Session>) -> (Vec<CandidateEntry>, Vec<SourceNote>) {
    let Some(t) = torrserver::target(&s.src) else { return Default::default() };
    let tracks = match torrserver::list(st, &t).await {
        Ok(v) => v,
        Err(e) => return (Vec::new(), vec![note("torrserver", format!("TorrServer не отдал список: {e}"))]),
    };
    let items: Vec<CandidateEntry> = tracks
        .into_iter()
        .filter(|t| t.lang == "en" || t.lang == "und")
        .map(|t| entry(SubCandidate::Torrserver { track: t.index, title: t.title, lang: t.lang }))
        .collect();
    if items.is_empty() {
        return (items, vec![note("torrserver", "в раздаче нет английских субтитров".into())]);
    }
    (items, Vec::new())
}

/// Every English text track of the video file; the sizes are what reading them would download.
async fn embedded_candidates(st: &Arc<AppState>, s: &Arc<Session>) -> (Vec<CandidateEntry>, Vec<SourceNote>) {
    let idx = match embedded::index(st, s, None).await {
        Ok(i) => i,
        Err(e) => return (Vec::new(), vec![note("embedded", e)]),
    };
    let (mut items, mut notes) = (Vec::new(), Vec::new());
    for t in mkv::pick_track(&idx.file.tracks) {
        let cues = if t.number == idx.track.number {
            idx.cues.clone()
        } else {
            mkv::parse_cues(&idx.file.cues_body, idx.file.seg_data, t.number, idx.file.scale)
        };
        if cues.len() < 20 {
            continue;
        }
        let (bytes, _) = embedded::estimate(&cues, 0, f64::MAX, idx.file.piece);
        items.push(entry(SubCandidate::Embedded {
            track: t.number,
            title: embedded::track_label(t),
            cues: cues.len() as u32,
            bytes,
        }));
    }
    if items.is_empty() {
        notes.push(note("embedded", "в файле нет английских субтитров с индексом блоков".into()));
    }
    (items, notes)
}

fn sidecar_candidates(s: &Session) -> (Vec<CandidateEntry>, Vec<SourceNote>) {
    let refs = &s.req.subtitles;
    if refs.is_empty() {
        return Default::default();
    }
    let mut cands: Vec<_> = refs.iter().filter(|r| sidecar::is_english_ref(&r.label, &r.url)).collect();
    if cands.is_empty() && refs.len() == 1 {
        cands.push(&refs[0]);
    }
    if cands.is_empty() {
        return (Vec::new(), vec![note("sidecar", "среди субтитров от Lampa нет английских".into())]);
    }
    let items = cands
        .into_iter()
        .map(|r| entry(SubCandidate::Sidecar { url: r.url.clone(), label: r.label.clone() }))
        .collect();
    (items, Vec::new())
}

async fn opensubtitles_candidates(st: &Arc<AppState>, s: &Arc<Session>) -> (Vec<CandidateEntry>, Vec<SourceNote>) {
    if !st.cfg().opensubtitles_enabled() {
        return (Vec::new(), vec![note("opensubtitles", "OpenSubtitles не настроен".into())]);
    }
    let hits = match os::search(st, s).await {
        Ok(h) => h,
        Err(e) => {
            crate::logs::log("app", &format!("opensubtitles: {e}"));
            return (Vec::new(), vec![note("opensubtitles", format!("ошибка поиска: {e}"))]);
        }
    };
    if hits.is_empty() {
        return (Vec::new(), vec![note("opensubtitles", "ничего не найдено".into())]);
    }
    let items = hits
        .into_iter()
        .map(|h| {
            let cached = os::cache_path(h.file_id).exists();
            entry(SubCandidate::Opensubtitles {
                file_id: h.file_id,
                release: h.release,
                exact: h.exact,
                hearing_impaired: h.hearing_impaired,
                downloads: h.downloads,
                cached,
            })
        })
        .collect();
    (items, Vec::new())
}

/// Installs the chosen candidate, replacing the cues and dropping the analysis of the old ones.
pub async fn select(st: &Arc<AppState>, s: &Arc<Session>, c: SubCandidate) -> Result<(), String> {
    let key = c.key();
    let (kind, label, exact, bytes) = match &c {
        SubCandidate::Torrserver { track, title, .. } => {
            let t = torrserver::target(&s.src).ok_or_else(|| "это видео не из TorrServer".to_string())?;
            let bytes = torrserver::fetch(st, &t, *track).await.map_err(|e| format!("TorrServer: {e}"))?;
            ("sidecar", format!("TorrServer: {title}"), true, bytes)
        }
        SubCandidate::Sidecar { url, label } => {
            if !s.req.subtitles.iter().any(|r| &r.url == url) {
                return Err("этого файла нет среди субтитров от Lampa".into());
            }
            let bytes = sidecar::read_ref(st, url).await.map_err(|e| format!("субтитры от Lampa: {e}"))?;
            ("sidecar", label.clone(), true, bytes)
        }
        SubCandidate::Opensubtitles { file_id, release, exact, .. } => {
            if !st.cfg().opensubtitles_enabled() {
                return Err("OpenSubtitles не настроен".into());
            }
            let bytes = match os::download(st, *file_id).await {
                Ok(os::Download::Bytes(b)) => b,
                Ok(os::Download::QuotaExhausted) => return Err("дневной лимит OpenSubtitles исчерпан".into()),
                Err(e) => return Err(format!("OpenSubtitles: {e}")),
            };
            ("opensubtitles", release.clone(), *exact, bytes)
        }
        // Choosing a track here is the user's consent: no confirmation modal, no `install`.
        SubCandidate::Embedded { track, .. } => {
            return match embedded::start(st, s, Some(*track), true).await {
                Some(()) => Ok(()),
                None => Err("встроенные субтитры недоступны".into()),
            };
        }
    };
    let text = parse::decode(&bytes);
    let path = acquire::save_cache(s, &key, &text).await;
    acquire::install(st, s, kind, label, exact, key, path, text).await.map(|_| ())
}
