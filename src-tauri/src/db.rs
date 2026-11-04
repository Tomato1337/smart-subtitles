use rusqlite::Connection;

const SCHEMA: &str = "
CREATE TABLE media(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('lampa','file')), source_url TEXT NOT NULL, title TEXT NOT NULL, original_title TEXT, year INTEGER, tmdb_id INTEGER, tmdb_type TEXT, imdb_id TEXT, season INTEGER, episode INTEGER, episode_title TEXT, duration REAL, last_position REAL NOT NULL DEFAULT 0, sub_offset REAL NOT NULL DEFAULT 0, audio_index INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE subtitle_source(media_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('sidecar','opensubtitles','embedded')), label TEXT NOT NULL, exact INTEGER NOT NULL, file_path TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE TABLE cue(media_id TEXT NOT NULL, idx INTEGER NOT NULL, start REAL NOT NULL, end REAL NOT NULL, text TEXT NOT NULL, ru TEXT, PRIMARY KEY(media_id, idx));
CREATE TABLE chunk(media_id TEXT NOT NULL, cue_idx INTEGER NOT NULL, start_char INTEGER NOT NULL, end_char INTEGER NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, ru TEXT NOT NULL, PRIMARY KEY(media_id, cue_idx, start_char));
CREATE TABLE cue_pattern(media_id TEXT NOT NULL, cue_idx INTEGER NOT NULL, pattern_id TEXT NOT NULL, start_char INTEGER NOT NULL, end_char INTEGER NOT NULL, PRIMARY KEY(media_id, cue_idx, pattern_id));
CREATE TABLE annot_batch(media_id TEXT NOT NULL, first_idx INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN('done','failed')), PRIMARY KEY(media_id, first_idx));
CREATE TABLE explanation(media_id TEXT NOT NULL, cue_idx INTEGER NOT NULL, span TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(media_id, cue_idx, span));
CREATE TABLE exposure(pattern_id TEXT NOT NULL, media_id TEXT NOT NULL, cue_idx INTEGER NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(pattern_id, media_id, cue_idx));
CREATE TABLE pattern_state(pattern_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN('learning','known')), updated_at INTEGER NOT NULL);
CREATE TABLE chat_message(id INTEGER PRIMARY KEY AUTOINCREMENT, media_id TEXT NOT NULL, cue_idx INTEGER NOT NULL, role TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE proposal(id INTEGER PRIMARY KEY AUTOINCREMENT, media_id TEXT NOT NULL, cue_idx INTEGER NOT NULL, words_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('pending','adding','added','dismissed','failed')), error TEXT, created_at INTEGER NOT NULL);
";

/// v2: one automatic subtitle-offset probe per (media, subtitle file).
const MIGRATION_2: &str = "CREATE TABLE sub_sync(media_id TEXT PRIMARY KEY, source_path TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('done','failed')), offset REAL, support INTEGER NOT NULL, detail TEXT, created_at INTEGER NOT NULL);";

/// v3: warn/error notifications kept until the user deletes them.
const MIGRATION_3: &str = "CREATE TABLE notification(id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL CHECK(level IN('warn','error')), message TEXT NOT NULL, created_at INTEGER NOT NULL);";

/// v4: per-media consent for the dialog analysis; NULL = the user has not been asked yet.
const MIGRATION_4: &str = "ALTER TABLE media ADD COLUMN annot TEXT CHECK(annot IN('on','off')); UPDATE media SET annot='on' WHERE id IN (SELECT DISTINCT media_id FROM annot_batch);";

/// v5: which candidate the active subtitles came from (`SubCandidate::key`); NULL for rows written before v5.
const MIGRATION_5: &str = "ALTER TABLE subtitle_source ADD COLUMN ref TEXT;";

/// v6: tokens and dollars of every LLM request, per film and task; `usd` is NULL when no price is known.
const MIGRATION_6: &str = "CREATE TABLE llm_usage(id INTEGER PRIMARY KEY AUTOINCREMENT, media_id TEXT NOT NULL, task TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL, usd REAL, created_at INTEGER NOT NULL);
CREATE INDEX llm_usage_media_task ON llm_usage(media_id, task);";

/// v7: a subtitles track inside the video file being read block by block; the row is the resume point
/// and the user's consent to keep downloading it.
const MIGRATION_7: &str = "CREATE TABLE embedded_load(media_id TEXT PRIMARY KEY, track INTEGER NOT NULL, label TEXT NOT NULL, next_cue INTEGER NOT NULL, total_cues INTEGER NOT NULL);";

pub fn open(path: &std::path::Path) -> anyhow::Result<Connection> {
    let conn = Connection::open(path)?;
    init(&conn)?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> anyhow::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    let mut v: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if v == 0 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(SCHEMA)?;
        tx.pragma_update(None, "user_version", 1)?;
        tx.commit()?;
        v = 1;
    }
    if v < 2 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATION_2)?;
        tx.pragma_update(None, "user_version", 2)?;
        tx.commit()?;
    }
    if v < 3 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATION_3)?;
        tx.pragma_update(None, "user_version", 3)?;
        tx.commit()?;
    }
    if v < 4 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATION_4)?;
        tx.pragma_update(None, "user_version", 4)?;
        tx.commit()?;
    }
    if v < 5 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATION_5)?;
        tx.pragma_update(None, "user_version", 5)?;
        tx.commit()?;
    }
    if v < 6 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATION_6)?;
        tx.pragma_update(None, "user_version", 6)?;
        tx.commit()?;
    }
    if v < 7 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATION_7)?;
        tx.pragma_update(None, "user_version", 7)?;
        tx.commit()?;
    }
    conn.execute(
        "UPDATE proposal SET status='failed', error='Прервано перезапуском' WHERE status='adding'",
        [],
    )?;
    Ok(())
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn init_is_idempotent_and_fails_stuck_proposals() {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c.execute("INSERT INTO proposal(media_id,cue_idx,words_json,status,created_at) VALUES('m',1,'[]','adding',0)", []).unwrap();
        init(&c).unwrap();
        let (s, e): (String, String) = c.query_row("SELECT status,error FROM proposal", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(s, "failed");
        assert_eq!(e, "Прервано перезапуском");
    }

    #[test]
    fn init_migrates_v1_to_v2() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.pragma_update(None, "user_version", 1).unwrap();
        init(&c).unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, 7);
        c.execute("INSERT INTO sub_sync(media_id,source_path,status,offset,support,detail,created_at) VALUES('m','/s.srt','done',0.5,7,NULL,0)", []).unwrap();
        init(&c).unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, 7);
        let n: i64 = c.query_row("SELECT count(*) FROM sub_sync", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }
}
