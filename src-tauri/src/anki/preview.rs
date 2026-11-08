//! One card as the settings dialog, the add-card modal and the job editor show it: the note type,
//! the field mapping and the values the current draft and assets would put into Anki.

use crate::{
    anki::{
        cards::{self, WordDraft},
        connect,
        fields::{self, Source},
        images, jobs, note_type,
    },
    state::AppState,
};
use serde::Serialize;
use std::collections::BTreeMap;

const PREVIEW_IMAGE: &str = r#"<div class="ss-ph">🖼 Картинка появится при добавлении</div>"#;
const PREVIEW_CLIP: &str = r#"<div class="ss-ph">🎬 Клип из фильма</div>"#;
const PREVIEW_IMAGE_FAILED: &str = r#"<div class="ss-ph">🖼 Картинка не сгенерирована</div>"#;
const PREVIEW_AUDIO_FAILED: &str = r#"<div class="ss-ph">🔇 Звук не сгенерирован</div>"#;
const PREVIEW_CLIP_FAILED: &str = r#"<div class="ss-ph">🎬 Клип не сгенерирован</div>"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardPreview {
    pub note_type: note_type::NoteTypeView,
    /// Anki field name -> source id (`""` = the field stays empty).
    pub mapping: Vec<(String, String)>,
    pub values: BTreeMap<String, String>,
}

/// Values and mapping of a card that is not in Anki yet. `media` carries the captured cue when the
/// preview belongs to a film; the settings preview passes the sample cue instead.
pub async fn build(
    _st: &AppState,
    client: &connect::Client<'_>,
    anki: &crate::config::Anki,
    draft: &WordDraft,
    media: Option<(&jobs::MediaContext, &jobs::CapturedCue)>,
    route: &images::ResolvedRoute,
) -> Result<CardPreview, String> {
    let view = note_type::view(client, &anki.note_type).await.map_err(|e| format!("{e:#}"))?;
    let map = fields::resolve(&view.fields, &anki.fields);
    let mut values = fields::Values {
        word: draft.word.clone(),
        translation: draft.translation.clone(),
        word_type: draft.word_type.clone(),
        cloze_sentence: draft.cloze_sentence.clone(),
        sentence: draft.full_sentence.clone(),
        sentence_translation: draft.sentence_translation.clone(),
        ..Default::default()
    };
    let clip_field = map.iter().any(|(_, s)| *s == Some(Source::Clip));
    let has_clip = anki.clip && (media.is_some() || clip_field);
    let span = cards::cloze_inner(&draft.cloze_sentence).unwrap_or_else(|| draft.word.clone());
    match media {
        Some((m, cue)) => {
            let name = m.original_title.clone().unwrap_or_else(|| m.title.clone());
            let start = cue.start + cue.offset;
            let text_one_line = cue.text.replace('\n', " ");
            if anki.clip {
                values.clip_text = fields::clip_text(&text_one_line, cards::word_index(&text_one_line, &span));
                values.clip_source = fields::clip_source(&cards::source_label(&name, m.season, m.episode, start), &name, m.year);
            }
        }
        // No film: the draft sentence and a fixed sample source stand in for the movie line.
        None if has_clip => {
            values.clip_text = fields::clip_text(&draft.full_sentence, cards::word_index(&draft.full_sentence, &span));
            values.clip_source = "Marty Supreme · 00:12:34 · Smart Subtitles".into();
        }
        None => {}
    }

    let subject = cards::image_prompt(draft);
    let cached = images::cached_route(&images::dir(), route, &subject).map_err(|e| e.public_text())?;
    let mut out = BTreeMap::new();
    let mut mapping = vec![];
    for (field, source) in &map {
        let Some(source) = *source else {
            mapping.push((field.clone(), String::new()));
            continue;
        };
        mapping.push((field.clone(), source.id().to_string()));
        let value = match source {
            Source::Image => match &cached {
                Some(a) => {
                    // A selected file that cannot be read or is not an image is an error, not a
                    // placeholder that pretends the preview is complete.
                    let url = images::data_url(&a.path)?;
                    format!("<img src=\"{url}\">")
                }
                None => PREVIEW_IMAGE.to_string(),
            },
            Source::Clip if has_clip => PREVIEW_CLIP.to_string(),
            Source::WordAudio if anki.tts => "[sound:word.mp3]".to_string(),
            Source::SentenceAudio if anki.sentence_audio != "none" => "[sound:sentence.mp3]".to_string(),
            other => values.value(other),
        };
        out.insert(field.clone(), value);
    }
    Ok(CardPreview { note_type: view, mapping, values: out })
}

