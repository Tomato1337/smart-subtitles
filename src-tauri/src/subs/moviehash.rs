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
        let mut head = vec![0u8; CHUNK.min(size as usize)];
        f.read_exact(&mut head).await?;
        let tail_len = CHUNK.min(size as usize);
        f.seek(std::io::SeekFrom::Start(size - tail_len as u64)).await?;
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
    let head = r.bytes().await?.to_vec();
    if size < CHUNK as u64 { return Err(anyhow!("файл слишком мал")); }
    let r = http.get(src).header("Range", format!("bytes={}-{}", size - CHUNK as u64, size - 1)).send().await?.error_for_status()?;
    let tail = r.bytes().await?.to_vec();
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
}
