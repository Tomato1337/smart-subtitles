//! Card writer: clip, AI picture and audio for the chosen words, then one `addNote` per word.
//!
//! tutor's `flashcards.py` is gone: AnkiConnect gets the media through `storeMediaFile` and the notes
//! through `addNote`, with the field mapping from the settings.

use crate::{
    anki::{
        connect,
        fields::{self, Source, Values},
        images, note_type, tts,
    },
    asr::{self, align},
    db::now,
    logs,
    media::clip,
    session::Session,
    state::AppState,
};
use futures_util::stream::{self, StreamExt};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};
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

/// Phase of a background add for the live status in the draft modal and the agent panel.
fn progress(st: &AppState, id: i64, media_id: &str, phase: &'static str) {
    let _ = st.app.emit("cards:progress", json!({ "proposalId": id, "mediaId": media_id, "phase": phase }));
}

struct Ctx { id: i64, media_id: String, cue_idx: u32, words: Vec<WordDraft> }

async fn load(st: &AppState, id: i64) -> Result<Ctx, String> {
    st.db(move |c| {
        let (m, i, j, status): (String, u32, String, String) = c.query_row("SELECT media_id,cue_idx,words_json,status FROM proposal WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        if status == "adding" || status == "added" {
            return Err(rusqlite::Error::InvalidParameterName(format!("proposal status {status}")));
        }
        Ok(Ctx { id, media_id: m, cue_idx: i, words: serde_json::from_str(&j).unwrap_or_default() })
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
/// background (clip, image, audio, addNote); the result arrives as the `cards:result` event.
pub async fn enqueue(st: &Arc<AppState>, id: i64, indices: Vec<usize>) -> Result<(), String> {
    let ctx = load(st, id).await?;
    let words: Vec<String> = indices.iter().filter_map(|i| ctx.words.get(*i)).map(|w| w.word.clone()).collect();
    if words.is_empty() { return Err("ничего не выбрано".into()); }
    // The clip is cut from the session open now: the user may switch films before the job runs.
    let session = st.sessions.current().filter(|s| s.media_id == ctx.media_id);
    let audio_index = session.as_ref().map(|s| *s.audio_index.lock().unwrap());
    set_status(st, id, "adding", None).await;
    progress(st, id, &ctx.media_id, "queued");
    let st = st.clone();
    tauri::async_runtime::spawn(async move {
        let _turn = st.cards_queue.lock().await;
        progress(&st, id, &ctx.media_id, "preparing");
        let mut report = Report { proposal_id: id, media_id: ctx.media_id.clone(), cue_idx: ctx.cue_idx, indices: indices.clone(), words, added: 0, error: None, warnings: vec![] };
        let clip_source = session.as_deref().zip(audio_index);
        match run(&st, &ctx, &indices, clip_source).await {
            Ok(o) => {
                set_status(&st, id, "added", None).await;
                report.added = o.added;
                report.warnings = o.warnings;
                crate::anki::index::refresh(&st).await;
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

/// What `run` needs to know about one cue.
pub struct CueMeta {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub offset: f64,
    pub title: String,
    pub original_title: Option<String>,
    pub year: Option<i32>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub next_start: Option<f64>,
}

pub async fn cue_meta(st: &AppState, media_id: &str, cue_idx: u32) -> Result<CueMeta, String> {
    let (mid, ci) = (media_id.to_string(), cue_idx);
    let (s, e, t, m, next): (f64, f64, String, (f64, String, Option<String>, Option<i32>, Option<u32>, Option<u32>), Option<f64>) = st
        .db(move |c| {
            let (s, e, t): (f64, f64, String) = c.query_row("SELECT start,end,text FROM cue WHERE media_id=?1 AND idx=?2", params![mid, ci], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            let m = c.query_row("SELECT sub_offset,title,original_title,year,season,episode FROM media WHERE id=?1", [&mid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?;
            let next: Option<f64> = c.query_row("SELECT start FROM cue WHERE media_id=?1 AND idx=?2", params![mid, ci + 1], |r| r.get::<_, f64>(0)).optional()?;
            Ok((s, e, t, m, next))
        })
        .await?;
    Ok(CueMeta {
        start: s,
        end: e,
        text: t,
        offset: m.0,
        title: m.1,
        original_title: m.2,
        year: m.3,
        season: m.4,
        episode: m.5,
        next_start: next,
    })
}

/// Image subject when the draft has none: the word as used in its sentence.
pub fn image_prompt(w: &WordDraft) -> String {
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

/// A clip is cut only when the video setting is on and something actually needs it.
fn needs_clip(clips_on: bool, clip_field: bool, sentence_field: bool, mode: &str) -> bool {
    clips_on && (clip_field || (sentence_field && mode == "clip"))
}

/// Sentence audio from the clip is impossible without a clip; TTS needs nothing else.
fn needs_sentence_audio(sentence_field: bool, mode: &str, clips_on: bool) -> bool {
    sentence_field && mode != "none" && (mode != "clip" || clips_on)
}

async fn run(st: &Arc<AppState>, ctx: &Ctx, indices: &[usize], clip_source: Option<(&Session, u32)>) -> Result<Outcome, String> {
    if !connect::available(st).await { return Err("Anki не запущен".into()); }
    let picked: Vec<WordDraft> = indices.iter().filter_map(|i| ctx.words.get(*i)).cloned().collect();
    if picked.is_empty() { return Err("ничего не выбрано".into()); }
    let cfg = st.cfg();
    let anki = &cfg.anki;

    connect::call(st, "createDeck", json!({ "deck": anki.deck }), Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
    note_type::ensure(st, &anki.note_type).await.map_err(|e| e.to_string())?;
    let model_fields: Vec<String> = connect::call(st, "modelFieldNames", json!({ "modelName": anki.note_type }), Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let map = fields::resolve(&model_fields, &anki.fields);
    if let Some((name, None)) = map.first() {
        return Err(format!("Первое поле «{name}» типа «{}» ни с чем не сопоставлено — настройте поля Anki", anki.note_type));
    }

    let has = |source: Source| map.iter().any(|(_, s)| *s == Some(source));
    let mode = anki.sentence_audio.as_str();
    let clips_on = anki.clip;
    let need_clip = needs_clip(clips_on, has(Source::Clip), has(Source::SentenceAudio), mode);
    let spec = images::effective(st, &cfg.images).await;
    let need_image = has(Source::Image) && spec.backend != "none";
    let need_word_audio = has(Source::WordAudio) && anki.tts;
    let need_sentence_audio = needs_sentence_audio(has(Source::SentenceAudio), mode, clips_on);

    let cue = cue_meta(st, &ctx.media_id, ctx.cue_idx).await?;
    let name = cue.original_title.clone().unwrap_or_else(|| cue.title.clone());
    let text_one_line = cue.text.replace('\n', " ");
    let (start, end) = (cue.start + cue.offset, cue.end + cue.offset);
    // The speech of this cue, not the subtitle timing, decides where the clip ends.
    if need_clip { progress(st, ctx.id, &ctx.media_id, "clip"); }
    let (start, end) = match clip_source {
        Some((s, audio_index)) if s.probe.get().is_some() && need_clip => {
            speech_window(st, s, audio_index, ctx.cue_idx, &cue.text, start, end, cue.next_start.map(|n| n + cue.offset)).await
        }
        _ => (start, end),
    };
    // The clip's line and source belong to the clip: with the video setting off they stay empty.
    let clip_label = if clips_on { fields::clip_source(&source_label(&name, cue.season, cue.episode, start), &name, cue.year) } else { String::new() };
    let mut warnings = vec![];
    if !clips_on && has(Source::SentenceAudio) && mode == "clip" {
        logs::log("app", "cards: клип выключен — звук предложения из клипа недоступен");
        warnings.push("озвучка предложения из клипа выключена вместе с видео".into());
    }

    // One clip per cue, shared by all its words (one media file in Anki).
    let clip = match clip_source {
        _ if !need_clip => Err("клип не нужен".to_string()),
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
    let mut clip_file: Option<String> = None;
    if need_clip {
        match &clip {
            Ok((path, file_name)) => match tokio::fs::read(path).await {
                Ok(bytes) => match connect::store_media(st, file_name, &bytes).await {
                    Ok(()) => clip_file = Some(file_name.clone()),
                    Err(e) => {
                        logs::log("app", &format!("cards: clip upload failed: {e:#}"));
                        warnings.push(format!("без клипа ({e})"));
                    }
                },
                Err(e) => warnings.push(format!("без клипа ({e})")),
            },
            Err(e) => {
                logs::log("app", &format!("cards: clip for cue {} skipped: {e}", ctx.cue_idx));
                warnings.push(format!("без клипа ({e})"));
            }
        }
    }

    // The clip's own sound as one MP3, stored once per word under that word's media name.
    let clip_mp3: Option<Vec<u8>> = if need_sentence_audio && mode == "clip" && clip.is_ok() {
        match clip_audio(clip.as_ref().unwrap().0.as_path()).await {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                logs::log("app", &format!("cards: clip audio failed: {e}"));
                None
            }
        }
    } else {
        None
    };

    // Pictures: 3 at a time, as tutor did.
    let mut image_files: HashMap<usize, String> = HashMap::new();
    let mut missing_images: Vec<String> = vec![];
    if need_image {
        progress(st, ctx.id, &ctx.media_id, "image");
        let jobs: Vec<(usize, String, String)> = picked
            .iter()
            .enumerate()
            .map(|(i, w)| (i, w.word.clone(), images::prompt(&image_prompt(w), &cfg.images.style, &spec.backend)))
            .collect();
        let jobs = jobs.into_iter().map(|(i, word, prompt)| {
            let st = st.clone();
            let spec = spec.clone();
            async move { (i, word, images::generate(&st, &spec, &prompt).await) }
        });
        for (i, word, r) in stream::iter(jobs).buffered(3).collect::<Vec<_>>().await {
            let path = match r {
                Ok(path) => path,
                Err(e) => {
                    logs::log("app", &format!("cards: image for {word} failed: {e}"));
                    missing_images.push(word);
                    continue;
                }
            };
            let ext = path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "webp".into());
            let name = fields::media_name(&word, &picked[i].full_sentence, &ext);
            let bytes = match tokio::fs::read(&path).await {
                Ok(bytes) => bytes,
                Err(e) => {
                    logs::log("app", &format!("cards: image for {word} unreadable: {e}"));
                    missing_images.push(word);
                    continue;
                }
            };
            match connect::store_media(st, &name, &bytes).await {
                Ok(()) => {
                    image_files.insert(i, name);
                }
                Err(e) => {
                    logs::log("app", &format!("cards: image upload for {word} failed: {e:#}"));
                    missing_images.push(word);
                }
            }
        }
    }

    // Audio: the word always (it autoplays on the back), the sentence by clip or by TTS.
    let tmp = std::env::temp_dir().join(format!("smartsubs-cards-{}", uuid::Uuid::new_v4()));
    let mut word_audio: HashMap<usize, String> = HashMap::new();
    let mut sentence_audio: HashMap<usize, String> = HashMap::new();
    let mut missing_audio: Vec<String> = vec![];
    if need_word_audio || need_sentence_audio {
        progress(st, ctx.id, &ctx.media_id, "audio");
        if let Err(e) = std::fs::create_dir_all(&tmp) {
            logs::log("app", &format!("cards: audio dir: {e}"));
        }
        for (i, w) in picked.iter().enumerate() {
            let mut failed = false;
            if let Some(bytes) = &clip_mp3 {
                let name = fields::media_name(&w.word, clip_file.as_deref().unwrap_or(&w.full_sentence), "mp3");
                match connect::store_media(st, &name, bytes).await {
                    Ok(()) => {
                        sentence_audio.insert(i, name);
                    }
                    Err(e) => {
                        logs::log("app", &format!("cards: sentence audio upload for {} failed: {e:#}", w.word));
                        failed = true;
                    }
                }
            } else if need_sentence_audio && mode == "tts" {
                let name = fields::media_name(&w.word, &w.full_sentence, "mp3");
                match tts_media(st, &w.full_sentence, &anki.tts_voice, &name, &tmp).await {
                    Ok(()) => {
                        sentence_audio.insert(i, name);
                    }
                    Err(e) => {
                        logs::log("app", &format!("cards: sentence audio for {} failed: {e}", w.word));
                        failed = true;
                    }
                }
            } else if need_sentence_audio {
                failed = true;
            }
            if need_word_audio {
                let name = fields::media_name(&w.word, &w.word, "mp3");
                match tts_media(st, &w.word, &anki.tts_voice, &name, &tmp).await {
                    Ok(()) => {
                        word_audio.insert(i, name);
                    }
                    Err(e) => {
                        logs::log("app", &format!("cards: word audio for {} failed: {e}", w.word));
                        failed = true;
                    }
                }
            }
            if failed {
                missing_audio.push(w.word.clone());
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    let tags: Vec<String> = anki.tags.replace("{film}", &fields::slug(&name)).split_whitespace().map(String::from).collect();
    let mut added = 0usize;
    let mut first_error: Option<String> = None;
    progress(st, ctx.id, &ctx.media_id, "anki");
    for (i, w) in picked.iter().enumerate() {
        let span = cloze_inner(&w.cloze_sentence).unwrap_or_else(|| w.word.clone());
        let values = Values {
            word: w.word.clone(),
            translation: w.translation.clone(),
            word_type: w.word_type.clone(),
            cloze_sentence: w.cloze_sentence.clone(),
            sentence: w.full_sentence.clone(),
            sentence_translation: w.sentence_translation.clone(),
            image_file: image_files.get(&i).cloned(),
            word_audio: word_audio.get(&i).cloned(),
            sentence_audio: sentence_audio.get(&i).cloned(),
            clip_file: clip_file.clone(),
            clip_text: if clips_on { fields::clip_text(&text_one_line, word_index(&text_one_line, &span)) } else { String::new() },
            clip_source: clip_label.clone(),
        };
        let mut fields_json = Map::new();
        for (field, source) in &map {
            if let Some(source) = source {
                fields_json.insert(field.clone(), Value::String(values.value(*source)));
            }
        }
        let params = json!({ "note": {
            "deckName": anki.deck,
            "modelName": anki.note_type,
            "fields": fields_json,
            "tags": tags,
            "options": { "allowDuplicate": true },
        } });
        match connect::call(st, "addNote", params, Duration::from_secs(60)).await {
            Ok(_) => added += 1,
            Err(e) => {
                let msg = e.to_string();
                logs::log("app", &format!("cards: addNote for {} failed: {msg}", w.word));
                first_error.get_or_insert_with(|| msg.clone());
                warnings.push(format!("не добавлено: {} ({msg})", w.word));
            }
        }
    }
    if added == 0 {
        return Err(first_error.unwrap_or_else(|| "ни одна карточка не добавлена".into()));
    }
    if !missing_images.is_empty() {
        warnings.push(format!("без картинки: {}", missing_images.join(", ")));
    }
    if !missing_audio.is_empty() {
        warnings.push(format!("без озвучки: {}", missing_audio.join(", ")));
    }
    if anki.sync_after_add {
        progress(st, ctx.id, &ctx.media_id, "sync");
        // The cards are already in Anki; a failed sync must not report the add as failed.
        if let Err(e) = connect::call(st, "sync", json!({}), Duration::from_secs(300)).await {
            logs::log("app", &format!("cards: AnkiWeb sync failed: {e:#}"));
        }
    }
    Ok(Outcome { added, warnings })
}

/// Sentence audio from the movie clip: one MP3 per cue, stored under a per-word media name.
async fn clip_audio(clip: &Path) -> Result<Vec<u8>, String> {
    let out = std::env::temp_dir().join(format!("smartsubs-clip-{}.mp3", uuid::Uuid::new_v4()));
    let o = tokio::time::timeout(
        Duration::from_secs(120),
        tokio::process::Command::new("nice")
            .args(["-n", "10", "ffmpeg", "-v", "error", "-y", "-i"])
            .arg(clip)
            .args(["-vn", "-c:a", "libmp3lame", "-q:a", "4"])
            .arg(&out)
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let bytes = match o {
        Ok(Ok(o)) if o.status.success() => std::fs::read(&out).map_err(|e| e.to_string()),
        Ok(Ok(o)) => Err(format!("ffmpeg: {}", String::from_utf8_lossy(&o.stderr).trim().lines().last().unwrap_or("ошибка"))),
        Ok(Err(e)) => Err(format!("ffmpeg: {e}")),
        Err(_) => Err("ffmpeg: таймаут 120 с".into()),
    };
    let _ = std::fs::remove_file(&out);
    bytes
}

/// TTS into a temp file, then into Anki under `name`.
async fn tts_media(st: &AppState, text: &str, voice: &str, name: &str, dir: &Path) -> Result<(), String> {
    let path = dir.join(name);
    tts::speak(text, voice, &path).await?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    connect::store_media(st, name, &bytes).await.map_err(|e| format!("{e:#}"))
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
    fn the_video_switch_gates_every_clip_consumer() {
        assert!(needs_clip(true, true, false, "none"));
        assert!(!needs_clip(false, true, false, "none"));
        assert!(needs_clip(true, false, true, "clip"));
        assert!(!needs_clip(true, false, true, "tts"));
        assert!(!needs_clip(false, false, true, "clip"));
        assert!(needs_sentence_audio(true, "tts", false));
        assert!(needs_sentence_audio(true, "clip", true));
        assert!(!needs_sentence_audio(true, "clip", false));
        assert!(!needs_sentence_audio(false, "clip", true));
        assert!(!needs_sentence_audio(true, "none", true));
    }

    #[test]
    fn image_prompt_falls_back_to_the_sentence() {
        let w = WordDraft {
            word: "bring".into(),
            translation: "принести".into(),
            word_type: "verb".into(),
            cloze_sentence: "It'll {{c1::bring}} him joy.".into(),
            full_sentence: "It'll bring him joy.".into(),
            sentence_translation: "Это доставит ему радость.".into(),
            image_prompt: "  ".into(),
        };
        assert_eq!(image_prompt(&w), "A scene that shows the meaning of \"bring\" as in: It'll bring him joy.");
        assert_eq!(image_prompt(&WordDraft { image_prompt: "A gift".into(), ..w }), "A gift");
    }
}
