use super::{client, prompts};
use crate::{patterns, session::Session, state::AppState, types::*};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::json;
use std::{collections::HashSet, sync::{atomic::Ordering, Arc, Mutex}};
use tauri::Emitter;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub const BATCH: u32 = 40;
const KINDS: [&str; 6] = ["idiom", "phrasal_verb", "collocation", "slang", "reduction", "grammar"];

#[derive(Deserialize, Default)]
struct RawChunk { #[serde(default)] text: String, #[serde(default)] kind: String, #[serde(default)] ru: String }
#[derive(Deserialize, Default)]
struct RawPattern { #[serde(default)] id: String, #[serde(default)] text: String }
#[derive(Deserialize, Default)]
struct RawCue {
    i: u32,
    #[serde(default)] en: String,
    #[serde(default)] ru: String,
    #[serde(default)] chunks: Vec<RawChunk>,
    #[serde(default)] patterns: Vec<RawPattern>,
}
#[derive(Deserialize, Default)]
struct RawBatch { #[serde(default)] cues: Vec<RawCue> }

fn lower_chars(s: &str) -> Vec<char> {
    s.chars().map(|c| { let mut l = c.to_lowercase(); match (l.next(), l.next()) { (Some(x), None) => x, _ => c } }).collect()
}

/// Case-insensitive search for `needle` in `hay` from char index `from`; returns char range.
fn find_chars(hay: &[char], needle: &[char], from: usize) -> Option<(usize, usize)> {
    if needle.is_empty() || hay.len() < needle.len() { return None; }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle).map(|i| (i, i + needle.len()))
}

/// UTF-16 offset of every char index (the frontend indexes strings in UTF-16 code units).
fn utf16_offsets(text: &str) -> Vec<u32> {
    let mut v = Vec::with_capacity(text.chars().count() + 1);
    let mut o = 0u32;
    for c in text.chars() { v.push(o); o += c.len_utf16() as u32; }
    v.push(o);
    v
}

/// Lowercased alphanumeric words: line breaks, dashes and punctuation do not affect matching.
fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric() && c != '\'').filter(|w| !w.is_empty()).map(str::to_lowercase).collect()
}

/// The model's echo of the English text identifies the cue; `i` alone drifts inside a long script.
fn same_text(echo: &str, text: &str) -> bool {
    let (a, b) = (words(echo), words(text));
    if a.is_empty() || b.is_empty() { return false; }
    let common = a.iter().filter(|w| b.contains(w)).count();
    common * 5 >= a.len().max(b.len()) * 4
}

fn process(cues: &[(u32, String)], raw: RawBatch) -> Vec<CueAnnotation> {
    let mut out: Vec<CueAnnotation> = vec![];
    for rc in raw.cues {
        let by_idx = cues.iter().find(|(i, t)| *i == rc.i && same_text(&rc.en, t));
        let Some((idx, text)) = by_idx.or_else(|| cues.iter().find(|(_, t)| same_text(&rc.en, t))) else { continue };
        if rc.ru.trim().is_empty() || out.iter().any(|a| a.idx == *idx) { continue; }
        let idx = *idx;
        let hay = lower_chars(text);
        let orig: Vec<char> = text.chars().collect();
        let off = utf16_offsets(text);

        let mut chunks = vec![];
        let mut cursor = 0usize;
        let mut seen = HashSet::new();
        for c in rc.chunks.iter().take(12) {
            let kind = c.kind.replace(' ', "_").to_lowercase();
            if !KINDS.contains(&kind.as_str()) || c.ru.trim().is_empty() { continue; }
            let Some((a, b)) = find_chars(&hay, &lower_chars(c.text.trim()), cursor) else { continue };
            cursor = b;
            if !seen.insert(off[a]) { continue; }
            chunks.push(Chunk { start_char: off[a], end_char: off[b], text: orig[a..b].iter().collect(), kind, ru: c.ru.trim().to_string() });
            if chunks.len() == 4 { break; }
        }
        let mut pats: Vec<CuePattern> = vec![];
        for p in &rc.patterns {
            if patterns::get(&p.id).is_none() || pats.iter().any(|x| x.pattern_id == p.id) { continue; }
            let Some((a, b)) = find_chars(&hay, &lower_chars(p.text.trim()), 0) else { continue };
            pats.push(CuePattern { pattern_id: p.id.clone(), start_char: off[a], end_char: off[b] });
            if pats.len() == 3 { break; }
        }
        out.push(CueAnnotation { idx, ru: rc.ru.trim().to_string(), chunks, patterns: pats });
    }
    out
}

