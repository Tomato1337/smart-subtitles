//! Card preparation: clip, AI picture, audio and rendered fields for one captured cue, shared by
//! every job that builds a card. Nothing here adds a note or touches the open session: the caller
//! owns the job, its cancellation and the Anki commit.

use crate::{
    anki::{
        connect,
        fields::{self, Source, Values},
        images, jobs, note_type, tts,
    },
    asr::{self, align},
    config, db::now, logs,
    media::clip,
    state::AppState,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Map;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

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

/// Everything one card needs that does not change while the job runs.
pub struct PreparedCard {
    pub fields: BTreeMap<String, String>,
    pub mapping: Vec<(String, Option<Source>)>,
    pub assets: jobs::JobAssets,
    pub warnings: Vec<String>,
}

/// Image subject when the draft has none: the word as used in its sentence.
pub fn image_prompt(w: &WordDraft) -> String {
    if !w.image_prompt.trim().is_empty() { return w.image_prompt.clone(); }
    format!("A scene that shows the meaning of \"{}\" as in: {}", w.word, w.full_sentence)
}

fn hash(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts { h.update(p.as_bytes()); h.update([0u8]); }
    hex::encode(h.finalize())[..24].to_string()
}

fn asset_file(hash: &str, ext: &str) -> PathBuf {
    config::cache_dir().join("card-assets").join(format!("{hash}.{ext}"))
}

/// Image identity: the subject, the style and the resolved route settings (no keys). A translation
/// edit or an unchanged route keeps the selected picture; a route/subject change invalidates it.
pub fn image_input_hash(subject: &str, style: &str, route: &images::ResolvedRoute) -> String {
    let route_json = serde_json::to_string(&route.specs.iter().map(images::Spec::public_id).collect::<Vec<_>>()).unwrap_or_default();
    hash(&[subject, style, &route_json])
}

/// Word audio depends on the word and the voice only.
fn word_audio_input_hash(word: &str, voice: &str) -> String {
    hash(&["word-audio", word, voice])
}

/// Sentence TTS depends on the sentence, the voice and the mode; its translation never changes it.
fn sentence_audio_input_hash(sentence: &str, voice: &str, mode: &str) -> String {
    hash(&["sentence-audio", sentence, voice, mode])
}

/// Clip-derived sentence audio depends on the actual clip asset, not on the draft's sentence text.
fn clip_audio_input_hash(clip_key: &str) -> String {
    hash(&["clip-audio", clip_key])
}

/// Everything the clip's bytes depend on: captured source, selected tracks, HDR, cue timing and the
/// cue's own words (the refined speech window is a function of those). The URL is hashed, not stored.
fn clip_input_hash(c: &jobs::ClipContext, cue: &jobs::CapturedCue) -> String {
    let start = format!("{:.3}", cue.start);
    let end = format!("{:.3}", cue.end);
    let offset = format!("{:.3}", cue.offset);
    let next = cue.next_start.map(|n| format!("{n:.3}")).unwrap_or_default();
    hash(&[
        "clip",
        &c.source_url,
        &c.audio_index.to_string(),
        &c.video_index.map(|v| v.to_string()).unwrap_or_default(),
        &c.hdr.to_string(),
        &start,
        &end,
        &offset,
        &next,
        &cue.text,
    ])
}

/// Refined speech windows are shared by every card of one cue: the first word pays the ASR work, the
/// rest of the proposal reuses the same content-addressed result.
fn span_cache_path(clip_key: &str) -> PathBuf {
    config::cache_dir().join("card-assets").join(format!("speech-{clip_key}.json"))
}

fn read_span(path: &Path) -> Option<(f64, f64)> {
    let bytes = std::fs::read(path).ok()?;
    let span: [f64; 2] = serde_json::from_slice(&bytes).ok()?;
    let (start, end) = (span[0], span[1]);
    (start.is_finite() && end.is_finite() && start >= 0.0 && end >= start).then_some((start, end))
}

async fn write_span(path: &Path, start: f64, end: f64) {
    let Ok(body) = serde_json::to_vec(&[start, end]) else { return };
    if let Some(parent) = path.parent() {
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return;
        }
    }
    let part = part_path(path);
    if tokio::fs::write(&part, body).await.is_ok() {
        let _ = tokio::fs::rename(&part, path).await;
    } else {
        let _ = tokio::fs::remove_file(&part).await;
    }
}

fn part_path(path: &Path) -> PathBuf {
    let id = uuid::Uuid::new_v4();
    match (path.file_stem().and_then(|s| s.to_str()), path.extension().and_then(|e| e.to_str())) {
        (Some(stem), Some(ext)) => path.with_file_name(format!("{stem}.part-{id}.{ext}")),
        _ => {
            let mut p = path.as_os_str().to_os_string();
            p.push(format!(".part-{id}"));
            PathBuf::from(p)
        }
    }
}

async fn read_file_nonempty(path: &Path) -> Option<Vec<u8>> {
    tokio::fs::read(path).await.ok().filter(|b| !b.is_empty())
}

fn is_image_bytes(bytes: &[u8]) -> bool {
    !bytes.is_empty() && matches!(crate::poster::image_mime(bytes), "image/png" | "image/jpeg" | "image/webp")
}

fn is_mp3(bytes: &[u8]) -> bool {
    bytes.starts_with(b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0)
}

