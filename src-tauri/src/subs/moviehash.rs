use anyhow::{anyhow, Context};

const CHUNK: usize = 65536;

/// OpenSubtitles hash: file size + sum of little-endian u64 words over the first and last 64 KiB (wrapping).
pub fn moviehash(size: u64, head: &[u8], tail: &[u8]) -> String {
    let sum = |b: &[u8]| b.chunks_exact(8).fold(0u64, |a, w| a.wrapping_add(u64::from_le_bytes(w.try_into().unwrap())));
    format!("{:016x}", size.wrapping_add(sum(head)).wrapping_add(sum(tail)))
}

/// Size and first/last 64 KiB of a file:// or http(s) source (two Range requests for HTTP).
pub async fn head_tail(http: &reqwest::Client, src: &str) -> anyhow::Result<(u64, Vec<u8>, Vec<u8>)> {
    if let Some(path) = src.strip_prefix("file://") {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let path = url::Url::parse(src).ok().and_then(|u| u.to_file_path().ok()).unwrap_or_else(|| path.into());
        let mut f = tokio::fs::File::open(&path).await.context("open")?;
        let size = f.metadata().await?.len();
        let head_len = usize::try_from(size.min(CHUNK as u64)).context("head size overflow")?;
        let mut head = vec![0u8; head_len];
        f.read_exact(&mut head).await?;
        let tail_len = usize::try_from(size.min(CHUNK as u64)).context("tail size overflow")?;
        let tail_start = size.checked_sub(tail_len as u64).ok_or_else(|| anyhow!("size underflow"))?;
        f.seek(std::io::SeekFrom::Start(tail_start)).await?;
        let mut tail = vec![0u8; tail_len];
        f.read_exact(&mut tail).await?;
        return Ok((size, head, tail));
    }
    let r = http.get(src).header("Range", format!("bytes=0-{}", CHUNK - 1)).send().await?.error_for_status()?;
    let size = r
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('/').next())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| anyhow!("нет Content-Range"))?;
    let head = crate::subs::sidecar::read_bounded(r, CHUNK).await?;
    let tail_from = size.checked_sub(CHUNK as u64).ok_or_else(|| anyhow!("файл слишком мал"))?;
    let tail_to = size.checked_sub(1).ok_or_else(|| anyhow!("файл слишком мал"))?;
    let r = http.get(src).header("Range", format!("bytes={tail_from}-{tail_to}")).send().await?.error_for_status()?;
    let tail = crate::subs::sidecar::read_bounded(r, CHUNK).await?;
    Ok((size, head, tail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_reference_python_implementation() {
        // reference: size + sum(<Q words of first and last 64 KiB) mod 2^64 over bytes (i*7)%251, 200 KiB
        let data: Vec<u8> = (0..200 * 1024).map(|i| ((i * 7) % 251) as u8).collect();
        let h = moviehash(data.len() as u64, &data[..65536], &data[data.len() - 65536..]);
        assert_eq!(h, "627992a2a9c7e48e");
    }

    #[tokio::test]
    async fn head_tail_caps_oversized_range_response_and_handles_small_file() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let dir = std::env::temp_dir().join(format!("smartsubs-mh-{}", std::process::id()));
        let _ = tokio::fs::create_dir_all(&dir).await;
        let tiny = dir.join("tiny.bin");
        tokio::fs::write(&tiny, b"hello").await.unwrap();
        let file_url = url::Url::from_file_path(&tiny).unwrap().to_string();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let (sz, head, tail) = head_tail(&client, &file_url).await.unwrap();
        let _ = tokio::fs::remove_dir_all(&dir).await;
        assert_eq!(sz, 5);
        assert_eq!(head, b"hello");
        assert_eq!(tail, b"hello");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 512];
            let _ = sock.read(&mut buf).await;
            let body = vec![b'x'; CHUNK + 1024];
            let hdr = format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-{}/{}\r\nContent-Length: {}\r\n\r\n",
                CHUNK - 1,
                CHUNK * 4,
                body.len()
            );
            let _ = sock.write_all(hdr.as_bytes()).await;
            let _ = sock.write_all(&body).await;
        });

        let err = head_tail(&client, &format!("http://{addr}/film.mkv")).await.unwrap_err();
        assert!(err.to_string().contains("too large") || err.to_string().contains("exceeds"), "err={err}");
        let _ = server.await;
    }
}