fn task_text(cues: &[(u32, String)], cefr_hint: &str) -> String {
    let mut lines = String::new();
    for (i, t) in cues {
        lines.push_str(&format!("[{i}] {}\n", t.replace('\n', " / ")));
    }
    format!(
        "TASK annotate exactly these cues:\n{lines}\
         Return {{\"cues\":[{{\"i\":<idx>,\"en\":\"<текст реплики из списка выше, дословно>\",\"ru\":\"<перевод именно этой реплики с учётом контекста фильма>\",\"chunks\":[{{\"text\":\"<точная подстрока реплики>\",\"kind\":\"idiom|phrasal_verb|collocation|slang|reduction|grammar\",\"ru\":\"<перевод чанка в этом контексте>\"}}],\"patterns\":[{{\"id\":\"<id из каталога>\",\"text\":\"<точная подстрока>\"}}]}}]}}. \
         Одна запись на каждую строку списка, в том же порядке; ru переводит только свою реплику, не соседние. \
         Chunks: только многословные единицы и трудные слова уровня выше {cefr_hint}; не больше 4 на реплику. Patterns: 0–3 на реплику, только id из каталога."
    )
}

fn load_missing_cues_db(
    c: &rusqlite::Connection,
    media_id: &str,
    first: u32,
) -> rusqlite::Result<(u32, Vec<(u32, String)>)> {
    let end = first + BATCH;
    let total: u32 = c.query_row(
        "SELECT count(*) FROM cue WHERE media_id=?1 AND idx>=?2 AND idx<?3",
        params![media_id, first, end],
        |r| r.get(0),
    )?;
    let cues = c
        .prepare(
            "SELECT idx,text FROM cue WHERE media_id=?1 AND idx>=?2 AND idx<?3 AND (ru IS NULL OR trim(ru)='') ORDER BY idx",
        )?
        .query_map(params![media_id, first, end], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok((total, cues))
}

fn save_batch_db(
    c: &rusqlite::Connection,
    media_id: &str,
    first: u32,
    anns: &[CueAnnotation],
) -> rusqlite::Result<u32> {
    let end = first + BATCH;
    let tx = c.unchecked_transaction()?;
    for a in anns {
        tx.execute("DELETE FROM chunk WHERE media_id=?1 AND cue_idx=?2", params![media_id, a.idx])?;
        tx.execute("DELETE FROM cue_pattern WHERE media_id=?1 AND cue_idx=?2", params![media_id, a.idx])?;
        tx.execute("UPDATE cue SET ru=?1 WHERE media_id=?2 AND idx=?3", params![a.ru, media_id, a.idx])?;
        for ch in &a.chunks {
            tx.execute(
                "INSERT OR REPLACE INTO chunk VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![media_id, a.idx, ch.start_char, ch.end_char, ch.text, ch.kind, ch.ru],
            )?;
        }
        for p in &a.patterns {
            tx.execute(
                "INSERT OR REPLACE INTO cue_pattern VALUES(?1,?2,?3,?4,?5)",
                params![media_id, a.idx, p.pattern_id, p.start_char, p.end_char],
            )?;
        }
    }
    let missing: u32 = tx.query_row(
        "SELECT count(*) FROM cue WHERE media_id=?1 AND idx>=?2 AND idx<?3 AND (ru IS NULL OR trim(ru)='')",
        params![media_id, first, end],
        |r| r.get(0),
    )?;
    let status = if missing == 0 { "done" } else { "failed" };
    tx.execute("INSERT OR REPLACE INTO annot_batch VALUES(?1,?2,?3)", params![media_id, first, status])?;
    tx.commit()?;
    Ok(missing)
}

async fn request_batch(
    st: &Arc<AppState>,
    s: &Arc<Session>,
    first: u32,
    cues: &[(u32, String)],
    cefr: &str,
    blocked: &CancellationToken,
) -> anyhow::Result<Option<Vec<CueAnnotation>>> {
    let raw: RawBatch = tokio::select! {
        r = async {
            let mut messages = (*prompts::prefix(st, s).await?).clone();
            messages.push(json!({ "role": "user", "content": task_text(cues, cefr) }));
            client::chat_json(st, super::tasks::Task::Annotate, &s.media_id, &format!("annotate {first}"), &messages, 8000).await
        } => r?,
        _ = blocked.cancelled() => return Ok(None),
    };
    Ok(Some(process(cues, raw)))
}

async fn run_batch(st: &Arc<AppState>, s: &Arc<Session>, first: u32, blocked: &CancellationToken) -> anyhow::Result<bool> {
    let mid = s.media_id.clone();
    let (total_in_batch, cues) = st
        .db(move |c| load_missing_cues_db(c, &mid, first))
        .await
        .map_err(anyhow::Error::msg)?;
    if total_in_batch == 0 {
        return Ok(true);
    }
    if cues.is_empty() {
        let mid = s.media_id.clone();
        st.db(move |c| save_batch_db(c, &mid, first, &[]))
            .await
            .map_err(anyhow::Error::msg)?;
        return Ok(true);
    }

    let cefr = st.cfg().learner.cefr.clone();
    let Some(anns) = request_batch(st, s, first, &cues, &cefr, blocked).await? else {
        return Ok(false);
    };
    if anns.is_empty() || anns.len() * 2 < cues.len() {
        if !anns.is_empty() {
            let (mid, a2) = (s.media_id.clone(), anns.clone());
            st.db(move |c| save_batch_db(c, &mid, first, &a2))
                .await
                .map_err(anyhow::Error::msg)?;
            let _ = st.app.emit("annot:updated", json!({ "mediaId": s.media_id, "cues": anns }));
        }
        anyhow::bail!("ответ не совпал с репликами: {} из {}", anns.len(), cues.len());
    }

    let (mid, a2) = (s.media_id.clone(), anns.clone());
    let mut missing = st
        .db(move |c| save_batch_db(c, &mid, first, &a2))
        .await
        .map_err(anyhow::Error::msg)?;
    let _ = st.app.emit("annot:updated", json!({ "mediaId": s.media_id, "cues": anns }));

    if missing > 0 && !blocked.is_cancelled() {
        let mid = s.media_id.clone();
        let (_, retry_cues) = st
            .db(move |c| load_missing_cues_db(c, &mid, first))
            .await
            .map_err(anyhow::Error::msg)?;
        if !retry_cues.is_empty() {
            let Some(more) = request_batch(st, s, first, &retry_cues, &cefr, blocked).await? else {
                return Ok(false);
            };
            if !more.is_empty() {
                let (mid, a3) = (s.media_id.clone(), more.clone());
                missing = st
                    .db(move |c| save_batch_db(c, &mid, first, &a3))
                    .await
                    .map_err(anyhow::Error::msg)?;
                let _ = st.app.emit("annot:updated", json!({ "mediaId": s.media_id, "cues": more }));
            }
        }
    }

    if missing > 0 {
        anyhow::bail!("неполный разбор пачки: осталось {missing} непереведённых реплик");
    }
    Ok(true)
}

#[derive(Default)]
pub struct Run {
    cancel: CancellationToken,
    blocked: CancellationToken,
    status: Mutex<(bool, Option<AnnotFailure>)>,
    emit_lock: tokio::sync::Mutex<()>,
}

fn failure(error: &anyhow::Error) -> AnnotFailure {
    if error.downcast_ref::<client::MissingKeyError>().is_some() {
        return AnnotFailure { message: "Нет API-ключа для разбора диалогов".into(), blocked: true };
    }
    let (message, blocked) = match error.downcast_ref::<client::HttpError>().map(|e| e.status.as_u16()) {
        Some(401) => ("API-ключ не принят (HTTP 401)".into(), true),
        Some(402) => ("Недостаточно средств у LLM-провайдера (HTTP 402)".into(), true),
        Some(403) => ("LLM-провайдер отказал в доступе (HTTP 403)".into(), true),
        Some(code) => (format!("Ошибка LLM-провайдера (HTTP {code})"), false),
        None if error.downcast_ref::<reqwest::Error>().is_some_and(|e| e.is_timeout()) =>
            ("LLM-провайдер не ответил вовремя".into(), false),
        None => ("Не удалось разобрать диалоги. Подробности в llm.log".into(), false),
    };
    AnnotFailure { message, blocked }
}

async fn run_batch_recorded(st: &Arc<AppState>, s: &Arc<Session>, run: &Run, first: u32) {
    match run_batch(st, s, first, &run.blocked).await {
        Ok(true) => {}
        Ok(false) => return,
        Err(e) => {
            crate::logs::log("llm", &format!("batch {first} failed: {e}"));
            let failure = failure(&e);
            {
                let mut status = run.status.lock().unwrap();
                // A concurrent transient error must not overwrite the reason the run stopped.
                if !status.1.as_ref().is_some_and(|f| f.blocked) {
                    if failure.blocked { run.blocked.cancel(); }
                    status.1 = Some(failure);
                }
            }
            let mid = s.media_id.clone();
            let _ = st.db(move |c| { c.execute("INSERT OR REPLACE INTO annot_batch VALUES(?1,?2,'failed')", params![mid, first])?; Ok(()) }).await;
            let _ = st.app.emit("annot:failed", json!({ "mediaId": s.media_id, "firstIdx": first }));
        }
    }
    emit_status_for_run(st, &s.media_id, run).await;
}

/// Batch counters of one media's analysis; no session is needed, so the home screen can ask too.
pub async fn status(st: &AppState, media_id: &str) -> Result<AnnotStatus, String> {
    let mid = media_id.to_string();
    let mut status = st.db(move |c| {
        let cues: u32 = c.query_row("SELECT count(*) FROM cue WHERE media_id=?1", [&mid], |r| r.get(0))?;
        let consent = c
            .query_row("SELECT annot FROM media WHERE id=?1", [&mid], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten();
        let mut q = c.prepare("SELECT status, count(*) FROM annot_batch WHERE media_id=?1 GROUP BY status")?;
        let rows = q.query_map([&mid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?)))?;
        let (mut done, mut failed) = (0u32, 0u32);
        for row in rows {
            let (state, n) = row?;
            if state == "done" { done = n } else { failed = n }
        }
        Ok(AnnotStatus { media_id: mid, consent, total: cues.div_ceil(BATCH), done, failed, running: false, failure: None })
    }).await?;
    if let Some(s) = st.sessions.current().filter(|s| s.media_id == media_id) {
        let run = s.annot_run.lock().unwrap();
        let current = run.status.lock().unwrap();
        status.running = current.0;
        status.failure.clone_from(&current.1);
    }
    Ok(status)
}

pub async fn emit_status(st: &AppState, media_id: &str) {
    if let Ok(x) = status(st, media_id).await { let _ = st.app.emit("annot:progress", x); }
}

async fn emit_status_for_run(st: &AppState, media_id: &str, run: &Run) {
    let _guard = tokio::select! {
        g = run.emit_lock.lock() => g,
        _ = run.cancel.cancelled() => return,
    };
    if run.cancel.is_cancelled() { return; }
    let res = tokio::select! {
        r = status(st, media_id) => r,
        _ = run.cancel.cancelled() => return,
    };
    let Ok(x) = res else { return };
    if !run.cancel.is_cancelled() {
        let _ = st.app.emit("annot:progress", x);
    }
}

/// Calibrated on real usage logs: prompt tokens / prompt chars ≈ 2.8 (script-heavy, digits and brackets tokenize densely).
const CHARS_PER_TOKEN: f64 = 2.8;
/// Mean completion over 209 logged batches: 2 832 tokens per 40 cues.
const OUT_TOKENS_PER_CUE: u64 = 72;

fn est_tokens(s: &str) -> u64 { (s.chars().count() as f64 / CHARS_PER_TOKEN).ceil() as u64 }

/// `batches`: (cue count, task tokens) of every batch still to run. The first request pays the
/// whole prefix; the others read it from the provider's prefix cache.
fn estimate_from(prefix_tokens: u64, batches: &[(u32, u64)]) -> AnnotEstimate {
    let cues: u32 = batches.iter().map(|(c, _)| *c).sum();
    let input_tokens: u64 = batches.iter().map(|(_, t)| prefix_tokens + t).sum();
    let cached_tokens = prefix_tokens.saturating_mul(batches.len().saturating_sub(1) as u64);
    AnnotEstimate { cues, batches: batches.len() as u32, input_tokens, cached_tokens, output_tokens: cues as u64 * OUT_TOKENS_PER_CUE, partial: false }
}

/// Estimate of the remaining analysis, without a single LLM request.
pub async fn estimate(st: &Arc<AppState>, s: &Arc<Session>) -> Result<AnnotEstimate, String> {
    let mid = s.media_id.clone();
    let (cues, done, progress): (Vec<(u32, String)>, HashSet<u32>, Option<(u32, u32)>) = st
        .db(move |c| {
            let cues = c.prepare("SELECT idx,text FROM cue WHERE media_id=?1 ORDER BY idx")?.query_map([&mid], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
            let done = c.prepare("SELECT first_idx FROM annot_batch WHERE media_id=?1 AND status='done'")?.query_map([&mid], |r| r.get(0))?.collect::<Result<HashSet<u32>, _>>()?;
            // (stored cues, cues in the whole track) while the video file is still being read.
            let progress = crate::subs::store::embedded_progress(c, &mid)?.map(|(_, next, total)| (next, total));
            Ok((cues, done, progress))
        })
        .await?;
    let cefr = st.cfg().learner.cefr.clone();
    let mut batches = vec![];
    for first in (0..cues.len()).step_by(BATCH as usize) {
        if done.contains(&(first as u32)) { continue; }
        let slice = &cues[first..(first + BATCH as usize).min(cues.len())];
        batches.push((slice.len() as u32, est_tokens(&task_text(slice, &cefr))));
    }
    let prefix_tokens = prompts::prefix(st, s)
        .await
        .map_err(|e| e.to_string())?
        .iter()
        .map(|m| est_tokens(m["content"].as_str().unwrap_or("")))
        .sum();
    let mut e = estimate_from(prefix_tokens, &batches);
    // A partly read track is priced by the cues stored so far; scale them to the whole film, so the
    // number the user agrees to does not grow as the rest arrives.
    if let Some((_, total)) = progress.filter(|(next, total)| next < total) {
        if !cues.is_empty() {
            let k = total as f64 / cues.len() as f64;
            e.cues = (e.cues as f64 * k).round() as u32;
            e.batches = (e.batches as f64 * k).round() as u32;
            e.input_tokens = (e.input_tokens as f64 * k).round() as u64;
            e.cached_tokens = (e.cached_tokens as f64 * k).round() as u64;
            e.output_tokens = (e.output_tokens as f64 * k).round() as u64;
            e.partial = true;
        }
    }
    Ok(e)
}

/// Batches to run, starting with the one containing `priority`, then forward, then wrapping to the start.
pub fn batch_order(total_cues: u32, priority: u32, skip: &HashSet<u32>) -> Vec<u32> {
    let n = total_cues.div_ceil(BATCH);
    if n == 0 { return vec![]; }
    let p = (priority / BATCH).min(n - 1);
    (0..n).map(|k| ((p + k) % n) * BATCH).filter(|f| !skip.contains(f)).collect()
}

/// Cue count the scheduler may take batches from. While the subtitles are still being read out of
/// the video file, a batch that is not full yet must not start: it would be stored as done with
/// cues missing.
pub fn eligible(count: u32, loading: bool) -> u32 {
    if loading { count / BATCH * BATCH } else { count }
}

async fn scheduler(st: &Arc<AppState>, s: &Arc<Session>, run: &Arc<Run>) {
    let cancel = &run.cancel;
    let mid = s.media_id.clone();
    let duration = s.probe.get().map(|p| p.duration).unwrap_or(0.0);
    let resume_at = s.req.resume_at;
    let (done, consent, resume, sub_offset) = match st
        .db(move |c| {
            let d = c.prepare("SELECT first_idx FROM annot_batch WHERE media_id=?1 AND status='done'")?.query_map([&mid], |r| r.get(0))?.collect::<Result<HashSet<u32>, _>>()?;
            let media = c.query_row("SELECT annot,last_position,sub_offset FROM media WHERE id=?1", [&mid], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))).optional()?;
            let (consent, last, off) = media.unwrap_or((None, 0.0, 0.0));
            let resume = crate::session::resume_position(last, resume_at, duration);
            Ok((d, consent, resume, off))
        })
        .await
    {
        Ok(x) => x,
        Err(_) => return,
    };
    // No consent yet (the user has not been asked) and "watch without analysis" both mean: do not run.
    if consent.as_deref() != Some("on") { return; }
    let mid = s.media_id.clone();
    let first = match st
        .db(move |c| {
            c.query_row("SELECT max(idx) FROM cue WHERE media_id=?1 AND start + ?2 <= ?3", params![mid, sub_offset, resume], |r| r.get::<_, Option<u32>>(0))
        })
        .await
    {
        Ok(x) => x.unwrap_or(0),
        Err(_) => 0,
    };
    prioritize(&s, first);
    let taken = Arc::new(Mutex::new(done));
    let sem = Arc::new(Semaphore::new(3));
    let mut tasks = tokio::task::JoinSet::new();
    let mut warmed = false;
    loop {
        let permit = tokio::select! {
            p = sem.clone().acquire_owned() => p.unwrap(),
            _ = cancel.cancelled() => break,
            _ = run.blocked.cancelled() => break,
        };
        // The cue set grows while the embedded subtitles load, so the count is read every time.
        // `loading` also needs a loader that is actually running: after a failed or cancelled load
        // the row stays behind, and waiting for cues that will never come would hang the analysis.
        let running = matches!(s.embedded.lock().unwrap().as_ref().map(|e| e.phase), Some("loading"));
        let mid = s.media_id.clone();
        let (count, row_loading) = match st
            .db(move |c| {
                let n: u32 = c.query_row("SELECT count(*) FROM cue WHERE media_id=?1", [&mid], |r| r.get(0))?;
                let loading = crate::subs::store::embedded_progress(c, &mid)?.is_some_and(|(_, next, total)| next < total);
                Ok((n, loading))
            })
            .await
        {
            Ok(x) => x,
            Err(_) => break,
        };
        if cancel.is_cancelled() || run.blocked.is_cancelled() { break; }
        let loading = row_loading && running;
        let next = {
            let mut t = taken.lock().unwrap();
            let f = batch_order(eligible(count, loading), s.annot_priority.load(Ordering::Relaxed), &t).into_iter().next();
            if let Some(f) = f { t.insert(f); }
            f
        };
        let Some(first) = next else {
            // Nothing to do right now. If more cues are on their way, wait for them (the permit is
            // released at the end of this iteration); otherwise the analysis is finished.
            if !loading { break; }
            tokio::select! {
                _ = s.cues_grew.notified() => continue,
                _ = cancel.cancelled() => break,
                _ = run.blocked.cancelled() => break,
            }
        };
        let (st2, s2, r2) = (st.clone(), s.clone(), run.clone());
        tasks.spawn(async move {
            tokio::select! { _ = run_batch_recorded(&st2, &s2, &r2, first) => {}, _ = r2.cancel.cancelled() => {} }
            drop(permit);
        });
        // The first request alone fills DeepSeek's prefix cache; the parallel ones after it hit it.
        if !warmed {
            warmed = true;
            tokio::select! { _ = tasks.join_next() => {}, _ = cancel.cancelled() => break }
        }
    }
    while tasks.join_next().await.is_some() {}
}