/// Cache and temp paths are private implementation details; an error may mention them, but a job
/// record or notification must not.
fn scrub_paths(text: &str) -> String {
    let mut s = text.to_string();
    for dir in [config::cache_dir(), clip::clips_dir(), std::env::temp_dir()] {
        let p = dir.to_string_lossy();
        if !p.is_empty() {
            s = s.replace(p.as_ref(), "<файл>");
        }
    }
    s
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let part = part_path(path);
    tokio::fs::write(&part, bytes).await?;
    tokio::fs::rename(&part, path).await
}

/// Serialises the ASR-backed refinement so two cards of one proposal cannot both transcribe the
/// same cue before either writes the shared cache entry.
static SPAN_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> = std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Window of the cue's actual speech: whisper over ±2 s around the cue, then the span of the cue's own
/// words. Any failure keeps the plain cue window — a card without a refined clip is better than none.
#[allow(clippy::too_many_arguments)]
async fn speech_window(
    st: &AppState,
    src: &str,
    audio_index: u32,
    cue_idx: u32,
    text: &str,
    start: f64,
    end: f64,
    next_start: Option<f64>,
    clip_key: &str,
    cancel: &CancellationToken,
) -> (f64, f64) {
    let cached = span_cache_path(clip_key);
    if let Some(span) = read_span(&cached) {
        return span;
    }
    let _guard = tokio::select! {
        _ = cancel.cancelled() => {
            logs::log("app", &format!("cards: speech window for cue {cue_idx} cancelled"));
            return (start, end);
        }
        guard = SPAN_LOCK.lock() => guard,
    };
    if let Some(span) = read_span(&cached) {
        return span;
    }
    let a = (start - 2.0).max(0.0);
    let dur = (end - start + 4.0).min(16.0);
    // A card must not wait behind a running film-wide probe (up to 10 min of transcription). The
    // child token cancels the ASR processes and is awaited briefly, so their groups are killed
    // before this future is dropped.
    let stop = cancel.child_token();
    let work = async {
        let tmp = asr::pcm_temp()?;
        asr::extract_pcm_cancellable(src, audio_index, a, dur, &tmp.0, &stop).await?;
        let mut words = asr::transcribe_cancellable(st, &[tmp.0.clone()], &stop)
            .await?
            .into_iter()
            .next()
            .unwrap_or_default();
        for w in &mut words {
            w.start += a;
            w.end += a;
        }
        Ok::<_, anyhow::Error>(align::speech_span(text, &words))
    };
    tokio::pin!(work);
    let mut timed_out = false;
    let mut cancelled = false;
    let span = tokio::select! {
        r = &mut work => r,
        _ = tokio::time::sleep(Duration::from_secs(120)) => {
            timed_out = true;
            Err(anyhow::anyhow!("таймаут распознавания"))
        }
        _ = cancel.cancelled() => {
            cancelled = true;
            Err(anyhow::anyhow!("отменено"))
        }
    };
    if timed_out || cancelled {
        stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), work.as_mut()).await;
    }
    let span = match span {
        Ok(span) => span,
        Err(_) if timed_out => {
            logs::log("app", &format!("cards: speech window for cue {cue_idx} not found: таймаут распознавания"));
            return (start, end);
        }
        Err(_) if cancelled => {
            logs::log("app", &format!("cards: speech window for cue {cue_idx} cancelled"));
            return (start, end);
        }
        Err(e) => {
            logs::log("app", &format!("cards: speech window for cue {cue_idx} not found: {e}"));
            return (start, end);
        }
    };
    let (s0, e0) = match span {
        Some(span) => span,
        None => {
            logs::log("app", &format!("cards: speech window for cue {cue_idx} not found: no words matched"));
            return (start, end);
        }
    };
    write_span(&cached, s0, e0).await;
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

/// The values one card renders from a captured cue, a draft and its selected assets.
pub fn render_values(context: &jobs::JobContext, draft: &WordDraft, assets: &jobs::JobAssets) -> Values {
    let cue = &context.cue;
    let media = &context.media;
    let name = media.original_title.clone().unwrap_or_else(|| media.title.clone());
    let text_one_line = cue.text.replace('\n', " ");
    let start = cue.start + cue.offset;
    let span = cloze_inner(&draft.cloze_sentence).unwrap_or_else(|| draft.word.clone());
    let file_name = |slot: &Option<jobs::AssetSlot>| slot.as_ref().filter(|s| s.status == "ready").and_then(|s| s.file_name.clone());
    Values {
        word: draft.word.clone(),
        translation: draft.translation.clone(),
        word_type: draft.word_type.clone(),
        cloze_sentence: draft.cloze_sentence.clone(),
        sentence: draft.full_sentence.clone(),
        sentence_translation: draft.sentence_translation.clone(),
        image_file: file_name(&assets.image),
        word_audio: file_name(&assets.word_audio),
        sentence_audio: file_name(&assets.sentence_audio),
        clip_file: file_name(&assets.clip),
        clip_text: if context.anki.clip { fields::clip_text(&text_one_line, word_index(&text_one_line, &span)) } else { String::new() },
        clip_source: if context.anki.clip {
            fields::clip_source(&source_label(&name, media.season, media.episode, start), &name, media.year)
        } else {
            String::new()
        },
    }
}

/// How a missing audio asset is produced: TTS from text, or transcoding the selected clip.
enum AudioProduce {
    Tts { text: String, voice: String },
    Clip { path: PathBuf },
}

