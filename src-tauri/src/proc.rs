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
    let resolved = resolve_program(program.as_ref());
    #[cfg(windows)]
    if let Some((node, script)) = node_entrypoint_for_cmd(Path::new(&resolved)) {
        let mut c = Command::new(node);
        c.arg(script);
        c.creation_flags(CREATE_NO_WINDOW);
        return c;
    }
    #[allow(unused_mut)]
    let mut c = Command::new(&resolved);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Background work (clips, speech recognition, image conversion) at a lower CPU priority, so
/// playback does not stutter: `nice -n 10` on Unix, the below-normal priority class on Windows.
pub fn background(program: impl AsRef<OsStr>) -> Command {
    let resolved = resolve_program(program.as_ref());
    #[cfg(unix)]
    {
        let mut c = Command::new("nice");
        c.args(["-n", "10"]).arg(resolved);
        c
    }
    #[cfg(windows)]
    {
        if let Some((node, script)) = node_entrypoint_for_cmd(Path::new(&resolved)) {
            let mut c = Command::new(node);
            c.arg(script);
            c.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
            return c;
        }
        let mut c = Command::new(&resolved);
        c.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
        c
    }
}

/// Resolves bare executable names (no path separator) via `find` so Windows never searches CWD first.
fn resolve_program(program: &OsStr) -> OsString {
    if let Some(s) = program.to_str() {
        if !s.is_empty() && !s.contains('/') && !s.contains('\\') {
            if let Some(found) = find(s) {
                return found.into_os_string();
            }
        }
    }
    program.to_os_string()
}

/// Extracts a Node.js script entrypoint from an npm-generated Windows `.cmd` shim so callers can
/// run `node <script>` directly instead of passing untrusted args through `cmd.exe`.
pub fn parse_cmd_js_target(cmd_path: &Path, content: &str) -> Option<PathBuf> {
    let dir = cmd_path.parent()?;
    for raw_line in content.lines() {
        let mut idx = 0;
        while let Some(rel) = raw_line[idx..].find('"') {
            let start = idx + rel + 1;
            let Some(end_rel) = raw_line[start..].find('"') else { break };
            let token = &raw_line[start..start + end_rel];
            idx = start + end_rel + 1;
            let lower = token.to_ascii_lowercase();
            if !(lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs")) {
                continue;
            }
            let rel_path = token
                .strip_prefix("%dp0%\\")
                .or_else(|| token.strip_prefix("%dp0%/"))
                .or_else(|| token.strip_prefix("%~dp0\\"))
                .or_else(|| token.strip_prefix("%~dp0/"))
                .or_else(|| token.strip_prefix("%dp0%"))
                .or_else(|| token.strip_prefix("%~dp0"))?;
            let normalized = rel_path.replace('\\', "/");
            if normalized.is_empty() || normalized.contains("..") || normalized.starts_with('/') {
                continue;
            }
            let mut candidate = dir.to_path_buf();
            for part in normalized.split('/').filter(|p| !p.is_empty()) {
                candidate.push(part);
            }
            return Some(candidate);
        }
    }
    None
}

/// Resolves `(node_executable, script_path)` for a `.cmd` npm wrapper when both exist safely.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn node_entrypoint_for_cmd(cmd_path: &Path) -> Option<(PathBuf, PathBuf)> {
    let ext = cmd_path.extension()?.to_str()?;
    if !ext.eq_ignore_ascii_case("cmd") {
        return None;
    }
    let content = std::fs::read_to_string(cmd_path).ok()?;
    let script = parse_cmd_js_target(cmd_path, &content)?;
    if !script.is_file() {
        return None;
    }
    let dir = cmd_path.parent()?;
    let sibling = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let node = if executable(&sibling) { sibling } else { find("node")? };
    Some((node, script))
}

