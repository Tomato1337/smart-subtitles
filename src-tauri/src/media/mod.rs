pub mod clip;
pub mod probe;
pub mod stream;

/// What ffmpeg and ffprobe get as input: the local path of a `file://` source, the URL otherwise.
/// ffmpeg does not percent-decode `file:` URLs, so a name with a space or Cyrillic would not open.
pub fn input(src: &str) -> String {
    if src.starts_with("file://") {
        if let Some(p) = url::Url::parse(src).ok().and_then(|u| u.to_file_path().ok()) {
            return p.to_string_lossy().into_owned();
        }
    }
    src.to_string()
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn file_urls_become_decoded_paths() {
        assert_eq!(super::input("file:///tmp/%D0%A4%D0%B8%D0%BB%D1%8C%D0%BC%20one.mkv"), "/tmp/Фильм one.mkv");
        assert_eq!(super::input("http://h/stream/a%20b.mkv?x=1"), "http://h/stream/a%20b.mkv?x=1");
    }
}

/// Removes its file on drop.
pub struct TempFile(pub std::path::PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
