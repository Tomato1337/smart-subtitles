use super::{anki_index, api::slug};
use crate::{asr::{self, align}, db::now, logs, media::{clip, TempFile}, session::Session, state::AppState};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc, time::Duration};
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WordDraft {
    pub word: String,
    pub translation: String,
    pub word_type: String,
    pub cloze_sentence: String,
    pub full_sentence: String,
    pub sentence_translation: String,
    #[serde(default)]
    pub image_prompt: String,
}

/// Text inside the first `{{c1::…}}`.
pub fn cloze_inner(cloze: &str) -> Option<String> {
    let a = cloze.find("{{c1::")? + 6;
    let b = cloze[a..].find("}}")? + a;
    Some(cloze[a..b].to_string())
}

/// Index in `text.split_whitespace()` of the first token matching the first word of `span` (0 when absent).
pub fn word_index(text: &str, span: &str) -> usize {
    let first = span.split_whitespace().next().map(crate::asr::norm_word).unwrap_or_default();
    if first.is_empty() { return 0; }
    text.split_whitespace().position(|t| crate::asr::norm_word(t) == first).unwrap_or(0)
}

fn hms(sec: f64) -> String {
    let s = sec.max(0.0) as u64;
    format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

pub fn source_label(name: &str, season: Option<u32>, episode: Option<u32>, start: f64) -> String {
    let se = match (season, episode) { (Some(s), Some(e)) => format!(" S{s:02}E{e:02}"), _ => String::new() };
    format!("{name}{se} [{}]", hms(start))
}

pub async fn create_proposal(st: &AppState, media_id: &str, cue_idx: u32, words: &[WordDraft]) -> Result<i64, String> {
    let (m, j) = (media_id.to_string(), serde_json::to_string(words).map_err(|e| e.to_string())?);
    st.db(move |c| {
        c.execute("INSERT INTO proposal(media_id,cue_idx,words_json,status,created_at) VALUES(?1,?2,?3,'pending',?4)", params![m, cue_idx, j, now()])?;
        Ok(c.last_insert_rowid())
    })
    .await
}

pub async fn set_status(st: &AppState, id: i64, status: &'static str, error: Option<String>) {
    let _ = st.db(move |c| { c.execute("UPDATE proposal SET status=?1, error=?2 WHERE id=?3", params![status, error, id])?; Ok(()) }).await;
}

struct Ctx { media_id: String, cue_idx: u32, words: Vec<WordDraft> }

async fn load(st: &AppState, id: i64) -> Result<Ctx, String> {
    st.db(move |c| {
        let (m, i, j, status): (String, u32, String, String) = c.query_row("SELECT media_id,cue_idx,words_json,status FROM proposal WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        if status == "adding" || status == "added" {
            return Err(rusqlite::Error::InvalidParameterName(format!("proposal status {status}")));
        }
        Ok(Ctx { media_id: m, cue_idx: i, words: serde_json::from_str(&j).unwrap_or_default() })
    })
    .await
}

/// Outcome of one background add, sent to the frontend as `cards:result`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Report {
    proposal_id: i64,
    media_id: String,
    cue_idx: u32,
    indices: Vec<usize>,
    words: Vec<String>,
    added: usize,
    /// Set when nothing reached Anki.
    error: Option<String>,
    /// Cards were added, but without some media.
    warnings: Vec<String>,
}

/// Queues the chosen words of a proposal for Anki and returns at once. Jobs run one at a time in the
/// background (clip, image, flashcards.py); the result arrives as the `cards:result` event.
pub async fn enqueue(st: &Arc<AppState>, id: i64, indices: Vec<usize>) -> Result<(), String> {
    let ctx = load(st, id).await?;
    let words: Vec<String> = indices.iter().filter_map(|i| ctx.words.get(*i)).map(|w| w.word.clone()).collect();
    if words.is_empty() { return Err("ничего не выбрано".into()); }
    // The clip is cut from the session open now: the user may switch films before the job runs.
    let session = st.sessions.current().filter(|s| s.media_id == ctx.media_id);
    let audio_index = session.as_ref().map(|s| *s.audio_index.lock().unwrap());
    set_status(st, id, "adding", None).await;
    let st = st.clone();
    tauri::async_runtime::spawn(async move {
        let _turn = st.cards_queue.lock().await;
        let mut report = Report { proposal_id: id, media_id: ctx.media_id.clone(), cue_idx: ctx.cue_idx, indices: indices.clone(), words, added: 0, error: None, warnings: vec![] };
        let clip_source = session.as_deref().zip(audio_index);
        match run(&st, &ctx, &indices, clip_source).await {
            Ok(o) => {
                set_status(&st, id, "added", None).await;
                report.added = o.added;
                report.warnings = o.warnings;
                anki_index::refresh(&st).await;
            }
            Err(e) => {
                logs::log("app", &format!("cards: proposal {id} failed: {e}"));
                set_status(&st, id, "failed", Some(e.clone())).await;
                report.error = Some(e);
            }
        }
        let _ = st.app.emit("cards:result", &report);
    });
    Ok(())
}

