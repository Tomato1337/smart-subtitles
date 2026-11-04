use super::moviehash;
use crate::{session::Session, state::AppState};
use anyhow::{anyhow, bail};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex, time::{Duration, Instant}};

const BASE: &str = "https://api.opensubtitles.com/api/v1";
static TOKEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// One subtitle file the search found; `exact` marks a moviehash match.
#[derive(Debug, Clone)]
pub struct Hit {
    pub file_id: i64,
    pub release: String,
    pub exact: bool,
    pub hearing_impaired: bool,
    pub downloads: i64,
}

pub struct Found { pub bytes: Vec<u8>, pub label: String, pub exact: bool, pub file_id: i64 }

pub enum Outcome { Found(Found), NotFound, QuotaExhausted }

/// A `/download` answer: the file itself, or the daily quota is gone.
pub enum Download { Bytes(Vec<u8>), QuotaExhausted }

fn req(st: &AppState, b: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    b.header("Api-Key", &st.cfg().opensubtitles.api_key).header("User-Agent", "smart-subtitle v0.1").header("Accept", "application/json")
}

/// Sends the request; one retry after 2 s on HTTP 429.
async fn send(b: reqwest::RequestBuilder) -> anyhow::Result<reqwest::Response> {
    let again = b.try_clone();
    let r = b.send().await?;
    if r.status().as_u16() == 429 {
        if let Some(b2) = again {
            tokio::time::sleep(Duration::from_secs(2)).await;
            return Ok(b2.send().await?);
        }
    }
    Ok(r)
}

async fn token(st: &AppState) -> anyhow::Result<String> {
    if let Some((t, at)) = TOKEN.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_secs(23 * 3600) { return Ok(t.clone()); }
    }
    let o = &st.cfg().opensubtitles;
    let r = send(req(st, st.http.post(format!("{BASE}/login")).json(&json!({ "username": o.username, "password": o.password })))).await?;
    if !r.status().is_success() { bail!("OpenSubtitles login: HTTP {}", r.status()); }
    let v: Value = r.json().await?;
    let t = v["token"].as_str().ok_or_else(|| anyhow!("нет token"))?.to_string();
    *TOKEN.lock().unwrap() = Some((t.clone(), Instant::now()));
    Ok(t)
}

/// Orders search hits: hash match first, then non-HI, dropping machine/foreign-parts results, then by downloads.
pub fn rank(data: &[Value]) -> Vec<Hit> {
    let flag = |a: &Value, k: &str| a[k].as_bool().unwrap_or(false);
    let mut c: Vec<Hit> = data
        .iter()
        .filter(|d| {
            let a = &d["attributes"];
            let forced = a["release"].as_str().is_some_and(|r| r.to_lowercase().contains("forced"));
            !forced && !flag(a, "ai_translated") && !flag(a, "machine_translated") && !flag(a, "foreign_parts_only") && a["files"][0]["file_id"].is_number()
        })
        .map(|d| {
            let a = &d["attributes"];
            Hit {
                file_id: a["files"][0]["file_id"].as_i64().unwrap_or(0),
                release: a["release"].as_str().unwrap_or("OpenSubtitles").to_string(),
                exact: flag(a, "moviehash_match"),
                hearing_impaired: flag(a, "hearing_impaired"),
                downloads: a["download_count"].as_i64().unwrap_or(0),
            }
        })
        .collect();
    c.sort_by_key(|h| (!h.exact, h.hearing_impaired, std::cmp::Reverse(h.downloads)));
    c
}

