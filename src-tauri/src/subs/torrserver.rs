//! TorrServer MatriX.147+ `/subs` API: subtitle files that live inside the torrent.

use crate::state::AppState;
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;

/// Fully built `…/subs/{hash}/{id}`; the credentials from the source URL are kept.
pub struct Target {
    list: Url,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct Track {
    pub index: u32,
    pub title: String,
    pub lang: String,
    pub format: String,
}

/// Live state of the torrent behind a stream: peers, speed and the contiguous part of the current
/// readahead window that is already downloaded. The five-dot signal in the player uses the last one.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentHealth {
    pub active_peers: u32,
    pub total_peers: u32,
    pub connected_seeders: u32,
    /// Bytes per second, as TorrServer counts them.
    pub download_speed: f64,
    /// Downloaded share of the reader's window; `None` while no reader is open.
    pub buffer_percent: Option<f64>,
    pub buffered_pieces: u32,
    pub buffer_pieces: u32,
}

fn field<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| v.get(*k))
}

fn number(v: &Value, keys: &[&str]) -> f64 {
    field(v, keys)
        .and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0.0)
}

fn count(v: &Value, keys: &[&str]) -> u32 {
    number(v, keys).max(0.0).min(u32::MAX as f64) as u32
}

/// Reader window and the pieces loaded contiguously from its read position, as TorrServer's cache
/// state reports them. A missing piece stops the count: that is exactly where playback would stall.
fn buffer(v: &Value) -> (Option<f64>, u32, u32) {
    let Some(reader) = field(v, &["Readers", "readers"]).and_then(Value::as_array).and_then(|a| a.first()) else {
        return (None, 0, 0);
    };
    let at = count(reader, &["Reader", "reader", "Start", "start"]) as u64;
    let end = count(reader, &["End", "end"]) as u64;
    let span = end.saturating_sub(at);
    if span == 0 { return (None, 0, 0); }
    let pieces = field(v, &["Pieces", "pieces"]).and_then(Value::as_object);
    let mut loaded = 0u64;
    for i in at..end {
        let done = pieces
            .and_then(|m| m.get(&i.to_string()))
            .and_then(|p| field(p, &["Completed", "completed"]))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !done { break; }
        loaded += 1;
    }
    let percent = loaded as f64 / span as f64 * 100.0;
    (Some(percent), loaded.min(u32::MAX as u64) as u32, span.min(u32::MAX as u64) as u32)
}

/// Parses a `/cache` cache state or a `/torrents get` status. Cache state nests the status under
/// `Torrent`; builds differ in the case of JSON keys, so both spellings are accepted.
fn parse_health(v: &Value) -> Option<TorrentHealth> {
    let status = field(v, &["Torrent", "torrent"]).unwrap_or(v);
    // An empty `/cache` answer has neither a status nor a hash: the caller tries `/torrents`.
    let known = ["ActivePeers", "active_peers", "TotalPeers", "total_peers", "Stat", "stat", "Name", "name"]
        .iter()
        .any(|k| status.get(*k).is_some());
    if !status.is_object() || !known { return None; }
    let (buffer_percent, buffered_pieces, buffer_pieces) = buffer(v);
    Some(TorrentHealth {
        active_peers: count(status, &["ActivePeers", "active_peers"]),
        total_peers: count(status, &["TotalPeers", "total_peers"]),
        connected_seeders: count(status, &["ConnectedSeeders", "connected_seeders"]),
        download_speed: number(status, &["DownloadSpeed", "download_speed"]),
        buffer_percent,
        buffered_pieces,
        buffer_pieces,
    })
}

fn btih(s: &str) -> Option<String> {
    let h = s.to_ascii_lowercase();
    (h.len() == 40 && h.chars().all(|c| c.is_ascii_hexdigit())).then_some(h)
}

/// `(any stream URL with its credentials, the server prefix, the info hash, the file index)`.
fn parts(src: &str) -> Option<(Url, String, String, u32)> {
    let u = Url::parse(src).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    let at = u.path().find("/stream/")?;
    let prefix = u.path()[..at].to_string();
    let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
    let link = q.get("link")?;
    let index: u32 = q.get("index")?.parse().ok()?;
    let hash = if let Some(rest) = link.strip_prefix("magnet:") {
        let rest = rest.split_once("urn:btih:")?.1;
        btih(rest.split('&').next()?)?
    } else {
        btih(link)?
    };
    Some((u, prefix, hash, index))
}

