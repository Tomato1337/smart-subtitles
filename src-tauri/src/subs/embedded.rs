//! Subtitles stored inside the video file: the Matroska Cues are read once, then only the blocks
//! of one track, so playback can start as soon as the beginning of the track has arrived.
//!
//! Cues are always fetched in time order from the first unloaded one, and new rows are only ever
//! appended at the tail, so `cue.idx` stays the start-time rank that the rest of the app keys on.

use super::{acquire, mkv, parse::RawCue, store, torrserver};
use crate::{
    llm::annotate,
    session::{self, Session},
    state::AppState,
    types::{set_state, EmbeddedState, SubsStatus},
};
use futures_util::stream::{self, StreamExt};
use reqwest::header::RANGE;
use std::{collections::HashSet, sync::Arc, time::Duration};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

/// Cues further from the resume point than this are left for the background load.
const HEAD_SECS: f64 = 600.0;
/// One read holds the block header and 4 KiB of text; a longer block is then re-read whole.
const WINDOW: u64 = 4096 + 7;
const MAX_INFO: u64 = 4096;
const MAX_TRACKS: u64 = 1 << 20;
const MAX_CUES: u64 = 16 << 20;
/// TorrServer downloads a whole torrent piece per read; this is the usual size when it does not say.
const PIECE_FALLBACK: u64 = 4 << 20;
/// A plain HTTP source has no pieces: only the block itself is transferred.
const PIECE_PLAIN: u64 = 4096;

/// The file itself: everything the reader learns before it looks at a single block.
pub struct File {
    pub seg_data: u64,
    /// Seconds per timestamp tick.
    pub scale: f64,
    /// Bytes one read in a new place costs (a torrent piece, or the read itself).
    pub piece: u64,
    pub tracks: Vec<mkv::TextTrack>,
    /// The whole Cues body, so another track's cues parse without a second read.
    pub cues_body: Vec<u8>,
}

/// The file plus the cues of one track, in time order.
pub struct Index {
    pub track: mkv::TextTrack,
    pub cues: Vec<mkv::CueRef>,
    pub file: Arc<File>,
}

impl File {
    fn index(self: &Arc<Self>, track: &mkv::TextTrack) -> Result<Index, String> {
        let cues = mkv::parse_cues(&self.cues_body, self.seg_data, track.number, self.scale);
        if cues.len() < 20 {
            return Err("у встроенных субтитров нет индекса блоков".into());
        }
        Ok(Index { track: track.clone(), cues, file: self.clone() })
    }
}

fn label(t: &mkv::TextTrack) -> String {
    let lang = t.lang.to_uppercase();
    if t.name.is_empty() { lang } else { format!("{lang} · {}", t.name) }
}

/// `ENG · US` style name of a track, for the modal and the chooser.
pub fn track_label(t: &mkv::TextTrack) -> String {
    label(t)
}

fn elem_header(b: &[u8]) -> Result<(usize, u64), String> {
    let (_, n) = mkv::vint(b, 0, true).ok_or("битый заголовок Matroska")?;
    let (size, m) = mkv::vint(b, n, false).ok_or("битый размер элемента Matroska")?;
    Ok((n + m, size))
}

async fn read_range(st: &AppState, src: &str, from: u64, len: u64) -> Result<Vec<u8>, String> {
    let to = from.saturating_add(len.max(1) - 1);
    let r = st
        .http
        .get(src)
        .header(RANGE, format!("bytes={from}-{to}"))
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if r.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err("сервер не поддерживает Range".into());
    }
    r.bytes().await.map(|b| b.to_vec()).map_err(|e| e.without_url().to_string())
}

/// Body of the element whose header starts at `at`: from the already-read head, else one header
/// read and one body read. `max` bounds the element size.
async fn body_at(st: &AppState, src: &str, at: u64, head: &[u8], max: u64) -> Result<Vec<u8>, String> {
    if let Some(buf) = head.get(at as usize..) {
        if let Ok((hn, size)) = elem_header(buf) {
            if size > 0 && size <= max {
                if let Some(body) = buf.get(hn..hn + size as usize) {
                    return Ok(body.to_vec());
                }
            }
        }
    }
    let hdr = read_range(st, src, at, 16).await?;
    let (hn, size) = elem_header(&hdr)?;
    if size == 0 || size > max {
        return Err(format!("неожиданный размер элемента Matroska: {size}"));
    }
    read_range(st, src, at + hn as u64, size).await
}

