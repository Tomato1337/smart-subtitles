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
    for t in ["cue", "chunk", "cue_pattern", "annot_batch", "explanation"] {
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

pub fn set_source(conn: &Connection, media_id: &str, kind: &str, label: &str, exact: bool, path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO subtitle_source(media_id,kind,label,exact,file_path,fetched_at) VALUES(?1,?2,?3,?4,?5,?6)",
        params![media_id, kind, label, exact as i32, path, now()],
    )?;
    Ok(())
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
}