/// Reuses or creates one audio asset. A ready asset with an uploaded file is reused even when the
/// local cache is gone (restored through `retrieveMediaFile` for preview). A ready asset with only a
/// local file retries just the upload. An unchanged failed asset is never regenerated silently.
async fn ensure_audio(
    client: &connect::Client<'_>,
    cancel: &CancellationToken,
    prior: Option<&jobs::AssetSlot>,
    input: &str,
    file_name: &str,
    cache_path: &Path,
    produce: AudioProduce,
    what: &str,
) -> Result<(Option<String>, Option<jobs::AssetSlot>, Option<String>), jobs::JobError> {
    use jobs::{AssetSlot, JobError};
    let same = prior.filter(|s| s.input_hash == input);
    if let Some(s) = same {
        if s.status == "failed" {
            let msg = s.error.clone().map(|e| format!("{what} ({e})")).unwrap_or_else(|| what.to_string());
            return Ok((None, Some(s.clone()), Some(msg)));
        }
        if s.status == "ready" {
            let mut slot = s.clone();
            let local = match slot.cache_path.as_deref() {
                Some(p) => read_file_nonempty(Path::new(p)).await.filter(|b| is_mp3(b)),
                None => None,
            };
            if let Some(file) = slot.file_name.clone() {
                if local.is_none() {
                    match client.retrieve_media(&file).await {
                        Ok(bytes) if !bytes.is_empty() => {
                            if write_atomic(cache_path, &bytes).await.is_ok() {
                                slot.cache_path = Some(cache_path.to_string_lossy().into_owned());
                            }
                        }
                        _ => return Ok((Some(file), Some(slot), Some(format!("{what} (файл не прочитан из Anki)")))),
                    }
                }
                return Ok((Some(file), Some(slot), None));
            }
            if let Some(bytes) = local {
                match upload_bytes(client, file_name, &bytes, cancel).await {
                    Ok(()) => {
                        slot.file_name = Some(file_name.to_string());
                        return Ok((Some(file_name.to_string()), Some(slot), None));
                    }
                    Err(JobError::Cancelled) => return Err(JobError::Cancelled),
                    Err(e) => {
                        let msg = job_msg(e);
                        logs::log("app", &format!("cards: {what} upload failed: {msg}"));
                        slot.error = Some(msg.clone());
                        return Ok((None, Some(slot), Some(format!("{what} ({msg})"))));
                    }
                }
            }
            // Neither a local file nor an uploaded name: explicit warning; do not regenerate behind
            // the user's back. `cards_job_image`-style explicit actions are the retry path.
            slot.status = "failed".into();
            slot.error = Some("файл не найден".into());
            return Ok((None, Some(slot), Some(format!("{what} (файл не найден)"))));
        }
    }
    let failed = |msg: String| AssetSlot {
        input_hash: input.to_string(),
        status: "failed".into(),
        cache_path: None,
        file_name: None,
        provider: None,
        model: None,
        error: Some(msg),
    };
    let bytes = match produce {
        AudioProduce::Tts { text, voice } => match cached_tts(&text, &voice, cancel, cache_path).await {
            Ok(b) => b,
            Err(JobError::Cancelled) => return Err(JobError::Cancelled),
            Err(e) => {
                let msg = job_msg(e);
                logs::log("app", &format!("cards: {what} failed: {msg}"));
                return Ok((None, Some(failed(msg.clone())), Some(format!("{what} ({msg})"))));
            }
        },
        AudioProduce::Clip { path } => match clip_audio(&path, cache_path, cancel).await {
            Ok(()) => match read_file_nonempty(cache_path).await {
                Some(b) => b,
                None => return Ok((None, Some(failed("файл озвучки пуст".into())), Some(format!("{what} (файл озвучки пуст)")))),
            },
            Err(JobError::Cancelled) => return Err(JobError::Cancelled),
            Err(e) => {
                let msg = job_msg(e);
                logs::log("app", &format!("cards: {what} failed: {msg}"));
                return Ok((None, Some(failed(msg.clone())), Some(format!("{what} ({msg})"))));
            }
        },
    };
    if !is_mp3(&bytes) {
        return Ok((None, Some(failed("файл озвучки повреждён".into())), Some(format!("{what} (файл озвучки повреждён)"))));
    }
    let mut slot = AssetSlot {
        input_hash: input.to_string(),
        status: "ready".into(),
        cache_path: Some(cache_path.to_string_lossy().into_owned()),
        file_name: None,
        provider: None,
        model: None,
        error: None,
    };
    match upload_bytes(client, file_name, &bytes, cancel).await {
        Ok(()) => {
            slot.file_name = Some(file_name.to_string());
            Ok((Some(file_name.to_string()), Some(slot), None))
        }
        Err(JobError::Cancelled) => Err(JobError::Cancelled),
        Err(e) => {
            let msg = job_msg(e);
            logs::log("app", &format!("cards: {what} upload failed: {msg}"));
            slot.error = Some(msg.clone());
            Ok((None, Some(slot), Some(format!("{what} ({msg})"))))
        }
    }
}

/// Local copy of the selected clip, restored from Anki when only the uploaded file remains.
async fn local_clip(
    client: &connect::Client<'_>,
    slot: Option<&jobs::AssetSlot>,
) -> Result<Option<PathBuf>, jobs::JobError> {
    let Some(slot) = slot else { return Ok(None) };
    if let Some(path) = slot.cache_path.as_deref() {
        if tokio::fs::read(path).await.ok().is_some_and(|b| clip::is_webm(&b)) {
            return Ok(Some(PathBuf::from(path)));
        }
    }
    if let Some(name) = &slot.file_name {
        let path = clip::clips_dir().join(name);
        match client.retrieve_media(name).await {
            Ok(bytes) if clip::is_webm(&bytes) => {
                write_atomic(&path, &bytes).await.map_err(|e| jobs::JobError::Failed(format!("клип: {e}")))?;
                return Ok(Some(path));
            }
            _ => {}
        }
    }
    Ok(None)
}