/// English candidates for the session's film, best first; downloading them is a separate, quota-bound step.
pub async fn search(st: &AppState, s: &Session) -> anyhow::Result<Vec<Hit>> {
    let hash = match moviehash::head_tail(&st.http, &s.src.clone()).await {
        Ok((size, h, t)) => Some(moviehash::moviehash(size, &h, &t)),
        Err(e) => { crate::logs::log("app", &format!("moviehash: {e}")); None }
    };
    // Parameters must be sorted alphabetically and lower-case, otherwise the API redirects.
    let mut q: Vec<(&str, String)> = vec![];
    let card = s.req.card.as_ref().filter(|c| c.tmdb_id != 0);
    let (season, episode) = crate::session::season_episode_of(&s.req);
    match (card, season, episode) {
        (Some(c), Some(se), Some(ep)) if c.kind == "tv" => {
            q.push(("episode_number", ep.to_string()));
            q.push(("languages", "en".into()));
            if let Some(h) = &hash { q.push(("moviehash", h.clone())); }
            q.push(("parent_tmdb_id", c.tmdb_id.to_string()));
            q.push(("season_number", se.to_string()));
        }
        (Some(c), _, _) => {
            q.push(("languages", "en".into()));
            if let Some(h) = &hash { q.push(("moviehash", h.clone())); }
            q.push(("tmdb_id", c.tmdb_id.to_string()));
        }
        _ => {
            q.push(("languages", "en".into()));
            if let Some(h) = &hash { q.push(("moviehash", h.clone())); }
            q.push(("query", s.req.card.as_ref().and_then(|c| c.original_title.clone()).unwrap_or_else(|| s.req.title.clone())));
        }
    }
    let r = send(req(st, st.http.get(format!("{BASE}/subtitles")).query(&q))).await?;
    if !r.status().is_success() { bail!("OpenSubtitles search: HTTP {}", r.status()); }
    let v: Value = r.json().await?;
    Ok(rank(v["data"].as_array().map(Vec::as_slice).unwrap_or_default()))
}

pub fn cache_path(file_id: i64) -> PathBuf {
    crate::config::cache_dir().join("opensubtitles").join(format!("{file_id}.srt"))
}

pub async fn download(st: &AppState, file_id: i64) -> anyhow::Result<Download> {
    let cache = cache_path(file_id);
    if let Ok(bytes) = tokio::fs::read(&cache).await {
        return Ok(Download::Bytes(bytes));
    }
    // Anonymous downloads work with the API key alone (smaller daily quota); login only raises it.
    let mut dl = req(st, st.http.post(format!("{BASE}/download")).json(&json!({ "file_id": file_id, "sub_format": "srt" })));
    if !st.cfg().opensubtitles.username.is_empty() {
        dl = dl.bearer_auth(token(st).await?);
    }
    let r = send(dl).await?;
    let status = r.status().as_u16();
    let d: Value = r.json().await.unwrap_or(Value::Null);
    let Some(link) = d["link"].as_str() else {
        if status == 406 || d["remaining"].as_i64() == Some(0) { return Ok(Download::QuotaExhausted); }
        bail!("OpenSubtitles download: HTTP {status}");
    };
    let bytes = st.http.get(link).send().await?.error_for_status()?.bytes().await?.to_vec();
    if let Some(dir) = cache.parent() { let _ = tokio::fs::create_dir_all(dir).await; }
    let _ = tokio::fs::write(&cache, &bytes).await;
    Ok(Download::Bytes(bytes))
}

pub async fn fetch(st: &AppState, s: &Session) -> anyhow::Result<Outcome> {
    let Some(hit) = search(st, s).await?.into_iter().next() else { return Ok(Outcome::NotFound) };
    match download(st, hit.file_id).await? {
        Download::Bytes(bytes) => Ok(Outcome::Found(Found { bytes, label: hit.release, exact: hit.exact, file_id: hit.file_id })),
        Download::QuotaExhausted => Ok(Outcome::QuotaExhausted),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(id: i64, hash: bool, hi: bool, dl: i64, ai: bool) -> Value {
        json!({"attributes":{"moviehash_match":hash,"hearing_impaired":hi,"download_count":dl,"ai_translated":ai,"files":[{"file_id":id}]}})
    }

    #[test]
    fn selection_order() {
        let d = vec![hit(1, false, false, 900, false), hit(2, true, true, 10, false), hit(3, true, false, 5, false), hit(4, true, false, 99, true)];
        let r = rank(&d);
        assert_eq!(r[0].file_id, 3);
        assert!(r[0].exact);
        let d = vec![hit(1, false, true, 900, false), hit(2, false, false, 10, false), hit(3, false, false, 50, false)];
        let r = rank(&d);
        assert_eq!(r[0].file_id, 3);
        assert!(!r[0].exact);
        assert!(rank(&[hit(9, true, false, 1, true)]).is_empty());
    }
}
