use crate::state::AppState;
use anyhow::{anyhow, bail};
use serde_json::{json, Value};
use std::time::Duration;

pub fn slug(s: &str) -> String {
    let t: String = s.to_lowercase().chars().map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    let t = t.trim_matches('_').to_string();
    if t.is_empty() { "media".into() } else { t }
}

fn srt_time(t: f64) -> String {
    let ms = (t * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

pub fn to_srt(cues: &[(f64, f64, String)]) -> String {
    cues.iter().enumerate().map(|(i, (s, e, t))| format!("{}\n{} --> {}\n{}\n\n", i + 1, srt_time(*s), srt_time(*e), t)).collect()
}

/// Writes the English script as .srt and imports it into tutor's "My materials". Returns the new material id.
pub async fn import_script(st: &AppState, media_id: &str) -> anyhow::Result<i64> {
    let mid = media_id.to_string();
    let (title, cues): (String, Vec<(f64, f64, String)>) = st
        .db(move |c| {
            let title: String = c.query_row("SELECT title FROM media WHERE id=?1", [&mid], |r| r.get(0))?;
            let cues = c.prepare("SELECT start,end,text FROM cue WHERE media_id=?1 ORDER BY idx")?.query_map([&mid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
            Ok((title, cues))
        })
        .await
        .map_err(anyhow::Error::msg)?;
    if cues.is_empty() { bail!("нет субтитров"); }
    // Tutor runs in Docker and only sees its bind-mounted tree, so the file goes under <tutor.root>/data (same path on both sides).
    let dir = std::path::Path::new(&st.cfg.tutor.root).join("data").join("smart-subtitle");
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(format!("{}.srt", slug(&title)));
    tokio::fs::write(&path, to_srt(&cues)).await?;
    let url = format!("{}/api/media/import", st.cfg.tutor.api_url.trim_end_matches('/'));
    let r = st.http.post(url).timeout(Duration::from_secs(30)).json(&json!({ "path": path })).send().await.map_err(|_| anyhow!("Tutor не запущен ({})", st.cfg.tutor.api_url))?;
    let ok = r.status().is_success();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !ok { bail!("tutor: {}", v["error"].as_str().unwrap_or("ошибка импорта")); }
    v["id"].as_i64().ok_or_else(|| anyhow!("tutor не вернул id"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_and_srt() {
        assert_eq!(slug("Marty Supreme!"), "marty_supreme");
        assert_eq!(slug("Пацаны"), "пацаны");
        assert_eq!(slug("???"), "media");
        assert_eq!(to_srt(&[(1.5, 3723.456, "Hi".into())]), "1\n00:00:01,500 --> 01:02:03,456\nHi\n\n");
    }
}
