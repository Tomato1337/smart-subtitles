//! Field builders ported from tutor's `anki/flashcards.py`: which value goes into which Anki field.
//!
//! The note type is the user's, so nothing here knows field names: `auto_source` guesses from a
//! name, `resolve` applies the saved mapping on top and `Values::value` renders one source.

use regex::Regex;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::LazyLock;

/// Where an Anki field's value comes from. The ids are the config's `anki.fields` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Word,
    Translation,
    WordType,
    ClozeGap,
    ClozeRaw,
    Sentence,
    SentenceTranslation,
    Image,
    WordAudio,
    SentenceAudio,
    Clip,
    ClipText,
    ClipSource,
}

impl Source {
    pub fn id(self) -> &'static str {
        match self {
            Source::Word => "word",
            Source::Translation => "translation",
            Source::WordType => "wordType",
            Source::ClozeGap => "clozeGap",
            Source::ClozeRaw => "clozeRaw",
            Source::Sentence => "sentence",
            Source::SentenceTranslation => "sentenceTranslation",
            Source::Image => "image",
            Source::WordAudio => "wordAudio",
            Source::SentenceAudio => "sentenceAudio",
            Source::Clip => "clip",
            Source::ClipText => "clipText",
            Source::ClipSource => "clipSource",
        }
    }

    /// `""` is not a source: it means "this field stays empty" in a saved mapping.
    pub fn parse(s: &str) -> Option<Source> {
        Some(match s {
            "word" => Source::Word,
            "translation" => Source::Translation,
            "wordType" => Source::WordType,
            "clozeGap" => Source::ClozeGap,
            "clozeRaw" => Source::ClozeRaw,
            "sentence" => Source::Sentence,
            "sentenceTranslation" => Source::SentenceTranslation,
            "image" => Source::Image,
            "wordAudio" => Source::WordAudio,
            "sentenceAudio" => Source::SentenceAudio,
            "clip" => Source::Clip,
            "clipText" => Source::ClipText,
            "clipSource" => Source::ClipSource,
            _ => return None,
        })
    }
}

/// Guess from a field name: lowercase, non-alphanumerics dropped, then the name table.
pub fn auto_source(field: &str) -> Option<Source> {
    let key: String = field.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
    Some(match key.as_str() {
        "word" | "front" | "expression" | "vocab" | "vocabulary" | "term" | "english" => Source::Word,
        "wordtranslation" | "translation" | "meaning" | "back" | "russian" | "definition" => Source::Translation,
        "wordtype" | "partofspeech" | "pos" | "type" => Source::WordType,
        "clozetext" | "cloze" => Source::ClozeGap,
        "text" => Source::ClozeRaw,
        "fullsentence" | "sentence" | "example" | "context" => Source::Sentence,
        "sentencetranslation" | "exampletranslation" => Source::SentenceTranslation,
        "image" | "picture" | "pic" | "img" => Source::Image,
        "wordaudio" | "audio" | "sound" | "pronunciation" => Source::WordAudio,
        "sentenceaudio" | "exampleaudio" => Source::SentenceAudio,
        "clip" | "video" => Source::Clip,
        "cliptext" => Source::ClipText,
        "clipsource" | "source" => Source::ClipSource,
        _ => return None,
    })
}

/// One entry per model field, in model order. A saved value wins (`""` = explicitly empty);
/// a field with no saved value falls back to `auto_source`.
pub fn resolve(model_fields: &[String], saved: &BTreeMap<String, String>) -> Vec<(String, Option<Source>)> {
    model_fields
        .iter()
        .map(|f| {
            let source = match saved.get(f) {
                Some(v) => Source::parse(v),
                None => auto_source(f),
            };
            (f.clone(), source)
        })
        .collect()
}

/// Front-side sentence: `{{c1::word}}` markers and `___` runs become `[...]`.
pub fn cloze_gap(sentence: &str) -> String {
    static GAP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\{c\d+::.*?\}\}|_{3,}").unwrap());
    GAP.replace_all(sentence, "[...]").into_owned()
}

