pub mod clip;
pub mod probe;
pub mod stream;

/// Removes its file on drop.
pub struct TempFile(pub std::path::PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
