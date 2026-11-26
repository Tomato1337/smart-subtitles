use crate::state::AppState;
use regex::Regex;
use std::sync::OnceLock;

fn en_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(^|[^a-z])(en|eng|english)([^a-z]|$)").unwrap())
}

fn decode_url(u: &str) -> String {
    url::form_urlencoded::parse(format!("k={u}").as_bytes()).next().map(|p| p.1.into_owned()).unwrap_or_default()
}

pub fn is_english_ref(label: &str, url: &str) -> bool {
    en_re().is_match(label) || en_re().is_match(&decode_url(url))
}

/// Heuristic for a lone unlabelled file: lots of English stopwords, almost no Cyrillic.
pub fn looks_english(text: &str) -> bool {
    static W: OnceLock<Regex> = OnceLock::new();
    let w = W.get_or_init(|| Regex::new(r"(?i)\b(the|you|and|is)\b").unwrap());
    let sample: String = text.lines().take(200).collect::<Vec<_>>().join("\n");
    let letters = sample.chars().filter(|c| c.is_alphabetic()).count().max(1);
    let cyr = sample.chars().filter(|c| ('\u{0400}'..='\u{04FF}').contains(c)).count();
    w.find_iter(&sample).count() >= 10 && (cyr as f64 / letters as f64) < 0.05
}

pub(super) const MAX_SUB_BYTES: usize = 10 * 1024 * 1024;

pub(super) fn no_redirect_http(url: &str) -> anyhow::Result<reqwest::Client> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    static LOOPBACK_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let is_loopback = url::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str().map(|h| {
                h.eq_ignore_ascii_case("localhost") || h == "127.0.0.1" || h == "[::1]" || h == "::1"
            })
        })
        .unwrap_or(false);
    let cell = if is_loopback { &LOOPBACK_CLIENT } else { &CLIENT };
    if let Some(c) = cell.get() {
        return Ok(c.clone());
    }
    let mut b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30));
    if is_loopback {
        b = b.no_proxy();
    }
    let built = b.build()?;
    Ok(cell.get_or_init(|| built).clone())
}

pub(super) async fn read_bounded(
    resp: reqwest::Response,
    max_bytes: usize,
) -> anyhow::Result<Vec<u8>> {
    if resp.status().is_redirection() {
        anyhow::bail!("HTTP redirect rejected ({})", resp.status());
    }
    let mut resp = resp.error_for_status()?;
    if let Some(len) = resp.content_length() {
        if len > max_bytes as u64 {
            anyhow::bail!("HTTP body too large ({len} > {max_bytes})");
        }
    }
    let cap = resp
        .content_length()
        .and_then(|n| usize::try_from(n).ok())
        .map(|n| n.min(max_bytes))
        .unwrap_or(0);
    let mut out = Vec::with_capacity(cap);
    while let Some(chunk) = resp.chunk().await? {
        let next_len = out
            .len()
            .checked_add(chunk.len())
            .filter(|&n| n <= max_bytes)
            .ok_or_else(|| anyhow::anyhow!("HTTP body exceeds {max_bytes} bytes"))?;
        out.reserve(next_len - out.len());
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

pub(super) async fn read_file_bounded(
    path: &std::path::Path,
    max_bytes: usize,
) -> anyhow::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let f = tokio::fs::File::open(path).await?;
    let meta = f.metadata().await?;
    if meta.len() > max_bytes as u64 {
        anyhow::bail!("subtitle file too large ({} > {max_bytes})", meta.len());
    }
    let mut buf = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0).min(max_bytes));
    let read = f
        .take((max_bytes as u64).saturating_add(1))
        .read_to_end(&mut buf)
        .await?;
    if read > max_bytes || buf.len() > max_bytes {
        anyhow::bail!("subtitle file exceeds {max_bytes} bytes");
    }
    Ok(buf)
}

