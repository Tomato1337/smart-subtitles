use super::{client, prompts, tasks::Task};
use crate::{db::now, session::Session, state::AppState, anki::cards::{cloze_inner, WordDraft}};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Explanation {
    pub chunk: String,
    pub translation: String,
    pub meaning: String,
    pub literal: String,
    pub register: String,
    pub word_type: String,
    pub grammar: String,
    pub pattern_id: Option<String>,
    pub examples: Vec<Example>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Example { pub en: String, pub ru: String }

async fn cue_text(st: &AppState, media_id: &str, idx: u32) -> Result<String, String> {
    let m = media_id.to_string();
    st.db(move |c| c.query_row("SELECT text FROM cue WHERE media_id=?1 AND idx=?2", params![m, idx], |r| r.get(0))).await
}

async fn ask<T: serde::de::DeserializeOwned>(st: &AppState, s: &Session, task: Task, tag: &str, prompt: String, max_tokens: u32) -> Result<T, String> {
    let mut messages = (*prompts::prefix(st, s).await.map_err(|e| e.to_string())?).clone();
    messages.push(json!({ "role": "user", "content": prompt }));
    client::chat_json(st, task, &s.media_id, tag, &messages, max_tokens).await.map_err(|e| e.to_string())
}

/// The same request from a captured media context, without touching the open session.
async fn ask_media<T: serde::de::DeserializeOwned>(
    st: &AppState,
    media: &prompts::MediaContext,
    task: Task,
    tag: &str,
    prompt: String,
    max_tokens: u32,
) -> Result<T, String> {
    let mut messages = (*prompts::prefix_for_media(st, media).await.map_err(|e| e.to_string())?).clone();
    messages.push(json!({ "role": "user", "content": prompt }));
    client::chat_json(st, task, &media.media_id, tag, &messages, max_tokens).await.map_err(|e| e.to_string())
}

/// Contextual explanation of a span; cached per (media, cue, span).
pub async fn explain(st: &Arc<AppState>, s: &Arc<Session>, cue_idx: u32, span: String) -> Result<Explanation, String> {
    let (m, sp) = (s.media_id.clone(), span.clone());
    let cached: Option<String> = st
        .db(move |c| Ok(c.query_row("SELECT json FROM explanation WHERE media_id=?1 AND cue_idx=?2 AND span=?3", params![m, cue_idx, sp], |r| r.get(0)).ok()))
        .await?;
    if let Some(j) = cached.and_then(|j| serde_json::from_str(&j).ok()) { return Ok(j); }

    let text = one_line(&cue_text(st, &s.media_id, cue_idx).await?);
    let task = format!(
        "TASK explain span \"{span}\" in cue [{cue_idx}] «{text}». Return {{\"chunk\":\"<каноническая форма, напр. bail on someone>\",\"translation\":\"<перевод в этом контексте>\",\"meaning\":\"<что здесь имеется в виду, 1–2 предложения по-русски>\",\"literal\":\"<буквальный перевод или пусто>\",\"register\":\"neutral|informal|slang|vulgar|formal\",\"word_type\":\"<часть речи / тип по-английски>\",\"grammar\":\"<объяснение грамматики по-русски или пусто>\",\"pattern_id\":\"<id каталога или null>\",\"examples\":[{{\"en\":\"\",\"ru\":\"\"}}]}}. 2 примера."
    );
    let e: Explanation = ask(st, s, Task::Explain, &format!("explain {cue_idx}"), task, 900).await?;
    let (m, sp, j) = (s.media_id.clone(), span, serde_json::to_string(&e).map_err(|e| e.to_string())?);
    st.db(move |c| { c.execute("INSERT OR REPLACE INTO explanation VALUES(?1,?2,?3,?4,?5)", params![m, cue_idx, sp, j, now()])?; Ok(()) }).await?;
    Ok(e)
}

fn one_line(s: &str) -> String { s.replace('\n', " ") }

/// Wraps the first case-insensitive occurrence of `target` in `{{c1::…}}`.
pub fn wrap_cloze(sentence: &str, target: &str) -> Option<String> {
    let hay: Vec<char> = sentence.chars().collect();
    let low: Vec<char> = sentence.to_lowercase().chars().collect();
    let t: Vec<char> = target.to_lowercase().chars().collect();
    if t.is_empty() || low.len() != hay.len() || hay.len() < t.len() { return None; }
    let i = (0..=hay.len() - t.len()).find(|&i| low[i..i + t.len()] == t[..])?;
    let (a, b): (String, String) = (hay[..i].iter().collect(), hay[i + t.len()..].iter().collect());
    let mid: String = hay[i..i + t.len()].iter().collect();
    Some(format!("{a}{{{{c1::{mid}}}}}{b}"))
}

/// Ensures a phrase card hides one chunk, never most of the phrase.
pub fn fix_phrase_cloze(d: &mut WordDraft, chunk_fallback: Option<&str>) {
    let total = d.full_sentence.chars().count().max(1);
    let ok = cloze_inner(&d.cloze_sentence).is_some_and(|inner| (inner.chars().count() as f64) / (total as f64) <= 0.6);
    if ok { return; }
    let target = chunk_fallback.map(str::to_string).or_else(|| {
        d.full_sentence.split_whitespace().map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_string()).rev().find(|w| w.chars().count() > 3)
    });
    if let Some(c) = target.and_then(|t| wrap_cloze(&d.full_sentence, &t)) { d.cloze_sentence = c; }
}

