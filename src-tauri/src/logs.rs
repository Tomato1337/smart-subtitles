use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// A log rotates into `<name>.log.1` once it reaches this size, so each log name tops out near 10 MiB.
const MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Log files untouched for this long are deleted at startup, so old logs cannot fill the disk.
const RETENTION: Duration = Duration::from_secs(14 * 24 * 3600);

/// Appends one line to ~/.config/smart-subtitle/logs/<name>.log. Failures are ignored on purpose:
/// logging must never break playback.
/// Hides URL userinfo (`://user:pass@`) and credential-shaped fragments of third-party text
/// (LLM error bodies are logged verbatim) so secrets never reach log files.
pub fn redact(s: &str) -> String {
    use std::sync::LazyLock;
    static USERINFO: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"://[^/@\s]+@").unwrap());
    static AUTHZ: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)\b(authorization)\b\s*[:=]\s*\S.*$").unwrap());
    static KEYVAL: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"(?i)\b(x-api-key|api[_-]?key|access[_-]?token)\b\s*[:=]\s*"?[^\s",}]+"?"#).unwrap());
    static SCHEME: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}").unwrap());
    static SK: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\bsk-[A-Za-z0-9_-]{8,}").unwrap());
    let s = USERINFO.replace_all(s, "://***@");
    let s = AUTHZ.replace_all(&s, "$1=***");
    let s = KEYVAL.replace_all(&s, "$1=***");
    let s = SCHEME.replace_all(&s, "$1 ***");
    SK.replace_all(&s, "sk-***").into_owned()
}

fn logs_dir() -> PathBuf {
    crate::config::config_dir().join("logs")
}

pub fn log(name: &str, line: &str) {
    append(&logs_dir(), name, &redact(line));
}

/// Appends `<unix secs> <line>` to `<dir>/<name>.log`, rotating first when the file is already at
/// MAX_BYTES. Every error is swallowed: a log write must never disturb playback.
fn append(dir: &Path, name: &str, line: &str) {
    if std::fs::create_dir_all(dir).is_err() { return; }
    let path = dir.join(format!("{name}.log"));
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else { return };
    if f.metadata().is_ok_and(|m| m.len() >= MAX_BYTES) {
        drop(f);
        let _ = std::fs::rename(&path, dir.join(format!("{name}.log.1")));
        let Ok(fresh) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else { return };
        f = fresh;
    }
    let ts = SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = writeln!(f, "{ts} {line}");
}

/// Deletes log files older than RETENTION. Called once at startup; a handful of files, so it is cheap.
pub fn vacuum() {
    vacuum_dir(&logs_dir(), SystemTime::now());
}

fn vacuum_dir(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() { continue; }
        let Ok(modified) = meta.modified() else { continue };
        // A future mtime (clock jump) fails duration_since and is simply left alone.
        if now.duration_since(modified).is_ok_and(|age| age > RETENTION) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn redacts_credentials() {
        assert_eq!(super::redact("LLM HTTP 401: {\"error\":\"Incorrect API key: sk-live-abcdef123456\"}"), "LLM HTTP 401: {\"error\":\"Incorrect API key: sk-***\"}");
        assert_eq!(super::redact("Authorization: Bearer abcdefghijklmnop"), "Authorization=***");
        assert_eq!(super::redact("x-api-key: 1234567890abcdef"), "x-api-key=***");
        assert_eq!(super::redact("api_key=\"abc123\", model=m"), "api_key=***, model=m");
        assert_eq!(super::redact("Authorization: Basic dXNlcjpwYXNz"), "Authorization=***");
        assert_eq!(super::redact("annotate 0 prompt=2421 cache_hit=- completion=896"), "annotate 0 prompt=2421 cache_hit=- completion=896");
    }

    #[test]
    fn redacts_userinfo() {
        assert_eq!(super::redact("ffmpeg -i https://admin:p%24w@h.example/tor/x?a=1 -map 0"), "ffmpeg -i https://***@h.example/tor/x?a=1 -map 0");
        assert_eq!(super::redact("http://127.0.0.1:8095/x"), "http://127.0.0.1:8095/x");
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ss-logs-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rotates_at_max_bytes() {
        let dir = scratch("rotate");
        std::fs::write(dir.join("x.log"), vec![b'x'; super::MAX_BYTES as usize]).unwrap();
        super::append(&dir, "x", "line");
        assert_eq!(std::fs::metadata(dir.join("x.log.1")).unwrap().len(), super::MAX_BYTES);
        let fresh = std::fs::read_to_string(dir.join("x.log")).unwrap();
        assert_eq!(fresh.lines().count(), 1);
        assert!(fresh.ends_with(" line\n"), "unexpected content: {fresh:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vacuum_removes_only_stale() {
        let dir = scratch("vacuum");
        let now = std::time::SystemTime::now();
        let old = dir.join("old.log");
        let new = dir.join("new.log");
        std::fs::write(&old, "a\n").unwrap();
        std::fs::write(&new, "b\n").unwrap();
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(now - std::time::Duration::from_secs(20 * 24 * 3600)).unwrap();
        std::fs::File::options().write(true).open(&new).unwrap().set_modified(now - std::time::Duration::from_secs(24 * 3600)).unwrap();
        super::vacuum_dir(&dir, now);
        assert!(!old.exists());
        assert!(new.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