/// Maps a TorrServer `/stream/…?link=&index=` URL to its `/subs` endpoint.
pub fn target(src: &str) -> Option<Target> {
    let (mut u, prefix, hash, index) = parts(src)?;
    u.set_path(&format!("{prefix}/subs/{hash}/{index}"));
    u.set_query(None);
    u.set_fragment(None);
    Some(Target { list: u })
}

/// `(…/cache or …/torrents with credentials, the info hash)` of a stream.
fn api_url(src: &str, endpoint: &str) -> Option<(Url, String)> {
    let (mut u, prefix, hash, _) = parts(src)?;
    u.set_path(&format!("{prefix}/{endpoint}"));
    u.set_query(None);
    u.set_fragment(None);
    Some((u, hash))
}

async fn api_value(st: &AppState, src: &str, endpoint: &str, action: &str, hash: &str) -> Option<Value> {
    let (u, _) = api_url(src, endpoint)?;
    st.http
        .post(u)
        .timeout(Duration::from_secs(4))
        .json(&json!({ "action": action, "hash": hash }))
        .send()
        .await
        .map_err(hide)
        .ok()?
        .error_for_status()
        .map_err(hide)
        .ok()?
        .json()
        .await
        .map_err(hide)
        .ok()
}

/// Peers, download speed and buffer health of the stream's torrent. `None` when the source is not a
/// TorrServer stream or the server does not expose its cache state.
pub async fn health(st: &AppState, src: &str) -> Option<TorrentHealth> {
    let (_, hash) = api_url(src, "cache")?;
    if let Some(v) = api_value(st, src, "cache", "get", &hash).await {
        if let Some(h) = parse_health(&v) { return Some(h); }
    }
    // Older builds answer `/cache` with `{}` before the first read; `/torrents` still has the speed.
    api_value(st, src, "torrents", "get", &hash)
        .await
        .and_then(|v| parse_health(&v))
}

/// English tracks in server order; a single unlabelled track is a fallback.
pub fn pick(tracks: &[Track]) -> (Vec<&Track>, bool) {
    let en: Vec<&Track> = tracks.iter().filter(|t| t.lang == "en").collect();
    if !en.is_empty() {
        return (en, false);
    }
    let und: Vec<&Track> = tracks.iter().filter(|t| t.lang == "und").collect();
    if und.len() == 1 {
        return (und, true);
    }
    (Vec::new(), false)
}

fn hide(e: reqwest::Error) -> anyhow::Error {
    anyhow::anyhow!(e.without_url())
}

pub async fn list(st: &AppState, t: &Target) -> anyhow::Result<Vec<Track>> {
    // The server waits up to 60 s for torrent metadata or a read.
    let r = st
        .http
        .get(t.list.clone())
        .timeout(Duration::from_secs(70))
        .send()
        .await
        .map_err(hide)?
        .error_for_status()
        .map_err(hide)?;
    r.json::<Vec<Track>>().await.map_err(hide)
}

pub async fn fetch(st: &AppState, t: &Target, track: u32) -> anyhow::Result<Vec<u8>> {
    let mut u = t.list.clone();
    u.query_pairs_mut()
        .append_pair("track", &track.to_string())
        .append_pair("format", "original")
        .append_pair("encoding", "utf8");
    let r = st
        .http
        .get(u)
        .timeout(Duration::from_secs(70))
        .send()
        .await
        .map_err(hide)?
        .error_for_status()
        .map_err(hide)?;
    Ok(r.bytes().await.map_err(hide)?.to_vec())
}

