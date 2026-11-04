use super::{clean::clean, parse::RawCue};
use crate::{db::now, types::*};
use rusqlite::{params, Connection};
use std::collections::HashMap;

/// Cleans text, drops empty cues, sorts by start.
pub fn normalize(raw: Vec<RawCue>) -> Vec<RawCue> {
    let mut v: Vec<RawCue> = raw
        .into_iter()
        .filter_map(|c| {
            let t = clean(&c.text);
            (!t.is_empty() && c.end > c.start).then(|| RawCue { text: t, ..c })
        })
        .collect();
    v.sort_by(|a, b| a.start.total_cmp(&b.start));
    v
}

/// Replaces all cues and every table derived from them.
pub fn replace_cues(conn: &Connection, media_id: &str, cues: &[RawCue]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for t in ["cue", "chunk", "cue_pattern", "annot_batch", "explanation", "embedded_load"] {
        tx.execute(&format!("DELETE FROM {t} WHERE media_id=?1"), [media_id])?;
    }
    {
        let mut ins = tx.prepare("INSERT INTO cue(media_id,idx,start,end,text) VALUES(?1,?2,?3,?4,?5)")?;
        for (i, c) in cues.iter().enumerate() {
            ins.execute(params![media_id, i as u32, c.start, c.end, c.text])?;
        }
    }
    tx.commit()
}

pub fn set_source(conn: &Connection, media_id: &str, kind: &str, label: &str, exact: bool, path: &str, key: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO subtitle_source(media_id,kind,label,exact,file_path,fetched_at,ref) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![media_id, kind, label, exact as i32, path, now(), key],
    )?;
    Ok(())
}

/// `(candidate key, label)` of the subtitles installed for this media; the key is `None` before v5.
pub fn active(conn: &Connection, media_id: &str) -> rusqlite::Result<Option<(Option<String>, String)>> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT ref,label FROM subtitle_source WHERE media_id=?1", [media_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()
}

/// Empties the cues and starts reading one track of the video file: the row is the resume point.
/// `replace_cues` runs its own transaction, so this is not one.
pub fn begin_embedded(conn: &Connection, media_id: &str, track: u64, label: &str, total: u32) -> rusqlite::Result<()> {
    replace_cues(conn, media_id, &[])?;
    conn.execute("UPDATE media SET annot=NULL, sub_offset=0 WHERE id=?1", [media_id])?;
    let key = format!("embedded:{track}");
    set_source(conn, media_id, "embedded", label, true, &key, &key)?;
    conn.execute(
        "INSERT OR REPLACE INTO embedded_load(media_id,track,label,next_cue,total_cues) VALUES(?1,?2,?3,0,?4)",
        params![media_id, track as i64, label, total],
    )?;
    Ok(())
}

/// Appends the next cues of a running embedded load, keeping `idx` contiguous from 0. Returns
/// `false` when this loader no longer owns the cue table — another source replaced it, or another
/// track took over — so the caller stops instead of mixing two cue sets.
pub fn append_cues(conn: &Connection, media_id: &str, track: u64, cues: &[RawCue], next_cue: u32) -> rusqlite::Result<bool> {
    use rusqlite::OptionalExtension;
    let tx = conn.unchecked_transaction()?;
    let owner: Option<(i64, u32)> = tx
        .query_row("SELECT track,next_cue FROM embedded_load WHERE media_id=?1", [media_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let Some((owner, prev)) = owner else { return Ok(false) };
    if owner as u64 != track || next_cue <= prev {
        return Ok(false);
    }
    let base: u32 = tx.query_row("SELECT coalesce(max(idx)+1, 0) FROM cue WHERE media_id=?1", [media_id], |r| r.get(0))?;
    {
        let mut ins = tx.prepare("INSERT INTO cue(media_id,idx,start,end,text) VALUES(?1,?2,?3,?4,?5)")?;
        for (i, c) in cues.iter().enumerate() {
            ins.execute(params![media_id, base + i as u32, c.start, c.end, c.text])?;
        }
    }
    let changed = tx.execute(
        "UPDATE embedded_load SET next_cue=?1 WHERE media_id=?2 AND track=?3 AND next_cue=?4",
        params![next_cue, media_id, track as i64, prev],
    )?;
    if changed != 1 {
        return Ok(false);
    }
    tx.commit()?;
    Ok(true)
}

/// `(track, cues written so far, cues in the whole track)` of an interrupted embedded load.
pub fn embedded_progress(conn: &Connection, media_id: &str) -> rusqlite::Result<Option<(u64, u32, u32)>> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT track,next_cue,total_cues FROM embedded_load WHERE media_id=?1", [media_id], |r| {
        Ok((r.get::<_, i64>(0)? as u64, r.get(1)?, r.get(2)?))
    })
    .optional()
}