struct Outcome { added: usize, warnings: Vec<String> }

/// Image flags for flashcards.py from tutor's card settings (`GET /api/settings`), so cards get the same
/// pictures as in tutor. Tutor not running: its defaults (omp, image role model).
async fn image_args(st: &AppState) -> Vec<String> {
    let url = format!("{}/api/settings", st.cfg().tutor.api_url.trim_end_matches('/'));
    let settings = match st.http.get(url).timeout(Duration::from_secs(3)).send().await {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or(Value::Null),
        _ => Value::Null,
    };
    image_backend_args(&settings, &st.cfg().tutor.root)
}

pub fn image_backend_args(settings: &Value, tutor_root: &str) -> Vec<String> {
    let backend = settings["cards.imageBackend"].as_str().filter(|b| ["omp", "runware", "none"].contains(b)).unwrap_or("omp");
    let mut a = vec!["--image-backend".to_string(), backend.to_string()];
    if backend == "omp" {
        if let Some(m) = settings["cards.ompImageModel"].as_str().filter(|m| !m.is_empty()) {
            a.extend(["--omp-image-model".to_string(), m.to_string()]);
        }
        a.extend(["--omp-overlay".to_string(), Path::new(tutor_root).join("teacher").join("image-overlay.yml").to_string_lossy().into_owned()]);
    }
    a
}

/// PATH for flashcards.py without `node_modules/.bin`: `npm run tauri dev` prepends every parent one, and a
/// stray `~/node_modules/.bin/omp` (bun script) would shadow the real omp used for images.
fn child_path(path: &str) -> String {
    path.split(':').filter(|d| !d.trim_end_matches('/').ends_with("node_modules/.bin")).collect::<Vec<_>>().join(":")
}

/// Image subject when the draft has none: the word as used in its sentence.
fn image_prompt(w: &WordDraft) -> String {
    if !w.image_prompt.trim().is_empty() { return w.image_prompt.clone(); }
    format!("A scene that shows the meaning of \"{}\" as in: {}", w.word, w.full_sentence)
}

/// Window of the cue's actual speech: whisper over ±2 s around the cue, then the span of the cue's own
/// words. Any failure keeps the plain cue window — a card without a refined clip is better than none.
async fn speech_window(
    st: &AppState,
    s: &Session,
    audio_index: u32,
    cue_idx: u32,
    text: &str,
    start: f64,
    end: f64,
    next_start: Option<f64>,
) -> (f64, f64) {
    let a = (start - 2.0).max(0.0);
    let dur = (end - start + 4.0).min(16.0);
    // A card must not wait behind a running film-wide probe (up to 10 min of transcription).
    let span = tokio::time::timeout(Duration::from_secs(120), async {
        let tmp = asr::pcm_temp()?;
        asr::extract_pcm(&s.src, audio_index, a, dur, &tmp.0).await?;
        let mut words = asr::transcribe(st, &[tmp.0.clone()]).await?.into_iter().next().unwrap_or_default();
        for w in &mut words {
            w.start += a;
            w.end += a;
        }
        Ok::<_, anyhow::Error>(align::speech_span(text, &words))
    })
    .await;
    let span = match span {
        Ok(r) => r,
        Err(_) => {
            logs::log("app", &format!("cards: speech window for cue {cue_idx} not found: таймаут распознавания"));
            return (start, end);
        }
    };
    let (s0, e0) = match span {
        Ok(Some(span)) => span,
        Ok(None) => {
            logs::log("app", &format!("cards: speech window for cue {cue_idx} not found: no words matched"));
            return (start, end);
        }
        Err(e) => {
            logs::log("app", &format!("cards: speech window for cue {cue_idx} not found: {e}"));
            return (start, end);
        }
    };
    (s0, span_end(e0, next_start))
}

/// End of the clip: a little air after the last word, never past the next cue. `clip_args` pads the
/// tail by 0.5 s, so `next_start - 0.5` lands the clip exactly on that cue.
fn span_end(e0: f64, next_start: Option<f64>) -> f64 {
    match next_start.filter(|n| *n > e0) {
        Some(n) => (e0 + 0.3).min(n - 0.5).max(e0),
        None => e0 + 0.3,
    }
}

