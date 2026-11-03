use crate::{patterns::PATTERNS, session::Session, state::AppState};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

pub fn mmss(sec: f64) -> String {
    let s = sec.max(0.0) as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

async fn learner_cefr(st: &AppState) -> String {
    let url = format!("{}/api/settings", st.cfg().tutor.api_url.trim_end_matches('/'));
    let v: Option<Value> = async {
        st.http.get(url).timeout(Duration::from_secs(2)).send().await.ok()?.json().await.ok()
    }
    .await;
    v.and_then(|v| v["learner.cefr"].as_str().map(str::to_string)).unwrap_or_else(|| st.cfg().learner.cefr.clone())
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

/// The byte-for-byte stable prefix (system, film+script, "OK") shared by every request for one media,
/// which lets DeepSeek's automatic prefix cache hit. Built once per subtitle set.
pub async fn prefix(st: &AppState, s: &Session) -> anyhow::Result<Arc<Vec<Value>>> {
    if let Some(p) = s.prefix.lock().unwrap().clone() { return Ok(p); }
    let mid = s.media_id.clone();
    let cues: Vec<(u32, f64, String)> = st
        .db(move |c| {
            c.prepare("SELECT idx,start,text FROM cue WHERE media_id=?1 ORDER BY idx")?
                .query_map([&mid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        })
        .await
        .map_err(anyhow::Error::msg)?;
    let (season, episode) = crate::session::season_episode_of(&s.req);
    let card = s.req.card.as_ref();
    let mut film = format!("FILM: {}", card.map(|c| c.title.as_str()).filter(|t| !t.is_empty()).unwrap_or(&s.req.title));
    let orig = card.and_then(|c| c.original_title.clone());
    let year = card.and_then(|c| c.year);
    match (orig, year) {
        (Some(o), Some(y)) => film.push_str(&format!(" ({o}, {y})")),
        (Some(o), None) => film.push_str(&format!(" ({o})")),
        (None, Some(y)) => film.push_str(&format!(" ({y})")),
        _ => {}
    }
    if let (Some(se), Some(ep)) = (season, episode) {
        film.push_str(&format!(" S{se}E{ep}"));
        let t = s.req.episodes.iter().find(|e| e.episode == ep).and_then(|e| e.name_en.clone().or_else(|| e.name_ru.clone()));
        if let Some(t) = t { film.push_str(&format!(" «{t}»")); }
    }
    let mut script = String::from("SCRIPT:\n");
    for (i, start, text) in &cues {
        script.push_str(&format!("[{i}] {} {}\n", mmss(*start), text.replace('\n', " / ")));
    }
    let cefr = learner_cefr(st).await;
    let p = Arc::new(vec![
        json!({ "role": "system", "content": system_text(&cefr) }),
        json!({ "role": "user", "content": format!("{film}\n{script}") }),
        json!({ "role": "assistant", "content": "OK" }),
    ]);
    *s.prefix.lock().unwrap() = Some(p.clone());
    Ok(p)
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
}
