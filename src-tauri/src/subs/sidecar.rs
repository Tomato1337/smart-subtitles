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

pub async fn read_ref(st: &AppState, url: &str) -> anyhow::Result<Vec<u8>> {
    if url.starts_with("file://") {
        let p = url::Url::parse(url)?.to_file_path().map_err(|_| anyhow::anyhow!("bad file url"))?;
        return Ok(tokio::fs::read(p).await?);
    }
    Ok(st.http.get(st.cfg.with_auth(url)).send().await?.error_for_status()?.bytes().await?.to_vec())
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
}