/// Preview of one job's selected, revision-bound assets. It never reads the current-route image cache
/// and never generates: a ready slot is embedded from its local file or `retrieveMediaFile`, a failed
/// slot is shown as missing, and only an unattempted slot uses the "appears on add" placeholder.
pub async fn build_job(
    st: &AppState,
    context: &jobs::JobContext,
    draft: &WordDraft,
    assets: &jobs::JobAssets,
) -> Result<CardPreview, String> {
    let client = connect::Client::new(&st.http, &context.anki.url);
    let view = note_type::view(&client, &context.anki.note_type).await.map_err(|e| format!("{e:#}"))?;
    let map = fields::resolve(&view.fields, &context.anki.fields);
    let values = cards::render_values(context, draft, assets);
    let mut out = BTreeMap::new();
    let mut mapping = vec![];
    for (field, source) in &map {
        let Some(source) = *source else {
            mapping.push((field.clone(), String::new()));
            continue;
        };
        mapping.push((field.clone(), source.id().to_string()));
        let value = match source {
            Source::Image => match selected_media(&client, assets.image.as_ref(), MediaKind::Image).await? {
                Some(url) => format!("<img src=\"{url}\">"),
                None if assets.image.is_some() => PREVIEW_IMAGE_FAILED.to_string(),
                None => PREVIEW_IMAGE.to_string(),
            },
            Source::WordAudio => match selected_media(&client, assets.word_audio.as_ref(), MediaKind::Audio).await? {
                Some(url) => format!("<audio controls src=\"{url}\"></audio>"),
                None if assets.word_audio.is_some() => PREVIEW_AUDIO_FAILED.to_string(),
                None if context.anki.tts => "[sound:word.mp3]".to_string(),
                None => String::new(),
            },
            Source::SentenceAudio => match selected_media(&client, assets.sentence_audio.as_ref(), MediaKind::Audio).await? {
                Some(url) => format!("<audio controls src=\"{url}\"></audio>"),
                None if assets.sentence_audio.is_some() => PREVIEW_AUDIO_FAILED.to_string(),
                None if context.anki.sentence_audio != "none" => "[sound:sentence.mp3]".to_string(),
                None => String::new(),
            },
            Source::Clip => match selected_media(&client, assets.clip.as_ref(), MediaKind::Clip).await? {
                Some(url) => format!("<video playsinline preload=\"auto\" controls src=\"{url}\"></video>"),
                None if assets.clip.is_some() => PREVIEW_CLIP_FAILED.to_string(),
                None if context.anki.clip => PREVIEW_CLIP.to_string(),
                None => String::new(),
            },
            other => values.value(other),
        };
        out.insert(field.clone(), value);
    }
    Ok(CardPreview { note_type: view, mapping, values: out })
}

#[derive(Clone, Copy, PartialEq)]
enum MediaKind {
    Image,
    Audio,
    Clip,
}

/// Data URL of a ready slot's file: the local cache first, then the uploaded Anki media. A slot with
/// neither is `None`; read/format failures are explicit errors.
async fn selected_media(
    client: &connect::Client<'_>,
    slot: Option<&jobs::AssetSlot>,
    kind: MediaKind,
) -> Result<Option<String>, String> {
    let Some(slot) = slot.filter(|s| s.status == "ready") else { return Ok(None) };
    if let Some(path) = slot.cache_path.as_deref() {
        if let Ok(bytes) = tokio::fs::read(path).await {
            if !bytes.is_empty() {
                if let Ok(url) = media_data_url(&bytes, kind) {
                    return Ok(Some(url));
                }
            }
        }
    }
    let Some(name) = &slot.file_name else {
        return Err("медиафайл не найден ни в кэше, ни в Anki".into());
    };
    let bytes = client.retrieve_media(name).await.map_err(|e| format!("медиафайл {name}: {e}"))?;
    if bytes.is_empty() {
        return Err(format!("медиафайл {name}: пустой файл"));
    }
    media_data_url(&bytes, kind).map(Some)
}

/// Preview of a note that is already in Anki: the actual field values, with media rewritten to data
/// URLs for the script-free iframe. Text fields are not inverted back into a draft.
pub async fn build_actual(
    client: &connect::Client<'_>,
    anki: &crate::config::Anki,
    note: &connect::NoteInfo,
    mapping: &[(String, Option<Source>)],
) -> Result<CardPreview, String> {
    let view = note_type::view(client, &anki.note_type).await.map_err(|e| format!("{e:#}"))?;
    let mut values = BTreeMap::new();
    for (field, source) in mapping {
        let Some(source) = *source else { continue };
        let actual = note.field(field).unwrap_or("").to_string();
        values.insert(field.clone(), rewrite_media(client, source, &actual).await?);
    }
    Ok(CardPreview {
        note_type: view,
        mapping: mapping.iter().map(|(f, s)| (f.clone(), s.map(|s| s.id().to_string()).unwrap_or_default())).collect(),
        values,
    })
}