async fn read_ref_target(source_url: &str, url: &str, http_target: &str) -> anyhow::Result<Vec<u8>> {
    let parsed = url::Url::parse(url)?;
    match parsed.scheme() {
        "file" => {
            let source_is_file = url::Url::parse(source_url)
                .map(|u| u.scheme() == "file")
                .unwrap_or(false);
            if !source_is_file {
                anyhow::bail!("file:// subtitle reference rejected for non-file source");
            }
            let p = parsed.to_file_path().map_err(|_| anyhow::anyhow!("bad file url"))?;
            read_file_bounded(&p, MAX_SUB_BYTES).await
        }
        "http" | "https" => {
            let resp = no_redirect_http(http_target)?.get(http_target).send().await?;
            read_bounded(resp, MAX_SUB_BYTES).await
        }
        other => anyhow::bail!("unsupported subtitle scheme: {other}"),
    }
}

pub async fn read_ref(st: &AppState, source_url: &str, url: &str) -> anyhow::Result<Vec<u8>> {
    let http_target = if url.starts_with("http://") || url.starts_with("https://") {
        st.cfg().with_auth(url)
    } else {
        url.to_string()
    };
    read_ref_target(source_url, url, &http_target).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_refs() {
        assert!(is_english_ref("eng", "http://x/stream/a.srt"));
        assert!(is_english_ref("", "http://x/Subs/English/2_English.srt"));
        assert!(is_english_ref("English SDH", ""));
        assert!(!is_english_ref("rus", "http://x/Subs/rus/3.srt"));
        assert!(!is_english_ref("Engineer", "http://x/y"));
    }

    #[test]
    fn language_heuristic() {
        let en = "You are the one and it is true\n".repeat(12);
        assert!(looks_english(&en));
        assert!(!looks_english(&"Привет, это тест и ты\n".repeat(50)));
    }

    #[tokio::test]
    async fn read_ref_rejects_file_for_remote_source_and_allows_local() {
        let dir = std::env::temp_dir().join(format!("smartsubs-sc-{}", std::process::id()));
        let _ = tokio::fs::create_dir_all(&dir).await;
        let srt = dir.join("sub.srt");
        tokio::fs::write(&srt, b"1\n00:00:01,000 --> 00:00:02,000\nhi\n").await.unwrap();
        let file_url = url::Url::from_file_path(&srt).unwrap().to_string();

        let err = read_ref_target("http://example.com/video.mkv", &file_url, &file_url)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("file:// subtitle reference rejected"), "err={err}");

        let ok = read_ref_target("file:///tmp/video.mkv", &file_url, &file_url).await.unwrap();
        assert!(String::from_utf8_lossy(&ok).contains("hi"));
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn read_bounded_blocks_redirects_and_caps_streaming_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut req_buf = [0u8; 1024];
                let n = sock.read(&mut req_buf).await.unwrap();
                let req = String::from_utf8_lossy(&req_buf[..n]);
                if req.starts_with("GET /redirect ") {
                    let _ = sock
                        .write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/x\r\nContent-Length: 0\r\n\r\n")
                        .await;
                } else {
                    let _ = sock
                        .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                        .await;
                    let chunk = vec![b'a'; 4096];
                    let hdr = format!("{:x}\r\n", chunk.len());
                    for _ in 0..5 {
                        if sock.write_all(hdr.as_bytes()).await.is_err() { break; }
                        if sock.write_all(&chunk).await.is_err() { break; }
                        if sock.write_all(b"\r\n").await.is_err() { break; }
                    }
                    let _ = sock.write_all(b"0\r\n\r\n").await;
                }
            }
        });

        let redir_url = format!("http://{addr}/redirect");
        let err = read_ref_target("http://x/v.mkv", &redir_url, &redir_url).await.unwrap_err();
        assert!(err.to_string().contains("redirect rejected"), "err={err}");

        let big_url = format!("http://{addr}/big");
        let resp = no_redirect_http(&big_url).unwrap().get(&big_url).send().await.unwrap();
        let err = read_bounded(resp, 8192).await.unwrap_err();
        assert!(err.to_string().contains("exceeds 8192"), "err={err}");

        let _ = server.await;
    }
}
