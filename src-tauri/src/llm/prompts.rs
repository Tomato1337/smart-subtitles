use crate::{patterns::PATTERNS, session::Session, state::AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

/// The film a request is about, captured when a job is created so a later film swap cannot change it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaContext {
    pub media_id: String,
    pub title: String,
    pub original_title: Option<String>,
    pub year: Option<i32>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub episode_title: Option<String>,
}

pub fn mmss(sec: f64) -> String {
    let s = sec.max(0.0) as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// Tutor owns the level when the add-on is on; otherwise the one saved in the app.
async fn learner_cefr(st: &AppState) -> String {
    let cfg = st.cfg();
    if cfg.tutor.enabled {
        if let Some(v) = crate::tutor::api::settings(&st.http, &cfg.tutor).await {
            if let Some(level) = v["learner.cefr"].as_str() {
                return level.to_string();
            }
        }
    }
    cfg.learner.cefr.clone()
}

fn system_text(cefr: &str) -> String {
    let mut s = format!(
        "Ты — преподаватель английского для русскоязычного ученика уровня {cefr}. Переводы — естественный разговорный русский, \
         сохраняй регистр (мат → мат, сленг → сленг). Отвечай строго JSON по схеме задачи.\n\n\
         KINDS: idiom (идиома), phrasal_verb (фразовый глагол), collocation (устойчивое сочетание), slang (сленг), \
         reduction (gonna/wanna/kinda…), grammar (трудная грамматическая конструкция).\n\nPATTERNS (id — формула — описание):\n"
    );
    for p in PATTERNS.iter() {
        s.push_str(&format!("{} — {} — {}\n", p.id, p.formula, p.about));
    }
    s
}

fn cue_signature_db(c: &rusqlite::Connection, media_id: &str) -> rusqlite::Result<(i64, i64, i64)> {
    c.query_row(
        "SELECT count(*), coalesce(max(idx), -1), coalesce(sum(length(text)), 0) FROM cue WHERE media_id=?1",
        [media_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
}

async fn cue_signature(st: &AppState, media_id: &str) -> anyhow::Result<(i64, i64, i64)> {
    let mid = media_id.to_string();
    st.db(move |c| cue_signature_db(c, &mid))
        .await
        .map_err(anyhow::Error::msg)
}

fn cache_prefix_if_unchanged(
    slot: &std::sync::Mutex<Option<Arc<Vec<Value>>>>,
    before: (i64, i64, i64),
    after: (i64, i64, i64),
    built: &Arc<Vec<Value>>,
) -> bool {
    if before != after {
        return false;
    }
    *slot.lock().unwrap() = Some(built.clone());
    true
}

/// The byte-for-byte stable prefix (system, film+script, "OK") shared by every request for one media,
/// which lets DeepSeek's automatic prefix cache hit. Built once per subtitle set.
pub async fn prefix(st: &AppState, s: &Session) -> anyhow::Result<Arc<Vec<Value>>> {
    if let Some(p) = s.prefix.lock().unwrap().clone() { return Ok(p); }
    let before = cue_signature(st, &s.media_id).await?;
    let media = media_context(st, s).await?;
    let p = prefix_for_media(st, &media).await?;
    let after = cue_signature(st, &s.media_id).await?;
    cache_prefix_if_unchanged(&s.prefix, before, after, &p);
    Ok(p)
}

/// The same prefix from a captured media context, for a job whose film may no longer be open.
pub async fn prefix_for_media(st: &AppState, media: &MediaContext) -> anyhow::Result<Arc<Vec<Value>>> {
    let mid = media.media_id.clone();
    let cues: Vec<(u32, f64, String)> = st
        .db(move |c| {
            c.prepare("SELECT idx,start,text FROM cue WHERE media_id=?1 ORDER BY idx")?
                .query_map([&mid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        })
        .await
        .map_err(anyhow::Error::msg)?;
    let card = &media;
    let mut film = format!("FILM: {}", if card.title.is_empty() { "" } else { card.title.as_str() });
    match (card.original_title.clone(), card.year) {
        (Some(o), Some(y)) => film.push_str(&format!(" ({o}, {y})")),
        (Some(o), None) => film.push_str(&format!(" ({o})")),
        (None, Some(y)) => film.push_str(&format!(" ({y})")),
        _ => {}
    }
    if let (Some(se), Some(ep)) = (card.season, card.episode) {
        film.push_str(&format!(" S{se}E{ep}"));
        if let Some(t) = &card.episode_title { film.push_str(&format!(" «{t}»")); }
    }
    let mut script = String::from("SCRIPT:\n");
    for (i, start, text) in &cues {
        script.push_str(&format!("[{i}] {} {}\n", mmss(*start), text.replace('\n', " / ")));
    }
    let cefr = learner_cefr(st).await;
    Ok(Arc::new(vec![
        json!({ "role": "system", "content": system_text(&cefr) }),
        json!({ "role": "user", "content": format!("{film}\n{script}") }),
        json!({ "role": "assistant", "content": "OK" }),
    ]))
}

/// The film context of the open session, as a job stores it.
pub async fn media_context(st: &AppState, s: &Session) -> anyhow::Result<MediaContext> {
    let (season, episode) = crate::session::season_episode_of(&s.req);
    let card = s.req.card.as_ref();
    let episode_title = episode.and_then(|e| {
        s.req.episodes.iter().find(|x| x.episode == e).and_then(|x| x.name_en.clone().or_else(|| x.name_ru.clone()))
    });
    let _ = st;
    Ok(MediaContext {
        media_id: s.media_id.clone(),
        title: card.map(|c| c.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| s.req.title.clone()),
        original_title: card.and_then(|c| c.original_title.clone()),
        year: card.and_then(|c| c.year),
        season,
        episode,
        episode_title,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mmss_format() {
        assert_eq!(mmss(0.0), "0:00");
        assert_eq!(mmss(3723.4), "62:03");
    }

    #[test]
    fn system_lists_every_pattern() {
        let t = system_text("B1");
        assert!(t.contains("уровня B1"));
        assert_eq!(t.lines().filter(|l| l.contains(" — ") && l.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && l.split(' ').next().unwrap().contains('_') || l.starts_with("REDUCTIONS") || l.starts_with("ELLIPSIS") || l.starts_with("PASSIVE") || l.starts_with("WISH") || l.starts_with("INVERSION")).count() >= 40, true);
    }

    #[test]
    fn cache_prefix_skips_stale_build_when_cue_signature_changes() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init(&c).unwrap();
        c.execute("INSERT INTO media(id,kind,source_url,title,updated_at) VALUES('m1','file','u','t',0)", []).unwrap();
        c.execute("INSERT INTO cue(media_id,idx,start,end,text) VALUES('m1',0,0.0,1.0,'Hello')", []).unwrap();

        let before = cue_signature_db(&c, "m1").unwrap();
        // Simulate concurrent embedded cues growth while prefix was being built.
        c.execute("INSERT INTO cue(media_id,idx,start,end,text) VALUES('m1',1,1.0,2.0,'World')", []).unwrap();
        let after = cue_signature_db(&c, "m1").unwrap();
        assert_ne!(before, after);

        let slot = std::sync::Mutex::new(None);
        let built = Arc::new(vec![json!({ "role": "assistant", "content": "OK" })]);
        assert!(!cache_prefix_if_unchanged(&slot, before, after, &built));
        assert!(slot.lock().unwrap().is_none());

        // Also catches cue replacement with identical cue count and different text length.
        c.execute("UPDATE cue SET text='Different text here' WHERE media_id='m1' AND idx=1", []).unwrap();
        let after_replace = cue_signature_db(&c, "m1").unwrap();
        assert_ne!(after, after_replace);
        assert!(!cache_prefix_if_unchanged(&slot, after, after_replace, &built));

        // Stable signature caches cleanly.
        assert!(cache_prefix_if_unchanged(&slot, after_replace, after_replace, &built));
        assert!(slot.lock().unwrap().is_some());
    }
}