/// Reads the file header, Tracks and Cues once per session and builds the index of one track.
pub async fn index(st: &Arc<AppState>, s: &Arc<Session>, track: Option<u64>) -> Result<Arc<Index>, String> {
    if !(s.src.starts_with("http://") || s.src.starts_with("https://")) {
        return Err("встроенные субтитры бывают только у http(s)-источников".into());
    }
    let cached = s
        .embedded_index
        .get_or_init(|| async { read_index(st, s).await.map(Arc::new) })
        .await
        .clone();
    let base = cached.clone()?;
    let Some(track) = track else { return Ok(base) };
    if base.track.number == track {
        return Ok(base);
    }
    let Some(t) = base.file.tracks.iter().find(|t| t.number == track) else {
        return Err("в файле нет такой дорожки субтитров".into());
    };
    base.file.index(t).map(Arc::new)
}

async fn read_index(st: &Arc<AppState>, s: &Arc<Session>) -> Result<Index, String> {
    let head_bytes = read_range(st, &s.src, 0, 64 * 1024).await?;
    let mut head = mkv::parse_head(&head_bytes).map_err(|e| e.to_string())?;
    if head.cues.is_none() {
        // The first SeekHead can name a second one deeper in the file.
        if let Some(more) = head.more {
            let body = body_at(st, &s.src, more, &head_bytes, MAX_INFO).await?;
            mkv::merge_seek_head(&mut head, &body);
        }
    }
    let scale = match head.info {
        Some((at, _)) => mkv::parse_scale(&body_at(st, &s.src, at, &head_bytes, MAX_INFO).await?),
        None => mkv::parse_scale(&[]),
    };
    let tracks = match head.tracks {
        Some((at, _)) => mkv::parse_tracks(&body_at(st, &s.src, at, &head_bytes, MAX_TRACKS).await?),
        None => vec![],
    };
    let english = mkv::pick_track(&tracks);
    let Some(best) = english.first().map(|t| t.number) else {
        return Err("в файле нет встроенных английских субтитров".into());
    };
    let (at, _) = head.cues.ok_or("в файле нет индекса Cues")?;
    let cues_body = body_at(st, &s.src, at, &head_bytes, MAX_CUES).await?;
    let piece = if torrserver::target(&s.src).is_some() {
        torrserver::piece_length(st, &s.src).await.unwrap_or(PIECE_FALLBACK)
    } else {
        PIECE_PLAIN
    };
    let file = Arc::new(File { seg_data: head.seg_data, scale, piece, tracks, cues_body });
    let best = file.tracks.iter().find(|t| t.number == best).ok_or("в файле нет встроенных английских субтитров")?;
    file.index(best)
}

/// Bytes one full load costs and bytes the part before `until` costs: one torrent piece per
/// distinct piece the cue positions touch.
pub fn estimate(cues: &[mkv::CueRef], from: usize, until: f64, piece: u64) -> (u64, u64) {
    let piece = piece.max(1);
    let (mut all, mut head): (HashSet<u64>, HashSet<u64>) = (HashSet::new(), HashSet::new());
    for c in cues.iter().skip(from) {
        let p = (c.cluster + c.rel) / piece;
        all.insert(p);
        if c.time < until {
            head.insert(p);
        }
    }
    (all.len() as u64 * piece, head.len() as u64 * piece)
}

/// Where the film may start: cues up to `HEAD_SECS` after the resume point, but not past the track.
async fn head_until(st: &AppState, s: &Session, idx: &Index) -> f64 {
    let mid = s.media_id.clone();
    let last: f64 = st
        .db(move |c| c.query_row("SELECT last_position FROM media WHERE id=?1", [&mid], |r| r.get(0)))
        .await
        .unwrap_or(0.0);
    let duration = s.probe.get().map(|p| p.duration).unwrap_or(0.0);
    let resume = session::resume_position(last, s.req.resume_at, duration);
    let end = idx.cues.last().map(|c| c.time).unwrap_or(0.0);
    (resume + HEAD_SECS).min(end)
}

