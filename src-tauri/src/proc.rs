//! Finding and starting the external tools (ffmpeg, ffprobe, uv, omp) the same way on every OS.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// A child of a GUI app gets its own console window on Windows unless asked not to.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

/// A tool started in the foreground: the video stream, ffprobe, uv.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Background work (clips, speech recognition, image conversion) at a lower CPU priority, so
/// playback does not stutter: `nice -n 10` on Unix, the below-normal priority class on Windows.
pub fn background(program: impl AsRef<OsStr>) -> Command {
    #[cfg(unix)]
    {
        let mut c = Command::new("nice");
        c.args(["-n", "10"]).arg(program);
        c
    }
    #[cfg(windows)]
    {
        let mut c = Command::new(program);
        c.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
        c
    }
}

#[cfg(unix)]
pub fn executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
pub fn executable(p: &Path) -> bool {
    p.is_file()
}

/// File names a tool may have: `uv` on Unix; `uv.exe`, or `omp.cmd` for an npm-installed one, on Windows.
fn file_names(name: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd")]
    } else {
        vec![name.to_string()]
    }
}

/// First executable `name` in `dirs`, in order.
pub fn find_in(name: &str, dirs: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    let names = file_names(name);
    dirs.into_iter().flat_map(|d| names.iter().map(move |n| d.join(n)).collect::<Vec<_>>()).find(|p| executable(p))
}

/// `PATH`, then `~/.local/bin` and `~/.cargo/bin`: where the official uv installer puts it on every OS,
/// and where a GUI app's trimmed `PATH` often does not reach.
pub fn find(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".cargo").join("bin"));
    }
    find_in(name, dirs)
}

/// `path` without its `node_modules/.bin` entries: `npm run tauri dev` prepends every parent one, and a
/// stray `~/node_modules/.bin/omp` would shadow the real tool.
pub fn without_npm_bins(path: &OsStr) -> OsString {
    let kept = std::env::split_paths(path).filter(|d| !d.ends_with(Path::new("node_modules").join(".bin")));
    std::env::join_paths(kept).unwrap_or_else(|_| path.to_os_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn npm_bins_are_dropped_from_path() {
        let p = without_npm_bins(OsStr::new("/p/node_modules/.bin:/home/u/node_modules/.bin/:/home/u/.local/bin:/usr/bin"));
        assert_eq!(p, "/home/u/.local/bin:/usr/bin");
    }

    #[cfg(unix)]
    #[test]
    fn find_in_skips_non_executable_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("smartsubs-proc-{}", uuid::Uuid::new_v4()));
        let (a, b) = (dir.join("a"), dir.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("tool"), "").unwrap();
        std::fs::write(b.join("tool"), "").unwrap();
        std::fs::set_permissions(b.join("tool"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_in("tool", [a, b.clone()]), Some(b.join("tool")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