/// HTML-escape without touching quotes, as tutor does for the clip fields.
fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The movie line with the searched word in `<b>`; punctuation stays outside the bold.
pub fn clip_text(text: &str, word_index: usize) -> String {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let Some(token) = tokens.get(word_index) else {
        return escape(text);
    };
    let (lead, core, tail) = split_punctuation(token);
    tokens
        .iter()
        .enumerate()
        .map(|(i, t)| if i == word_index { format!("{lead}<b>{core}</b>{tail}") } else { escape(t) })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `(\W*)(.*?)(\W*)` of tutor: leading and trailing non-word characters around the core.
fn split_punctuation(token: &str) -> (String, String, String) {
    let chars: Vec<char> = token.chars().collect();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let lead_len = chars.iter().take_while(|c| !is_word(**c)).count();
    let tail_len = chars.iter().rev().take_while(|c| !is_word(**c)).count();
    if lead_len == chars.len() {
        // Only punctuation: bold the whole token.
        return (String::new(), escape(token), String::new());
    }
    let lead: String = chars[..lead_len].iter().collect();
    let core: String = chars[lead_len..chars.len() - tail_len].iter().collect();
    let tail: String = chars[chars.len() - tail_len..].iter().collect();
    (escape(&lead), escape(&core), escape(&tail))
}

/// «Title S01E02 · 00:01:05 · Smart Subtitles»; a label without a timecode falls back to title (year).
pub fn clip_source(source_label: &str, title: &str, year: Option<i32>) -> String {
    static LABEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)^(.*?)\s*\[([\d:]+)\]$").unwrap());
    let label = source_label.trim();
    let (mut base, timecode) = match LABEL.captures(label) {
        Some(c) => (c[1].to_string(), c[2].to_string()),
        None => (label.to_string(), String::new()),
    };
    if base.is_empty() && !title.is_empty() {
        base = match year {
            Some(y) => format!("{title} ({y})"),
            None => title.to_string(),
        };
    }
    [base, timecode, "Smart Subtitles".to_string()]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Anki media file name: `bring_up_1a2b3c4d.mp3` — the word for legibility, the salt for uniqueness.
pub fn media_name(word: &str, salt: &str, ext: &str) -> String {
    let short = hex::encode(Sha256::digest(salt.as_bytes()));
    format!("{}_{}.{ext}", sanitize(word), &short[..8])
}

/// Lowercase, `[^\w-]` → `_`, repeated `_` collapsed, edge `_` trimmed (tutor `_sanitize`).
pub fn sanitize(name: &str) -> String {
    static BAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\w\-]").unwrap());
    static RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_+").unwrap());
    let t = BAD.replace_all(&name.to_lowercase(), "_").into_owned();
    RUNS.replace_all(&t, "_").trim_matches('_').to_string()
}

/// Slug for tags and file names; empty input becomes `media`.
pub fn slug(s: &str) -> String {
    let t = sanitize(s);
    if t.is_empty() { "media".into() } else { t }
}

/// Every value one card can show, filled in as far as the run produced them.
#[derive(Debug, Default, Clone)]
pub struct Values {
    pub word: String,
    pub translation: String,
    pub word_type: String,
    pub cloze_sentence: String,
    pub sentence: String,
    pub sentence_translation: String,
    pub image_file: Option<String>,
    pub word_audio: Option<String>,
    pub sentence_audio: Option<String>,
    pub clip_file: Option<String>,
    pub clip_text: String,
    pub clip_source: String,
}

impl Values {
    /// Field HTML for one source; a missing media file is an empty field, as in tutor.
    pub fn value(&self, source: Source) -> String {
        match source {
            Source::Word => self.word.clone(),
            Source::Translation => self.translation.clone(),
            Source::WordType => self.word_type.clone(),
            Source::ClozeGap => cloze_gap(&self.cloze_sentence),
            Source::ClozeRaw => self.cloze_sentence.clone(),
            Source::Sentence => self.sentence.clone(),
            Source::SentenceTranslation => self.sentence_translation.clone(),
            Source::Image => self.image_file.as_ref().map(|f| format!("<img src=\"{f}\">")).unwrap_or_default(),
            Source::WordAudio => sound(self.word_audio.as_deref()),
            Source::SentenceAudio => sound(self.sentence_audio.as_deref()),
            // `<source src>` and not `<video src>`: Anki's media scanner only sees img/audio/object/source.
            Source::Clip => self
                .clip_file
                .as_ref()
                .map(|f| format!("<video playsinline preload=\"auto\"><source src=\"{f}\" type=\"video/webm\"></video>"))
                .unwrap_or_default(),
            Source::ClipText => self.clip_text.clone(),
            Source::ClipSource => self.clip_source.clone(),
        }
    }
}