fn state_of(idx: &Index, from: usize, head: f64) -> EmbeddedState {
    let piece = idx.file.piece;
    let (est_bytes, head_bytes) = estimate(&idx.cues, from, head, piece);
    EmbeddedState {
        phase: "loading",
        track: label(&idx.track),
        total_cues: idx.cues.len() as u32,
        loaded_cues: from as u32,
        loaded_until: idx.cues.get(from).or_else(|| idx.cues.last()).map(|c| c.time).unwrap_or(0.0),
        head_until: head,
        est_bytes,
        head_bytes,
        piece_bytes: piece,
        message: None,
    }
}

/// Asks the user before downloading, then starts reading the track from the first cue.
pub async fn start(st: &Arc<AppState>, s: &Arc<Session>, track: Option<u64>, confirmed: bool) -> Option<()> {
    let idx = match index(st, s, track).await {
        Ok(i) => i,
        Err(e) => {
            acquire::warn(st, s, e);
            return None;
        }
    };
    let head = head_until(st, s, &idx).await;
    let mut state = state_of(&idx, 0, head);
    if !confirmed {
        state.phase = "confirm";
        set_state(st, s, Some(state.clone()));
        let (tx, rx) = tokio::sync::oneshot::channel();
        *s.embedded_decision.lock().unwrap() = Some(tx);
        let accept = tokio::select! {
            answer = rx => answer.unwrap_or(false),
            _ = s.cancel.cancelled() => false,
        };
        *s.embedded_decision.lock().unwrap() = None;
        if !accept {
            // Declined: the next subtitle source gets its turn.
            set_state(st, s, None);
            return None;
        }
        state.phase = "loading";
    }
    let (mid, total, number, name) = (s.media_id.clone(), state.total_cues, idx.track.number, state.track.clone());
    // The previous load must be stopped before its cues are deleted, or it could append them to
    // the new load's table.
    s.embedded_cancel.lock().unwrap().cancel();
    if let Err(e) = st.db(move |c| store::begin_embedded(c, &mid, number, &name, total)).await {
        acquire::warn(st, s, e);
        set_state(st, s, None);
        return None;
    }
    let _ = st.app.emit("subs:offset", serde_json::json!({ "mediaId": s.media_id, "offset": 0.0 }));
    set_state(st, s, Some(state.clone()));
    acquire::status(st, SubsStatus::new(&s.media_id, "downloading").msg("встроенные субтитры"));
    spawn_load(st, s, idx, 0, head, state);
    Some(())
}

/// Continues a load the user already agreed to when the film was opened last time.
pub async fn resume(st: &Arc<AppState>, s: &Arc<Session>) {
    let mid = s.media_id.clone();
    let Some((track, next, _)) = st.db(move |c| store::embedded_progress(c, &mid)).await.ok().flatten() else { return };
    // One loader per session: a second one would append the same cues twice.
    s.embedded_cancel.lock().unwrap().cancel();
    let idx = match index(st, s, Some(track)).await {
        Ok(i) => i,
        Err(e) => {
            // The cues read so far stay usable: only the rest of the track is out of reach.
            acquire::warn(st, s, e);
            return;
        }
    };
    let from = next as usize;
    if from >= idx.cues.len() {
        set_state(st, s, None);
        return;
    }
    let head = head_until(st, s, &idx).await;
    let state = state_of(&idx, from, head);
    set_state(st, s, Some(state.clone()));
    acquire::status(st, SubsStatus::new(&s.media_id, "downloading").msg("встроенные субтитры"));
    spawn_load(st, s, idx, from, head, state);
}

fn spawn_load(st: &Arc<AppState>, s: &Arc<Session>, idx: Arc<Index>, from: usize, head: f64, state: EmbeddedState) {
    // The token is taken before the task starts, so a subtitle source that takes over between the
    // spawn and the task's first poll can still stop this load.
    let token = s.cancel.child_token();
    let old = std::mem::replace(&mut *s.embedded_cancel.lock().unwrap(), token.clone());
    old.cancel();
    let (st, s) = (st.clone(), s.clone());
    tauri::async_runtime::spawn(async move { load(st, s, idx, from, head, state, token).await });
}

/// End time of a cue: its own duration added to the start, else the block's, else up to the next
/// cue but no more than five seconds. A zero duration counts as none.
fn cue_end(start: f64, duration: Option<f64>, next: Option<f64>) -> f64 {
    duration
        .filter(|d| *d > 0.0)
        .map(|d| start + d)
        .unwrap_or_else(|| next.map(|n| n.min(start + 5.0)).unwrap_or(start + 5.0))
}