/// Builds every asset and renders the owned fields for one captured cue. Reuses an asset whose input
/// hash did not change; a failed unchanged generation is not retried silently.
pub async fn prepare(
    st: &Arc<AppState>,
    context: &jobs::JobContext,
    draft: &WordDraft,
    prior: &jobs::JobAssets,
    cancel: &CancellationToken,
    progress: &(dyn Fn(&str) + Send + Sync),
) -> Result<PreparedCard, jobs::JobError> {
    use jobs::{AssetSlot, JobError};
    let anki = &context.anki;
    let client = connect::Client::new(&st.http, &anki.url);
    client
        .create_deck(&anki.deck)
        .await
        .map_err(|e| JobError::Failed(format!("Anki: {e}")))?;
    note_type::ensure(&client, &anki.note_type).await.map_err(|e| JobError::Failed(format!("Anki: {e:#}")))?;
    let model_fields = client.model_field_names(&anki.note_type).await.map_err(|e| JobError::Failed(format!("Anki: {e}")))?;
    let map = fields::resolve(&model_fields, &anki.fields);
    if let Some((name, None)) = map.first() {
        return Err(JobError::Failed(format!(
            "Первое поле «{name}» типа «{}» ни с чем не сопоставлено — настройте поля Anki",
            anki.note_type
        )));
    }

    let has = |source: Source| map.iter().any(|(_, s)| *s == Some(source));
    let mode = anki.sentence_audio.as_str();
    let clips_on = anki.clip;
    let need_clip = needs_clip(clips_on, has(Source::Clip), has(Source::SentenceAudio), mode);
    let need_word_audio = has(Source::WordAudio) && anki.tts;
    let need_sentence_audio = needs_sentence_audio(has(Source::SentenceAudio), mode, clips_on);
    let cfg = st.cfg();
    let route = images::resolve_route(st, &cfg.images, &cfg.tutor).await.map_err(|e| jobs::JobError::Failed(e.public_text()))?;
    let image_subject = image_prompt(draft);
    let need_image = has(Source::Image) && !route.disabled();

    let cue = &context.cue;
    let (start, end) = (cue.start + cue.offset, cue.end + cue.offset);
    let mut warnings: Vec<String> = vec![];
    let mut assets = jobs::JobAssets::default();

    if !clips_on && has(Source::SentenceAudio) && mode == "clip" {
        logs::log("app", "cards: клип выключен — звук предложения из клипа недоступен");
        warnings.push("озвучка предложения из клипа выключена вместе с видео".into());
    }

    // ---- clip ---------------------------------------------------------------------------------
    let clip_input = context.clip.as_ref().map(|c| clip_input_hash(c, cue));
    let mut clip_slot: Option<jobs::AssetSlot> = None;
    if need_clip {
        progress("clip");
        match (&context.clip, &clip_input) {
            (Some(c), Some(h)) => {
                // The stored URL never carries credentials; they are applied only here, when used.
                let src = cfg.with_auth(&c.source_url);
                if let Some(slot) = prior.clip.as_ref().filter(|s| &s.input_hash == h) {
                    if slot.status == "failed" {
                        let msg = slot.error.clone().map(|e| format!("без клипа ({e})")).unwrap_or_else(|| "без клипа".into());
                        warnings.push(msg);
                        clip_slot = Some(slot.clone());
                    } else if slot.status == "ready" {
                        let mut slot = slot.clone();
                        if let Some(file) = slot.file_name.clone() {
                            let local_exists = match slot.cache_path.as_deref() {
                                Some(p) => tokio::fs::metadata(p).await.map(|m| m.len() > 0).unwrap_or(false),
                                None => false,
                            };
                            if !local_exists {
                                if let Ok(bytes) = client.retrieve_media(&file).await {
                                    if clip::is_webm(&bytes) {
                                        let path = clip::clips_dir().join(&file);
                                        if write_atomic(&path, &bytes).await.is_ok() {
                                            slot.cache_path = Some(path.to_string_lossy().into_owned());
                                        }
                                    }
                                }
                            }
                        } else if let Some(bytes) = match slot.cache_path.as_deref() {
                            Some(p) => tokio::fs::read(p).await.ok().filter(|b| clip::is_webm(b)),
                            _ => None,
                        } {
                            // A ready local clip without a confirmed upload: retry only the upload.
                            let file_name = match slot.cache_path.as_deref() {
                                Some(p) => Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| format!("smartsubs_{}.webm", &h[..16])),
                                None => format!("smartsubs_{}.webm", &h[..16]),
                            };
                            match upload_bytes(&client, &file_name, &bytes, cancel).await {
                                Ok(()) => slot.file_name = Some(file_name),
                                Err(JobError::Cancelled) => return Err(JobError::Cancelled),
                                Err(e) => {
                                    let msg = job_msg(e);
                                    logs::log("app", &format!("cards: clip upload failed: {msg}"));
                                    warnings.push(format!("без клипа ({msg})"));
                                    slot.error = Some(msg);
                                }
                            }
                        } else {
                            slot.status = "failed".into();
                            slot.error = Some("файл не найден".into());
                            warnings.push("без клипа (файл не найден)".into());
                        }
                        clip_slot = Some(slot);
                    }
                }
                if clip_slot.is_none() {
                    // The speech of this cue, not the subtitle timing, decides where the clip ends.
                    let (s0, e0) = if c.video_index.is_some() {
                        speech_window(
                            st,
                            &src,
                            c.audio_index,
                            context.cue_idx,
                            &cue.text,
                            start,
                            end,
                            cue.next_start.map(|n| n + cue.offset),
                            h,
                            cancel,
                        )
                        .await
                    } else {
                        (start, end)
                    };
                    if cancel.is_cancelled() {
                        return Err(JobError::Cancelled);
                    }
                    let file_name = format!("smartsubs_{}.webm", &h[..16]);
                    let spec = clip::ClipSpec { src: &src, video_index: c.video_index.unwrap_or(0), audio_index: c.audio_index, start: s0, end: e0, hdr: c.hdr };
                    match clip::make(&spec, &file_name, cancel).await {
                        Ok(path) => {
                            let mut slot = AssetSlot {
                                input_hash: h.clone(),
                                status: "ready".into(),
                                cache_path: Some(path.to_string_lossy().into_owned()),
                                file_name: None,
                                provider: None,
                                model: None,
                                error: None,
                            };
                            match upload(&client, &path, &file_name, None, cancel).await {
                                Ok(()) => slot.file_name = Some(file_name),
                                Err(JobError::Cancelled) => return Err(JobError::Cancelled),
                                Err(e) => {
                                    let msg = job_msg(e);
                                    logs::log("app", &format!("cards: clip upload failed: {msg}"));
                                    warnings.push(format!("без клипа ({msg})"));
                                    slot.error = Some(msg);
                                }
                            }
                            clip_slot = Some(slot);
                        }
                        Err(e) if cancel.is_cancelled() => {
                            logs::log("app", &format!("cards: clip cancelled: {e:#}"));
                            return Err(JobError::Cancelled);
                        }
                        Err(e) => {
                            let msg = images::scrub_text(&format!("{e:#}"), &route);
                            logs::log("app", &format!("cards: clip for cue {} skipped: {msg}", context.cue_idx));
                            warnings.push(format!("без клипа ({msg})"));
                            clip_slot = Some(AssetSlot {
                                input_hash: h.clone(),
                                status: "failed".into(),
                                cache_path: None,
                                file_name: None,
                                provider: None,
                                model: None,
                                error: Some(msg),
                            });
                        }
                    }
                }
            }
            (None, _) => warnings.push("без клипа (фильм уже закрыт или видео не распознано)".into()),
            _ => {}
        }
    }
    assets.clip = clip_slot;

    // ---- picture ------------------------------------------------------------------------------
    let image_hash = image_input_hash(&image_subject, &context.image_style, &route);
    if need_image {
        progress("image");
        let unchanged = prior.image.as_ref().filter(|s| s.input_hash == image_hash);
        let mut slot = match unchanged {
            Some(s) if s.status == "failed" => {
                // An unchanged failed picture is not generated again behind the user's back.
                warnings.push(s.error.clone().map(|e| format!("без картинки ({e})")).unwrap_or_else(|| "без картинки".into()));
                Some(s.clone())
            }
            Some(s) if s.status == "ready" => Some(s.clone()),
            _ => None,
        };
        if let Some(s) = slot.as_ref().filter(|s| s.status == "ready") {
            let mut updated = s.clone();
            if let Some(file_name) = s.file_name.clone() {
                let local_exists = match s.cache_path.as_deref() {
                    Some(p) => tokio::fs::metadata(p).await.map(|m| m.len() > 0).unwrap_or(false),
                    None => false,
                };
                if !local_exists {
                    // The uploaded file is the authority. Restore the local copy when Anki can give it
                    // back, so the editor preview and later submissions do not depend on this disk.
                    match client.retrieve_media(&file_name).await {
                        Ok(bytes) if !bytes.is_empty() => {
                            let ext = match crate::poster::image_mime(&bytes) {
                                "image/png" => "png",
                                "image/jpeg" => "jpg",
                                _ => "webp",
                            };
                            // Reuse the original provider cache path when known: `CardJob.image.key`
                            // projects its file stem, and restoring it into card-assets would lose it.
                            let path = match updated.cache_path.clone() {
                                Some(p) => PathBuf::from(p),
                                None => asset_file(&image_hash, ext),
                            };
                            if write_atomic(&path, &bytes).await.is_ok() {
                                updated.cache_path = Some(path.to_string_lossy().into_owned());
                            }
                        }
                        _ => {
                            // The note can still reference the uploaded media; only the local preview
                            // is missing until the next successful retrieval.
                            warnings.push("без картинки (файл не прочитан из Anki)".into());
                        }
                    }
                }
                slot = Some(updated);
            } else {
                let local = match s.cache_path.as_deref() {
                    Some(p) => tokio::fs::read(p).await.ok().filter(|b| is_image_bytes(b)),
                    None => None,
                };
                if let Some(bytes) = local {
                    // A ready local result without a confirmed upload: this explicit submission retries only the upload.
                    let ext = s
                        .cache_path
                        .as_deref()
                        .and_then(|p| Path::new(p).extension().map(|e| e.to_string_lossy().into_owned()))
                        .unwrap_or_else(|| "webp".into());
                    let file_name = fields::media_name(&draft.word, &format!("{image_hash}:{}", &image_hash[..8]), &ext);
                    match upload_bytes(&client, &file_name, &bytes, cancel).await {
                        Ok(()) => {
                            updated.file_name = Some(file_name);
                            updated.error = None;
                        }
                        Err(JobError::Cancelled) => return Err(JobError::Cancelled),
                        Err(e) => {
                            let msg = job_msg(e);
                            updated.error = Some(msg.clone());
                            warnings.push(format!("без картинки ({msg})"));
                        }
                    }
                } else {
                    updated.status = "failed".into();
                    updated.error = Some("файл не найден".into());
                    warnings.push("без картинки (файл не найден)".into());
                }
                slot = Some(updated);
            }
        }
        if slot.is_none() && unchanged.is_none() {
            // Provider and attempt travel through the phase channel as `img<TAB>provider<TAB>attempt`.
            let attempt = |provider: &str, n: u8| progress(&format!("img\t{provider}\t{n}"));
            match images::generate(st, &route, &image_subject, cancel, Some(&attempt)).await {
                Ok(asset) => {
                    let ext = asset.path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "webp".into());
                    let file_name = fields::media_name(&draft.word, &format!("{image_hash}:{}", asset.key), &ext);
                    let mut s = AssetSlot {
                        input_hash: image_hash.clone(),
                        status: "ready".into(),
                        cache_path: Some(asset.path.to_string_lossy().into_owned()),
                        file_name: None,
                        provider: Some(asset.provider),
                        model: Some(asset.model),
                        error: None,
                    };
                    match upload(&client, &asset.path, &file_name, Some(&image_hash), cancel).await {
                        Ok(()) => {
                            s.file_name = Some(file_name.clone());
                        }
                        Err(JobError::Cancelled) => return Err(JobError::Cancelled),
                        Err(e) => {
                            let msg = job_msg(e);
                            logs::log("app", &format!("cards: image upload failed: {msg}"));
                            warnings.push(format!("без картинки ({msg})"));
                            s.error = Some(msg);
                        }
                    }
                    slot = Some(s);
                }
                Err(e) if e.kind == images::ImageErrorKind::Cancelled => return Err(JobError::Cancelled),
                Err(e) if e.kind == images::ImageErrorKind::ProviderConfig => {
                    // No provider was ready (missing key/model) rather than a failed generation: keep
                    // the slot unattempted so a later configured submission can try, still without a call now.
                    let msg = e.public_text();
                    logs::log("app", &format!("cards: image skipped: {msg}"));
                    warnings.push(format!("без картинки ({msg})"));
                    slot = None;
                }
                Err(e) => {
                    let msg = e.public_text();
                    logs::log("app", &format!("cards: image failed: {msg}"));
                    warnings.push(format!("без картинки ({msg})"));
                    slot = Some(AssetSlot { input_hash: image_hash.clone(), status: "failed".into(), cache_path: None, file_name: None, provider: Some(e.provider), model: None, error: Some(msg) });
                }
            }
        }
        assets.image = slot;
    }

    // ---- audio --------------------------------------------------------------------------------
    if need_word_audio || need_sentence_audio {
        progress("audio");
    }
    if need_sentence_audio {
        let input = if mode == "clip" {
            assets
                .clip
                .as_ref()
                .filter(|s| !s.input_hash.is_empty())
                .map(|s| clip_audio_input_hash(&s.input_hash))
        } else {
            Some(sentence_audio_input_hash(&draft.full_sentence, &anki.tts_voice, mode))
        };
        match input {
            Some(input) => {
                let cache_path = asset_file(&input, "mp3");
                let file_name = fields::media_name(&draft.word, &format!("{input}:{mode}"), "mp3");
                let produce = if mode == "clip" {
                    match local_clip(&client, assets.clip.as_ref()).await? {
                        Some(path) => Some(AudioProduce::Clip { path }),
                        None => None,
                    }
                } else {
                    Some(AudioProduce::Tts { text: draft.full_sentence.clone(), voice: anki.tts_voice.clone() })
                };
                if let Some(produce) = produce {
                    let (_file, slot, warning) =
                        ensure_audio(&client, cancel, prior.sentence_audio.as_ref(), &input, &file_name, &cache_path, produce, "без озвучки предложения").await?;
                    if let Some(w) = warning {
                        warnings.push(w);
                    }
                    assets.sentence_audio = slot;
                } else {
                    warnings.push("без озвучки предложения (клип недоступен)".into());
                }
            }
            None => warnings.push("без озвучки предложения (клип недоступен)".into()),
        }
    }
    if need_word_audio {
        let input = word_audio_input_hash(&draft.word, &anki.tts_voice);
        let cache_path = asset_file(&input, "mp3");
        let file_name = fields::media_name(&draft.word, &format!("{input}:{}", anki.tts_voice), "mp3");
        let produce = AudioProduce::Tts { text: draft.word.clone(), voice: anki.tts_voice.clone() };
        let (_file, slot, warning) =
            ensure_audio(&client, cancel, prior.word_audio.as_ref(), &input, &file_name, &cache_path, produce, "без озвучки слова").await?;
        if let Some(w) = warning {
            warnings.push(w);
        }
        assets.word_audio = slot;
    }

    // ---- fields -------------------------------------------------------------------------------
    progress("anki");
    let values = render_values(context, draft, &assets);
    let mut out: Map<String, serde_json::Value> = Map::new();
    for (field, source) in &map {
        if let Some(source) = source {
            out.insert(field.clone(), serde_json::Value::String(values.value(*source)));
        }
    }
    let fields: BTreeMap<String, String> = out.into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string()))).collect();
    for slot in [assets.image.as_mut(), assets.word_audio.as_mut(), assets.sentence_audio.as_mut(), assets.clip.as_mut()]
        .into_iter()
        .flatten()
    {
        if let Some(error) = &mut slot.error {
            *error = images::scrub_text(&scrub_paths(error), &route);
        }
    }
    let warnings = warnings.into_iter().map(|w| images::scrub_text(&scrub_paths(&w), &route)).collect();
    Ok(PreparedCard { fields, mapping: map, assets, warnings })
}

