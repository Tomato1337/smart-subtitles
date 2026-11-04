//! System tools the app shells out to. Checked when the UI starts and shown in the setup wizard:
//! without ffmpeg/ffprobe there is no video, uv only disables optional features.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dep {
    pub id: &'static str,
    pub title: &'static str,
    pub importance: &'static str,
    pub found: bool,
    /// What the tool is needed for.
    pub purpose: &'static str,
    /// Copy-paste install command for this OS.
    pub install: String,
    /// One-line hint: the purpose, plus the install command when the tool is missing.
    pub hint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepsStatus {
    pub deps: Vec<Dep>,
    /// Warning for a toast when a required tool is missing; `None` when everything needed is there.
    pub notice: Option<String>,
}

#[cfg(unix)]
fn executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable(p: &Path) -> bool {
    p.is_file()
}

/// Looks in PATH and in the two directories the official uv installer uses.
fn find(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| executable(p))
}

/// Install command for a distro package, guessed from /etc/os-release.
fn pkg_install(pkg: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        return format!("brew install {pkg}");
    }
    #[cfg(target_os = "linux")]
    {
        let release = std::fs::read_to_string("/etc/os-release").unwrap_or_default().to_ascii_lowercase();
        let ids: String = release
            .lines()
            .filter(|l| l.starts_with("id=") || l.starts_with("id_like="))
            .collect::<Vec<_>>()
            .join(" ");
        if ids.contains("debian") || ids.contains("ubuntu") {
            format!("sudo apt install {pkg}")
        } else if ids.contains("fedora") || ids.contains("rhel") || ids.contains("centos") {
            format!("sudo dnf install {pkg}")
        } else if ids.contains("arch") {
            format!("sudo pacman -S {pkg}")
        } else {
            format!("установите пакет {pkg}")
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        format!("установите {pkg}")
    }
}

fn uv_install() -> String {
    #[cfg(target_os = "macos")]
    {
        "brew install uv".into()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "curl -LsSf https://astral.sh/uv/install.sh | sh".into()
    }
}

fn dep(id: &'static str, title: &'static str, importance: &'static str, purpose: &'static str, found: bool, install: String) -> Dep {
    let hint = if found { purpose.to_string() } else { format!("{purpose} Установите: {install}") };
    Dep { id, title, importance, found, purpose, install, hint }
}

/// Every tool worth checking, in the order the wizard shows them.
pub fn check() -> Vec<Dep> {
    // ffprobe ships with ffmpeg, but a trimmed package can have only one of them.
    let ffmpeg = find("ffmpeg").is_some() && find("ffprobe").is_some();
    vec![
        dep("ffmpeg", "ffmpeg и ffprobe", "required", "Видео, звук и клипы.", ffmpeg, pkg_install("ffmpeg")),
        dep("uv", "uv", "optional", "Автосинхронизация субтитров и озвучка слов на карточках.", find("uv").is_some(), uv_install()),
    ]
}

/// Toast text for missing required tools; the only thing that blocks the core feature.
pub fn notice(deps: &[Dep]) -> Option<String> {
    let missing: Vec<&Dep> = deps.iter().filter(|d| d.importance == "required" && !d.found).collect();
    if missing.is_empty() {
        return None;
    }
    let titles = missing.iter().map(|d| d.title).collect::<Vec<_>>().join(", ");
    Some(format!("Не найдены {titles}: видео не будет воспроизводиться. Установите: {}", missing[0].install))
}

pub fn status() -> DepsStatus {
    let deps = check();
    let notice = notice(&deps);
    DepsStatus { deps, notice }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_covers_required_and_optional_tools() {
        let deps = check();
        let ids: Vec<&str> = deps.iter().map(|d| d.id).collect();
        assert_eq!(ids, vec!["ffmpeg", "uv"]);
        assert_eq!(deps[0].importance, "required");
        assert_eq!(deps[1].importance, "optional");
    }

    #[test]
    fn missing_tool_hint_carries_the_install_command() {
        let d = dep("ffmpeg", "ffmpeg и ffprobe", "required", "Видео.", false, "sudo dnf install ffmpeg".into());
        assert_eq!(d.hint, "Видео. Установите: sudo dnf install ffmpeg");
        let ok = dep("ffmpeg", "ffmpeg и ffprobe", "required", "Видео.", true, "sudo dnf install ffmpeg".into());
        assert_eq!(ok.hint, "Видео.");
    }

    #[test]
    fn notice_mentions_only_missing_required_tools() {
        let deps = vec![
            dep("ffmpeg", "ffmpeg и ffprobe", "required", "Видео.", false, "sudo dnf install ffmpeg".into()),
            dep("uv", "uv", "optional", "Синхронизация.", false, "curl uv".into()),
        ];
        let n = notice(&deps).unwrap();
        assert!(n.contains("ffmpeg и ffprobe"));
        assert!(n.contains("sudo dnf install ffmpeg"));
        assert!(!n.contains("uv"));
    }

    #[test]
    fn notice_is_silent_when_required_tools_are_present() {
        let deps = vec![dep("ffmpeg", "ffmpeg и ffprobe", "required", "Видео.", true, String::new())];
        assert!(notice(&deps).is_none());
    }
}