/// One fetched line: the text and the block's own duration when it carries one.
struct Fetched {
    text: String,
    dur: Option<f64>,
}

/// The window read, and one exact re-read when the block is longer than the window.
async fn fetch_once(st: &AppState, s: &Session, idx: &Index, cue: &mkv::CueRef) -> Result<Fetched, String> {
    let track = idx.track.number;
    let base = cue.cluster + cue.rel;
    let win = read_range(st, &s.src, base + 5, WINDOW).await?;
    if let Some((_, dur, text)) = mkv::block_in_window(&win, track) {
        return Ok(Fetched { text, dur: dur.map(|d| d as f64 * idx.file.scale) });
    }
    // Either the text did not fit the window, or the position holds something else entirely.
    let Some((l, total)) = mkv::block_span(&win, track) else {
        return Err("блок субтитров не найден".into());
    };
    let exact = read_range(st, &s.src, cue.cluster + 4 + l as u64 + cue.rel, total).await?;
    let Some((_, dur, text)) = mkv::block_in_window(&exact, track) else {
        return Err("блок субтитров не прочитан".into());
    };
    Ok(Fetched { text, dur: dur.map(|d| d as f64 * idx.file.scale) })
}

async fn fetch(st: &AppState, s: &Session, idx: &Index, cue: &mkv::CueRef) -> Result<Fetched, String> {
    let mut last = String::new();
    for attempt in 0..3u64 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(attempt)).await;
        }
        match fetch_once(st, s, idx, cue).await {
            Ok(f) => return Ok(f),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Loads the track in time order: the head of the film first with a wider parallelism, the rest
/// slower so the video stream keeps its bandwidth. Every batch of `annotate::BATCH` cues is stored.
async fn load(st: Arc<AppState>, s: Arc<Session>, idx: Arc<Index>, from: usize, head: f64, mut state: EmbeddedState, token: CancellationToken) {
    let split = (from..idx.cues.len()).find(|i| idx.cues[*i].time >= head).unwrap_or(idx.cues.len());
    let (mut buf, mut first) = (Vec::new(), true);
    for (range, width) in [((from, split), 8usize), ((split, idx.cues.len()), 4usize)] {
        if range.0 >= range.1 {
            continue;
        }
        let (st2, s2, idx2) = (st.clone(), s.clone(), idx.clone());
        let mut lines = stream::iter(range.0..range.1)
            .map(move |i| {
                let (st, s, idx) = (st2.clone(), s2.clone(), idx2.clone());
                async move { (i, fetch(&st, &s, &idx, &idx.cues[i]).await) }
            })
            .buffered(width);
        loop {
            let next = tokio::select! {
                // Cancellation first: a ready line must not win over a stop.
                biased;
                _ = token.cancelled() => return,
                n = lines.next() => n,
            };
            let Some((i, got)) = next else { break };
            let got = match got {
                Ok(f) => f,
                Err(e) => {
                    fail(&st, &s, &mut state, e).await;
                    return;
                }
            };
            let cue = &idx.cues[i];
            let end = cue_end(cue.time, cue.duration.or(got.dur), idx.cues.get(i + 1).map(|n| n.time));
            buf.push(RawCue { start: cue.time, end, text: got.text });
            state.loaded_cues = (i + 1) as u32;
            state.loaded_until = idx.cues.get(i + 1).map(|c| c.time).unwrap_or(head);
            // A full batch, the end of the head (the film may start), or the end of the track.
            if buf.len() >= annotate::BATCH as usize || i + 1 == range.1 || i + 1 == idx.cues.len() {
                match flush(&st, &s, &idx, &token, &mut buf, &mut state, &mut first).await {
                    Ok(true) => {}
                    Ok(false) => return,
                    Err(e) => {
                        fail(&st, &s, &mut state, e).await;
                        return;
                    }
                }
            }
        }
    }
    if !buf.is_empty() {
        match flush(&st, &s, &idx, &token, &mut buf, &mut state, &mut first).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(e) => {
                fail(&st, &s, &mut state, e).await;
                return;
            }
        }
    }
    if token.is_cancelled() {
        return;
    }
    // A whole track with nothing stored means the blocks were not text we could read: saying
    // "done" would leave the film without subtitles and without an explanation.
    let mid = s.media_id.clone();
    let stored: i64 = st
        .db(move |c| c.query_row("SELECT count(*) FROM cue WHERE media_id=?1", [&mid], |r| r.get(0)))
        .await
        .unwrap_or(0);
    if stored == 0 && idx.cues.len() >= 8 {
        fail(&st, &s, &mut state, "в блоках дорожки нет читаемого текста".into()).await;
        return;
    }
    state.phase = "done";
    state.loaded_cues = idx.cues.len() as u32;
    state.loaded_until = s.probe.get().map(|p| p.duration).filter(|d| *d > 0.0).unwrap_or(state.head_until);
    set_state(&st, &s, Some(state.clone()));
    // The last batch may have been stored earlier: tell the analysis that nothing more is coming.
    s.cues_grew.notify_one();
    annotate::emit_status(&st, &s.media_id).await;
}

