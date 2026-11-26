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
    format!("http://127.0.0.1:{port}/media/poster/{}?t={}", poster_key(media_id), crate::server::media_token())
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
    if std::fs::metadata(&path).is_ok_and(|m| m.len() <= MAX_BYTES as u64) {
        if let Ok(b) = std::fs::read(&path) {
            return Some(b);
        }
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

pub(crate) fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            let this_net = o[0] == 0;
            let cgnat = o[0] == 100 && (o[1] & 0b1100_0000) == 64;
            let ietf_proto = o[0] == 192 && o[1] == 0 && o[2] == 0;
            let benchmark = o[0] == 198 && (o[1] & 0xfe) == 18;
            let reserved = o[0] >= 240;
            !(this_net
                || v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || cgnat
                || ietf_proto
                || benchmark
                || reserved)
        }
        std::net::IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(std::net::IpAddr::V4(v4));
            }
            let segs = v6.segments();
            if segs[..6] == [0; 6] && !v6.is_unspecified() && !v6.is_loopback() {
                if let Some(v4) = v6.to_ipv4() {
                    return is_public_ip(std::net::IpAddr::V4(v4));
                }
            }
            let docs = segs[0] == 0x2001 && segs[1] == 0x0db8;
            let discard = segs[0] == 0x0100 && segs[1] == 0 && segs[2] == 0 && segs[3] == 0;
            let site_local = (segs[0] & 0xffc0) == 0xfec0;
            !(v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || docs
                || discard
                || site_local)
        }
    }
}

pub(crate) async fn validate_poster_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("{raw}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("{raw}: разрешены только http(s) URL"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("{raw}: учетные данные в URL запрещены"));
    }
    let port = parsed.port_or_known_default().ok_or_else(|| format!("{raw}: нет порта"))?;
    match parsed.host() {
        Some(url::Host::Ipv4(v4)) => {
            if !is_public_ip(std::net::IpAddr::V4(v4)) {
                return Err(format!("{raw}: локальный или приватный IP запрещён"));
            }
        }
        Some(url::Host::Ipv6(v6)) => {
            if !is_public_ip(std::net::IpAddr::V6(v6)) {
                return Err(format!("{raw}: локальный или приватный IP запрещён"));
            }
        }
        Some(url::Host::Domain(domain)) => {
            let d = domain.trim_end_matches('.').to_ascii_lowercase();
            if d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") || d.ends_with(".internal") {
                return Err(format!("{raw}: локальный домен запрещён"));
            }
            let addrs: Vec<_> = tokio::net::lookup_host((domain, port))
                .await
                .map_err(|e| format!("{raw}: DNS: {e}"))?
                .collect();
            if addrs.is_empty() || addrs.iter().any(|a| !is_public_ip(a.ip())) {
                return Err(format!("{raw}: хост ведёт на непубличный адрес"));
            }
        }
        None => return Err(format!("{raw}: нет хоста")),
    }
    Ok(parsed)
}

pub(crate) async fn read_capped_image(mut r: reqwest::Response, url: &str) -> Result<Vec<u8>, String> {
    if !r.status().is_success() {
        return Err(format!("{url}: HTTP {}", r.status()));
    }
    if r.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
        return Err(format!("{url}: слишком большой постер"));
    }
    let mut buf = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|e| e.to_string())? {
        if buf.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err(format!("{url}: больше {MAX_BYTES} байт"));
        }
        buf.extend_from_slice(&chunk);
    }
    if image_mime(&buf) == "application/octet-stream" {
        return Err(format!("{url}: не изображение"));
    }
    Ok(buf)
}

async fn fetch(st: &AppState, url: &str) -> Result<Vec<u8>, String> {
    let parsed = validate_poster_url(url).await?;
    let r = st.untrusted_http.get(parsed).timeout(Duration::from_secs(15)).send().await.map_err(|e| e.to_string())?;
    if r.remote_addr().is_some_and(|a| !is_public_ip(a.ip())) {
        return Err(format!("{url}: ответ с непубличного адреса"));
    }
    read_capped_image(r, url).await
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

    #[test]
    fn url_appends_media_token() {
        let u = url(47800, "ts:abc:3");
        assert!(u.starts_with("http://127.0.0.1:47800/media/poster/"));
        assert!(u.contains("?t="));
        assert!(u.ends_with(crate::server::media_token()));
    }

    #[tokio::test]
    async fn ssrf_guard_rejects_local_private_metadata_and_non_http_urls() {
        for bad in [
            "file:///etc/passwd",
            "ftp://93.184.216.34/a.jpg",
            "https://user:pass@93.184.216.34/a.jpg",
            "http://127.0.0.1:8080/a.jpg",
            "http://localhost/a.jpg",
            "http://[::1]/a.jpg",
            "http://[::ffff:127.0.0.1]/a.jpg",
            "http://[::ffff:169.254.169.254]/latest/meta-data",
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.1/a.jpg",
            "http://172.16.0.1/a.jpg",
            "http://192.168.1.1/a.jpg",
            "http://100.64.0.1/a.jpg",
            "http://0.0.0.0/a.jpg",
        ] {
            assert!(validate_poster_url(bad).await.is_err(), "expected {bad} to be blocked");
        }
        assert!(is_public_ip("93.184.216.34".parse().unwrap()));
        assert!(is_public_ip("2606:2800:220:1:248:1893:25c8:1946".parse().unwrap()));
    }

    #[tokio::test]
    async fn read_capped_image_enforces_streaming_limit_and_no_redirects() {
        use axum::{body::Body, http::StatusCode, response::IntoResponse, routing::get, Router};
        let app = Router::new()
            .route("/ok.png", get(|| async { vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }))
            .route("/html", get(|| async { b"<html>not image</html>".to_vec() }))
            .route("/big", get(|| async {
                let chunks = futures_util::stream::iter((0..12).map(|i| {
                    let mut v = vec![0u8; 512 * 1024];
                    if i == 0 {
                        v[..4].copy_from_slice(&[0x89, 0x50, 0x4E, 0x47]);
                    }
                    Ok::<_, std::io::Error>(axum::body::Bytes::from(v))
                }));
                Body::from_stream(chunks)
            }))
            .route("/redir", get(|| async { (StatusCode::FOUND, [(axum::http::header::LOCATION, "/ok.png")]).into_response() }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();

        let r_ok = client.get(format!("http://{addr}/ok.png")).send().await.unwrap();
        assert_eq!(read_capped_image(r_ok, "ok").await.unwrap().len(), 8);

        let r_html = client.get(format!("http://{addr}/html")).send().await.unwrap();
        assert!(read_capped_image(r_html, "html").await.is_err());

        let r_big = client.get(format!("http://{addr}/big")).send().await.unwrap();
        assert!(read_capped_image(r_big, "big").await.is_err());

        let r_redir = client.get(format!("http://{addr}/redir")).send().await.unwrap();
        assert!(read_capped_image(r_redir, "redir").await.is_err());

        srv.abort();
    }
}
