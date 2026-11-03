use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// `$XDG_STATE_HOME/quickshell/user/generated` — where inir keeps its generated palette.
pub fn inir_dir() -> PathBuf {
    dirs::state_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".local/state"))
        .join("quickshell/user/generated")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InirTheme {
    pub seed: String,
    /// `"dark"` or `"light"`.
    pub mode: String,
    /// The MD3 roles in snake_case (`surface_container_lowest`, `on_primary`, …), all `#rrggbb`.
    pub colors: BTreeMap<String, String>,
}

fn is_hex(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The first inir palette file that parses as a JSON object, keeping only its hex colors.
fn palette(dir: &Path) -> Option<BTreeMap<String, String>> {
    for name in ["app-palette.json", "palette.json", "colors.json"] {
        let Ok(bytes) = std::fs::read(dir.join(name)) else { continue };
        let Ok(serde_json::Value::Object(map)) = serde_json::from_slice::<serde_json::Value>(&bytes) else { continue };
        return Some(
            map.into_iter()
                .filter_map(|(k, v)| v.as_str().filter(|s| is_hex(s)).map(|s| (k, s.to_ascii_lowercase())))
                .collect(),
        );
    }
    None
}

/// Reads a theme from an inir `generated` directory. `None` means "no usable palette right now",
/// which the watcher treats as a half-written file and skips.
pub fn load_from(dir: &Path) -> Option<InirTheme> {
    let colors = palette(dir)?;
    if !["surface", "on_surface", "primary"].iter().all(|k| colors.contains_key(*k)) {
        return None;
    }
    let seed = std::fs::read_to_string(dir.join("color.txt"))
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| is_hex(s))
        .or_else(|| colors.get("primary").cloned())?;
    let mode = std::fs::read(dir.join("theme-meta.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("mode").and_then(|m| m.as_str()).map(str::to_string))
        .filter(|m| m == "light")
        .unwrap_or_else(|| "dark".into());
    Some(InirTheme { seed, mode, colors })
}

pub fn load() -> Option<InirTheme> { load_from(&inir_dir()) }

fn apply_window_bg(app: &AppHandle, t: &InirTheme) {
    let Some(c) = t.colors.get("surface").and_then(|s| s.parse::<tauri::window::Color>().ok()) else { return };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_background_color(Some(c));
    }
}

/// Polls inir's palette files every 2 s (there is no file-watch crate in the tree) and tells the
/// frontend about every full change. `None` readings are skipped, so a half-written file never
/// clears the theme.
pub async fn watch(app: AppHandle) {
    let mut last = load();
    if let Some(t) = last.as_ref() {
        apply_window_bg(&app, t);
    }
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        let cur = load();
        if let (true, Some(t)) = (cur != last, cur.as_ref()) {
            apply_window_bg(&app, t);
            let _ = app.emit("theme:changed", t);
            last = cur;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = r##"{"surface":"#15151A","on_surface":"#c7c5d1","primary":"#bcc2ff"}"##;

    fn dir_with(files: &[(&str, &str)]) -> PathBuf {
        let d = std::env::temp_dir().join(format!("inir-theme-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        for (name, body) in files {
            std::fs::write(d.join(name), body).unwrap();
        }
        d
    }

    fn load_and_clean(files: &[(&str, &str)]) -> Option<InirTheme> {
        let d = dir_with(files);
        let t = load_from(&d);
        let _ = std::fs::remove_dir_all(&d);
        t
    }

    #[test]
    fn app_palette_wins_over_colors_json() {
        let t = load_and_clean(&[
            ("app-palette.json", BASE),
            ("colors.json", r##"{"surface":"#000000","on_surface":"#ffffff","primary":"#ff0000"}"##),
        ])
        .unwrap();
        assert_eq!(t.colors["surface"], "#15151a");
        assert_eq!(t.mode, "dark");
    }

    #[test]
    fn invalid_hex_values_are_dropped() {
        let t = load_and_clean(&[(
            "palette.json",
            r##"{"surface":"#15151a","on_surface":"#c7c5d1","primary":"#bcc2ff","secondary":"red","tertiary":"#12345"}"##,
        )])
        .unwrap();
        assert!(!t.colors.contains_key("secondary"));
        assert!(!t.colors.contains_key("tertiary"));
    }

    #[test]
    fn missing_surface_gives_none() {
        assert!(load_and_clean(&[("colors.json", r##"{"on_surface":"#c7c5d1","primary":"#bcc2ff"}"##)]).is_none());
        assert!(load_and_clean(&[]).is_none());
    }

    #[test]
    fn color_txt_beats_primary() {
        let t = load_and_clean(&[("app-palette.json", BASE), ("color.txt", "#ABCDEF\n")]).unwrap();
        assert_eq!(t.seed, "#abcdef");
        assert_eq!(load_and_clean(&[("app-palette.json", BASE)]).unwrap().seed, "#bcc2ff");
    }

    #[test]
    fn theme_meta_gives_mode() {
        let t = load_and_clean(&[("app-palette.json", BASE), ("theme-meta.json", r#"{"mode":"light"}"#)]).unwrap();
        assert_eq!(t.mode, "light");
        let t = load_and_clean(&[("app-palette.json", BASE), ("theme-meta.json", r#"{"mode":"dark"}"#)]).unwrap();
        assert_eq!(t.mode, "dark");
    }
}
