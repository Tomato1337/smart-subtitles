use super::moviehash;
use crate::{session::Session, state::AppState};
use anyhow::{anyhow, bail};
use serde_json::{json, Value};
use std::{sync::Mutex, time::{Duration, Instant}};

const BASE: &str = "https://api.opensubtitles.com/api/v1";
static TOKEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);

pub struct Found { pub bytes: Vec<u8>, pub label: String, pub exact: bool }

pub enum Outcome { Found(Found), NotFound, QuotaExhausted }

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
pub fn pick(data: &[Value]) -> Option<(&Value, bool)> {
    let flag = |a: &Value, k: &str| a[k].as_bool().unwrap_or(false);
    let mut c: Vec<&Value> = data
        .iter()
        .filter(|d| {
            let a = &d["attributes"];
            let forced = a["release"].as_str().is_some_and(|r| r.to_lowercase().contains("forced"));
            !forced && !flag(a, "ai_translated") && !flag(a, "machine_translated") && !flag(a, "foreign_parts_only") && a["files"][0]["file_id"].is_number()
        })
        .collect();
    c.sort_by_key(|d| {
        let a = &d["attributes"];
        (!flag(a, "moviehash_match"), flag(a, "hearing_impaired"), std::cmp::Reverse(a["download_count"].as_i64().unwrap_or(0)))
    });
    c.first().map(|d| (*d, d["attributes"]["moviehash_match"].as_bool().unwrap_or(false)))
}

pub async fn fetch(st: &AppState, s: &Session) -> anyhow::Result<Outcome> {
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
    let data = v["data"].as_array().cloned().unwrap_or_default();
    let Some((hit, exact)) = pick(&data) else { return Ok(Outcome::NotFound) };
    let file_id = hit["attributes"]["files"][0]["file_id"].clone();
    let label = hit["attributes"]["release"].as_str().unwrap_or("OpenSubtitles").to_string();

    let cache = crate::config::cache_dir().join("opensubtitles").join(format!("{file_id}.srt"));
    if let Ok(bytes) = tokio::fs::read(&cache).await {
        return Ok(Outcome::Found(Found { bytes, label, exact }));
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
        if status == 406 || d["remaining"].as_i64() == Some(0) { return Ok(Outcome::QuotaExhausted); }
        bail!("OpenSubtitles download: HTTP {status}");
    };
    let bytes = st.http.get(link).send().await?.error_for_status()?.bytes().await?.to_vec();
    if let Some(dir) = cache.parent() { let _ = tokio::fs::create_dir_all(dir).await; }
    let _ = tokio::fs::write(&cache, &bytes).await;
    Ok(Outcome::Found(Found { bytes, label, exact }))
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
        let (h, exact) = pick(&d).unwrap();
        assert_eq!(h["attributes"]["files"][0]["file_id"], 3);
        assert!(exact);
        let d = vec![hit(1, false, true, 900, false), hit(2, false, false, 10, false), hit(3, false, false, 50, false)];
        let (h, exact) = pick(&d).unwrap();
        assert_eq!(h["attributes"]["files"][0]["file_id"], 3);
        assert!(!exact);
        assert!(pick(&[hit(9, true, false, 1, true)]).is_none());
    }
}