async fn run(st: &Arc<AppState>, ctx: &Ctx, indices: &[usize], clip_source: Option<(&Session, u32)>) -> Result<Outcome, String> {
    if !anki_index::available(st).await { return Err("Anki не запущен".into()); }
    let picked: Vec<&WordDraft> = indices.iter().filter_map(|i| ctx.words.get(*i)).collect();
    if picked.is_empty() { return Err("ничего не выбрано".into()); }

    let (mid, ci) = (ctx.media_id.clone(), ctx.cue_idx);
    let (cue_start, cue_end, cue_text, offset, title, orig, year, season, episode, next_cue_start): (f64, f64, String, f64, String, Option<String>, Option<i32>, Option<u32>, Option<u32>, Option<f64>) = st
        .db(move |c| {
            let (s, e, t): (f64, f64, String) = c.query_row("SELECT start,end,text FROM cue WHERE media_id=?1 AND idx=?2", params![mid, ci], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            let m = c.query_row("SELECT sub_offset,title,original_title,year,season,episode FROM media WHERE id=?1", [&mid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?;
            let next: Option<f64> = c.query_row("SELECT start FROM cue WHERE media_id=?1 AND idx=?2", params![mid, ci + 1], |r| r.get::<_, f64>(0)).optional()?;
            Ok((s, e, t, m.0, m.1, m.2, m.3, m.4, m.5, next))
        })
        .await?;
    let name = orig.clone().unwrap_or_else(|| title.clone());
    let text_one_line = cue_text.replace('\n', " ");
    let (start, end) = (cue_start + offset, cue_end + offset);
    // The speech of this cue, not the subtitle timing, decides where the clip ends.
    let (start, end) = match clip_source {
        Some((s, audio_index)) if s.probe.get().is_some() => {
            speech_window(st, s, audio_index, ci, &cue_text, start, end, next_cue_start.map(|n| n + offset)).await
        }
        _ => (start, end),
    };
    let mut warnings = vec![];

    // One clip per cue, shared by all its words (one media file in Anki).
    let clip = match clip_source {
        None => Err("фильм уже закрыт".to_string()),
        Some((s, _)) if s.probe.get().is_none() => Err("видео ещё не распознано".to_string()),
        Some((s, audio_index)) => {
            let p = s.probe.get().unwrap();
            let key = format!("{}|{}|{start:.3}|{end:.3}|{audio_index}", ctx.media_id, ctx.cue_idx);
            let file_name = format!("smartsubs_{}.webm", &hex::encode(Sha256::digest(key.as_bytes()))[..16]);
            let spec = clip::ClipSpec { src: &s.src, video_index: p.video.index, audio_index, start, end, hdr: p.video.hdr };
            clip::make(&spec, &file_name).await.map(|path| (path, file_name)).map_err(|e| e.to_string())
        }
    };
    if let Err(e) = &clip {
        logs::log("app", &format!("cards: clip for cue {} skipped: {e}", ctx.cue_idx));
        warnings.push(format!("без клипа ({e})"));
    }

    let mut words = vec![];
    for w in &picked {
        let mut j = json!({
            "word": w.word, "translation": w.translation, "word_type": w.word_type, "cloze_sentence": w.cloze_sentence,
            "full_sentence": w.full_sentence, "sentence_translation": w.sentence_translation, "image_prompt": image_prompt(w),
            "source": "smart-subtitle",
        });
        if let Ok((path, file_name)) = &clip {
            let span = cloze_inner(&w.cloze_sentence).unwrap_or_else(|| w.word.clone());
            j["clip"] = json!({
                "path": path, "fileName": file_name, "text": text_one_line, "wordIndex": word_index(&text_one_line, &span),
                "title": name, "year": year, "startMs": (start * 1000.0).round() as i64,
                "sourceLabel": source_label(&name, season, episode, start), "provider": "Smart Subtitles",
            });
        }
        words.push(j);
    }

    let tmp = TempFile(std::env::temp_dir().join(format!("smartsubs-cards-{}.json", uuid::Uuid::new_v4())));
    std::fs::write(&tmp.0, serde_json::to_vec(&json!({ "words": words })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let tags = format!("vocab smartsubs smartsubs::{}", slug(&name));
    let out = tokio::time::timeout(
        Duration::from_secs(30 * 60),
        // Lower priority: playback (ffmpeg stream, webview) must not stutter while images are generated.
        tokio::process::Command::new("nice")
            .args(["-n", "10", "python3", "anki/flashcards.py", "--input"]).arg(&tmp.0)
            .args(["--deck", &st.cfg().tutor.deck, "--tags", &tags])
            .args(image_args(st).await)
            .current_dir(&st.cfg().tutor.root)
            .env("PATH", child_path(&std::env::var("PATH").unwrap_or_default()))
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "flashcards.py: таймаут 30 мин".to_string())?
    .map_err(|e| format!("python3: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    let r = parse_result(&String::from_utf8_lossy(&out.stdout), &stderr, out.status.success());
    if !matches!(&r, Ok(f) if f.images_missing.is_empty()) {
        let tail: String = stderr.chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();
        logs::log("app", &format!("flashcards.py stderr: {tail}"));
    }
    let r = r?;
    if !r.images_missing.is_empty() { warnings.push(format!("без картинки: {}", r.images_missing.join(", "))); }
    Ok(Outcome { added: r.added, warnings })
}

#[derive(Debug, PartialEq)]
pub struct FlashResult { pub added: usize, pub images_missing: Vec<String> }

/// Last non-empty stdout line is `{"ok":true,"added":N,"imagesMissing":[…],…}` or `{"ok":false,"error":…}`.
pub fn parse_result(stdout: &str, stderr: &str, success: bool) -> Result<FlashResult, String> {
    let last = stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    match serde_json::from_str::<Value>(last) {
        Ok(v) if v["ok"].as_bool() == Some(true) => Ok(FlashResult {
            added: v["added"].as_u64().unwrap_or(0) as usize,
            images_missing: v["imagesMissing"].as_array().map(|a| a.iter().filter_map(|w| w.as_str().map(String::from)).collect()).unwrap_or_default(),
        }),
        Ok(v) => Err(v["error"].as_str().unwrap_or("flashcards.py: ошибка").to_string()),
        Err(_) => Err(if success { "flashcards.py: нет результата".into() } else { format!("flashcards.py: {}", stderr.trim().lines().last().unwrap_or("ошибка")) }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloze_and_word_index() {
        assert_eq!(cloze_inner("He {{c1::bailed on}} me").as_deref(), Some("bailed on"));
        assert_eq!(cloze_inner("none"), None);
        assert_eq!(word_index("Look, he bailed on me.", "bailed on"), 2);
        assert_eq!(word_index("Look, he bailed on me.", "Bailed"), 2);
        assert_eq!(word_index("Hi there", "absent"), 0);
    }

    #[test]
    fn labels() {
        assert_eq!(source_label("Marty Supreme", None, None, 3723.9), "Marty Supreme [01:02:03]");
        assert_eq!(source_label("The Boys", Some(5), Some(1), 65.0), "The Boys S05E01 [00:01:05]");
    }

    #[test]
    fn tutor_output_parsing() {
        assert_eq!(parse_result("noise\n{\"ok\":true,\"added\":2}\n", "", true), Ok(FlashResult { added: 2, images_missing: vec![] }));
        assert_eq!(parse_result("{\"ok\":true,\"added\":2,\"imagesMissing\":[\"bail\"]}", "", true), Ok(FlashResult { added: 2, images_missing: vec!["bail".into()] }));
        assert_eq!(parse_result("{\"ok\":false,\"error\":\"bad clip\"}", "", false), Err("bad clip".into()));
        assert_eq!(parse_result("", "Traceback\nValueError: x", false), Err("flashcards.py: ValueError: x".into()));
    }

    #[test]
    fn image_flags_follow_tutor_settings() {
        let omp = image_backend_args(&json!({ "cards.imageBackend": "omp", "cards.ompImageModel": "openai/gpt-image-1" }), "/t");
        assert_eq!(omp, ["--image-backend", "omp", "--omp-image-model", "openai/gpt-image-1", "--omp-overlay", "/t/teacher/image-overlay.yml"]);
        assert_eq!(image_backend_args(&json!({ "cards.imageBackend": "none" }), "/t"), ["--image-backend", "none"]);
        // Tutor down or an unknown value: tutor's default backend with the image-role model.
        assert_eq!(image_backend_args(&Value::Null, "/t"), ["--image-backend", "omp", "--omp-overlay", "/t/teacher/image-overlay.yml"]);
        assert_eq!(image_backend_args(&json!({ "cards.imageBackend": "dalle" }), "/t")[1], "omp");
    }

    #[test]
    fn clip_ends_after_the_last_word_but_before_the_next_cue() {
        let close = |a: f64, b: f64| assert!((a - b).abs() < 1e-9, "{a} != {b}");
        close(span_end(33.58, None), 33.88);
        close(span_end(33.58, Some(60.0)), 33.88);
        // The next cue is close: the tail stops 0.5 s before it.
        close(span_end(33.58, Some(34.2)), 33.7);
        // …but the last word is never cut off.
        close(span_end(33.58, Some(34.0)), 33.58);
        close(span_end(33.58, Some(33.0)), 33.88);
    }

    #[test]
    fn child_path_drops_npm_bins() {
        assert_eq!(child_path("/p/node_modules/.bin:/home/u/node_modules/.bin/:/home/u/.local/bin:/usr/bin"), "/home/u/.local/bin:/usr/bin");
    }
}
