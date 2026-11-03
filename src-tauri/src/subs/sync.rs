//! One automatic offset probe per (media, subtitle file): whisper on a few audio fragments spread over
//! the film, then the shift that lines their speech up with the cues.

use crate::{
    asr::{self, align::{self, SyncResult}},
    db::now,
    logs,
    media::TempFile,
    session::Session,
    state::AppState,
};
use rusqlite::{params, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Emitter;

/// Seconds of audio per fragment and how far before its cue a fragment starts.
const WINDOW: f64 = 40.0;
const LEAD: f64 = 5.0;

struct Gate {
    source_path: String,
    cur: f64,
    cues: Vec<(f64, f64, String)>,
}

/// Starts the probe in the background; it never blocks opening a film.
pub fn spawn(st: &Arc<AppState>, s: &Arc<Session>) {
    tauri::async_runtime::spawn(run(st.clone(), s.clone()));
}

pub async fn run(st: Arc<AppState>, s: Arc<Session>) {
    if let Err(e) = once(&st, &s).await {
        logs::log("asr", &format!("sync: failed: {e}"));
        toast(&st, format!("Автоподгонка субтитров не удалась: {e}"));
    }
}

async fn once(st: &Arc<AppState>, s: &Arc<Session>) -> anyhow::Result<()> {
    let mid = s.media_id.clone();
    let gate = st
        .db(move |c| {
            let source_path: Option<String> = c.query_row("SELECT file_path FROM subtitle_source WHERE media_id=?1", [&mid], |r| r.get(0)).optional()?;
            let Some(source_path) = source_path else { return Ok(None) };
            let done: Option<String> = c.query_row("SELECT source_path FROM sub_sync WHERE media_id=?1", [&mid], |r| r.get(0)).optional()?;
            if done.as_deref() == Some(source_path.as_str()) {
                return Ok(None);
            }
            let cur: f64 = c.query_row("SELECT sub_offset FROM media WHERE id=?1", [&mid], |r| r.get(0))?;
            let cues = c
                .prepare("SELECT start,end,text FROM cue WHERE media_id=?1 ORDER BY idx")?
                .query_map([&mid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Some(Gate { source_path, cur, cues }))
        })
        .await
        .map_err(|e| anyhow::anyhow!("db: {e}"))?;
    let Some(gate) = gate else { return Ok(()) };
    let Some(probe) = s.probe.get() else { return Ok(()) };
    if probe.duration < 120.0 || gate.cues.len() < 20 {
        logs::log("asr", "sync: skipped (short)");
        return Ok(());
    }
    let (duration, cur, cues, source_path) = (probe.duration, gate.cur, gate.cues, gate.source_path);
    let audio_index = *s.audio_index.lock().unwrap();

    // Audio first, one fragment at a time: a closed film or a dead stream stops the whole probe.
    let starts = windows(&cues, duration, cur);
    if starts.is_empty() {
        logs::log("asr", "sync: skipped (no cues near the sample points)");
        return Ok(());
    }
    let mut files: Vec<PathBuf> = vec![];
    let mut temps: Vec<TempFile> = vec![];
    for w in &starts {
        if s.cancel.is_cancelled() {
            return Ok(());
        }
        let t = asr::pcm_temp()?;
        asr::extract_pcm(&s.src, audio_index, *w, WINDOW, &t.0).await?;
        // The torrent stream sometimes answers with zeros; that must stay a transient failure, not a
        // "weak" verdict recorded for this subtitle file forever.
        if silent(&t.0) {
            anyhow::bail!("поток отдал тишину");
        }
        files.push(t.0.clone());
        temps.push(t);
    }
    let heard = asr::transcribe(st, &files).await?;
    drop(temps);
    let fragments: Vec<Vec<asr::Word>> = heard
        .into_iter()
        .zip(&starts)
        .map(|(mut words, w)| {
            for word in &mut words {
                word.start += w;
                word.end += w;
            }
            words
        })
        .collect();

    let result = align::estimate(&cues, &fragments);
    let written = write(st, s, &source_path, cur, &result).await?;
    report(st, s, cur, written);
    Ok(())
}

/// Outcome of the write half, already free of SQL.
enum Written {
    /// Another subtitle file was installed meanwhile; nothing was written.
    Stale,
    Applied { offset: f64, support: usize },
    /// The saved offset changed while the probe ran; the manual value wins.
    Kept { offset: f64 },
    Weak { support: usize, total: usize },
    Drift,
}

/// Owned copy of the estimate, safe to move into the DB closure.
#[derive(Clone, Copy)]
enum Want {
    Offset { offset: f64, support: usize },
    Weak { support: usize, total: usize },
    Drift,
}

async fn write(st: &Arc<AppState>, s: &Arc<Session>, source_path: &str, cur: f64, result: &SyncResult) -> anyhow::Result<Written> {
    let want = match *result {
        SyncResult::Offset { offset, support } => Want::Offset { offset, support },
        SyncResult::Weak { support, total } => Want::Weak { support, total },
        SyncResult::Drift => Want::Drift,
    };
    let (mid, sp) = (s.media_id.clone(), source_path.to_string());
    st.db(move |c| {
        let still: Option<String> = c.query_row("SELECT file_path FROM subtitle_source WHERE media_id=?1", [&mid], |r| r.get(0)).optional()?;
        if still.as_deref() != Some(sp.as_str()) {
            return Ok(Written::Stale);
        }
        // A second probe for the same file may have finished first (film reopened mid-run); its verdict stands.
        let done: Option<String> = c.query_row("SELECT source_path FROM sub_sync WHERE media_id=?1", [&mid], |r| r.get(0)).optional()?;
        if done.as_deref() == Some(sp.as_str()) {
            return Ok(Written::Stale);
        }
        let ts = now();
        let (status, offset, support, detail) = match want {
            Want::Offset { offset, support } => ("done", Some(offset), support, None),
            Want::Weak { support, .. } => ("failed", None, support, Some("weak")),
            Want::Drift => ("failed", None, 0, Some("drift")),
        };
        c.execute(
            "INSERT OR REPLACE INTO sub_sync(media_id,source_path,status,offset,support,detail,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![mid, sp, status, offset, support as i64, detail, ts],
        )?;
        let Some(offset) = offset else {
            return Ok(match want {
                Want::Weak { support, total } => Written::Weak { support, total },
                _ => Written::Drift,
            });
        };
        let changed = c.execute("UPDATE media SET sub_offset=?1 WHERE id=?2 AND sub_offset=?3", params![offset, mid, cur])?;
        // 0 rows: the user moved the offset by hand while the probe was running.
        Ok(if changed == 0 { Written::Kept { offset } } else { Written::Applied { offset, support } })
    })
    .await
    .map_err(|e| anyhow::anyhow!("db: {e}"))
}

/// True when a fragment is digital silence: the torrent stream answered with zeros instead of audio.
fn silent(pcm: &Path) -> bool {
    match std::fs::read(pcm) {
        Ok(bytes) => {
            bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]).abs()).fold(0.0, f32::max) < 1e-4
        }
        Err(_) => true,
    }
}