/// Uploads one local file under `file_name`; the salt of the name is the content hash, so editing one
/// picture or audio never overwrites media another note uses.
async fn upload(
    client: &connect::Client<'_>,
    path: &Path,
    file_name: &str,
    _hash: Option<&str>,
    cancel: &CancellationToken,
) -> Result<(), jobs::JobError> {
    let bytes = tokio::select! {
        _ = cancel.cancelled() => return Err(jobs::JobError::Cancelled),
        r = tokio::fs::read(path) => r.map_err(|e| jobs::JobError::Failed(format!("файл не читается: {e}")))?,
    };
    upload_bytes(client, file_name, &bytes, cancel).await
}

async fn upload_bytes(
    client: &connect::Client<'_>,
    file_name: &str,
    bytes: &[u8],
    cancel: &CancellationToken,
) -> Result<(), jobs::JobError> {
    tokio::select! {
        _ = cancel.cancelled() => Err(jobs::JobError::Cancelled),
        r = client.store_media(file_name, bytes) => r.map_err(|e| jobs::JobError::Failed(format!("Anki: {e}"))),
    }
}

fn job_msg(e: jobs::JobError) -> String {
    match e {
        jobs::JobError::Cancelled => "отменено".into(),
        jobs::JobError::Failed(m) | jobs::JobError::Conflict(m) => m,
    }
}

