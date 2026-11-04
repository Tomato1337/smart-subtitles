use crate::{logs, state::AppState};
use sha1::{Digest, Sha1};
use std::path::PathBuf;
use std::time::Duration;

const MAX_BYTES: usize = 5 * 1024 * 1024;

/// SHA-1 of the media id: ids look like `ts:abc:3` and cannot be used as a file name or path segment.
pub fn poster_key(media_id: &str) -> String { hex::encode(Sha1::digest(media_id.as_bytes())) }

pub fn poster_path(media_id: &str) -> PathBuf { dir().join(poster_key(media_id)) }

/// URL of a cached poster on the local media server.
pub fn url(port: u16, media_id: &str) -> String {
    format!("http://127.0.0.1:{port}/media/poster/{}", poster_key(media_id))
}

fn dir() -> PathBuf { crate::config::cache_dir().join("posters") }

fn valid_key(key: &str) -> bool {
    key.len() == 40 && key.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

pub fn image_mime(b: &[u8]) -> &'static str {
    if b.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if b.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

/// Poster bytes for `key`, downloading and caching them on first use. `None` becomes a 404.
pub async fn bytes(st: &AppState, key: &str) -> Option<Vec<u8>> {
    if !valid_key(key) {
        return None;
    }
    let path = dir().join(key);
    if let Ok(b) = std::fs::read(&path) {
        return Some(b);
    }
    let s = st.sessions.current()?;
    if poster_key(&s.media_id) != key {
        return None;
    }
    let url = s.req.card.as_ref().and_then(|c| c.poster.clone())?;
    match fetch(st, &url).await {
        Ok(b) => {
            if let Err(e) = store(key, &b) {
                logs::log("app", &format!("poster: {e}"));
            }
            Some(b)
        }
        Err(e) => {
            logs::log("app", &format!("poster: {e}"));
            None
        }
    }
}

async fn fetch(st: &AppState, url: &str) -> Result<Vec<u8>, String> {
    let r = st.http.get(url).timeout(Duration::from_secs(15)).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{url}: HTTP {}", r.status()));
    }
    let b = r.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if b.len() > MAX_BYTES {
        return Err(format!("{url}: {} байт", b.len()));
    }
    if image_mime(&b) == "application/octet-stream" {
        return Err(format!("{url}: не изображение"));
    }
    Ok(b)
}

/// Writes through a temp file so a concurrent reader never sees half a poster.
fn store(key: &str, b: &[u8]) -> std::io::Result<()> {
    let dir = dir();
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!("{key}.tmp"));
    std::fs::write(&tmp, b)?;
    std::fs::rename(&tmp, dir.join(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_hex_and_stable() {
        let k = poster_key("ts:abc:3");
        assert_eq!(k.len(), 40);
        assert_eq!(k, poster_key("ts:abc:3"));
        assert_ne!(k, poster_key("ts:abc:4"));
        assert!(valid_key(&k));
        assert!(!valid_key("TS:ABC"));
        assert!(!valid_key("../escape"));
    }

    #[test]
    fn mime_sniffing() {
        assert_eq!(image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(image_mime(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]), "image/png");
        assert_eq!(image_mime(b"RIFF\x24\x00\x00\x00WEBPVP8 "), "image/webp");
        assert_eq!(image_mime(b"<html>"), "application/octet-stream");
    }
}