fn toast(st: &AppState, message: String) {
    let _ = st.app.emit("toast", serde_json::json!({ "message": message }));
}

fn report(st: &Arc<AppState>, s: &Session, cur: f64, written: Written) {
    match written {
        Written::Stale => {}
        Written::Applied { offset, support } => {
            logs::log("asr", &format!("sync: offset {offset:+.1} support {support}"));
            if (offset - cur).abs() >= 0.1 {
                let _ = st.app.emit("subs:offset", serde_json::json!({ "mediaId": s.media_id, "offset": offset }));
                toast(st, format!("Субтитры подогнаны по звуку: сдвиг {offset:+.1} с"));
            }
        }
        Written::Kept { offset } => logs::log("asr", &format!("sync: manual offset changed during sync, kept (found {offset:+.1})")),
        Written::Weak { support, total } => {
            logs::log("asr", &format!("sync: weak support {support}/{total}"));
            toast(st, "Автоподгонка субтитров: мало совпадений со звуком, сдвиг не изменён".into());
        }
        Written::Drift => {
            logs::log("asr", "sync: drift");
            toast(st, "Автоподгонка субтитров: сдвиг разный в разных частях фильма — похоже, субтитры от другой версии".into());
        }
    }
}

/// Fragments start five seconds before the first cue near each quarter of the film; a window that
/// would repeat the previous audio is dropped.
fn windows(cues: &[(f64, f64, String)], duration: f64, cur: f64) -> Vec<f64> {
    let mut out: Vec<f64> = vec![];
    for t in [0.15, 0.35, 0.55, 0.75] {
        let Some(cue) = cues.iter().find(|c| c.0 >= duration * t) else { continue };
        let w = (cue.0 + cur - LEAD).max(0.0);
        if out.last().is_some_and(|prev| w < prev + WINDOW) {
            continue;
        }
        out.push(w);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cues(n: usize) -> Vec<(f64, f64, String)> {
        (0..n).map(|i| (i as f64 * 10.0, i as f64 * 10.0 + 2.0, "hello world".into())).collect()
    }

    #[test]
    fn silent_detects_zero_filled_fragments() {
        let dir = std::env::temp_dir().join(format!("smartsubs-silent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let zero = dir.join("zero.f32");
        let tone = dir.join("tone.f32");
        std::fs::write(&zero, vec![0u8; 16000 * 4]).unwrap();
        let samples: Vec<u8> = (0..16000).flat_map(|i| (0.2 * (i as f32 * 0.05).sin()).to_le_bytes()).collect();
        std::fs::write(&tone, samples).unwrap();
        assert!(silent(&zero));
        assert!(!silent(&tone));
        assert!(silent(&dir.join("missing.f32")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_cover_the_film_without_overlap() {
        let c = cues(60);
        // 0.15 → 90 s → the cue at 90 s; its window opens 5 s earlier.
        assert_eq!(windows(&c, 600.0, 0.0), [85.0, 205.0, 325.0, 445.0]);
        // A subtitle offset moves every window with the cues.
        assert_eq!(windows(&c, 600.0, 0.5), [85.5, 205.5, 325.5, 445.5]);
        // Short film: two windows, the rest would repeat the same audio.
        assert_eq!(windows(&c, 100.0, 0.0), [15.0, 55.0]);
        // A big shift is clamped at zero and still keeps the windows apart.
        assert_eq!(windows(&c, 600.0, -100.0), [0.0, 105.0, 225.0, 345.0]);
    }
}