/// TTS into a content-addressed card-assets file; an existing file is reused without calling edge-tts.
/// The file is published by an atomic rename only after a successful, nonempty render.
async fn cached_tts(
    text: &str,
    voice: &str,
    cancel: &CancellationToken,
    path: &Path,
) -> Result<Vec<u8>, jobs::JobError> {
    if cancel.is_cancelled() {
        return Err(jobs::JobError::Cancelled);
    }
    if let Some(bytes) = read_file_nonempty(path).await {
        return Ok(bytes);
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| jobs::JobError::Failed(format!("каталог озвучки: {e}")))?;
    }
    let part = part_path(path);
    match tts::speak(text, voice, &part, cancel).await {
        Ok(()) => {
            let bytes = read_file_nonempty(&part)
                .await
                .ok_or_else(|| jobs::JobError::Failed("озвучка: пустой файл".into()))?;
            if let Err(e) = tokio::fs::rename(&part, path).await {
                let _ = tokio::fs::remove_file(&part).await;
                return Err(jobs::JobError::Failed(format!("озвучка: {e}")));
            }
            Ok(bytes)
        }
        Err(e) if cancel.is_cancelled() => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(jobs::JobError::Cancelled)
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(jobs::JobError::Failed(e))
        }
    }
}

/// The clip's own sound as one MP3 in the content-addressed card-assets directory. The output is
/// published atomically; cancellation/timeout kills the ffmpeg group and removes the partial file.
async fn clip_audio(clip: &Path, out: &Path, cancel: &CancellationToken) -> Result<(), jobs::JobError> {
    if cancel.is_cancelled() {
        return Err(jobs::JobError::Cancelled);
    }
    if read_file_nonempty(out).await.is_some() {
        return Ok(());
    }
    if let Some(parent) = out.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| jobs::JobError::Failed(format!("каталог озвучки: {e}")))?;
    }
    let part = part_path(out);
    let mut cmd = crate::proc::background("ffmpeg");
    cmd.args(["-v", "error", "-y", "-i"])
        .arg(clip)
        .args(["-vn", "-c:a", "libmp3lame", "-q:a", "4"])
        .arg(&part);
    let o = match crate::proc::output_cancellable(cmd, Duration::from_secs(120), cancel).await {
        Ok(o) => o,
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(match e {
                crate::proc::ProcessError::Cancelled => jobs::JobError::Cancelled,
                other => jobs::JobError::Failed(format!("ffmpeg: {other}")),
            });
        }
    };
    if !o.status.success() {
        let _ = tokio::fs::remove_file(&part).await;
        let e = String::from_utf8_lossy(&o.stderr).into_owned();
        return Err(jobs::JobError::Failed(format!("ffmpeg: {}", e.trim().lines().last().unwrap_or("ошибка"))));
    }
    if read_file_nonempty(&part).await.is_none() {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(jobs::JobError::Failed("ffmpeg: пустой файл".into()));
    }
    if let Err(e) = tokio::fs::rename(&part, out).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(jobs::JobError::Failed(format!("ffmpeg: {e}")));
    }
    Ok(())
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

    fn spec(model: &str, base: &str) -> images::Spec {
        images::Spec {
            backend: "openai".into(),
            model: model.into(),
            base_url: base.into(),
            api_key: "k".into(),
            size: "1024x1024".into(),
            agent_model: String::new(),
            inherited: false,
        }
    }

    fn route(model: &str, base: &str) -> images::ResolvedRoute {
        images::ResolvedRoute { specs: vec![spec(model, base)], style: String::new() }
    }

    #[test]
    fn image_identity_follows_subject_style_and_route_only() {
        let base = image_input_hash("A dog", "", &route("m", "https://a.example"));
        assert_eq!(base, image_input_hash("A dog", "", &route("m", "https://a.example")));
        assert_ne!(base, image_input_hash("A cat", "", &route("m", "https://a.example")));
        assert_ne!(base, image_input_hash("A dog", "photo", &route("m", "https://a.example")));
        assert_ne!(base, image_input_hash("A dog", "", &route("other", "https://a.example")));
        assert_ne!(base, image_input_hash("A dog", "", &route("m", "https://b.example")));
        // A translation is not part of the image input.
        let translated = WordDraft {
            translation: "собака".into(),
            ..WordDraft {
                word: "dog".into(),
                translation: String::new(),
                word_type: "noun".into(),
                cloze_sentence: "A {{c1::dog}}".into(),
                full_sentence: "A dog".into(),
                sentence_translation: "Собака".into(),
                image_prompt: "A dog".into(),
            }
        };
        assert_eq!(image_prompt(&translated), "A dog");
    }

    #[test]
    fn audio_identity_separates_voice_and_clip_source() {
        let word = word_audio_input_hash("dog", "en-US-A");
        assert_eq!(word, word_audio_input_hash("dog", "en-US-A"));
        assert_ne!(word, word_audio_input_hash("cat", "en-US-A"));
        assert_ne!(word, word_audio_input_hash("dog", "en-GB-B"));
        let sentence = sentence_audio_input_hash("A dog.", "en-US-A", "tts");
        assert_ne!(sentence, sentence_audio_input_hash("A cat.", "en-US-A", "tts"));
        assert_ne!(sentence, sentence_audio_input_hash("A dog.", "en-GB-B", "tts"));
        assert_ne!(sentence, sentence_audio_input_hash("A dog.", "en-US-A", "clip"));
        // Clip-derived audio is keyed by the clip, not by the sentence text.
        let clip = clip_audio_input_hash("clip-key-1");
        assert_eq!(clip, clip_audio_input_hash("clip-key-1"));
        assert_ne!(clip, clip_audio_input_hash("clip-key-2"));
    }

    #[test]
    fn clip_identity_covers_source_tracks_hdr_and_captured_cue() {
        let cue = jobs::CapturedCue {
            start: 10.0,
            end: 12.0,
            text: "A dog.".into(),
            offset: 0.0,
            next_start: Some(20.0),
            chunk_fallback: None,
        };
        let clip = jobs::ClipContext { source_url: "https://example/film.mkv".into(), audio_index: 1, video_index: Some(0), hdr: false };
        let base = clip_input_hash(&clip, &cue);
        assert_eq!(base, clip_input_hash(&clip, &cue.clone()));
        assert_ne!(base, clip_input_hash(&jobs::ClipContext { audio_index: 2, ..clip.clone() }, &cue));
        assert_ne!(base, clip_input_hash(&jobs::ClipContext { video_index: None, ..clip.clone() }, &cue));
        assert_ne!(base, clip_input_hash(&jobs::ClipContext { hdr: true, ..clip.clone() }, &cue));
        assert_ne!(base, clip_input_hash(&jobs::ClipContext { source_url: "https://example/other.mkv".into(), ..clip.clone() }, &cue));
        assert_ne!(base, clip_input_hash(&clip, &jobs::CapturedCue { text: "A cat.".into(), ..cue.clone() }));
        assert_ne!(base, clip_input_hash(&clip, &jobs::CapturedCue { start: 10.5, ..cue.clone() }));
        assert_ne!(base, clip_input_hash(&clip, &jobs::CapturedCue { next_start: None, ..cue.clone() }));
    }

    #[tokio::test]
    async fn a_refined_span_is_shared_through_its_cache_file() {
        let dir = std::env::temp_dir().join(format!("smartsubs-span-{}", uuid::Uuid::new_v4()));
        let path = dir.join("speech.json");
        assert_eq!(read_span(&path), None);
        write_span(&path, 10.25, 11.75).await;
        assert_eq!(read_span(&path), Some((10.25, 11.75)));
        // A corrupted or nonsensical cache entry is rejected, never trusted as a span.
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(read_span(&path), None);
        std::fs::write(&path, b"[12.0,3.0]").unwrap();
        assert_eq!(read_span(&path), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_ready_cached_audio_retries_only_its_upload() {
        use axum::{routing::post, Json, Router};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let app = Router::new().route(
            "/",
            post(move |Json(_v): Json<serde_json::Value>| {
                let c = c.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    Json(serde_json::json!({ "result": null, "error": "boom" }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let dir = std::env::temp_dir().join(format!("smartsubs-audio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cache_path = dir.join("audio.mp3");
        std::fs::write(&cache_path, b"ID3fake").unwrap();
        let base = format!("http://{addr}");
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &base);
        let produce = || AudioProduce::Tts { text: "word".into(), voice: "en-US-A".into() };
        let first = ensure_audio(&client, &CancellationToken::new(), None, "input", "word.mp3", &cache_path, produce(), "без озвучки слова").await.unwrap();
        assert!(first.0.is_none(), "the failed upload leaves no Anki filename");
        assert_eq!(first.1.as_ref().unwrap().status, "ready");
        assert!(first.2.unwrap().contains("boom"));
        let prior = first.1.unwrap();
        let second = ensure_audio(&client, &CancellationToken::new(), Some(&prior), "input", "word.mp3", &cache_path, produce(), "без озвучки слова").await.unwrap();
        assert!(second.0.is_none());
        assert_eq!(second.1.as_ref().unwrap().status, "ready");
        assert_eq!(calls.load(Ordering::SeqCst), 2, "each submission retried only the upload, never TTS");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
