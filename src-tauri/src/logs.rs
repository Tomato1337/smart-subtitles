use std::io::Write;

/// Appends one line to ~/.config/smart-subtitle/logs/<name>.log. Failures are ignored on purpose:
/// logging must never break playback.
/// Hides URL userinfo (`://user:pass@`) so credentials never reach log files.
pub fn redact(s: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"://[^/@\s]+@").unwrap()).replace_all(s, "://***@").into_owned()
}

pub fn log(name: &str, line: &str) {
    let line = &redact(line);
    let dir = crate::config::config_dir().join("logs");
    if std::fs::create_dir_all(&dir).is_err() { return; }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{name}.log"))) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{ts} {line}");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn redacts_userinfo() {
        assert_eq!(super::redact("ffmpeg -i https://admin:p%24w@h.example/tor/x?a=1 -map 0"), "ffmpeg -i https://***@h.example/tor/x?a=1 -map 0");
        assert_eq!(super::redact("http://127.0.0.1:8095/x"), "http://127.0.0.1:8095/x");
    }
}