/// Torrent piece size of the file behind `src`, in bytes: one HTTP Range read of a block inside a
/// new piece makes TorrServer download that whole piece. `None` when the server does not say.
pub async fn piece_length(st: &AppState, src: &str) -> Option<u64> {
    let (u, hash) = api_url(src, "cache")?;
    let r = st
        .http
        .post(u)
        .timeout(Duration::from_secs(20))
        .json(&serde_json::json!({ "action": "get", "hash": hash }))
        .send()
        .await
        .map_err(hide)
        .ok()?
        .error_for_status()
        .map_err(hide)
        .ok()?;
    // TorrServer names it `PiecesLength`; other builds use a snake_case and a string value.
    let v: serde_json::Value = r.json().await.map_err(hide).ok()?;
    let field = ["PiecesLength", "PieceLength", "pieceLength", "piecesLength"]
        .iter()
        .find_map(|k| v.get(*k))?;
    let n = field.as_u64().or_else(|| field.as_str().and_then(|s| s.parse().ok()))?;
    (n > 0).then_some(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(index: u32, lang: &str, title: &str) -> Track {
        Track { index, title: title.into(), lang: lang.into(), format: "srt".into() }
    }

    #[test]
    fn stream_url_with_credentials() {
        let u = target("https://u:p@h.example/tor/stream/x.mkv?link=ABCDEF0123456789ABCDEF0123456789ABCDEF01&index=3&play").unwrap();
        assert_eq!(u.list.as_str(), "https://u:p@h.example/tor/subs/abcdef0123456789abcdef0123456789abcdef01/3");
    }

    #[test]
    fn stream_url_without_prefix() {
        let h = "0123456789abcdef0123456789abcdef01234567";
        let u = target(&format!("http://127.0.0.1:8095/stream/x?link={h}&index=1")).unwrap();
        assert_eq!(u.list.as_str(), format!("http://127.0.0.1:8095/subs/{h}/1"));
    }

    #[test]
    fn magnet_link() {
        let u = target("https://h.example/tor/stream/x?link=magnet%3A%3Fxt%3Durn%3Abtih%3AABCDEF0123456789ABCDEF0123456789ABCDEF01%26dn%3Dx&index=2").unwrap();
        assert_eq!(u.list.path(), "/tor/subs/abcdef0123456789abcdef0123456789abcdef01/2");
    }

    #[test]
    fn unsupported_sources() {
        assert!(target("file:///a.mkv").is_none());
        assert!(target("https://h.example/tor/play/abc/1").is_none());
        assert!(target("https://h.example/tor/stream/x?link=0123456789abcdef0123456789abcdef01234567").is_none());
        assert!(target("https://h.example/tor/stream/x?index=1").is_none());
        assert!(target("https://h.example/tor/stream/x?link=abcdefghijklmnopqrstuvwxyz234567&index=1").is_none());
    }

    #[test]
    fn health_reads_cache_state_and_contiguous_pieces() {
        let v = serde_json::json!({
            "Pieces": {
                "10": { "Completed": true },
                "11": { "Completed": true },
                "12": { "Completed": false }
            },
            "Readers": [{ "Start": 10, "End": 15, "Reader": 10 }],
            "Torrent": {
                "active_peers": 12,
                "total_peers": 290,
                "connected_seeders": 10,
                "download_speed": 4_728_750.0
            }
        });
        let h = parse_health(&v).unwrap();
        assert_eq!((h.active_peers, h.total_peers, h.connected_seeders), (12, 290, 10));
        assert_eq!(h.download_speed, 4_728_750.0);
        assert_eq!((h.buffered_pieces, h.buffer_pieces), (2, 5));
        assert!((h.buffer_percent.unwrap() - 40.0).abs() < 1e-9);
    }

    #[test]
    fn health_without_a_reader_still_reports_peers() {
        let h = parse_health(&serde_json::json!({
            "active_peers": 3,
            "total_peers": 9,
            "connected_seeders": 2,
            "download_speed": 1_000_000.0
        }))
        .unwrap();
        assert_eq!(h.buffer_percent, None);
        assert_eq!(h.active_peers, 3);
        assert_eq!(h.total_peers, 9);
    }

    #[test]
    fn empty_cache_answer_is_not_a_status() {
        assert!(parse_health(&serde_json::json!({})).is_none());
    }

    #[test]
    fn parts_split_the_stream_url() {
        let h = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
        let (_, prefix, hash, index) = parts(&format!("https://u:p@h.example/tor/stream/x.mkv?link={h}&index=3&play")).unwrap();
        assert_eq!(prefix, "/tor");
        assert_eq!(hash, h.to_lowercase());
        assert_eq!(index, 3);
        assert!(parts("file:///a.mkv").is_none());
    }

    #[test]
    fn picks_english_tracks() {
        let list = [t(0, "ru", "rus"), t(1, "en", "a"), t(2, "en", "b")];
        let (c, lone) = pick(&list);
        assert_eq!(c.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert!(!lone);
    }

    #[test]
    fn picks_lone_unlabelled() {
        let list = [t(0, "ru", "rus"), t(1, "und", "x")];
        let (c, lone) = pick(&list);
        assert_eq!(c.len(), 1);
        assert!(lone);
    }

    #[test]
    fn rejects_ambiguous_or_foreign() {
        assert!(pick(&[t(0, "und", "a"), t(1, "und", "b")]).0.is_empty());
        assert!(pick(&[t(0, "ru", "a")]).0.is_empty());
    }

    #[tokio::test]
    async fn errors_hide_credentials() {
        let u = Url::parse("http://user:sekret@127.0.0.1:1/subs/x/1").unwrap();
        let e = reqwest::Client::new().get(u).send().await.unwrap_err();
        let msg = hide(e).to_string();
        assert!(!msg.contains("sekret") && !msg.contains("127.0.0.1"), "{msg}");
    }
}