/// Rejects characters that `cmd.exe` interprets as command/variable metacharacters when a `.cmd`
/// wrapper cannot be unwrapped to a direct binary invocation.
#[allow(dead_code)]
pub fn has_cmd_metachars(s: &OsStr) -> bool {
    let Some(text) = s.to_str() else { return true };
    text.chars().any(|c| matches!(c, '\r' | '\n' | '\0' | '&' | '|' | '<' | '>' | '^' | '%' | '!' | '"'))
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

/// `PATH` entries excluding empty, relative (`.`, `./...`) and current-working-directory entries.
fn is_safe_path_dir(dir: &Path, cwd: Option<&Path>, cwd_canon: Option<&Path>) -> bool {
    if dir.as_os_str().is_empty() || !dir.is_absolute() {
        return false;
    }
    if dir.components().any(|c| matches!(c, std::path::Component::CurDir | std::path::Component::ParentDir)) {
        return false;
    }
    if let Some(c) = cwd {
        if dir == c {
            return false;
        }
    }
    if let Some(cc) = cwd_canon {
        if dir.canonicalize().ok().as_deref() == Some(cc) {
            return false;
        }
    }
    true
}

pub(crate) fn filter_safe_dirs(dirs: impl IntoIterator<Item = PathBuf>, cwd: Option<&Path>) -> Vec<PathBuf> {
    let cwd_canon = cwd.and_then(|c| c.canonicalize().ok());
    dirs.into_iter().filter(|d| is_safe_path_dir(d, cwd, cwd_canon.as_deref())).collect()
}

/// `PATH`, then `~/.local/bin` and `~/.cargo/bin`: where the official uv installer puts it on every OS,
/// and where a GUI app's trimmed `PATH` often does not reach. Excludes CWD and relative `.` entries.
pub fn find(name: &str) -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok();
    let path_dirs = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    let mut dirs = filter_safe_dirs(path_dirs, cwd.as_deref());
    if let Some(home) = dirs::home_dir() {
        dirs.extend(filter_safe_dirs([home.join(".local").join("bin"), home.join(".cargo").join("bin")], cwd.as_deref()));
    }
    find_in(name, dirs)
}

/// `path` without its `node_modules/.bin` entries: `npm run tauri dev` prepends every parent one, and a
/// stray `~/node_modules/.bin/omp` would shadow the real tool.
pub fn without_npm_bins(path: &OsStr) -> OsString {
    let kept = std::env::split_paths(path).filter(|d| !d.ends_with(Path::new("node_modules").join(".bin")));
    std::env::join_paths(kept).unwrap_or_else(|_| path.to_os_string())
}

/// Why a supervised child did not produce output.
#[derive(Debug)]
pub enum ProcessError {
    Cancelled,
    TimedOut,
    Spawn(std::io::Error),
    Wait(std::io::Error),
}

impl std::fmt::Display for ProcessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProcessError::Cancelled => f.write_str("отменено"),
            ProcessError::TimedOut => f.write_str("таймаут"),
            ProcessError::Spawn(e) | ProcessError::Wait(e) => write!(f, "{e}"),
        }
    }
}

/// Starts a child that owns a process group on Unix (so a timed-out `sh -c` wrapper and its children
/// all die) and is killed on drop. The caller keeps the `Child` until it is reaped.
pub fn spawn_owned(cmd: Command) -> std::io::Result<tokio::process::Child> {
    let mut cmd = cmd;
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    cmd.spawn()
}

/// Kills the child's own process group on Unix, the immediate child on Windows, then reaps it.
/// The `Child` borrow stays alive until the group is gone, so the group id cannot be recycled.
pub async fn terminate_owned(child: &mut tokio::process::Child) -> std::io::Result<()> {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status().await;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
    Ok(())
}

/// Runs a child to completion at a deadline, with cancellation; both kill the whole group.
/// Output is collected concurrently, so a chatty tool cannot fill a pipe and deadlock. Readers are
/// always joined or aborted after the child group is gone: a cancelled call leaves no detached task
/// and no pipe handle behind.
pub async fn output_cancellable(
    cmd: Command,
    limit: std::time::Duration,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<std::process::Output, ProcessError> {
    let mut cmd = cmd;
    if cancel.is_cancelled() {
        return Err(ProcessError::Cancelled);
    }
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = spawn_owned(cmd).map_err(ProcessError::Spawn)?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let mut out_task = tokio::spawn(async move {
        let mut v = Vec::new();
        if let Some(p) = &mut out_pipe {
            tokio::io::AsyncReadExt::read_to_end(p, &mut v).await?;
        }
        Ok::<_, std::io::Error>(v)
    });
    let mut err_task = tokio::spawn(async move {
        let mut v = Vec::new();
        if let Some(p) = &mut err_pipe {
            tokio::io::AsyncReadExt::read_to_end(p, &mut v).await?;
        }
        Ok::<_, std::io::Error>(v)
    });
    let status = tokio::select! {
        _ = cancel.cancelled() => {
            let _ = terminate_owned(&mut child).await;
            // The group is dead; let both readers drain what is already buffered, but never wait on
            // a pipe some unrelated grandchild might still hold.
            drain_reader(&mut out_task).await;
            drain_reader(&mut err_task).await;
            return Err(ProcessError::Cancelled);
        }
        r = tokio::time::timeout(limit, child.wait()) => match r {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                let _ = terminate_owned(&mut child).await;
                drain_reader(&mut out_task).await;
                drain_reader(&mut err_task).await;
                return Err(ProcessError::Wait(e));
            }
            Err(_) => {
                let _ = terminate_owned(&mut child).await;
                drain_reader(&mut out_task).await;
                drain_reader(&mut err_task).await;
                return Err(ProcessError::TimedOut);
            }
        }
    };
    // Join both readers before propagating an error, so neither task is detached.
    let stdout = join_reader(out_task).await;
    let stderr = join_reader(err_task).await;
    let stdout = stdout?;
    let stderr = stderr?;
    drop(child);
    Ok(std::process::Output { status, stdout, stderr })
}

