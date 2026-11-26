pub mod clip;
pub mod probe;
pub mod stream;

pub fn is_http(src: &str) -> bool {
    let lower = src.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// What ffmpeg and ffprobe get as input: the local path of a `file://` source, the URL otherwise.
/// ffmpeg does not percent-decode `file:` URLs, so a name with a space or Cyrillic would not open.
/// Local relative paths starting with `-` are prefixed with `./` so ffmpeg never treats them as options.
pub fn input(src: &str) -> String {
    if src.starts_with("file://") {
        if let Some(p) = url::Url::parse(src).ok().and_then(|u| u.to_file_path().ok()) {
            let s = p.to_string_lossy().into_owned();
            return if s.starts_with('-') { format!("./{s}") } else { s };
        }
    }
    if !is_http(src) && src.starts_with('-') {
        return format!("./{src}");
    }
    src.to_string()
}

pub const REMOTE_PROTOCOL_WHITELIST: &str = "http,https,httpproxy,tcp,tls,crypto";

/// Appends `-protocol_whitelist http,https,httpproxy,tcp,tls,crypto` before `-i <input>` when the
/// input is remote HTTP(S), allowing system `http_proxy` tunneling while preventing playlist/demuxer
/// dereferencing of `file://`, `concat:`, or `subfile:`.
pub fn push_input(args: &mut Vec<String>, src: &str) {
    if is_http(src) {
        args.extend(["-protocol_whitelist".into(), REMOTE_PROTOCOL_WHITELIST.into()]);
    }
    args.extend(["-i".into(), input(src)]);
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn file_urls_become_decoded_paths() {
        assert_eq!(super::input("file:///tmp/%D0%A4%D0%B8%D0%BB%D1%8C%D0%BC%20one.mkv"), "/tmp/Фильм one.mkv");
        assert_eq!(super::input("http://h/stream/a%20b.mkv?x=1"), "http://h/stream/a%20b.mkv?x=1");
        assert_eq!(super::input("-evil.mkv"), "./-evil.mkv");
    }

    #[test]
    fn http_inputs_get_protocol_whitelist() {
        let mut a = Vec::new();
        super::push_input(&mut a, "https://cdn.example/video.m3u8");
        assert_eq!(
            a,
            vec!["-protocol_whitelist", super::REMOTE_PROTOCOL_WHITELIST, "-i", "https://cdn.example/video.m3u8"]
        );
    }
}

/// Removes its file on drop.
pub struct TempFile(pub std::path::PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