/// Cancels the current annotation run and resets its status to idle.
pub fn stop(s: &Arc<Session>) {
    let mut current = s.annot_run.lock().unwrap();
    current.cancel.cancel();
    *current = Arc::new(Run::default());
}

/// (Re)starts background annotation: drops the cached prompt prefix and cancels the previous scheduler.
pub fn restart(st: &Arc<AppState>, s: &Arc<Session>) -> bool {
    *s.prefix.lock().unwrap() = None;
    start(st, s, None)
}

fn prepare_start_run(
    slot: &Mutex<Arc<Run>>,
    parent_cancel: &CancellationToken,
    enabled: bool,
    first: Option<u32>,
) -> Option<Arc<Run>> {
    let mut current = slot.lock().unwrap();
    let is_running = current.status.lock().unwrap().0;
    let is_blocked = current.blocked.is_cancelled();
    if first.is_some() && is_running && !is_blocked {
        return None;
    }
    current.cancel.cancel();
    let run = Arc::new(Run {
        cancel: parent_cancel.child_token(),
        status: Mutex::new((enabled, None)),
        ..Default::default()
    });
    *current = run.clone();
    Some(run)
}

fn start(st: &Arc<AppState>, s: &Arc<Session>, first: Option<u32>) -> bool {
    let enabled = st.cfg().llm_enabled();
    let Some(run) = prepare_start_run(&s.annot_run, &s.cancel, enabled, first) else {
        return false;
    };
    if !enabled { return false; }
    let (st, s) = (st.clone(), s.clone());
    tauri::async_runtime::spawn(async move {
        emit_status_for_run(&st, &s.media_id, &run).await;
        if let Some(first) = first {
            tokio::select! {
                _ = run_batch_recorded(&st, &s, &run, first) => {},
                _ = run.cancel.cancelled() => {},
            }
        } else {
            scheduler(&st, &s, &run).await;
        }
        run.status.lock().unwrap().0 = false;
        emit_status_for_run(&st, &s.media_id, &run).await;
    });
    true
}

