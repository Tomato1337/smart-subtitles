use super::{client, prompts};
use crate::{patterns, session::Session, state::AppState, types::*};
use rusqlite::params;
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

async fn run_batch(st: &Arc<AppState>, s: &Arc<Session>, first: u32) -> Result<(), String> {
    let mid = s.media_id.clone();
    let cues: Vec<(u32, String)> = st
        .db(move |c| {
            c.prepare("SELECT idx,text FROM cue WHERE media_id=?1 AND idx>=?2 AND idx<?3 ORDER BY idx")?
                .query_map(params![mid, first, first + BATCH], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect()
        })
        .await?;
    if cues.is_empty() { return Ok(()); }

    let mut messages = (*prompts::prefix(st, s).await.map_err(|e| e.to_string())?).clone();
    messages.push(json!({ "role": "user", "content": task_text(&cues, &st.cfg.learner.cefr) }));
    let raw: RawBatch = client::chat_json(st, &format!("annotate {first}"), &messages, 8000).await.map_err(|e| e.to_string())?;
    let anns = process(&cues, raw);
    if anns.len() * 2 < cues.len() {
        return Err(format!("ответ не совпал с репликами: {} из {}", anns.len(), cues.len()));
    }

    let (mid, a2) = (s.media_id.clone(), anns.clone());
    st.db(move |c| {
        let tx = c.unchecked_transaction()?;
        for a in &a2 {
            tx.execute("UPDATE cue SET ru=?1 WHERE media_id=?2 AND idx=?3", params![a.ru, mid, a.idx])?;
            for ch in &a.chunks {
                tx.execute("INSERT OR REPLACE INTO chunk VALUES(?1,?2,?3,?4,?5,?6,?7)", params![mid, a.idx, ch.start_char, ch.end_char, ch.text, ch.kind, ch.ru])?;
            }
            for p in &a.patterns {
                tx.execute("INSERT OR REPLACE INTO cue_pattern VALUES(?1,?2,?3,?4,?5)", params![mid, a.idx, p.pattern_id, p.start_char, p.end_char])?;
            }
        }
        tx.execute("INSERT OR REPLACE INTO annot_batch VALUES(?1,?2,'done')", params![mid, first])?;
        tx.commit()
    })
    .await?;
    let _ = st.app.emit("annot:updated", json!({ "mediaId": s.media_id, "cues": anns }));
    Ok(())
}

async fn run_batch_recorded(st: &Arc<AppState>, s: &Arc<Session>, first: u32) {
    if let Err(e) = run_batch(st, s, first).await {
        crate::logs::log("llm", &format!("batch {first} failed: {e}"));
        let mid = s.media_id.clone();
        let _ = st.db(move |c| { c.execute("INSERT OR REPLACE INTO annot_batch VALUES(?1,?2,'failed')", params![mid, first])?; Ok(()) }).await;
        let _ = st.app.emit("annot:failed", json!({ "mediaId": s.media_id, "firstIdx": first }));
    }
}

/// Batches to run, starting with the one containing `priority`, then forward, then wrapping to the start.
pub fn batch_order(total_cues: u32, priority: u32, skip: &HashSet<u32>) -> Vec<u32> {
    let n = total_cues.div_ceil(BATCH);
    if n == 0 { return vec![]; }
    let p = (priority / BATCH).min(n - 1);
    (0..n).map(|k| ((p + k) % n) * BATCH).filter(|f| !skip.contains(f)).collect()
}

async fn scheduler(st: Arc<AppState>, s: Arc<Session>, cancel: CancellationToken) {
    let mid = s.media_id.clone();
    let (total, done): (u32, HashSet<u32>) = match st
        .db(move |c| {
            let n: u32 = c.query_row("SELECT count(*) FROM cue WHERE media_id=?1", [&mid], |r| r.get(0))?;
            let d = c.prepare("SELECT first_idx FROM annot_batch WHERE media_id=?1 AND status='done'")?.query_map([&mid], |r| r.get(0))?.collect::<Result<HashSet<u32>, _>>()?;
            Ok((n, d))
        })
        .await
    {
        Ok(x) => x,
        Err(_) => return,
    };
    let taken = Arc::new(Mutex::new(done));
    let sem = Arc::new(Semaphore::new(3));
    let mut tasks = tokio::task::JoinSet::new();
    let mut warmed = false;
    loop {
        let permit = tokio::select! {
            p = sem.clone().acquire_owned() => p.unwrap(),
            _ = cancel.cancelled() => break,
        };
        let next = {
            let mut t = taken.lock().unwrap();
            let f = batch_order(total, s.annot_priority.load(Ordering::Relaxed), &t).into_iter().next();
            if let Some(f) = f { t.insert(f); }
            f
        };
        let Some(first) = next else { break };
        let (st2, s2, c2) = (st.clone(), s.clone(), cancel.clone());
        tasks.spawn(async move {
            tokio::select! { _ = run_batch_recorded(&st2, &s2, first) => {}, _ = c2.cancelled() => {} }
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

/// (Re)starts background annotation: drops the cached prompt prefix and cancels the previous scheduler.
pub fn restart(st: &Arc<AppState>, s: &Arc<Session>) {
    *s.prefix.lock().unwrap() = None;
    let token = s.cancel.child_token();
    let old = std::mem::replace(&mut *s.annot_cancel.lock().unwrap(), token.clone());
    old.cancel();
    if !st.cfg.llm_enabled() { return; }
    tauri::async_runtime::spawn(scheduler(st.clone(), s.clone(), token));
}

pub fn prioritize(s: &Session, cue_idx: u32) { s.annot_priority.store(cue_idx, Ordering::Relaxed); }

/// Retries one failed batch (from the "перевести снова" button).
pub async fn retry(st: &Arc<AppState>, s: &Arc<Session>, first: u32) {
    run_batch_recorded(st, s, first).await;
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
}