/// Media references in mapped media fields become data URLs; text stays as Anki stores it. A mapped
/// media field whose file cannot be read is an explicit error, never a raw private path in the iframe.
async fn rewrite_media(client: &connect::Client<'_>, source: Source, value: &str) -> Result<String, String> {
    match source {
        Source::Image => match attr(value, "src") {
            // Already resolved: the editor's not-yet-uploaded picture, read from the job's own file.
            Some(name) if name.starts_with("data:") => Ok(value.to_string()),
            Some(name) => {
                let bytes = client.retrieve_media(&name).await.map_err(|e| format!("медиафайл {name}: {e}"))?;
                Ok(format!("<img src=\"{}\">", media_data_url(&bytes, MediaKind::Image)?))
            }
            None => Ok(value.to_string()),
        },
        Source::WordAudio | Source::SentenceAudio => match sound_name(value) {
            Some(name) => {
                let bytes = client.retrieve_media(&name).await.map_err(|e| format!("медиафайл {name}: {e}"))?;
                Ok(format!("<audio controls src=\"{}\"></audio>", media_data_url(&bytes, MediaKind::Audio)?))
            }
            None => Ok(value.to_string()),
        },
        Source::Clip => match attr(value, "src") {
            Some(name) => {
                let bytes = client.retrieve_media(&name).await.map_err(|e| format!("медиафайл {name}: {e}"))?;
                Ok(format!(
                    "<video playsinline preload=\"auto\" controls src=\"{}\"></video>",
                    media_data_url(&bytes, MediaKind::Clip)?
                ))
            }
            None => Ok(value.to_string()),
        },
        _ => Ok(value.to_string()),
    }
}

/// MIME of a stored media file. WebM and MP3 are not images and must not be labeled `audio/mpeg`
/// just because `image_mime` did not recognize them.
fn media_mime(bytes: &[u8]) -> &'static str {
    let image = crate::poster::image_mime(bytes);
    if image.starts_with("image/") {
        return image;
    }
    if bytes.len() >= 4 && bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return "video/webm";
    }
    if bytes.starts_with(b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0) {
        return "audio/mpeg";
    }
    "application/octet-stream"
}

fn media_data_url(bytes: &[u8], kind: MediaKind) -> Result<String, String> {
    use base64::Engine;
    let mime = media_mime(bytes);
    let ok = match kind {
        MediaKind::Image => mime.starts_with("image/"),
        MediaKind::Audio => mime == "audio/mpeg",
        MediaKind::Clip => mime == "video/webm",
    };
    if !ok {
        return Err(format!("медиафайл имеет неверный формат ({mime})"));
    }
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

fn attr(value: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let at = value.find(&needle)? + needle.len();
    let rest = &value[at..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn sound_name(value: &str) -> Option<String> {
    let at = value.find("[sound:")? + 7;
    let rest = &value[at..];
    let end = rest.find(']')?;
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_attributes_are_read_from_stored_html() {
        assert_eq!(attr("<img src=\"a.webp\">", "src").as_deref(), Some("a.webp"));
        assert_eq!(attr("<video><source src=\"c.webm\"></video>", "src").as_deref(), Some("c.webm"));
        assert_eq!(attr("plain", "src"), None);
        assert_eq!(sound_name("[sound:a.mp3]").as_deref(), Some("a.mp3"));
        assert_eq!(sound_name("none"), None);
    }

    #[tokio::test]
    async fn an_unuploaded_selected_picture_is_previewed_without_anki() {
        // The editor previews a freshly generated picture from its local file before upload; Anki
        // does not have it, so that source must never be fetched as a media file name.
        let http = reqwest::Client::new();
        let unreachable = connect::Client::new(&http, "http://127.0.0.1:9");
        let value = "<img src=\"data:image/png;base64,iVBORw0KGgo=\">";
        assert_eq!(rewrite_media(&unreachable, Source::Image, value).await.unwrap(), value);
    }

    #[test]
    fn webm_and_mp3_keep_their_own_mime() {
        let webm = [0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0];
        assert_eq!(media_mime(&webm), "video/webm");
        let mp3 = b"ID3\x04\x00\x00\x00\x00\x00\x00";
        assert_eq!(media_mime(mp3), "audio/mpeg");
        assert!(media_data_url(&webm, MediaKind::Clip).unwrap().starts_with("data:video/webm;base64,"));
        assert!(media_data_url(mp3, MediaKind::Audio).unwrap().starts_with("data:audio/mpeg;base64,"));
        assert!(media_data_url(&webm, MediaKind::Audio).is_err());
        assert!(media_data_url(mp3, MediaKind::Clip).is_err());
        let png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert!(media_data_url(&png, MediaKind::Image).unwrap().starts_with("data:image/png;base64,"));
        assert!(media_data_url(&png, MediaKind::Clip).is_err());
    }
}