pub fn prioritize(s: &Session, cue_idx: u32) { s.annot_priority.store(cue_idx, Ordering::Relaxed); }

/// Retries one failed batch (from the "перевести снова" button).
pub fn retry(st: &Arc<AppState>, s: &Arc<Session>, first: u32) {
    start(st, s, Some(first));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cues(texts: &[&str]) -> Vec<(u32, String)> { texts.iter().enumerate().map(|(i, t)| (i as u32, t.to_string())).collect() }

    fn raw(json: serde_json::Value) -> RawBatch { serde_json::from_value(json).unwrap() }

    #[test]
    fn drops_chunks_missing_from_text_and_finds_second_occurrence() {
        let c = cues(&["He bailed on me, and then he bailed on her."]);
        let a = process(&c, raw(json!({"cues":[{"i":0,"en":"He bailed on me, and then he bailed on her.","ru":"Он меня бросил","chunks":[
            {"text":"bailed on","kind":"phrasal_verb","ru":"бросил"},
            {"text":"bailed on","kind":"phrasal_verb","ru":"бросил"},
            {"text":"not in text","kind":"idiom","ru":"x"}],"patterns":[]}]})));
        assert_eq!(a[0].chunks.len(), 2);
        assert_eq!((a[0].chunks[0].start_char, a[0].chunks[0].end_char), (3, 12));
        assert_eq!(a[0].chunks[1].start_char, 29);
        assert_eq!(a[0].chunks[1].text, "bailed on");
    }

    #[test]
    fn case_insensitive_keeps_original_text_and_utf16_offsets() {
        let c = cues(&["😀 Come ON, man!"]);
        let a = process(&c, raw(json!({"cues":[{"i":0,"en":"😀 Come ON, man!","ru":"Давай","chunks":[{"text":"come on","kind":"idiom","ru":"давай"}]}]})));
        assert_eq!(a[0].chunks[0].text, "Come ON");
        assert_eq!(a[0].chunks[0].start_char, 3);
    }

    #[test]
    fn patterns_validated_against_catalog() {
        let c = cues(&["I've been waiting for ages."]);
        let a = process(&c, raw(json!({"cues":[{"i":0,"en":"I've been waiting for ages.","ru":"Я жду целую вечность","patterns":[
            {"id":"PRESENT_PERFECT_CONT","text":"I've been waiting"},
            {"id":"NOT_A_PATTERN","text":"for ages"},
            {"id":"PASSIVE","text":"absent"}]}]})));
        assert_eq!(a[0].patterns.len(), 1);
        assert_eq!(a[0].patterns[0].pattern_id, "PRESENT_PERFECT_CONT");
        assert_eq!(a[0].patterns[0].end_char, 17);
    }

    #[test]
    fn cues_without_translation_are_skipped() {
        let c = cues(&["Hi."]);
        assert!(process(&c, raw(json!({"cues":[{"i":0,"en":"Hi.","ru":"  "},{"i":9,"en":"Bye.","ru":"лишний"}]}))).is_empty());
    }

    #[test]
    fn index_drift_is_realigned_by_echoed_text_or_dropped() {
        let c = vec![(80, "Life is a short trip ♪".to_string()), (81, "-Do you mind?\n-No. Can I help you?".to_string())];
        let a = process(&c, raw(json!({"cues":[
            {"i":80,"en":"- Do you mind? / - No. Can I help you?","ru":"— Не возражаете? — Нет. Чем могу помочь?"},
            {"i":81,"en":"Let's go then.","ru":"Ну что, поехали."}]})));
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].idx, 81);
        assert!(process(&c, raw(json!({"cues":[{"i":80,"ru":"без эха"}]}))).is_empty());
    }

    #[test]
    fn batch_order_prioritizes_then_wraps() {
        let none = HashSet::new();
        assert_eq!(batch_order(130, 0, &none), vec![0, 40, 80, 120]);
        assert_eq!(batch_order(130, 85, &none), vec![80, 120, 0, 40]);
        let skip: HashSet<u32> = [80, 0].into_iter().collect();
        assert_eq!(batch_order(130, 85, &skip), vec![120, 40]);
        assert!(batch_order(0, 0, &none).is_empty());
    }

    #[test]
    fn estimate_counts_prefix_once_uncached() {
        let e = estimate_from(1000, &[(40, 100), (10, 50)]);
        assert_eq!((e.cues, e.batches, e.input_tokens, e.cached_tokens, e.output_tokens), (50, 2, 2150, 1000, 3600));
        assert!(!e.partial);
        let empty = estimate_from(1000, &[]);
        assert_eq!((empty.cues, empty.batches, empty.input_tokens, empty.cached_tokens, empty.output_tokens), (0, 0, 0, 0, 0));
    }

    #[test]
    fn a_partly_loaded_track_only_gives_whole_batches() {
        assert_eq!(eligible(95, true), 80);
        assert_eq!(eligible(95, false), 95);
        assert_eq!(eligible(39, true), 0);
        assert_eq!(eligible(40, true), 40);
        assert_eq!(eligible(0, true), 0);
    }

    #[test]
    fn failure_classifies_missing_key_and_http_statuses() {
        let missing = failure(&anyhow::Error::new(client::MissingKeyError));
        assert!(missing.blocked);
        assert_eq!(missing.message, "Нет API-ключа для разбора диалогов");

        for status in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::PAYMENT_REQUIRED,
            reqwest::StatusCode::FORBIDDEN,
        ] {
            let f = failure(&anyhow::Error::new(client::HttpError::test(status)));
            assert!(f.blocked, "status {status} should block");
        }

        let server_err = failure(&anyhow::Error::new(client::HttpError::test(reqwest::StatusCode::INTERNAL_SERVER_ERROR)));
        assert!(!server_err.blocked);
        assert_eq!(server_err.message, "Ошибка LLM-провайдера (HTTP 500)");

        let generic = failure(&anyhow::anyhow!("boom"));
        assert!(!generic.blocked);
        assert_eq!(generic.message, "Не удалось разобрать диалоги. Подробности в llm.log");
    }

    #[test]
    fn save_batch_db_clears_stale_rows_and_withholds_done_until_complete() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init(&c).unwrap();
        c.execute("INSERT INTO media(id,kind,source_url,title,updated_at) VALUES('m1','file','u','t',0)", []).unwrap();
        c.execute("INSERT INTO cue(media_id,idx,start,end,text) VALUES('m1',0,0.0,1.0,'Hi'),('m1',1,1.0,2.0,'Bye')", []).unwrap();
        // Pre-existing stale chunk & pattern on cue 0.
        c.execute("INSERT INTO chunk VALUES('m1',0,0,2,'Hi','slang','привет')", []).unwrap();
        c.execute("INSERT INTO cue_pattern VALUES('m1',0,'PASSIVE',0,2)", []).unwrap();

        // Save partial batch (only cue 0, cue 1 still missing).
        let partial = vec![CueAnnotation {
            idx: 0,
            ru: "Привет".into(),
            chunks: vec![Chunk { start_char: 0, end_char: 2, text: "Hi".into(), kind: "idiom".into(), ru: "здорова".into() }],
            patterns: vec![],
        }];
        let missing = save_batch_db(&c, "m1", 0, &partial).unwrap();
        assert_eq!(missing, 1);

        let batch_status: String = c.query_row("SELECT status FROM annot_batch WHERE media_id='m1' AND first_idx=0", [], |r| r.get(0)).unwrap();
        assert_eq!(batch_status, "failed");

        // Stale chunk and pattern rows on cue 0 were deleted before inserting new ones.
        let pat_n: i64 = c.query_row("SELECT count(*) FROM cue_pattern WHERE media_id='m1' AND cue_idx=0", [], |r| r.get(0)).unwrap();
        assert_eq!(pat_n, 0);
        let chunk_kind: String = c.query_row("SELECT kind FROM chunk WHERE media_id='m1' AND cue_idx=0", [], |r| r.get(0)).unwrap();
        assert_eq!(chunk_kind, "idiom");

        // Missing-cue query targets only cue 1.
        let (total, todo) = load_missing_cues_db(&c, "m1", 0).unwrap();
        assert_eq!(total, 2);
        assert_eq!(todo, vec![(1, "Bye".to_string())]);

        // Completing cue 1 flips batch status to 'done'.
        let rest = vec![CueAnnotation { idx: 1, ru: "Пока".into(), chunks: vec![], patterns: vec![] }];
        let missing = save_batch_db(&c, "m1", 0, &rest).unwrap();
        assert_eq!(missing, 0);
        let batch_status: String = c.query_row("SELECT status FROM annot_batch WHERE media_id='m1' AND first_idx=0", [], |r| r.get(0)).unwrap();
        assert_eq!(batch_status, "done");
    }

    #[test]
    fn prepare_start_run_allows_explicit_retry_to_clear_blocked_state() {
        let parent = CancellationToken::new();
        let blocked_run = Arc::new(Run::default());
        blocked_run.blocked.cancel();
        *blocked_run.status.lock().unwrap() = (false, Some(AnnotFailure { message: "HTTP 401".into(), blocked: true }));
        let slot = Mutex::new(blocked_run.clone());

        // Single-batch retry (first = Some) must replace a blocked run and reset `blocked`.
        let next = prepare_start_run(&slot, &parent, true, Some(40)).expect("retry should clear blocked");
        assert!(!next.blocked.is_cancelled());
        assert!(next.status.lock().unwrap().1.is_none());
        assert!(blocked_run.cancel.is_cancelled());

        // While an unblocked run is actively executing, single-batch retry steps aside.
        assert!(prepare_start_run(&slot, &parent, true, Some(40)).is_none());
    }
}