pub fn list(conn: &Connection, media_id: &str) -> rusqlite::Result<SubsList> {
    let cues: Vec<Cue> = conn
        .prepare("SELECT idx,start,end,text,ru FROM cue WHERE media_id=?1 ORDER BY idx")?
        .query_map([media_id], |r| Ok(Cue { idx: r.get(0)?, start: r.get(1)?, end: r.get(2)?, text: r.get(3)?, ru: r.get(4)? }))?
        .collect::<Result<_, _>>()?;

    let mut chunks: HashMap<u32, Vec<Chunk>> = HashMap::new();
    for row in conn
        .prepare("SELECT cue_idx,start_char,end_char,text,kind,ru FROM chunk WHERE media_id=?1 ORDER BY cue_idx,start_char")?
        .query_map([media_id], |r| Ok((r.get::<_, u32>(0)?, Chunk { start_char: r.get(1)?, end_char: r.get(2)?, text: r.get(3)?, kind: r.get(4)?, ru: r.get(5)? })))?
    {
        let (i, c) = row?;
        chunks.entry(i).or_default().push(c);
    }
    let mut pats: HashMap<u32, Vec<CuePattern>> = HashMap::new();
    for row in conn
        .prepare("SELECT cue_idx,pattern_id,start_char,end_char FROM cue_pattern WHERE media_id=?1 ORDER BY cue_idx,start_char")?
        .query_map([media_id], |r| Ok((r.get::<_, u32>(0)?, CuePattern { pattern_id: r.get(1)?, start_char: r.get(2)?, end_char: r.get(3)? })))?
    {
        let (i, p) = row?;
        pats.entry(i).or_default().push(p);
    }
    let annotations = cues
        .iter()
        .filter_map(|c| {
            c.ru.clone().map(|ru| CueAnnotation {
                idx: c.idx,
                ru,
                chunks: chunks.remove(&c.idx).unwrap_or_default(),
                patterns: pats.remove(&c.idx).unwrap_or_default(),
            })
        })
        .collect();
    Ok(SubsList { cues, annotations })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(s: f64, e: f64, t: &str) -> RawCue { RawCue { start: s, end: e, text: t.into() } }

    #[test]
    fn normalize_drops_empty_and_sorts() {
        let n = normalize(vec![raw(5.0, 6.0, "Later"), raw(1.0, 2.0, "♪ la ♪"), raw(3.0, 4.0, "<i>BOB: Hi</i>")]);
        assert_eq!(n.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["Hi", "Later"]);
    }

    #[test]
    fn replace_clears_annotations() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init(&c).unwrap();
        replace_cues(&c, "m", &[raw(0.0, 1.0, "One"), raw(1.0, 2.0, "Two")]).unwrap();
        c.execute("UPDATE cue SET ru='Раз' WHERE idx=0", []).unwrap();
        c.execute("INSERT INTO chunk VALUES('m',0,0,3,'One','idiom','раз')", []).unwrap();
        let l = list(&c, "m").unwrap();
        assert_eq!(l.cues.len(), 2);
        assert_eq!(l.annotations.len(), 1);
        assert_eq!(l.annotations[0].chunks[0].text, "One");
        replace_cues(&c, "m", &[raw(0.0, 1.0, "Three")]).unwrap();
        let l = list(&c, "m").unwrap();
        assert_eq!((l.cues.len(), l.annotations.len()), (1, 0));
        let n: i64 = c.query_row("SELECT count(*) FROM chunk", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn embedded_load_appends_contiguous_cues() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init(&c).unwrap();
        c.execute("INSERT INTO media(id,kind,source_url,title,updated_at) VALUES('m','lampa','u','t',0)", []).unwrap();
        c.execute("UPDATE media SET annot='on', sub_offset=2.5 WHERE id='m'", []).unwrap();
        begin_embedded(&c, "m", 3, "ENG · US", 6).unwrap();
        assert_eq!(embedded_progress(&c, "m").unwrap(), Some((3, 0, 6)));
        // A new load starts from an empty cue set and a fresh consent.
        let (annot, off): (Option<String>, f64) = c.query_row("SELECT annot,sub_offset FROM media WHERE id='m'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((annot.as_deref(), off), (None, 0.0));
        assert_eq!(active(&c, "m").unwrap().map(|(k, l)| (k, l)), Some((Some("embedded:3".into()), "ENG · US".into())));

        assert!(append_cues(&c, "m", 3, &[raw(1.0, 2.0, "One"), raw(2.0, 3.0, "Two"), raw(3.0, 4.0, "Three")], 3).unwrap());
        assert!(append_cues(&c, "m", 3, &[raw(4.0, 5.0, "Four"), raw(5.0, 6.0, "Five"), raw(6.0, 7.0, "Six")], 6).unwrap());
        let idx: Vec<u32> = c.prepare("SELECT idx FROM cue WHERE media_id='m' ORDER BY idx").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(idx, vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(embedded_progress(&c, "m").unwrap(), Some((3, 6, 6)));

        // A loader that lost the table writes nothing: another track, or a source that took over.
        assert!(!append_cues(&c, "m", 4, &[raw(7.0, 8.0, "Seven")], 7).unwrap());
        assert!(!append_cues(&c, "m", 3, &[raw(7.0, 8.0, "Seven")], 6).unwrap());
        let n: i64 = c.query_row("SELECT count(*) FROM cue", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 6);
        assert_eq!(embedded_progress(&c, "m").unwrap(), Some((3, 6, 6)));

        // Any other source replacing the cues ends the embedded load.
        replace_cues(&c, "m", &[raw(0.0, 1.0, "Other")]).unwrap();
        assert_eq!(embedded_progress(&c, "m").unwrap(), None);
        assert!(!append_cues(&c, "m", 3, &[raw(7.0, 8.0, "Seven")], 7).unwrap());
    }
}