/// Waits briefly for a reader after the child was killed, then aborts it so no task is leaked.
async fn drain_reader(task: &mut tokio::task::JoinHandle<std::io::Result<Vec<u8>>>) {
    if tokio::time::timeout(std::time::Duration::from_secs(2), &mut *task).await.is_err() {
        task.abort();
        let _ = task.await;
    }
}

/// Joins a reader after normal child exit; its buffer or IO error is part of the result.
async fn join_reader(mut task: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>) -> Result<Vec<u8>, ProcessError> {
    match tokio::time::timeout(std::time::Duration::from_secs(2), &mut task).await {
        Ok(Ok(Ok(v))) => Ok(v),
        Ok(Ok(Err(e))) => Err(ProcessError::Wait(e)),
        Ok(Err(e)) => Err(ProcessError::Wait(std::io::Error::other(e.to_string()))),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err(ProcessError::Wait(std::io::Error::new(std::io::ErrorKind::TimedOut, "поток вывода не закрылся")))
        }
    }
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

    #[test]
    fn filter_safe_dirs_excludes_cwd_and_relative_entries() {
        let dir = std::env::temp_dir().join(format!("smartsubs-proc-safe-{}", uuid::Uuid::new_v4()));
        let cwd = dir.join("cwd");
        let bin = dir.join("bin");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let filtered = filter_safe_dirs(
            [
                PathBuf::from(""),
                PathBuf::from("."),
                PathBuf::from("./bin"),
                cwd.clone(),
                cwd.join("."),
                bin.clone(),
            ],
            Some(&cwd),
        );
        assert_eq!(filtered, vec![bin]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parses_npm_cmd_shim_and_rejects_cmd_metachars() {
        let dir = std::env::temp_dir().join(format!("smartsubs-proc-cmd-{}", uuid::Uuid::new_v4()));
        let js = dir.join("node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
        std::fs::create_dir_all(js.parent().unwrap()).unwrap();
        std::fs::write(&js, "console.log('hi');").unwrap();
        let cmd_path = dir.join("omp.cmd");
        let shim = r#"@ECHO off
"%_prog%"  "%dp0%\node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js" %*
"#;
        assert_eq!(parse_cmd_js_target(&cmd_path, shim), Some(js));
        assert_eq!(parse_cmd_js_target(&cmd_path, r#"node "%dp0%\..\evil.js""#), None);
        assert!(has_cmd_metachars(OsStr::new("hello & calc")));
        assert!(has_cmd_metachars(OsStr::new("line1\nline2")));
        assert!(!has_cmd_metachars(OsStr::new("--model anthropic/claude")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_kills_the_owned_process_group() {
        let dir = std::env::temp_dir().join(format!("smartsubs-proc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("child.pid");
        let script = format!("sleep 60 & echo $! > '{}'; wait", pidfile.display());
        let mut cmd = Command::new("sh");
        cmd.args(["-c", &script]);
        let cancel = tokio_util::sync::CancellationToken::new();
        let task = tokio::spawn({
            let cancel = cancel.clone();
            async move { output_cancellable(cmd, std::time::Duration::from_secs(60), &cancel).await }
        });
        let mut pid = None;
        for _ in 0..200 {
            if let Ok(text) = std::fs::read_to_string(&pidfile) {
                if let Ok(p) = text.trim().parse::<u32>() {
                    pid = Some(p);
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let pid = pid.expect("descendant pid was written");
        cancel.cancel();
        let result = task.await.unwrap();
        assert!(matches!(result, Err(ProcessError::Cancelled)), "{result:?}");
        let mut gone = false;
        for _ in 0..100 {
            if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
                gone = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(gone, "descendant {pid} of the owned group survived cancellation");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