fn sound(file: Option<&str>) -> String {
    file.map(|f| format!("[sound:{f}]")).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_mapping_by_field_name() {
        assert_eq!(auto_source("Word"), Some(Source::Word));
        assert_eq!(auto_source("Front"), Some(Source::Word));
        assert_eq!(auto_source("Back"), Some(Source::Translation));
        assert_eq!(auto_source("Word Translation"), Some(Source::Translation));
        assert_eq!(auto_source("Text"), Some(Source::ClozeRaw));
        assert_eq!(auto_source("ClozeText"), Some(Source::ClozeGap));
        assert_eq!(auto_source("Sentence Audio"), Some(Source::SentenceAudio));
        assert_eq!(auto_source("Clip Source"), Some(Source::ClipSource));
        assert_eq!(auto_source("Frequency"), None);
    }

    #[test]
    fn saved_mapping_overrides_auto_and_can_empty_a_field() {
        let model: Vec<String> = ["Word", "Back", "Image"].iter().map(|s| s.to_string()).collect();
        let saved: BTreeMap<String, String> =
            [("Word".to_string(), "translation".to_string()), ("Back".to_string(), String::new())].into_iter().collect();
        let got = resolve(&model, &saved);
        assert_eq!(got[0], ("Word".to_string(), Some(Source::Translation)));
        assert_eq!(got[1], ("Back".to_string(), None));
        assert_eq!(got[2], ("Image".to_string(), Some(Source::Image)));
        assert_eq!(Source::parse("nonsense"), None);
        assert_eq!(Source::Word.id(), "word");
    }

    #[test]
    fn cloze_gap_hides_the_answer() {
        assert_eq!(cloze_gap("He {{c1::bailed on}} me"), "He [...] me");
        assert_eq!(cloze_gap("He {{c1::bailed::hint}} me"), "He [...] me");
        assert_eq!(cloze_gap("He ___ me"), "He [...] me");
        assert_eq!(cloze_gap("no gap here"), "no gap here");
    }

    #[test]
    fn clip_text_bolds_the_word_inside_its_punctuation() {
        assert_eq!(clip_text("Look, he bailed on me.", 2), "Look, he <b>bailed</b> on me.");
        assert_eq!(clip_text("He \"bailed,\" on me", 1), "He \"<b>bailed</b>,\" on me");
        assert_eq!(clip_text("Wait — now", 1), "Wait <b>—</b> now");
        assert_eq!(clip_text("a & b", 1), "a <b>&amp;</b> b");
    }

    #[test]
    fn clip_source_joins_label_timecode_and_provider() {
        assert_eq!(clip_source("The Boys S05E01 [00:01:05]", "", None), "The Boys S05E01 · 00:01:05 · Smart Subtitles");
        assert_eq!(clip_source("", "Marty Supreme", Some(2025)), "Marty Supreme (2025) · Smart Subtitles");
        assert_eq!(clip_source("Marty Supreme [01:02:03]", "", Some(2025)), "Marty Supreme · 01:02:03 · Smart Subtitles");
    }

    #[test]
    fn media_names_sanitize_the_word_and_hash_the_salt() {
        assert!(media_name("Bring up!", "s", "mp3").starts_with("bring_up_"));
        assert_eq!(media_name("Bring up!", "s", "mp3"), media_name("Bring up!", "s", "mp3"));
        assert_ne!(media_name("bring", "one", "mp3"), media_name("bring", "two", "mp3"));
        assert_eq!(media_name("Bring up!", "s", "mp3").len(), "bring_up_".len() + 8 + ".mp3".len());
        assert_eq!(slug("Marty Supreme!"), "marty_supreme");
        assert_eq!(slug("???"), "media");
    }

    #[test]
    fn values_render_media_and_text() {
        let v = Values {
            word: "bring".into(),
            translation: "принести".into(),
            word_type: "verb".into(),
            cloze_sentence: "It'll {{c1::bring}} him joy.".into(),
            sentence: "It'll bring him joy.".into(),
            sentence_translation: "Это доставит ему радость.".into(),
            image_file: Some("bring_1.webp".into()),
            word_audio: Some("bring_2.mp3".into()),
            sentence_audio: None,
            clip_file: Some("smartsubs_3.webm".into()),
            clip_text: "It'll <b>bring</b> him joy.".into(),
            clip_source: "Marty Supreme · 00:01:05 · Smart Subtitles".into(),
        };
        assert_eq!(v.value(Source::Image), "<img src=\"bring_1.webp\">");
        assert_eq!(v.value(Source::WordAudio), "[sound:bring_2.mp3]");
        assert_eq!(v.value(Source::SentenceAudio), "");
        assert_eq!(v.value(Source::ClozeGap), "It'll [...] him joy.");
        assert_eq!(v.value(Source::ClozeRaw), "It'll {{c1::bring}} him joy.");
        assert_eq!(
            v.value(Source::Clip),
            "<video playsinline preload=\"auto\"><source src=\"smartsubs_3.webm\" type=\"video/webm\"></video>"
        );
    }
}