/// Stores the accumulated cues; every batch makes the analysis read the longer script. `false`
/// means the cue table is no longer this load's (another source or track took over).
async fn flush(
    st: &Arc<AppState>,
    s: &Arc<Session>,
    idx: &Index,
    token: &CancellationToken,
    buf: &mut Vec<RawCue>,
    state: &mut EmbeddedState,
    first: &mut bool,
) -> Result<bool, String> {
    if token.is_cancelled() {
        return Ok(false);
    }
    let cues = store::normalize(std::mem::take(buf));
    let mid = s.media_id.clone();
    let next = state.loaded_cues;
    let track = idx.track.number;
    if !st.db(move |c| store::append_cues(c, &mid, track, &cues, next)).await? {
        return Ok(false);
    }
    // The prompt prefix carries the whole script, so it must be rebuilt from the longer cue list.
    *s.prefix.lock().unwrap() = None;
    s.cues_grew.notify_one();
    let _ = st.app.emit("subs:updated", serde_json::json!({ "mediaId": s.media_id }));
    set_state(st, s, Some(state.clone()));
    if *first && state.loaded_cues > 0 {
        *first = false;
        let mut e = SubsStatus::new(&s.media_id, "ready");
        e.source = Some("embedded");
        e.exact = Some(true);
        acquire::status(st, e);
        annotate::restart(st, s);
    }
    Ok(true)
}

async fn fail(st: &Arc<AppState>, s: &Arc<Session>, state: &mut EmbeddedState, e: String) {
    state.phase = "failed";
    state.message = Some(format!("загрузка прервана: {e}"));
    set_state(st, s, Some(state.clone()));
    acquire::warn(st, s, format!("загрузка встроенных субтитров: {e}"));
    // Nothing more will arrive: let the scheduler re-read the counters instead of waiting forever.
    s.cues_grew.notify_one();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(time: f64, cluster: u64, rel: u64) -> mkv::CueRef {
        mkv::CueRef { time, duration: None, cluster, rel }
    }

    #[test]
    fn estimate_counts_distinct_pieces() {
        let cues = vec![cue(1.0, 0, 0), cue(2.0, 100, 0), cue(3.0, 4096 * 2 + 10, 0), cue(4.0, 4096 * 3, 0)];
        // Pieces 0, 0, 2 and 3 for the whole track; 0 and 2 for the first three cues.
        assert_eq!(estimate(&cues, 0, 3.5, 4096), (4096 * 3, 4096 * 2));
        assert_eq!(estimate(&cues, 2, 10.0, 4096), (4096 * 2, 4096 * 2));
        assert_eq!(estimate(&[], 0, 10.0, 4096), (0, 0));
    }

    #[test]
    fn cue_end_adds_the_duration_to_the_start() {
        // A real cue of the test film: start 83.208 s, CueDuration 1250 ticks (1.25 s), next at 84.459 s.
        assert!((cue_end(83.208, Some(1.25), Some(84.459)) - 84.458).abs() < 1e-9);
        // No duration: up to the next cue, but never more than five seconds.
        assert_eq!(cue_end(10.0, None, Some(12.5)), 12.5);
        assert_eq!(cue_end(10.0, None, Some(100.0)), 15.0);
        assert_eq!(cue_end(10.0, None, None), 15.0);
        // A zero duration is no duration at all.
        assert_eq!(cue_end(10.0, Some(0.0), Some(11.0)), 11.0);
    }
}
