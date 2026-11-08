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

/// v8: the film was removed from «Недавних» by the user. Only the list entry is hidden: the analysis,
/// the chat and the position stay, and opening the film again brings it back (`session::open`).
const MIGRATION_8: &str = "ALTER TABLE media ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;";

/// v9: one durable job per Anki card, with its captured context, assets and the Anki note it owns.
const MIGRATION_9: &str = "
CREATE TABLE card_job(
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK(origin IN('quick','review','proposal')),
  intent_key TEXT,
  proposal_id INTEGER,
  word_index INTEGER,
  media_id TEXT NOT NULL,
  cue_idx INTEGER NOT NULL,
  span TEXT,
  state TEXT NOT NULL CHECK(state IN('grace','queued','drafting','generating','editing','committing','resolving','cancel_requested','cancelled','added','deleting','deleted','failed','interrupted')),
  revision INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  remaining_ms INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  context_json TEXT NOT NULL,
  draft_json TEXT,
  assets_json TEXT,
  mapping_json TEXT,
  owned_fields_json TEXT,
  baseline_fields_json TEXT,
  progress_json TEXT,
  pending_operation TEXT,
  pending_fields_json TEXT,
  note_profile TEXT,
  note_id INTEGER,
  error TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  note_confirmed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX card_job_proposal_word ON card_job(proposal_id, word_index) WHERE proposal_id IS NOT NULL;
CREATE UNIQUE INDEX card_job_intent ON card_job(intent_key) WHERE intent_key IS NOT NULL AND state NOT IN ('cancelled','deleted');
CREATE INDEX card_job_page ON card_job(created_at DESC, id DESC);
CREATE INDEX card_job_state ON card_job(state);
";

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
    if v < 8 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATION_8)?;
        tx.pragma_update(None, "user_version", 8)?;
        tx.commit()?;
    }
    if v < 9 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATION_9)?;
        tx.pragma_update(None, "user_version", 9)?;
        tx.commit()?;
    }
    // Proposals that already own job rows are reconciled by `anki::jobs::start`; only a legacy
    // `adding` proposal with no job behind it was interrupted by the restart.
    conn.execute(
        "UPDATE proposal SET status='failed', error='Прервано перезапуском' WHERE status='adding' \
         AND id NOT IN (SELECT proposal_id FROM card_job WHERE proposal_id IS NOT NULL)",
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
        let s: String = c.query_row("SELECT status FROM proposal", [], |r| r.get(0)).unwrap();
        assert_eq!(s, "failed");
    }

    #[test]
    fn init_migrates_legacy_databases_without_losing_rows() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.pragma_update(None, "user_version", 1).unwrap();
        init(&c).unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, 9);
        c.execute("INSERT INTO sub_sync(media_id,source_path,status,offset,support,detail,created_at) VALUES('m','/s.srt','done',0.5,7,NULL,0)", []).unwrap();
        init(&c).unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, 9);
        let n: i64 = c.query_row("SELECT count(*) FROM sub_sync", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn media_is_visible_until_hidden() {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c.execute("INSERT INTO media(id,kind,source_url,title,updated_at) VALUES('m','lampa','u','t',0)", []).unwrap();
        let hidden: bool = c.query_row("SELECT hidden FROM media WHERE id='m'", [], |r| r.get(0)).unwrap();
        assert!(!hidden);
        c.execute("UPDATE media SET hidden=?1 WHERE id='m'", [true]).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM media WHERE hidden=0", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn startup_reset_leaves_job_backed_proposals_for_reconciliation() {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c.execute("INSERT INTO proposal(id,media_id,cue_idx,words_json,status,created_at) VALUES(1,'m',1,'[]','adding',0),(2,'m',1,'[]','adding',0)", []).unwrap();
        c.execute("INSERT INTO card_job(id,origin,proposal_id,word_index,media_id,cue_idx,state,context_json,created_at,updated_at) VALUES('owned','proposal',2,0,'m',1,'committing','{}',0,0)", []).unwrap();
        init(&c).unwrap();
        let statuses: Vec<(i64, String)> = c.prepare("SELECT id,status FROM proposal ORDER BY id").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(statuses, vec![(1, "failed".into()), (2, "adding".into())]);
    }

    #[test]
    fn card_job_indexes_deduplicate_live_intents_and_proposal_words() {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        let insert_quick = |id: &str| c.execute("INSERT INTO card_job(id,origin,intent_key,media_id,cue_idx,state,context_json,created_at,updated_at) VALUES(?1,'quick','same-intent','m',1,'grace','{}',0,0)", [id]);
        insert_quick("first").unwrap();
        assert!(insert_quick("duplicate").is_err());
        c.execute("UPDATE card_job SET state='cancelled' WHERE id='first'", []).unwrap();
        insert_quick("explicit-new").unwrap();
        let insert_proposal = |id: &str| c.execute("INSERT INTO card_job(id,origin,proposal_id,word_index,media_id,cue_idx,state,context_json,created_at,updated_at) VALUES(?1,'proposal',3,4,'m',1,'queued','{}',0,0)", [id]);
        insert_proposal("word").unwrap();
        assert!(insert_proposal("same-word").is_err());
        let ids: Vec<String> = c.prepare("SELECT id FROM card_job ORDER BY id").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(ids, vec!["explicit-new", "first", "word"]);
    }
}