/// One draft for a captured cue: a job uses the cue text and chunk it stored, not the rank of a
/// subtitle set that may have been replaced since.
pub async fn draft_for_job(
    st: &Arc<AppState>,
    media: &prompts::MediaContext,
    cue_idx: u32,
    text: &str,
    span: Option<&str>,
    chunk_fallback: Option<&str>,
) -> Result<WordDraft, String> {
    let text = one_line(text);
    let schema = "{\"word\":\"\",\"translation\":\"\",\"word_type\":\"\",\"cloze_sentence\":\"\",\"full_sentence\":\"\",\"sentence_translation\":\"\",\"image_prompt\":\"\"}";
    // Same image rule as tutor's collect_words: one concrete picture of the meaning, no text in it.
    let image = "image_prompt = a concrete English image prompt (one visible scene that shows the meaning of the word in this situation, no text, letters or signs in the picture, ≤40 words).";
    let task = match span {
        Some(sp) => format!("TASK make one flashcard for \"{sp}\" from cue [{cue_idx}] «{text}». Return WORD_SCHEMA JSON {schema}: word = the span in canonical form, full_sentence = the cue in one line, cloze_sentence = the cue with {{{{c1::<span as it appears in the text>}}}}, word_type = part of speech. {image}"),
        None => format!("TASK make one PHRASE flashcard for the whole cue [{cue_idx}] «{text}». Return WORD_SCHEMA JSON {schema} where word = the whole cue as one line, translation = its contextual Russian translation, word_type = \"phrase\", full_sentence = the cue, sentence_translation = same translation, cloze_sentence = the cue with its single hardest chunk wrapped in {{{{c1::...}}}}. {image}"),
    };
    let mut d: WordDraft = ask_media(st, media, Task::Draft, &format!("draft {cue_idx}"), task, 800).await?;
    match span {
        Some(sp) => {
            if !d.cloze_sentence.contains("{{c1::") {
                d.cloze_sentence = wrap_cloze(&d.full_sentence, sp).or_else(|| wrap_cloze(&text, sp)).ok_or("не удалось построить cloze")?;
            }
        }
        None => {
            d.word_type = "phrase".into();
            d.full_sentence = text.clone();
            fix_phrase_cloze(&mut d, chunk_fallback);
        }
    }
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(cloze: &str, full: &str) -> WordDraft {
        WordDraft { word: full.into(), translation: "t".into(), word_type: "phrase".into(), cloze_sentence: cloze.into(), full_sentence: full.into(), sentence_translation: "t".into(), image_prompt: String::new() }
    }

    #[test]
    fn wraps_first_occurrence_case_insensitively() {
        assert_eq!(wrap_cloze("Come on, man", "come on").as_deref(), Some("{{c1::Come on}}, man"));
        assert_eq!(wrap_cloze("Hi", "absent"), None);
    }

    #[test]
    fn phrase_cloze_never_hides_most_of_the_phrase() {
        let full = "I can't believe she's backing out";
        let mut d = draft(&format!("{{{{c1::{full}}}}}"), full);
        fix_phrase_cloze(&mut d, Some("backing out"));
        assert_eq!(d.cloze_sentence, "I can't believe she's {{c1::backing out}}");

        let mut d = draft("no cloze at all", full);
        fix_phrase_cloze(&mut d, None);
        assert_eq!(d.cloze_sentence, "I can't believe she's {{c1::backing}} out");
    }

    #[test]
    fn good_cloze_untouched() {
        let full = "Come on, give me a break";
        let mut d = draft("Come on, give me {{c1::a break}}", full);
        fix_phrase_cloze(&mut d, Some("come on"));
        assert_eq!(d.cloze_sentence, "Come on, give me {{c1::a break}}");
    }
}
