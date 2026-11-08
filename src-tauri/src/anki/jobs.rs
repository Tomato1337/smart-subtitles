//! Durable card jobs: one row per card, its captured context, assets, the Anki note it owns and the
//! operations that create, edit, cancel or delete it.
//!
//! SQLite is the authority: every change is a one-row compare-and-set, revisions guard edits, and a
//! sent Anki operation is never blindly retried — it is reconciled through the job's own marker tag
//! first. The runtime adds grace timers, interaction holds and per-job cancellation; events and the
//! UI are projections of the committed rows.

use crate::{
    anki::{
        cards::{self, WordDraft},
        connect,
        fields::{self, Source},
        images, preview,
    },
    config, db, logs,
    llm::explain,
    state::{db_task, AppState},
};
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Emitter;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// The approved cancellation window of a quick add.
pub const GRACE_MS: u64 = 5000;
/// A client's interaction hold survives this long without renewal.
const HOLD_LEASE: Duration = Duration::from_secs(10);
const TICK: Duration = Duration::from_millis(100);
const SNAPSHOT: Duration = Duration::from_millis(250);
const PERSIST: Duration = Duration::from_secs(1);
const PAGE: usize = 20;
const TAG_PREFIX: &str = "smartsubs-job::";
pub const NOT_FOUND: &str = "Карточка не найдена";
pub const STALE: &str = "Карточка изменилась. Откройте её снова.";
const MISSING_NOTE: &str = "Заметка этой карточки не найдена в Anki. Откройте её снова.";
const ESTABLISHED: &str = "Карточка уже в Anki — удалите её, чтобы убрать.";
const OPERATION_RUNNING: &str = "Дождитесь завершения операции с карточкой.";
const LEGACY_PROPOSAL: &str = "У старой попытки нет идентификатора Anki. Проверьте заметку перед повторным добавлением.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardJobState {
    Grace,
    Queued,
    Drafting,
    Generating,
    Editing,
    Committing,
    Resolving,
    CancelRequested,
    Cancelled,
    Added,
    Deleting,
    Deleted,
    Failed,
    Interrupted,
}

impl CardJobState {
    pub fn as_str(self) -> &'static str {
        match self {
            CardJobState::Grace => "grace",
            CardJobState::Queued => "queued",
            CardJobState::Drafting => "drafting",
            CardJobState::Generating => "generating",
            CardJobState::Editing => "editing",
            CardJobState::Committing => "committing",
            CardJobState::Resolving => "resolving",
            CardJobState::CancelRequested => "cancel_requested",
            CardJobState::Cancelled => "cancelled",
            CardJobState::Added => "added",
            CardJobState::Deleting => "deleting",
            CardJobState::Deleted => "deleted",
            CardJobState::Failed => "failed",
            CardJobState::Interrupted => "interrupted",
        }
    }

    fn parse(s: &str) -> Result<Self, String> {
        Ok(match s {
            "grace" => Self::Grace,
            "queued" => Self::Queued,
            "drafting" => Self::Drafting,
            "generating" => Self::Generating,
            "editing" => Self::Editing,
            "committing" => Self::Committing,
            "resolving" => Self::Resolving,
            "cancel_requested" => Self::CancelRequested,
            "cancelled" => Self::Cancelled,
            "added" => Self::Added,
            "deleting" => Self::Deleting,
            "deleted" => Self::Deleted,
            "failed" => Self::Failed,
            "interrupted" => Self::Interrupted,
            other => return Err(format!("неизвестное состояние карточки «{other}»")),
        })
    }

    /// States the activity panel counts as work in flight.
    pub fn active(self) -> bool {
        matches!(
            self,
            Self::Grace
                | Self::Queued
                | Self::Drafting
                | Self::Generating
                | Self::Committing
                | Self::Resolving
                | Self::CancelRequested
                | Self::Deleting
        )
    }

    fn terminal(self) -> bool {
        matches!(self, Self::Cancelled | Self::Deleted | Self::Added | Self::Failed | Self::Interrupted)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum JobError {
    Cancelled,
    Failed(String),
    Conflict(String),
}

impl JobError {
    pub fn text(&self) -> String {
        match self {
            JobError::Cancelled => "отменено".into(),
            JobError::Failed(m) | JobError::Conflict(m) => m.clone(),
        }
    }
}

/// The film a job was created for, exactly as the rest of the app names it.
pub use crate::llm::prompts::MediaContext;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedCue {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub offset: f64,
    pub next_start: Option<f64>,
    pub chunk_fallback: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipContext {
    /// The raw original request URL, without credentials; `Config::with_auth` is applied when used.
    pub source_url: String,
    pub audio_index: u32,
    pub video_index: Option<u32>,
    pub hdr: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiTarget {
    pub url: String,
    pub deck: String,
    pub note_type: String,
    pub fields: BTreeMap<String, String>,
    pub tags: String,
    pub tts: bool,
    pub tts_voice: String,
    pub sentence_audio: String,
    pub clip: bool,
    pub sync_after_add: bool,
}

impl AnkiTarget {
    fn of(a: &config::Anki) -> Self {
        Self {
            url: a.url.clone(),
            deck: a.deck.clone(),
            note_type: a.note_type.clone(),
            fields: a.fields.clone(),
            tags: a.tags.clone(),
            tts: a.tts,
            tts_voice: a.tts_voice.clone(),
            sentence_audio: a.sentence_audio.clone(),
            clip: a.clip,
            sync_after_add: a.sync_after_add,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobContext {
    pub cue_idx: u32,
    pub media: MediaContext,
    pub cue: CapturedCue,
    /// Present when the video probe exists; a job without a probe keeps the raw source below.
    pub clip: Option<ClipContext>,
    /// The immutable raw request URL captured at click time, even before a probe exists.
    #[serde(default)]
    pub source_url: Option<String>,
    /// The audio track the learner selected when this job was created.
    #[serde(default)]
    pub audio_index: u32,
    pub anki: AnkiTarget,
    pub image_style: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSlot {
    pub input_hash: String,
    /// `ready` | `failed` | `disabled`
    pub status: String,
    pub cache_path: Option<String>,
    pub file_name: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobAssets {
    pub image: Option<AssetSlot>,
    pub word_audio: Option<AssetSlot>,
    pub sentence_audio: Option<AssetSlot>,
    pub clip: Option<AssetSlot>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: String,
    pub provider: Option<String>,
    pub attempt: Option<u32>,
}

impl Progress {
    fn phase(p: &str) -> Self {
        Self { phase: p.into(), provider: None, attempt: None }
    }
}

#[derive(Debug, Clone)]
pub struct JobRow {
    pub id: String,
    pub origin: String,
    pub proposal_id: Option<i64>,
    pub word_index: Option<i64>,
    pub media_id: String,
    pub cue_idx: u32,
    pub span: Option<String>,
    pub state: CardJobState,
    pub revision: u64,
    pub version: u64,
    pub remaining_ms: u64,
    pub cancel_requested: bool,
    pub context: JobContext,
    pub draft: Option<WordDraft>,
    pub assets: JobAssets,
    pub mapping: Option<Vec<(String, Option<Source>)>>,
    pub owned_fields: Option<BTreeMap<String, String>>,
    pub baseline_fields: Option<BTreeMap<String, String>>,
    pub progress: Progress,
    pub pending_operation: Option<String>,
    pub pending_fields: Option<BTreeMap<String, String>>,
    pub note_profile: Option<String>,
    pub note_id: Option<i64>,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub note_confirmed: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl JobRow {
    fn marker(&self) -> String {
        format!("{TAG_PREFIX}{}", self.id)
    }

    fn name(&self) -> String {
        self.context.media.original_title.clone().unwrap_or_else(|| self.context.media.title.clone())
    }
}

/// One job as the UI sees it: no URLs, no credentials, no paths.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardJob {
    pub id: String,
    pub origin: String,
    pub proposal_id: Option<i64>,
    pub word_index: Option<i64>,
    pub media_id: String,
    pub cue_idx: u32,
    pub span: Option<String>,
    pub title: String,
    pub cue_text: String,
    pub cue_start: f64,
    pub word: String,
    pub state: CardJobState,
    pub revision: u64,
    pub version: u64,
    pub remaining_ms: u64,
    pub held: bool,
    pub cancel_requested: bool,
    pub draft: Option<WordDraft>,
    pub note_id: Option<i64>,
    pub has_committed_note: bool,
    pub image: Option<SelectedImage>,
    pub phase: Option<String>,
    pub image_provider: Option<String>,
    pub attempt: Option<u32>,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedImage {
    pub key: String,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCursor {
    pub created_at: i64,
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardJobPage {
    pub items: Vec<CardJob>,
    pub active_jobs: Vec<CardJob>,
    pub next_cursor: Option<JobCursor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardJobEditor {
    pub job: CardJob,
    pub preview: Option<preview::CardPreview>,
    pub field_values: Option<BTreeMap<String, String>>,
    pub baseline_fields: Option<BTreeMap<String, String>>,
}

// ---------------------------------------------------------------------------------------------
// Row storage
// ---------------------------------------------------------------------------------------------

const COLUMNS: &str = "id,origin,proposal_id,word_index,media_id,cue_idx,span,state,revision,version,remaining_ms,\
cancel_requested,context_json,draft_json,assets_json,mapping_json,owned_fields_json,baseline_fields_json,progress_json,\
pending_operation,pending_fields_json,note_profile,note_id,error,warnings_json,note_confirmed,created_at,updated_at";

const ACTIVE_STATES: &str = "'grace','queued','drafting','generating','editing','committing','resolving','cancel_requested','deleting'";
/// States a worker failure may turn into `failed`; an editor/save/added row is never here.
const FAILABLE_STATES: &[&str] = &["queued", "drafting", "generating", "committing"];
/// States an unsent cancellation may finish; a confirmed note is fenced by `note_confirmed`.
const CANCELABLE_STATES: &[&str] = &["cancel_requested", "queued", "drafting", "generating", "committing"];

struct RawJob {
    id: String,
    origin: String,
    proposal_id: Option<i64>,
    word_index: Option<i64>,
    media_id: String,
    cue_idx: u32,
    span: Option<String>,
    state: String,
    revision: i64,
    version: i64,
    remaining_ms: i64,
    cancel_requested: bool,
    context_json: String,
    draft_json: Option<String>,
    assets_json: Option<String>,
    mapping_json: Option<String>,
    owned_fields_json: Option<String>,
    baseline_fields_json: Option<String>,
    progress_json: Option<String>,
    pending_operation: Option<String>,
    pending_fields_json: Option<String>,
    note_profile: Option<String>,
    note_id: Option<i64>,
    error: Option<String>,
    warnings_json: String,
    note_confirmed: bool,
    created_at: i64,
    updated_at: i64,
}

fn raw_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RawJob> {
    Ok(RawJob {
        id: r.get(0)?,
        origin: r.get(1)?,
        proposal_id: r.get(2)?,
        word_index: r.get(3)?,
        media_id: r.get(4)?,
        cue_idx: r.get(5)?,
        span: r.get(6)?,
        state: r.get(7)?,
        revision: r.get(8)?,
        version: r.get(9)?,
        remaining_ms: r.get(10)?,
        cancel_requested: r.get(11)?,
        context_json: r.get(12)?,
        draft_json: r.get(13)?,
        assets_json: r.get(14)?,
        mapping_json: r.get(15)?,
        owned_fields_json: r.get(16)?,
        baseline_fields_json: r.get(17)?,
        progress_json: r.get(18)?,
        pending_operation: r.get(19)?,
        pending_fields_json: r.get(20)?,
        note_profile: r.get(21)?,
        note_id: r.get(22)?,
        error: r.get(23)?,
        warnings_json: r.get(24)?,
        note_confirmed: r.get(25)?,
        created_at: r.get(26)?,
        updated_at: r.get(27)?,
    })
}

/// Stored JSON that no longer parses is a real error, never a silently empty job.
fn db_payload(msg: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, msg.into())),
    )
}

fn parse_json<T: serde::de::DeserializeOwned>(raw: &str, what: &str) -> Result<T, String> {
    serde_json::from_str(raw).map_err(|e| format!("{what}: сохранённые данные повреждены ({e})"))
}

fn mapping_from_json(raw: &str) -> Result<Vec<(String, Option<Source>)>, String> {
    let pairs: Vec<(String, Option<String>)> = parse_json(raw, "сопоставление полей")?;
    pairs
        .into_iter()
        .map(|(field, source)| match source {
            None => Ok((field, None)),
            Some(id) => Source::parse(&id)
                .map(|s| (field, Some(s)))
                .ok_or_else(|| format!("сопоставление полей: неизвестный источник «{id}»")),
        })
        .collect()
}

fn mapping_to_json(map: &[(String, Option<Source>)]) -> String {
    let pairs: Vec<(String, Option<&str>)> = map.iter().map(|(f, s)| (f.clone(), s.map(Source::id))).collect();
    serde_json::to_string(&pairs).unwrap_or_else(|_| "[]".into())
}

impl RawJob {
    fn parse(self) -> Result<JobRow, String> {
        Ok(JobRow {
            id: self.id,
            origin: self.origin,
            proposal_id: self.proposal_id,
            word_index: self.word_index,
            media_id: self.media_id,
            cue_idx: self.cue_idx,
            span: self.span,
            state: CardJobState::parse(&self.state)?,
            revision: self.revision.max(0) as u64,
            version: self.version.max(0) as u64,
            remaining_ms: self.remaining_ms.max(0) as u64,
            cancel_requested: self.cancel_requested,
            context: parse_json(&self.context_json, "контекст карточки")?,
            draft: match self.draft_json {
                Some(j) => Some(parse_json(&j, "черновик карточки")?),
                None => None,
            },
            assets: match self.assets_json {
                Some(j) => parse_json(&j, "медиа карточки")?,
                None => JobAssets::default(),
            },
            mapping: match self.mapping_json {
                Some(j) => Some(mapping_from_json(&j)?),
                None => None,
            },
            owned_fields: match self.owned_fields_json {
                Some(j) => Some(parse_json(&j, "поля карточки")?),
                None => None,
            },
            baseline_fields: match self.baseline_fields_json {
                Some(j) => Some(parse_json(&j, "исходные поля карточки")?),
                None => None,
            },
            progress: match self.progress_json {
                Some(j) => parse_json(&j, "прогресс карточки")?,
                None => Progress::default(),
            },
            pending_operation: self.pending_operation,
            pending_fields: match self.pending_fields_json {
                Some(j) => Some(parse_json(&j, "ожидающие поля карточки")?),
                None => None,
            },
            note_profile: self.note_profile,
            note_id: self.note_id,
            error: self.error,
            warnings: parse_json(&self.warnings_json, "предупреждения карточки")?,
            note_confirmed: self.note_confirmed,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

fn load_sync(c: &Connection, id: &str) -> rusqlite::Result<Option<JobRow>> {
    let raw = c
        .query_row(&format!("SELECT {COLUMNS} FROM card_job WHERE id=?1"), [id], raw_row)
        .optional()?;
    raw.map(|r| r.parse().map_err(db_payload)).transpose()
}

async fn load_db(db: &Arc<Mutex<Connection>>, id: &str) -> Result<JobRow, String> {
    let id = id.to_string();
    db_task(db, move |c| load_sync(c, &id)).await?.ok_or_else(|| NOT_FOUND.to_string())
}

async fn load(st: &Arc<AppState>, id: &str) -> Result<JobRow, String> {
    load_db(&st.db, id).await
}

/// One compare-and-set update. Every field that changed is written together with the version bump.
#[derive(Default, Clone)]
struct Change {
    state: Option<CardJobState>,
    remaining_ms: Option<u64>,
    cancel_requested: Option<bool>,
    draft: Option<Option<WordDraft>>,
    assets: Option<JobAssets>,
    mapping: Option<Vec<(String, Option<Source>)>>,
    owned_fields: Option<BTreeMap<String, String>>,
    baseline_fields: Option<BTreeMap<String, String>>,
    progress: Option<Progress>,
    pending_operation: Option<Option<String>>,
    pending_fields: Option<BTreeMap<String, String>>,
    note_profile: Option<String>,
    note_id: Option<i64>,
    error: Option<Option<String>>,
    warnings: Option<Vec<String>>,
    note_confirmed: Option<bool>,
    revision: Option<u64>,
}

fn text(s: &str) -> SqlValue {
    SqlValue::Text(s.to_string())
}

fn json_value<T: Serialize>(v: &T) -> SqlValue {
    SqlValue::Text(serde_json::to_string(v).unwrap_or_default())
}

/// SET fragments and their bound values, in one order for the plain and guarded compare-and-set.
fn change_sets(ch: &Change, vals: &mut Vec<SqlValue>) -> Vec<String> {
    let mut sets: Vec<String> = vec!["version=version+1".into(), "updated_at=?".into()];
    vals.push(SqlValue::Integer(db::now()));
    if let Some(s) = ch.state {
        sets.push("state=?".into());
        vals.push(text(s.as_str()));
    }
    if let Some(v) = ch.remaining_ms {
        sets.push("remaining_ms=?".into());
        vals.push(SqlValue::Integer(v as i64));
    }
    if let Some(v) = ch.cancel_requested {
        sets.push("cancel_requested=?".into());
        vals.push(SqlValue::Integer(v as i64));
    }
    if let Some(v) = &ch.draft {
        sets.push("draft_json=?".into());
        vals.push(match v {
            Some(d) => SqlValue::Text(serde_json::to_string(d).unwrap_or_default()),
            None => SqlValue::Null,
        });
    }
    if let Some(v) = &ch.assets {
        sets.push("assets_json=?".into());
        vals.push(json_value(v));
    }
    if let Some(v) = &ch.mapping {
        sets.push("mapping_json=?".into());
        vals.push(SqlValue::Text(mapping_to_json(v)));
    }
    if let Some(v) = &ch.owned_fields {
        sets.push("owned_fields_json=?".into());
        vals.push(json_value(v));
    }
    if let Some(v) = &ch.baseline_fields {
        sets.push("baseline_fields_json=?".into());
        vals.push(json_value(v));
    }
    if let Some(v) = &ch.progress {
        sets.push("progress_json=?".into());
        vals.push(json_value(v));
    }
    if let Some(v) = &ch.pending_operation {
        sets.push("pending_operation=?".into());
        vals.push(v.as_ref().map(|s| SqlValue::Text(s.clone())).unwrap_or(SqlValue::Null));
    }
    if let Some(v) = &ch.pending_fields {
        sets.push("pending_fields_json=?".into());
        vals.push(json_value(v));
    }
    if let Some(v) = &ch.note_profile {
        sets.push("note_profile=?".into());
        vals.push(SqlValue::Text(v.clone()));
    }
    if let Some(v) = ch.note_id {
        sets.push("note_id=?".into());
        vals.push(SqlValue::Integer(v));
    }
    if let Some(v) = &ch.error {
        sets.push("error=?".into());
        vals.push(v.as_ref().map(|s| SqlValue::Text(s.clone())).unwrap_or(SqlValue::Null));
    }
    if let Some(v) = &ch.warnings {
        sets.push("warnings_json=?".into());
        vals.push(json_value(v));
    }
    if let Some(v) = ch.note_confirmed {
        sets.push("note_confirmed=?".into());
        vals.push(SqlValue::Integer(v as i64));
    }
    if let Some(v) = ch.revision {
        sets.push("revision=?".into());
        vals.push(SqlValue::Integer(v as i64));
    }
    sets
}

fn apply_sync(c: &Connection, id: &str, expected_version: u64, ch: &Change) -> rusqlite::Result<bool> {
    let mut vals: Vec<SqlValue> = Vec::new();
    let sets = change_sets(ch, &mut vals);
    vals.push(text(id));
    vals.push(SqlValue::Integer(expected_version as i64));
    let sql = format!("UPDATE card_job SET {} WHERE id=? AND version=?", sets.join(","));
    c.execute(&sql, params_from_iter(vals)).map(|n| n == 1)
}

/// A row-state/revision guard for transitions a superseded worker may try to make. Version alone is
/// not enough: progress writes advance it without changing the work, and a fresh load would let an
/// old worker overwrite a newer save.
#[derive(Clone, Copy)]
struct Guard {
    revision: u64,
    states: &'static [&'static str],
    cancel_requested: Option<bool>,
    note_confirmed: Option<bool>,
}

fn apply_guarded_sync(c: &Connection, id: &str, guard: Guard, ch: &Change) -> rusqlite::Result<bool> {
    let mut vals: Vec<SqlValue> = Vec::new();
    let sets = change_sets(ch, &mut vals);
    vals.push(text(id));
    vals.push(SqlValue::Integer(guard.revision as i64));
    let marks = vec!["?"; guard.states.len()].join(",");
    let mut wheres = vec!["id=?".to_string(), "revision=?".to_string(), format!("state IN ({marks})")];
    for s in guard.states {
        vals.push(text(s));
    }
    if let Some(v) = guard.cancel_requested {
        wheres.push("cancel_requested=?".into());
        vals.push(SqlValue::Integer(v as i64));
    }
    if let Some(v) = guard.note_confirmed {
        wheres.push("note_confirmed=?".into());
        vals.push(SqlValue::Integer(v as i64));
    }
    let sql = format!("UPDATE card_job SET {} WHERE {}", sets.join(","), wheres.join(" AND "));
    c.execute(&sql, params_from_iter(vals)).map(|n| n == 1)
}

async fn apply_db(db: &Arc<Mutex<Connection>>, id: &str, expected_version: u64, ch: Change) -> Result<Option<JobRow>, String> {
    let (id2, ch2) = (id.to_string(), ch);
    let ok = db_task(db, move |c| apply_sync(c, &id2, expected_version, &ch2)).await?;
    if !ok {
        return Ok(None);
    }
    Ok(Some(load_db(db, id).await?))
}

async fn apply(st: &Arc<AppState>, id: &str, expected_version: u64, ch: Change) -> Result<Option<JobRow>, String> {
    let row = apply_db(&st.db, id, expected_version, ch).await?;
    if let Some(r) = &row {
        emit(st, r);
    }
    Ok(row)
}

async fn apply_guarded(st: &Arc<AppState>, id: &str, guard: Guard, ch: Change) -> Result<Option<JobRow>, String> {
    let (id2, ch2) = (id.to_string(), ch);
    let ok = db_task(&st.db, move |c| apply_guarded_sync(c, &id2, guard, &ch2)).await?;
    if !ok {
        return Ok(None);
    }
    let row = load(st, id).await?;
    emit(st, &row);
    Ok(Some(row))
}

fn dto_of(st: &AppState, row: &JobRow) -> CardJob {
    let held = row.state == CardJobState::Editing
        || (row.state == CardJobState::Grace && st.card_jobs.held(&row.id));
    let image = row.assets.image.as_ref().filter(|s| s.status == "ready").and_then(|s| {
        let key = s.cache_path.as_deref().and_then(|p| Path::new(p).file_stem().map(|f| f.to_string_lossy().into_owned()))?;
        Some(SelectedImage { key, provider: s.provider.clone().unwrap_or_default(), model: s.model.clone().unwrap_or_default() })
    });
    CardJob {
        id: row.id.clone(),
        origin: row.origin.clone(),
        proposal_id: row.proposal_id,
        word_index: row.word_index,
        media_id: row.media_id.clone(),
        cue_idx: row.cue_idx,
        span: row.span.clone(),
        title: row.context.media.title.clone(),
        cue_text: row.context.cue.text.clone(),
        cue_start: row.context.cue.start + row.context.cue.offset,
        word: row
            .draft
            .as_ref()
            .map(|d| d.word.clone())
            .or_else(|| row.span.clone())
            .unwrap_or_else(|| row.context.cue.text.lines().next().unwrap_or_default().trim().to_string()),
        state: row.state,
        revision: row.revision,
        version: row.version,
        remaining_ms: st.card_jobs.remaining_ms(&row.id, row.remaining_ms),
        held,
        cancel_requested: row.cancel_requested,
        draft: row.draft.clone(),
        note_id: row.note_id,
        has_committed_note: row.note_confirmed,
        image,
        phase: if row.progress.phase.is_empty() { None } else { Some(row.progress.phase.clone()) },
        image_provider: row.progress.provider.clone(),
        attempt: row.progress.attempt,
        error: row.error.clone(),
        warnings: row.warnings.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// The AppHandle-free projection used by commit/reconcile helpers and their tests.
fn dto_db(row: &JobRow) -> CardJob {
    let image = row.assets.image.as_ref().filter(|s| s.status == "ready").and_then(|s| {
        let key = s.cache_path.as_deref().and_then(|p| Path::new(p).file_stem().map(|f| f.to_string_lossy().into_owned()))?;
        Some(SelectedImage { key, provider: s.provider.clone().unwrap_or_default(), model: s.model.clone().unwrap_or_default() })
    });
    CardJob {
        id: row.id.clone(),
        origin: row.origin.clone(),
        proposal_id: row.proposal_id,
        word_index: row.word_index,
        media_id: row.media_id.clone(),
        cue_idx: row.cue_idx,
        span: row.span.clone(),
        title: row.context.media.title.clone(),
        cue_text: row.context.cue.text.clone(),
        cue_start: row.context.cue.start + row.context.cue.offset,
        word: row.draft.as_ref().map(|d| d.word.clone()).or_else(|| row.span.clone()).unwrap_or_default(),
        state: row.state,
        revision: row.revision,
        version: row.version,
        remaining_ms: row.remaining_ms,
        held: row.state == CardJobState::Editing,
        cancel_requested: row.cancel_requested,
        draft: row.draft.clone(),
        note_id: row.note_id,
        has_committed_note: row.note_confirmed,
        image,
        phase: if row.progress.phase.is_empty() { None } else { Some(row.progress.phase.clone()) },
        image_provider: row.progress.provider.clone(),
        attempt: row.progress.attempt,
        error: row.error.clone(),
        warnings: row.warnings.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn emit(st: &AppState, row: &JobRow) {
    let _ = st.app.emit("cards:job", dto_of(st, row));
}

/// Emits a committed row and returns its DTO.
fn publish(st: &AppState, row: &JobRow) -> CardJob {
    emit(st, row);
    dto_of(st, row)
}

fn safe(msg: impl Into<String>) -> String {
    logs::redact(&msg.into())
}

// ---------------------------------------------------------------------------------------------
// Runtime: grace, holds, cancellation ownership
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Grace {
    /// The SQLite version the deltas below belong to.
    base_version: u64,
    remaining_ms: u64,
    last: Option<tokio::time::Instant>,
    paused: bool,
    holds: BTreeMap<String, tokio::time::Instant>,
    editing: bool,
    tick: u64,
    finished: bool,
}

struct TokenState {
    generation: u64,
    token: CancellationToken,
}

#[derive(Clone)]
struct Operation {
    generation: u64,
    token: CancellationToken,
}

pub struct JobControl {
    tokens: Mutex<TokenState>,
    /// Signalled when an owned send/reconciliation turn ends; cancellation waits on the send lock.
    pub notify: Notify,
    grace: Mutex<Grace>,
    /// Serializes Anki writes (add/update/delete/reconcile) for this job, so cancellation waits for
    /// an in-flight send instead of racing it.
    pub send: tokio::sync::Mutex<()>,
}

impl JobControl {
    fn new(grace_ms: u64) -> Self {
        Self {
            tokens: Mutex::new(TokenState { generation: 0, token: CancellationToken::new() }),
            notify: Notify::new(),
            grace: Mutex::new(Grace { remaining_ms: grace_ms, last: Some(tokio::time::Instant::now()), ..Default::default() }),
            send: tokio::sync::Mutex::new(()),
        }
    }

    /// Starts one owned operation: a fresh token, and an older worker loses permission to finalize.
    fn start_operation(&self) -> Operation {
        let mut t = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        t.generation += 1;
        let fresh = CancellationToken::new();
        let old = std::mem::replace(&mut t.token, fresh.clone());
        old.cancel();
        Operation { generation: t.generation, token: fresh }
    }

    fn is_current(&self, generation: u64) -> bool {
        self.tokens.lock().unwrap_or_else(|e| e.into_inner()).generation == generation
    }

    fn cancel_current(&self) {
        self.tokens.lock().unwrap_or_else(|e| e.into_inner()).token.cancel();
    }

    fn held(&self) -> bool {
        let g = self.grace.lock().unwrap_or_else(|e| e.into_inner());
        !g.holds.is_empty() || g.editing
    }

    fn remaining(&self) -> u64 {
        self.grace.lock().unwrap_or_else(|e| e.into_inner()).remaining_ms
    }

    fn set_base_version(&self, version: u64) {
        self.grace.lock().unwrap_or_else(|e| e.into_inner()).base_version = version;
    }

    fn set_editing(&self, editing: bool) {
        let mut g = self.grace.lock().unwrap_or_else(|e| e.into_inner());
        g.editing = editing;
        g.last = Some(tokio::time::Instant::now());
    }

    /// An interaction hold or release. Returns whether the call was accepted and must be persisted:
    /// renewals are persisted too, so the stored remaining time never lags a live pause.
    fn hold(&self, client_id: &str, held: bool, now: tokio::time::Instant) -> bool {
        let mut g = self.grace.lock().unwrap_or_else(|e| e.into_inner());
        if g.finished || g.editing || g.remaining_ms == 0 {
            return false;
        }
        if !g.paused {
            elapse(&mut g, now);
        }
        g.holds.retain(|_, expiry| *expiry > now);
        if held {
            g.holds.insert(client_id.to_string(), now + HOLD_LEASE);
        } else {
            g.holds.remove(client_id);
        }
        g.paused = !g.holds.is_empty();
        g.last = Some(now);
        true
    }

    fn tick(&self, now: tokio::time::Instant) -> bool {
        let mut g = self.grace.lock().unwrap_or_else(|e| e.into_inner());
        if g.finished {
            return true;
        }
        let before = g.holds.len();
        g.holds.retain(|_, expiry| *expiry > now);
        if g.holds.len() != before && g.holds.is_empty() && !g.editing {
            // A lost heartbeat releases the pause without restoring elapsed grace.
            g.paused = false;
            g.last = Some(now);
        }
        if !g.paused && !g.editing {
            elapse(&mut g, now);
        }
        g.tick += 1;
        g.remaining_ms == 0 && !g.paused && !g.editing
    }

    fn finish(&self) {
        self.grace.lock().unwrap_or_else(|e| e.into_inner()).finished = true;
    }
}

fn elapse(g: &mut Grace, now: tokio::time::Instant) {
    if let Some(last) = g.last {
        let elapsed = now.saturating_duration_since(last).as_millis() as u64;
        g.remaining_ms = g.remaining_ms.saturating_sub(elapsed);
    }
    g.last = Some(now);
}

pub struct Runtime {
    controls: Mutex<HashMap<String, Arc<JobControl>>>,
    /// Jobs whose draft request is in flight: `cards_job_edit` must not start a second one.
    drafts: Mutex<std::collections::HashSet<String>>,
    /// Proposals whose aggregate report was already sent for the current round of jobs.
    reported: Mutex<std::collections::HashSet<i64>>,
    shutdown: CancellationToken,
    ready: tokio::sync::OnceCell<()>,
    network_started: AtomicBool,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            controls: Mutex::new(HashMap::new()),
            drafts: Mutex::new(std::collections::HashSet::new()),
            reported: Mutex::new(std::collections::HashSet::new()),
            shutdown: CancellationToken::new(),
            ready: tokio::sync::OnceCell::new(),
            network_started: AtomicBool::new(false),
        }
    }
}

impl Runtime {
    pub fn control(&self, job_id: &str) -> Arc<JobControl> {
        let mut m = self.controls.lock().unwrap_or_else(|e| e.into_inner());
        m.entry(job_id.to_string()).or_insert_with(|| Arc::new(JobControl::new(0))).clone()
    }

    fn control_with_grace(&self, job_id: &str, grace_ms: u64) -> Arc<JobControl> {
        let mut m = self.controls.lock().unwrap_or_else(|e| e.into_inner());
        m.entry(job_id.to_string()).or_insert_with(|| Arc::new(JobControl::new(grace_ms))).clone()
    }

    /// Starts an operation on this job's single control. Controls are never dropped while the app
    /// runs, so a save, an image run and a worker always share one send lock and one ownership line.
    fn start(&self, job_id: &str) -> (Arc<JobControl>, Operation) {
        let control = self.control(job_id);
        let op = control.start_operation();
        (control, op)
    }

    pub fn held(&self, job_id: &str) -> bool {
        self.controls.lock().unwrap_or_else(|e| e.into_inner()).get(job_id).map(|c| c.held()).unwrap_or(false)
    }

    fn remaining_ms(&self, job_id: &str, stored: u64) -> u64 {
        self.controls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(job_id)
            .map(|c| c.remaining())
            .unwrap_or(stored)
    }

    pub fn shutdown(&self) {
        self.shutdown.cancel();
        for c in self.controls.lock().unwrap_or_else(|e| e.into_inner()).values() {
            c.cancel_current();
        }
    }

    /// Local recovery happens once, before any operation is accepted; network reconciliation is
    /// scheduled separately so an unreachable Anki cannot block new clicks.
    pub async fn ensure_started(&self, st: &Arc<AppState>) {
        self.ready
            .get_or_init(|| async {
                recover_local(st).await;
            })
            .await;
        if !self.network_started.swap(true, Ordering::SeqCst) {
            let st = st.clone();
            tauri::async_runtime::spawn(async move { reconcile_after_start(&st).await });
        }
    }
}

/// Starts recovery. Called once after `AppState` construction.
pub async fn start(st: Arc<AppState>) {
    st.card_jobs.ensure_started(&st).await;
}

fn recovery_change(row: &JobRow) -> Option<Change> {
    match row.state {
        CardJobState::Resolving => None,
        CardJobState::Committing | CardJobState::Deleting => Some(Change {
            state: Some(CardJobState::Resolving),
            progress: Some(Progress::phase("resolving")),
            ..Default::default()
        }),
        CardJobState::CancelRequested if row.pending_operation.is_some() => Some(Change {
            state: Some(CardJobState::Resolving),
            progress: Some(Progress::phase("resolving")),
            ..Default::default()
        }),
        CardJobState::CancelRequested => Some(Change {
            state: Some(CardJobState::Cancelled),
            note_confirmed: Some(false),
            pending_operation: Some(None),
            warnings: Some(row.warnings.clone()),
            progress: Some(Progress::phase("cancelled")),
            ..Default::default()
        }),
        _ => Some(Change {
            state: Some(CardJobState::Interrupted),
            remaining_ms: Some(0),
            progress: Some(Progress::phase("interrupted")),
            ..Default::default()
        }),
    }
}

/// Local-only restart recovery: reversible work becomes `interrupted`, sent operations become
/// `resolving`, a held editor stays held. No network call and no generation happen here.
pub async fn recover_local_db(db: &Arc<Mutex<Connection>>) -> Result<Vec<JobRow>, String> {
    let db2 = db.clone();
    let ids: Vec<String> = db_task(&db2, |c| {
        let mut q = c.prepare(
            "SELECT id FROM card_job WHERE state IN('grace','queued','drafting','generating','committing','deleting','cancel_requested','resolving')",
        )?;
        let rows = q.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await?;
    let mut out = Vec::new();
    for id in ids {
        let row = load_db(db, &id).await?;
        if let Some(ch) = recovery_change(&row) {
            if let Some(updated) = apply_db(db, &id, row.version, ch).await? {
                out.push(updated);
            }
        } else {
            out.push(row);
        }
    }
    Ok(out)
}

async fn recover_local(st: &Arc<AppState>) {
    match recover_local_db(&st.db).await {
        Ok(rows) => {
            for row in rows {
                emit(st, &row);
            }
        }
        Err(e) => logs::log("app", &format!("cards: recovery failed: {e}")),
    }
}

/// Reconciles jobs whose operation may have reached Anki; an unreachable endpoint leaves them
/// unresolved instead of guessing. Runs off the startup path, one job at a time.
async fn reconcile_after_start(st: &Arc<AppState>) {
    let ids: Vec<String> = match db_task(&st.db, |c| {
        let mut q = c.prepare("SELECT id FROM card_job WHERE state='resolving' OR pending_operation IS NOT NULL ORDER BY created_at,id")?;
        let rows = q.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await
    {
        Ok(v) => v,
        Err(_) => return,
    };
    for id in ids {
        if st.card_jobs.shutdown.is_cancelled() {
            return;
        }
        let Ok(row) = load(st, &id).await else { continue };
        let (control, _op) = st.card_jobs.start(&id);
        let _send = control.send.lock().await;
        let client = connect::Client::new(&st.http, &row.context.anki.url);
        match reconcile_job(&st.db, &client, &id).await {
            Ok(job) => {
                let _ = job;
                if let Ok(row) = load(st, &id).await {
                    emit(st, &row);
                }
            }
            Err(e) => logs::log("app", &format!("cards: reconcile {id} after start: {}", safe(e))),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------

struct CapturedRow {
    start: f64,
    end: f64,
    text: String,
    title: String,
    original_title: Option<String>,
    year: Option<i32>,
    season: Option<u32>,
    episode: Option<u32>,
    episode_title: Option<String>,
    source_url: String,
    next_start: Option<f64>,
    chunk: Option<String>,
}

async fn capture_context(
    st: &Arc<AppState>,
    media_id: &str,
    cue_idx: u32,
    audio_index: u32,
    sub_offset: f64,
) -> Result<JobContext, String> {
    if !sub_offset.is_finite() {
        return Err("Некорректный сдвиг субтитров".into());
    }
    let (mid, ci) = (media_id.to_string(), cue_idx);
    let captured = db_task(&st.db, move |c| {
        let mut r = c
            .query_row(
                "SELECT c.start,c.end,c.text,m.title,m.original_title,m.year,m.season,m.episode,m.episode_title,m.source_url,m.sub_offset \
                 FROM cue c JOIN media m ON m.id=c.media_id WHERE c.media_id=?1 AND c.idx=?2",
                rusqlite::params![mid, ci],
                |r| {
                    Ok(CapturedRow {
                        start: r.get(0)?,
                        end: r.get(1)?,
                        text: r.get(2)?,
                        title: r.get(3)?,
                        original_title: r.get(4)?,
                        year: r.get(5)?,
                        season: r.get(6)?,
                        episode: r.get(7)?,
                        episode_title: r.get(8)?,
                        source_url: r.get(9)?,
                        next_start: None,
                        chunk: None,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| db_payload("Реплика не найдена"))?;
        r.next_start = c
            .query_row("SELECT start FROM cue WHERE media_id=?1 AND idx=?2", rusqlite::params![mid, ci + 1], |x| x.get::<_, f64>(0))
            .optional()?;
        r.chunk = c
            .query_row("SELECT text FROM chunk WHERE media_id=?1 AND cue_idx=?2 ORDER BY start_char LIMIT 1", rusqlite::params![mid, ci], |x| x.get(0))
            .optional()?;
        Ok(r)
    })
    .await?;

    let cfg = st.cfg();
    let session = st.sessions.current().filter(|s| s.media_id == media_id);
    // An index the probe does not know is an error; a probe without audio keeps a partial card.
    if let Some(s) = &session {
        if let Some(p) = s.probe.get() {
            if !p.audio.is_empty() && !p.audio.iter().any(|t| t.index == audio_index) {
                return Err("Выбранная аудиодорожка не найдена в фильме".into());
            }
        }
    }
    // The raw request URL is immutable per session and never carries credential-applied `src`.
    let source_url = session
        .as_ref()
        .map(|s| s.req.url.clone())
        .or_else(|| (!captured.source_url.trim().is_empty()).then(|| captured.source_url.clone()));
    let clip = session.as_ref().and_then(|s| {
        s.probe.get().map(|p| ClipContext {
            source_url: source_url.clone().unwrap_or_default(),
            audio_index,
            video_index: Some(p.video.index),
            hdr: p.video.hdr,
        })
    });
    let episode_title = captured.episode_title.clone().or_else(|| {
        session.as_ref().and_then(|s| {
            captured.episode.and_then(|e| s.req.episodes.iter().find(|x| x.episode == e).and_then(|x| x.name_en.clone().or_else(|| x.name_ru.clone())))
        })
    });
    Ok(JobContext {
        cue_idx,
        media: MediaContext {
            media_id: media_id.to_string(),
            title: captured.title,
            original_title: captured.original_title,
            year: captured.year,
            season: captured.season,
            episode: captured.episode,
            episode_title,
        },
        cue: CapturedCue {
            start: captured.start,
            end: captured.end,
            text: captured.text,
            offset: sub_offset,
            next_start: captured.next_start,
            chunk_fallback: captured.chunk,
        },
        clip,
        source_url,
        audio_index,
        anki: AnkiTarget::of(&cfg.anki),
        image_style: cfg.images.style.clone(),
    })
}

/// Film and cue for a settings preview: no audio validation, no job row.
pub async fn preview_context(st: &Arc<AppState>, media_id: &str, cue_idx: u32) -> Result<(MediaContext, CapturedCue), String> {
    let audio = st
        .sessions
        .current()
        .filter(|s| s.media_id == media_id)
        .and_then(|s| s.probe.get().and_then(|p| p.audio.first().map(|t| t.index)))
        .unwrap_or(0);
    let context = capture_context(st, media_id, cue_idx, audio, 0.0).await?;
    Ok((context.media, context.cue))
}

/// SHA-256 of the complete intent: every input that changes which note this click would create.
fn intent_key(context: &JobContext, span: Option<&str>) -> String {
    let clip = context.clip.as_ref();
    let v = json!([
        context.media.media_id,
        context.cue_idx,
        span,
        context.cue.start,
        context.cue.end,
        context.cue.text,
        context.cue.offset,
        context.source_url.as_deref().or_else(|| clip.map(|c| c.source_url.as_str())),
        context.audio_index,
        clip.map(|c| c.audio_index),
        clip.and_then(|c| c.video_index),
        clip.map(|c| c.hdr),
        context.anki.url,
        context.anki.deck,
        context.anki.note_type,
    ]);
    hex::encode(Sha256::digest(v.to_string().as_bytes()))
}

async fn create(
    st: &Arc<AppState>,
    media_id: String,
    cue_idx: u32,
    span: Option<String>,
    audio_index: u32,
    sub_offset: f64,
    mode: String,
) -> Result<CardJob, String> {
    st.card_jobs.ensure_started(st).await;
    let quick = match mode.as_str() {
        "quick" => true,
        "review" => false,
        _ => return Err("Неизвестный режим создания карточки".into()),
    };
    let span = span.filter(|s| !s.trim().is_empty());
    let context = capture_context(st, &media_id, cue_idx, audio_index, sub_offset).await?;
    let key = quick.then(|| intent_key(&context, span.as_deref()));
    let state = if quick { CardJobState::Grace } else { CardJobState::Editing };
    let remaining = if quick { GRACE_MS } else { 0 };
    let progress = Progress::phase(if quick { "grace" } else { "edit" });
    let id = uuid::Uuid::new_v4().to_string();
    let (db, ctx_json, key2, id2, span2, media2) = (
        st.db.clone(),
        serde_json::to_string(&context).map_err(|e| e.to_string())?,
        key.clone(),
        id.clone(),
        span.clone(),
        media_id.clone(),
    );
    // One transaction-less statement is enough: the partial unique index on intent_key makes the
    // insert-or-existing decision atomic even for two simultaneous clicks.
    let (chosen, inserted) = db_task(&db, move |c| {
        if let Some(k) = &key2 {
            if let Some(existing) = c
                .query_row(
                    "SELECT id FROM card_job WHERE intent_key=?1 AND state NOT IN('cancelled','deleted') ORDER BY created_at DESC LIMIT 1",
                    [k],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                return Ok((existing, false));
            }
        }
        c.execute(
            "INSERT INTO card_job(id,origin,intent_key,media_id,cue_idx,span,state,revision,version,remaining_ms,cancel_requested,\
             context_json,assets_json,progress_json,warnings_json,note_confirmed,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,0,1,?8,0,?9,'{}',?10,'[]',0,?11,?11) ON CONFLICT DO NOTHING",
            rusqlite::params![
                id2,
                if quick { "quick" } else { "review" },
                key2,
                media2,
                cue_idx,
                span2,
                state.as_str(),
                remaining as i64,
                ctx_json,
                serde_json::to_string(&progress).unwrap_or_default(),
                db::now()
            ],
        )?;
        if c.changes() == 1 {
            return Ok((id2, true));
        }
        let existing = match &key2 {
            Some(k) => c
                .query_row(
                    "SELECT id FROM card_job WHERE intent_key=?1 AND state NOT IN('cancelled','deleted') ORDER BY created_at DESC LIMIT 1",
                    [k],
                    |r| r.get::<_, String>(0),
                )
                .optional()?,
            None => None,
        };
        existing.map(|id| (id, false)).ok_or_else(|| db_payload("Карточка не создана"))
    })
    .await?;
    let row = load(st, &chosen).await?;
    if !inserted {
        return Ok(dto_of(st, &row));
    }
    if quick {
        let control = st.card_jobs.control_with_grace(&chosen, GRACE_MS);
        control.set_base_version(row.version);
        spawn_grace(st.clone(), chosen, control);
    }
    Ok(publish(st, &row))
}

// ---------------------------------------------------------------------------------------------
// Grace loop and worker
// ---------------------------------------------------------------------------------------------

fn spawn_grace(st: Arc<AppState>, job_id: String, control: Arc<JobControl>) {
    tauri::async_runtime::spawn(async move {
        let mut last_snapshot = tokio::time::Instant::now();
        let mut last_persist = tokio::time::Instant::now();
        loop {
            tokio::time::sleep(TICK).await;
            if st.card_jobs.shutdown.is_cancelled() || control.grace.lock().unwrap_or_else(|e| e.into_inner()).finished {
                return;
            }
            let now = tokio::time::Instant::now();
            let done = control.tick(now);
            if last_persist.elapsed() >= PERSIST {
                persist_grace(&st, &job_id, &control).await;
                last_persist = now;
            }
            if last_snapshot.elapsed() >= SNAPSHOT {
                emit_delta(&st, &job_id, &control);
                last_snapshot = now;
            }
            if done && expire_grace(&st, &job_id, &control).await {
                return;
            }
        }
    });
}

/// Persists the remaining grace time as a real version. The delta base version follows every
/// committed row, including a skipped write, so a later full row is never out of sync.
async fn persist_grace(st: &Arc<AppState>, job_id: &str, control: &Arc<JobControl>) {
    for _ in 0..3 {
        let Ok(row) = load(st, job_id).await else { return };
        if row.state != CardJobState::Grace {
            control.finish();
            return;
        }
        let remaining = control.remaining();
        if remaining == row.remaining_ms {
            control.set_base_version(row.version);
            return;
        }
        match apply(st, job_id, row.version, Change { remaining_ms: Some(remaining), ..Default::default() }).await {
            Ok(Some(row)) => {
                control.set_base_version(row.version);
                if row.state != CardJobState::Grace {
                    control.finish();
                }
                return;
            }
            Ok(None) => continue,
            Err(_) => return,
        }
    }
}

fn emit_delta(st: &AppState, job_id: &str, control: &Arc<JobControl>) {
    let g = control.grace.lock().unwrap_or_else(|e| e.into_inner());
    if g.finished {
        return;
    }
    let _ = st.app.emit(
        "cards:grace",
        json!({
            "jobId": job_id,
            "version": g.base_version,
            "tick": g.tick,
            "remainingMs": g.remaining_ms,
            "held": !g.holds.is_empty() || g.editing,
        }),
    );
}

/// Moves an expired grace job to `queued` exactly once. Returns whether the grace loop should stop.
async fn expire_grace(st: &Arc<AppState>, job_id: &str, control: &Arc<JobControl>) -> bool {
    if control.held() {
        return false;
    }
    let row = match load(st, job_id).await {
        Ok(row) => row,
        Err(_) => return false,
    };
    if row.state != CardJobState::Grace {
        control.finish();
        return true;
    }
    {
        // Entering queued clears interaction leases: a lost heartbeat cannot hold a ready job.
        let mut g = control.grace.lock().unwrap_or_else(|e| e.into_inner());
        g.holds.clear();
        g.paused = false;
        g.editing = false;
    }
    let change = Change {
        state: Some(CardJobState::Queued),
        remaining_ms: Some(0),
        progress: Some(Progress::phase("queued")),
        ..Default::default()
    };
    match apply(st, job_id, row.version, change).await {
        Ok(Some(_)) => {
            control.finish();
            spawn_worker(st.clone(), job_id.to_string());
            true
        }
        Ok(None) => {
            let fresh = load(st, job_id).await;
            match fresh {
                Ok(r) if r.state == CardJobState::Grace => false,
                _ => {
                    control.finish();
                    true
                }
            }
        }
        Err(_) => false,
    }
}

/// Starts one worker turn with a fresh cancellation token. A superseded worker can no longer
/// finalize the row even if it wakes up later.
pub fn spawn_worker(st: Arc<AppState>, job_id: String) {
    let (control, op) = st.card_jobs.start(&job_id);
    tauri::async_runtime::spawn(async move { run_job(st, job_id, control, op).await });
}

async fn run_job(st: Arc<AppState>, job_id: String, control: Arc<JobControl>, op: Operation) {
    let turn = st.cards_queue.lock().await;
    if !control.is_current(op.generation) || st.card_jobs.shutdown.is_cancelled() {
        return;
    }
    let Ok(row) = load(&st, &job_id).await else { return };
    if row.state != CardJobState::Queued || row.cancel_requested {
        drop(turn);
        return;
    }
    let result = execute(&st, &row, &control, &op.token).await;
    drop(turn);
    if !control.is_current(op.generation) || st.card_jobs.shutdown.is_cancelled() {
        return;
    }
    let latest = load(&st, &job_id).await;
    match result {
        Ok(()) => {
            if let Ok(row) = &latest {
                emit(&st, row);
                if row.state == CardJobState::Added {
                    announce(&st, row).await;
                }
            }
        }
        Err((JobError::Cancelled, _)) => {
            // Cancellation intent is persisted by `cards_job_cancel`, which owns the final
            // transition and any owned-note deletion. A superseded worker does nothing.
        }
        Err((e, last)) => {
            let can_fail = latest.as_ref().is_ok_and(|row| {
                !row.note_confirmed
                    && !matches!(
                        row.state,
                        CardJobState::Resolving
                            | CardJobState::Added
                            | CardJobState::Cancelled
                            | CardJobState::Deleted
                            | CardJobState::Editing
                    )
                    && !row.cancel_requested
            });
            if can_fail {
                let guard = Guard {
                    revision: last.revision,
                    states: FAILABLE_STATES,
                    cancel_requested: Some(false),
                    note_confirmed: Some(false),
                };
                let change = Change {
                    state: Some(CardJobState::Failed),
                    error: Some(Some(safe(e.text()))),
                    progress: Some(Progress::phase("failed")),
                    ..Default::default()
                };
                if let Ok(Some(row)) = apply_guarded(&st, &job_id, guard, change).await {
                    notify_failure(&st, &job_id).await;
                    announce(&st, &row).await;
                }
            }
        }
    }
    control.finish();
    control.notify.notify_waiters();
    refresh_proposal(&st, &job_id).await;
    sync_and_index(&st, &job_id).await;
}

/// Draft, assets and the owned add for one queued job. The last committed row travels with an error
/// so a superseded worker's failure transition is fenced by revision and state.
async fn execute(
    st: &Arc<AppState>,
    row: &JobRow,
    control: &Arc<JobControl>,
    token: &CancellationToken,
) -> Result<(), (JobError, JobRow)> {
    let client = connect::Client::new(&st.http, &row.context.anki.url);
    let mut current = row.clone();

    if current.draft.is_none() {
        current = match transition(st, &current, CardJobState::Drafting, Progress::phase("draft")).await {
            Ok(r) => r,
            Err(e) => return Err((e, current)),
        };
        let media = current.context.media.clone();
        let span = current.span.clone();
        let text = current.context.cue.text.clone();
        let chunk = current.context.cue.chunk_fallback.clone();
        let draft = explain::draft_for_job(st, &media, current.cue_idx, &text, span.as_deref(), chunk.as_deref()).await;
        match draft {
            Ok(d) => match apply(st, &current.id, current.version, Change { draft: Some(Some(d)), ..Default::default() }).await {
                Ok(Some(updated)) => current = updated,
                Ok(None) => return Err((JobError::Conflict(STALE.into()), current)),
                Err(e) => return Err((JobError::Failed(safe(e)), current)),
            },
            Err(e) => return Err((JobError::Failed(safe(e)), current)),
        }
    }
    if token.is_cancelled() || current.cancel_requested {
        return Err((JobError::Cancelled, current));
    }

    current = match transition(st, &current, CardJobState::Generating, Progress::phase("media")).await {
        Ok(r) => r,
        Err(e) => return Err((e, current)),
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (st2, id2, revision2) = (st.clone(), current.id.clone(), current.revision);
    let consumer = tauri::async_runtime::spawn(async move {
        while let Some(phase) = rx.recv().await {
            let Ok(row) = load(&st2, &id2).await else { continue };
            if row.revision != revision2 || !matches!(row.state, CardJobState::Drafting | CardJobState::Generating) {
                continue;
            }
            let next = match phase.strip_prefix("img\t") {
                Some(rest) => {
                    let mut parts = rest.split('\t');
                    let provider = parts.next().unwrap_or("").to_string();
                    let attempt = parts.next().and_then(|n| n.parse::<u32>().ok());
                    Progress { phase: "image".into(), provider: Some(provider), attempt }
                }
                None => Progress::phase(&phase),
            };
            if row.progress == next {
                continue;
            }
            let _ = apply(&st2, &id2, row.version, Change { progress: Some(next), ..Default::default() }).await;
        }
    });
    let Some(draft) = current.draft.as_ref() else {
        return Err((JobError::Failed("Черновик карточки недоступен".into()), current));
    };
    let prepared = cards::prepare(st, &current.context, draft, &current.assets, token, &|phase| {
        let _ = tx.send(phase.to_string());
    })
    .await;
    drop(tx);
    consumer.abort();
    let mut prepared = match prepared {
        Ok(p) => p,
        Err(e) => return Err((e, current)),
    };
    // Provider/ffmpeg/Anki error text is user-visible and may quote a source URL: scrub once here.
    prepared.warnings = prepared.warnings.into_iter().map(|w| safe(w)).collect();
    if token.is_cancelled() {
        return Err((JobError::Cancelled, current));
    }
    // The send is owned: cancellation waits for this lock and then reconciles, never races the add.
    let _send = control.send.lock().await;
    if token.is_cancelled() {
        return Err((JobError::Cancelled, current));
    }
    match commit_prepared(&st.db, &client, &current.id, current.revision, prepared).await {
        Ok(_) => Ok(()),
        Err(e) => Err((JobError::Failed(safe(e)), current)),
    }
}

async fn transition(st: &Arc<AppState>, row: &JobRow, state: CardJobState, progress: Progress) -> Result<JobRow, JobError> {
    match apply(st, &row.id, row.version, Change { state: Some(state), progress: Some(progress), ..Default::default() }).await {
        Ok(Some(updated)) => Ok(updated),
        Ok(None) => Err(JobError::Conflict(STALE.into())),
        Err(e) => Err(JobError::Failed(safe(e))),
    }
}

async fn notify_failure(st: &Arc<AppState>, job_id: &str) {
    let Ok(row) = load(st, job_id).await else { return };
    if let Some(e) = &row.error {
        let _ = crate::notify::push(st, crate::notify::Level::Error, format!("Карточка «{}» не добавлена: {e}", dto_of(st, &row).word));
    }
}

/// Warnings of a finished job are stored as notifications once, after the terminal transition.
async fn announce(st: &Arc<AppState>, row: &JobRow) {
    if row.warnings.is_empty() {
        return;
    }
    let word = dto_of(st, row).word;
    for w in &row.warnings {
        let _ = crate::notify::push(st, crate::notify::Level::Warn, format!("Карточка «{word}»: {w}"));
    }
}

async fn sync_and_index(st: &Arc<AppState>, job_id: &str) {
    let Ok(row) = load(st, job_id).await else { return };
    if row.state != CardJobState::Added {
        return;
    }
    if row.context.anki.sync_after_add {
        let client = connect::Client::new(&st.http, &row.context.anki.url);
        if let Err(e) = client.sync().await {
            logs::log("app", &format!("cards: AnkiWeb sync failed: {}", safe(e.to_string())));
        }
    }
    crate::anki::index::refresh(st).await;
}

// ---------------------------------------------------------------------------------------------
// Commit and reconciliation
// ---------------------------------------------------------------------------------------------

/// Renders fields and sends one owned add. A lost or ambiguous reply is reconciled through the job's
/// marker before anything is retried; the note ID is only ever established from Anki's own answer.
///
/// The row may have moved to a newer version while preparation reported progress, so this helper
/// reloads and fences on `revision` plus the pre-send state instead of a stale row version.
pub async fn commit_prepared(
    db: &Arc<Mutex<Connection>>,
    client: &connect::Client<'_>,
    job_id: &str,
    expected_revision: u64,
    prepared: cards::PreparedCard,
) -> Result<CardJob, String> {
    let row = load_db(db, job_id).await?;
    if row.revision != expected_revision {
        return Err(STALE.into());
    }
    if !matches!(row.state, CardJobState::Generating | CardJobState::Drafting | CardJobState::Queued) {
        return Err(STALE.into());
    }
    if row.cancel_requested {
        return Err("отменено".into());
    }
    let marker = row.marker();
    let mut tags: Vec<String> = row
        .context
        .anki
        .tags
        .replace("{film}", &fields::slug(&row.name()))
        .split_whitespace()
        .map(String::from)
        .collect();
    if !tags.iter().any(|t| t == &marker) {
        tags.push(marker);
    }
    let note = json!({
        "deckName": row.context.anki.deck,
        "modelName": row.context.anki.note_type,
        "fields": prepared.fields.clone(),
        "tags": tags,
        "options": { "allowDuplicate": true },
    });
    let change = Change {
        state: Some(CardJobState::Committing),
        pending_operation: Some(Some("add".into())),
        pending_fields: Some(prepared.fields.clone()),
        owned_fields: Some(prepared.fields.clone()),
        mapping: Some(prepared.mapping.clone()),
        assets: Some(prepared.assets.clone()),
        warnings: Some(prepared.warnings.clone()),
        progress: Some(Progress::phase("committing")),
        error: Some(None),
        ..Default::default()
    };
    let Some(current) = apply_db(db, job_id, row.version, change).await? else {
        let fresh = load_db(db, job_id).await?;
        return if fresh.cancel_requested {
            Err("отменено".into())
        } else {
            Err(STALE.into())
        };
    };
    match client.add_note(note).await {
        Ok(id) => finish_add(db, client, job_id, id).await,
        Err(e) => {
            // Every non-positive answer — transport, timeout, protocol or action — is reconciled
            // before anything is resent. The version round trip inside `reconcile_job` is the
            // quiescence barrier for AnkiConnect's serial request queue.
            let msg = safe(format!("Anki: {e}"));
            logs::log("app", &format!("cards: addNote {job_id}: {msg}"));
            let _ = apply_db(db, job_id, current.version, Change { error: Some(Some(msg.clone())), ..Default::default() }).await;
            match reconcile_job(db, client, job_id).await {
                Ok(job) => Ok(job),
                Err(err) => Err(err),
            }
        }
    }
}

/// Records a positive add answer only after the note is read back and its marker/model/profile are
/// verified. A cancellation that raced the send deletes this exact note and stays unconfirmed.
async fn finish_add(
    db: &Arc<Mutex<Connection>>,
    client: &connect::Client<'_>,
    job_id: &str,
    id: i64,
) -> Result<CardJob, String> {
    for _ in 0..4 {
        let row = load_db(db, job_id).await?;
        if matches!(row.state, CardJobState::Cancelled | CardJobState::Deleted) {
            return Ok(dto_db(&row));
        }
        let note = match note_by_id(client, id).await {
            Ok(Some(note)) => note,
            Ok(None) => {
                let msg = safe(format!("Anki не нашёл добавленную заметку {id}. Повторите попытку."));
                return unresolved(db, &row, msg).await;
            }
            Err(e) => return unresolved(db, &row, safe(format!("Anki не ответил при чтении заметки: {e}. Повторите."))).await,
        };
        if !note.tags.iter().any(|t| t == &row.marker()) {
            let msg = "У добавленной заметки нет метки карточки — проверьте её вручную".to_string();
            return unresolved(db, &row, msg).await;
        }
        if note.model_name != row.context.anki.note_type {
            let msg = safe(format!(
                "Заметка найдена, но её тип «{}» не совпадает с «{}»",
                note.model_name, row.context.anki.note_type
            ));
            return unresolved(db, &row, msg).await;
        }
        if let (Some(expected), Some(actual)) = (&row.note_profile, &note.profile) {
            if expected != actual {
                let msg = "Активный профиль Anki изменился — карточка не подтверждена".to_string();
                return unresolved(db, &row, msg).await;
            }
        }
        if row.cancel_requested {
            // The initial add was cancelled while its reply was lost: delete the single owned ID
            // and only then report cancellation.
            return delete_verified(db, client, &row, &note, CardJobState::Cancelled).await;
        }
        let owned = actual_owned(&row, &note);
        let change = Change {
            state: Some(CardJobState::Added),
            note_id: Some(id),
            note_profile: note.profile.clone(),
            note_confirmed: Some(true),
            owned_fields: Some(owned),
            pending_operation: Some(None),
            pending_fields: Some(BTreeMap::new()),
            progress: Some(Progress::phase("added")),
            error: Some(None),
            ..Default::default()
        };
        if let Some(done) = apply_db(db, job_id, row.version, change).await? {
            return Ok(dto_db(&done));
        }
    }
    Err(STALE.into())
}

async fn note_by_id(client: &connect::Client<'_>, id: i64) -> Result<Option<connect::NoteInfo>, String> {
    let info = client.notes_info(&[id]).await.map_err(|e| safe(format!("Anki: {e}")))?;
    Ok(info.into_iter().find(|n| n.note_id == id))
}

fn actual_owned(row: &JobRow, note: &connect::NoteInfo) -> BTreeMap<String, String> {
    let mapping: Vec<(String, Option<Source>)> = row
        .mapping
        .clone()
        .or_else(|| row.pending_fields.as_ref().map(|p| p.keys().map(|f| (f.clone(), None)).collect::<Vec<_>>()))
        .unwrap_or_default();
    let mut owned: BTreeMap<String, String> = mapping
        .iter()
        .filter_map(|(f, _)| note.fields.get(f).map(|v| (f.clone(), v.value.clone())))
        .collect();
    if owned.is_empty() {
        owned = row.pending_fields.clone().unwrap_or_default();
    }
    owned
}

/// The quiescence barrier and marker lookup. Zero matches after a successful ordered round trip means
/// the previous add did not persist; more than one is unresolved ambiguity and never auto-deleted.
pub async fn reconcile_job(db: &Arc<Mutex<Connection>>, client: &connect::Client<'_>, job_id: &str) -> Result<CardJob, String> {
    for attempt in 0..4 {
        let row = load_db(db, job_id).await?;
        let op = row.pending_operation.clone().or_else(|| match row.state {
            CardJobState::Committing => Some(if row.note_id.is_some() { "update".into() } else { "add".into() }),
            CardJobState::Deleting => Some("delete".into()),
            CardJobState::Resolving => Some(if row.note_id.is_some() { "update".into() } else { "add".into() }),
            _ => None,
        });
        let Some(op) = op else {
            return Ok(dto_db(&row));
        };
        if let Err(e) = client.version().await {
            let msg = safe(format!("Anki не отвечает: {e}. Повторите, когда Anki будет доступен."));
            return Ok(unresolved(db, &row, msg).await?);
        }
        let outcome = if op == "add" {
            reconcile_add(db, client, &row).await?
        } else if op == "update" {
            reconcile_update(db, client, &row).await?
        } else if op.starts_with("delete") {
            reconcile_delete(db, client, &row).await?
        } else {
            return Err(format!("неизвестная операция карточки «{op}»"));
        };
        if let Some(job) = outcome {
            return Ok(job);
        }
        if attempt == 3 {
            return Err(STALE.into());
        }
    }
    Err(STALE.into())
}

async fn reconcile_add(
    db: &Arc<Mutex<Connection>>,
    client: &connect::Client<'_>,
    row: &JobRow,
) -> Result<Option<CardJob>, String> {
    let marker = row.marker();
    let ids = match client.find_notes(&format!("tag:\"{marker}\"")).await {
        Ok(ids) => ids,
        Err(e) => return Ok(Some(unresolved(db, row, safe(format!("Anki: {e}. Повторите."))).await?)),
    };
    match ids.len() {
        0 => {
            if let Some(known) = row.note_id {
                match note_by_id(client, known).await {
                    Ok(Some(note)) => {
                        if row.cancel_requested {
                            return Ok(Some(delete_verified(db, client, row, &note, CardJobState::Cancelled).await?));
                        }
                        return Ok(Some(
                            unresolved(db, row, format!("Заметка {known} существует, но без метки карточки — проверьте её вручную")).await?,
                        ));
                    }
                    Ok(None) => {}
                    Err(e) => {
                        return Ok(Some(unresolved(db, row, safe(format!("Anki не ответил при чтении заметки: {e}. Повторите."))).await?))
                    }
                }
            }
            if row.cancel_requested {
                let change = Change {
                    state: Some(CardJobState::Cancelled),
                    cancel_requested: Some(true),
                    note_confirmed: Some(false),
                    pending_operation: Some(None),
                    pending_fields: Some(BTreeMap::new()),
                    progress: Some(Progress::phase("cancelled")),
                    error: Some(None),
                    ..Default::default()
                };
                Ok(apply_db(db, &row.id, row.version, change).await?.map(|done| dto_db(&done)))
            } else {
                let change = Change {
                    state: Some(CardJobState::Failed),
                    note_confirmed: Some(false),
                    pending_operation: Some(None),
                    pending_fields: Some(BTreeMap::new()),
                    progress: Some(Progress::phase("failed")),
                    error: Some(Some(
                        row.error.clone().unwrap_or_else(|| "Anki не подтвердил добавление — повторите".into()),
                    )),
                    ..Default::default()
                };
                Ok(apply_db(db, &row.id, row.version, change).await?.map(|done| dto_db(&done)))
            }
        }
        1 => {
            let note = match note_by_id(client, ids[0]).await {
                Ok(Some(note)) => note,
                Ok(None) => {
                    return Ok(Some(
                        unresolved(db, row, format!("Anki подтвердил метку, но не отдал заметку {}", ids[0])).await?,
                    ))
                }
                Err(e) => {
                    return Ok(Some(unresolved(db, row, safe(format!("Anki не ответил при чтении заметки: {e}. Повторите."))).await?))
                }
            };
            if !note.tags.iter().any(|t| t == &marker) {
                return Ok(Some(unresolved(db, row, "У найденной заметки нет метки этой карточки".into()).await?));
            }
            if note.model_name != row.context.anki.note_type {
                return Ok(Some(
                    unresolved(
                        db,
                        row,
                        safe(format!(
                            "Заметка найдена, но её тип «{}» не совпадает с «{}»",
                            note.model_name, row.context.anki.note_type
                        )),
                    )
                    .await?,
                ));
            }
            if let (Some(expected), Some(actual)) = (&row.note_profile, &note.profile) {
                if expected != actual {
                    return Ok(Some(unresolved(db, row, "Активный профиль Anki изменился — карточка не подтверждена".into()).await?));
                }
            }
            if row.cancel_requested {
                return Ok(Some(delete_verified(db, client, row, &note, CardJobState::Cancelled).await?));
            }
            let owned = actual_owned(row, &note);
            let change = Change {
                state: Some(CardJobState::Added),
                note_id: Some(note.note_id),
                note_profile: note.profile.clone(),
                note_confirmed: Some(true),
                owned_fields: Some(owned),
                pending_operation: Some(None),
                pending_fields: Some(BTreeMap::new()),
                progress: Some(Progress::phase("added")),
                error: Some(None),
                ..Default::default()
            };
            Ok(apply_db(db, &row.id, row.version, change).await?.map(|done| dto_db(&done)))
        }
        n => Ok(Some(
            unresolved(db, row, format!("В Anki {n} заметки с меткой этой карточки — проверьте её вручную")).await?,
        )),
    }
}

async fn reconcile_update(
    db: &Arc<Mutex<Connection>>,
    client: &connect::Client<'_>,
    row: &JobRow,
) -> Result<Option<CardJob>, String> {
    let Some(id) = row.note_id else {
        return Ok(Some(unresolved(db, row, MISSING_NOTE.into()).await?));
    };
    let missing_msg = safe(format!("Anki не подтвердил сохранение — заметка {id} не читается. Откройте карточку снова."));
    let note = match note_by_id(client, id).await {
        Ok(Some(note)) => note,
        Ok(None) => return Ok(Some(unresolved(db, row, MISSING_NOTE.into()).await?)),
        Err(e) => return Ok(Some(unresolved(db, row, safe(format!("Anki не ответил при чтении заметки: {e}. Повторите."))).await?)),
    };
    if note.model_name != row.context.anki.note_type {
        return Ok(Some(
            unresolved(
                db,
                row,
                safe(format!("Тип заметки в Anki — «{}», а не «{}»", note.model_name, row.context.anki.note_type)),
            )
            .await?,
        ));
    }
    if let (Some(expected), Some(actual)) = (&row.note_profile, &note.profile) {
        if expected != actual {
            return Ok(Some(unresolved(db, row, "Активный профиль Anki изменился — изменения не подтверждены".into()).await?));
        }
    }
    let pending = row.pending_fields.clone().unwrap_or_default();
    let applied = pending.iter().all(|(f, v)| note.fields.get(f).map(|x| &x.value) == Some(v));
    if applied {
        let owned = actual_owned(row, &note);
        let change = Change {
            state: Some(CardJobState::Added),
            note_id: Some(id),
            note_profile: note.profile.clone(),
            note_confirmed: Some(true),
            owned_fields: Some(owned.clone()),
            baseline_fields: Some(owned),
            pending_operation: Some(None),
            pending_fields: Some(BTreeMap::new()),
            progress: Some(Progress::phase("added")),
            error: Some(None),
            ..Default::default()
        };
        Ok(apply_db(db, &row.id, row.version, change).await?.map(|done| dto_db(&done)))
    } else if pending.is_empty() {
        Ok(Some(unresolved(db, row, missing_msg).await?))
    } else {
        // The note exists and the change did not apply: keep the pending patch so an explicit retry
        // can resend this exact update, never a new add.
        let change = Change {
            state: Some(CardJobState::Failed),
            note_id: Some(id),
            note_profile: note.profile.clone(),
            note_confirmed: Some(true),
            pending_operation: Some(Some("update".into())),
            pending_fields: Some(pending),
            progress: Some(Progress::phase("failed")),
            error: Some(Some("Anki не подтвердил сохранение изменений — повторите".into())),
            ..Default::default()
        };
        Ok(apply_db(db, &row.id, row.version, change).await?.map(|done| dto_db(&done)))
    }
}

fn delete_final(row: &JobRow) -> CardJobState {
    match row.pending_operation.as_deref() {
        Some(op) if op.ends_with("cancelled") => CardJobState::Cancelled,
        Some(op) if op.ends_with("deleted") => CardJobState::Deleted,
        _ if row.cancel_requested => CardJobState::Cancelled,
        _ => CardJobState::Deleted,
    }
}

async fn reconcile_delete(
    db: &Arc<Mutex<Connection>>,
    client: &connect::Client<'_>,
    row: &JobRow,
) -> Result<Option<CardJob>, String> {
    let Some(id) = row.note_id else {
        if row.cancel_requested {
            let change = Change {
                state: Some(CardJobState::Cancelled),
                cancel_requested: Some(true),
                note_confirmed: Some(false),
                pending_operation: Some(None),
                pending_fields: Some(BTreeMap::new()),
                progress: Some(Progress::phase("cancelled")),
                error: Some(None),
                ..Default::default()
            };
            return Ok(apply_db(db, &row.id, row.version, change).await?.map(|done| dto_db(&done)));
        }
        return Ok(Some(unresolved(db, row, MISSING_NOTE.into()).await?));
    };
    let final_state = delete_final(row);
    let note = match note_by_id(client, id).await {
        Ok(Some(note)) => note,
        Ok(None) => {
            // Already absent: verify no other note carries this job's marker, then finish.
            return Ok(Some(verify_deleted(db, client, row, id, final_state).await?));
        }
        Err(e) => return Ok(Some(unresolved(db, row, safe(format!("Anki не ответил при удалении: {e}. Повторите."))).await?)),
    };
    if note.model_name != row.context.anki.note_type {
        return Ok(Some(
            unresolved(
                db,
                row,
                safe(format!("Тип заметки в Anki — «{}», а не «{}»", note.model_name, row.context.anki.note_type)),
            )
            .await?,
        ));
    }
    if let (Some(expected), Some(actual)) = (&row.note_profile, &note.profile) {
        if expected != actual {
            return Ok(Some(unresolved(db, row, "Активный профиль Anki изменился — карточку не удаляю".into()).await?));
        }
    }
    if let Err(e) = client.delete_notes(&[id]).await {
        logs::log("app", &format!("cards: deleteNotes {id}: {}", safe(e.to_string())));
    }
    Ok(Some(delete_verified(db, client, row, &note, final_state).await?))
}

/// Deletes one verified owned note and confirms absence before claiming a terminal state.
async fn delete_verified(
    db: &Arc<Mutex<Connection>>,
    client: &connect::Client<'_>,
    row: &JobRow,
    note: &connect::NoteInfo,
    final_state: CardJobState,
) -> Result<CardJob, String> {
    if let Err(e) = client.delete_notes(&[note.note_id]).await {
        logs::log("app", &format!("cards: deleteNotes {}: {}", note.note_id, safe(e.to_string())));
    }
    verify_deleted(db, client, row, note.note_id, final_state).await
}

/// Confirms the owned ID and this job's marker are both absent; any other marker note is ambiguity.
async fn verify_deleted(
    db: &Arc<Mutex<Connection>>,
    client: &connect::Client<'_>,
    row: &JobRow,
    id: i64,
    final_state: CardJobState,
) -> Result<CardJob, String> {
    let left = match client.notes_info(&[id]).await {
        Ok(v) => v,
        Err(e) => return unresolved(db, row, safe(format!("Anki не ответил при удалении: {e}. Повторите."))).await,
    };
    if left.iter().any(|n| n.note_id == id) {
        return unresolved(db, row, "Anki не подтвердил удаление заметки".into()).await;
    }
    let marker = row.marker();
    let marker_left = match client.find_notes(&format!("tag:\"{marker}\"")).await {
        Ok(v) => v,
        Err(e) => return unresolved(db, row, safe(format!("Anki не ответил при удалении: {e}. Повторите."))).await,
    };
    if !marker_left.is_empty() {
        return unresolved(db, row, format!("В Anki остались заметки с меткой этой карточки ({}).", marker_left.len())).await;
    }
    let change = Change {
        state: Some(final_state),
        cancel_requested: Some(final_state == CardJobState::Cancelled),
        note_confirmed: Some(false),
        pending_operation: Some(None),
        pending_fields: Some(BTreeMap::new()),
        progress: Some(Progress::phase(final_state.as_str())),
        error: Some(None),
        ..Default::default()
    };
    match apply_db(db, &row.id, row.version, change).await? {
        Some(done) => Ok(dto_db(&done)),
        None => {
            let fresh = load_db(db, &row.id).await?;
            Ok(dto_db(&fresh))
        }
    }
}

async fn unresolved(db: &Arc<Mutex<Connection>>, row: &JobRow, error: String) -> Result<CardJob, String> {
    let change = Change {
        state: Some(CardJobState::Resolving),
        error: Some(Some(safe(error))),
        progress: Some(Progress::phase("resolving")),
        ..Default::default()
    };
    match apply_db(db, &row.id, row.version, change).await? {
        Some(done) => Ok(dto_db(&done)),
        None => {
            let fresh = load_db(db, &row.id).await?;
            Ok(dto_db(&fresh))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

/// A page of jobs and all still-active jobs on the first page. An invalid cursor is an explicit
/// error, never a silent jump to the beginning.
pub async fn page_db(
    db: &Arc<Mutex<Connection>>,
    cursor: Option<JobCursor>,
) -> Result<(Vec<JobRow>, Vec<JobRow>, Option<JobCursor>), String> {
    let cur = cursor.clone();
    db_task(db, move |c| {
        if let Some(cur) = &cur {
            if cur.created_at <= 0 || cur.id.trim().is_empty() {
                return Err(db_payload("Неверный курсор списка карточек"));
            }
            let exists = c
                .query_row("SELECT 1 FROM card_job WHERE id=?1 AND created_at=?2", rusqlite::params![cur.id, cur.created_at], |_| Ok(()))
                .optional()?
                .is_some();
            if !exists {
                return Err(db_payload("Неверный курсор списка карточек"));
            }
        }
        let mut items: Vec<JobRow> = Vec::new();
        match &cur {
            Some(cur) => {
                let mut q = c.prepare(&format!(
                    "SELECT {COLUMNS} FROM card_job WHERE (created_at < ?1) OR (created_at = ?1 AND id < ?2) ORDER BY created_at DESC, id DESC LIMIT {}",
                    PAGE + 1
                ))?;
                let mapped = q.query_map(rusqlite::params![cur.created_at, cur.id], raw_row)?;
                for r in mapped {
                    items.push(r?.parse().map_err(db_payload)?);
                }
            }
            None => {
                let mut q = c.prepare(&format!("SELECT {COLUMNS} FROM card_job ORDER BY created_at DESC, id DESC LIMIT {}", PAGE + 1))?;
                let mapped = q.query_map([], raw_row)?;
                for r in mapped {
                    items.push(r?.parse().map_err(db_payload)?);
                }
            }
        }
        let active: Vec<JobRow> = if cur.is_none() {
            let mut q = c.prepare(&format!(
                "SELECT {COLUMNS} FROM card_job WHERE state IN({ACTIVE_STATES}) ORDER BY created_at DESC, id DESC"
            ))?;
            let mapped = q.query_map([], raw_row)?;
            let mut v = Vec::new();
            for r in mapped {
                v.push(r?.parse().map_err(db_payload)?);
            }
            v
        } else {
            Vec::new()
        };
        let next_cursor = if items.len() > PAGE {
            items.truncate(PAGE);
            items.last().map(|r| JobCursor { created_at: r.created_at, id: r.id.clone() })
        } else {
            None
        };
        Ok((items, active, next_cursor))
    })
    .await
}

pub async fn cards_jobs(st: &Arc<AppState>, cursor: Option<JobCursor>) -> Result<CardJobPage, String> {
    st.card_jobs.ensure_started(st).await;
    let (items, active, next_cursor) = page_db(&st.db, cursor).await?;
    Ok(CardJobPage {
        items: items.iter().map(|r| dto_of(st, r)).collect(),
        active_jobs: active.iter().map(|r| dto_of(st, r)).collect(),
        next_cursor,
    })
}

pub async fn cards_job_get(st: &Arc<AppState>, job_id: String) -> Result<CardJob, String> {
    st.card_jobs.ensure_started(st).await;
    let row = load(st, &job_id).await?;
    Ok(dto_of(st, &row))
}

/// `quick` starts the five-second grace; `review` opens a held editor immediately.
pub async fn cards_job_create(
    st: &Arc<AppState>,
    media_id: String,
    cue_idx: u32,
    span: Option<String>,
    audio_index: u32,
    sub_offset: f64,
    mode: String,
) -> Result<CardJob, String> {
    create(st, media_id, cue_idx, span, audio_index, sub_offset, mode).await
}

/// A hold or lease renewal in `grace`; later states are an idempotent no-op.
pub async fn cards_job_hold(st: &Arc<AppState>, job_id: String, client_id: String, held: bool) -> Result<CardJob, String> {
    st.card_jobs.ensure_started(st).await;
    let row = load(st, &job_id).await?;
    if row.state != CardJobState::Grace {
        return Ok(dto_of(st, &row));
    }
    if client_id.trim().is_empty() {
        return Err("Не указан клиент удержания".into());
    }
    let control = st.card_jobs.control_with_grace(&job_id, row.remaining_ms);
    if !control.hold(&client_id, held, tokio::time::Instant::now()) {
        return Ok(dto_of(st, &row));
    }
    let remaining = control.remaining();
    match apply(st, &job_id, row.version, Change { remaining_ms: Some(remaining), ..Default::default() }).await? {
        Some(r) => {
            control.set_base_version(r.version);
            Ok(dto_of(st, &r))
        }
        None => {
            let row = load(st, &job_id).await?;
            control.set_base_version(row.version);
            Ok(dto_of(st, &row))
        }
    }
}

/// Cancels reversible work or undoes a just-confirmed initial add; never deletes an established,
/// edited note. A send already in flight is awaited, then reconciled.
pub async fn cards_job_cancel(st: &Arc<AppState>, job_id: String, revision: u64) -> Result<CardJob, String> {
    st.card_jobs.ensure_started(st).await;
    let control = st.card_jobs.control(&job_id);
    let result = cancel_inner(st, &job_id, revision, &control).await;
    if let Ok(job) = &result {
        refresh_proposal(st, &job_id).await;
        if job.note_id.is_some() && matches!(job.state, CardJobState::Cancelled | CardJobState::Deleted) {
            crate::anki::index::refresh(st).await;
        }
    }
    result
}

async fn cancel_inner(st: &Arc<AppState>, job_id: &str, revision: u64, control: &Arc<JobControl>) -> Result<CardJob, String> {
    let mut row = load(st, job_id).await?;
    if row.revision != revision {
        return Err(STALE.into());
    }
    if matches!(row.state, CardJobState::Cancelled | CardJobState::Deleted) {
        return Ok(dto_of(st, &row));
    }
    if row.note_confirmed {
        if row.baseline_fields.is_some() || row.state == CardJobState::Editing {
            return Err(ESTABLISHED.into());
        }
        if !matches!(row.state, CardJobState::Added) {
            return Err(OPERATION_RUNNING.into());
        }
        let _send = control.send.lock().await;
        row = load(st, job_id).await?;
        if matches!(row.state, CardJobState::Cancelled | CardJobState::Deleted) {
            return Ok(dto_of(st, &row));
        }
        if row.note_confirmed && row.baseline_fields.is_none() && row.state == CardJobState::Added {
            let job = remove_note(st, &row, CardJobState::Cancelled).await?;
            control.finish();
            return Ok(job);
        }
        return Err(ESTABLISHED.into());
    }
    // Persist the intent before interrupting reversible work, so an add racing this call can see it.
    let mut intent_row = None;
    let mut intent_version = row.version;
    for _ in 0..3 {
        match apply(
            st,
            job_id,
            intent_version,
            Change {
                state: Some(CardJobState::CancelRequested),
                cancel_requested: Some(true),
                progress: Some(Progress::phase("cancel_requested")),
                ..Default::default()
            },
        )
        .await?
        {
            Some(r) => {
                intent_row = Some(r);
                break;
            }
            None => {
                let fresh = load(st, job_id).await?;
                if fresh.cancel_requested || fresh.state.terminal() {
                    intent_row = Some(fresh);
                    break;
                }
                if fresh.revision != revision {
                    return Err(STALE.into());
                }
                intent_version = fresh.version;
            }
        }
    }
    let Some(intent) = intent_row else { return Err(STALE.into()) };
    row = intent;
    // The intent is durable; now the worker's reversible preparation loses ownership.
    let (control, _op) = st.card_jobs.start(job_id);
    if row.note_confirmed {
        // The add completed between our first load and the intent write.
        let _send = control.send.lock().await;
        row = load(st, job_id).await?;
        if row.note_confirmed && row.baseline_fields.is_none() && row.state == CardJobState::Added {
            let job = remove_note(st, &row, CardJobState::Cancelled).await?;
            control.finish();
            return Ok(job);
        }
        if !row.note_confirmed && matches!(row.state, CardJobState::Cancelled | CardJobState::Deleted) {
            return Ok(dto_of(st, &row));
        }
        return Err(ESTABLISHED.into());
    }
    let _send = control.send.lock().await;
    row = load(st, job_id).await?;
    if matches!(row.state, CardJobState::Cancelled | CardJobState::Deleted) {
        control.finish();
        return Ok(dto_of(st, &row));
    }
    if row.note_confirmed {
        if row.baseline_fields.is_none() && row.state == CardJobState::Added {
            let job = remove_note(st, &row, CardJobState::Cancelled).await?;
            control.finish();
            return Ok(job);
        }
        return Err(ESTABLISHED.into());
    }
    if row.pending_operation.is_some() || matches!(row.state, CardJobState::Committing | CardJobState::Deleting) {
        let client = connect::Client::new(&st.http, &row.context.anki.url);
        let job = reconcile_job(&st.db, &client, job_id).await?;
        if let Ok(done) = load(st, job_id).await {
            emit(st, &done);
        }
        control.finish();
        return Ok(job);
    }
    let job = finalize_cancel(st, &row).await?;
    control.finish();
    Ok(job)
}

async fn finalize_cancel(st: &Arc<AppState>, row: &JobRow) -> Result<CardJob, String> {
    let change = Change {
        state: Some(CardJobState::Cancelled),
        cancel_requested: Some(true),
        note_confirmed: Some(false),
        pending_operation: Some(None),
        pending_fields: Some(BTreeMap::new()),
        progress: Some(Progress::phase("cancelled")),
        error: Some(None),
        ..Default::default()
    };
    // A progress write may advance the version without changing the work: the state/revision guard
    // is the real permission, so an old consumer cannot strand a cancelled row.
    for _ in 0..3 {
        let guard = Guard {
            revision: row.revision,
            states: CANCELABLE_STATES,
            cancel_requested: Some(true),
            note_confirmed: Some(false),
        };
        if let Some(done) = apply_guarded(st, &row.id, guard, change.clone()).await? {
            announce(st, &done).await;
            return Ok(dto_of(st, &done));
        }
        let fresh = load(st, &row.id).await?;
        if fresh.state == CardJobState::Cancelled || fresh.state == CardJobState::Deleted {
            return Ok(dto_of(st, &fresh));
        }
        if fresh.note_confirmed || !fresh.cancel_requested {
            return Ok(dto_of(st, &fresh));
        }
    }
    let fresh = load(st, &row.id).await?;
    Ok(dto_of(st, &fresh))
}

/// Deletes the job's established note and confirms its absence.
async fn remove_note(st: &Arc<AppState>, row: &JobRow, final_state: CardJobState) -> Result<CardJob, String> {
    let client = connect::Client::new(&st.http, &row.context.anki.url);
    let job = delete_owned_note(&st.db, &client, &row.id, final_state).await?;
    if let Ok(done) = load(st, &row.id).await {
        emit(st, &done);
    }
    Ok(job)
}

/// Deletes exactly the note this job owns and confirms its absence. Shared by cancel-as-undo and the
/// explicit delete action; it never matches notes by word or by another job's marker.
///
/// The caller acquires the per-job send lock; this helper is the AppHandle-free seam used by tests.
pub async fn delete_owned_note(
    db: &Arc<Mutex<Connection>>,
    client: &connect::Client<'_>,
    job_id: &str,
    final_state: CardJobState,
) -> Result<CardJob, String> {
    if !matches!(final_state, CardJobState::Cancelled | CardJobState::Deleted) {
        return Err("неверное конечное состояние удаления".into());
    }
    let row = load_db(db, job_id).await?;
    if row.state == final_state {
        return Ok(dto_db(&row));
    }
    let Some(id) = row.note_id else {
        return Err(MISSING_NOTE.into());
    };
    let op = format!("delete:{}", final_state.as_str());
    let Some(current) = apply_db(
        db,
        job_id,
        row.version,
        Change {
            state: Some(CardJobState::Deleting),
            pending_operation: Some(Some(op)),
            cancel_requested: Some(final_state == CardJobState::Cancelled),
            progress: Some(Progress::phase("deleting")),
            ..Default::default()
        },
    )
    .await?
    else {
        return Err(STALE.into());
    };
    let note = match note_by_id(client, id).await {
        Ok(Some(note)) => note,
        Ok(None) => {
            // Already missing: the owned ID is absent. Confirm the marker too before finishing.
            return verify_deleted(db, client, &current, id, final_state).await;
        }
        Err(e) => return unresolved(db, &current, safe(format!("Anki не ответил при удалении: {e}. Повторите."))).await,
    };
    if note.model_name != current.context.anki.note_type {
        return unresolved(
            db,
            &current,
            safe(format!("Тип заметки в Anki — «{}», а не «{}»", note.model_name, current.context.anki.note_type)),
        )
        .await;
    }
    if let (Some(expected), Some(actual)) = (&current.note_profile, &note.profile) {
        if expected != actual {
            return unresolved(db, &current, "Активный профиль Anki изменился — карточку не удаляю. Переключитесь на прежний профиль.".into()).await;
        }
    }
    delete_verified(db, client, &current, &note, final_state).await
}

pub async fn cards_job_delete(st: &Arc<AppState>, job_id: String) -> Result<CardJob, String> {
    st.card_jobs.ensure_started(st).await;
    let control = st.card_jobs.control(&job_id);
    let result = delete_inner(st, &job_id, &control).await;
    if let Ok(job) = &result {
        refresh_proposal(st, &job_id).await;
        if job.note_id.is_some() && matches!(job.state, CardJobState::Deleted | CardJobState::Cancelled) {
            crate::anki::index::refresh(st).await;
        }
    }
    result
}

async fn delete_inner(st: &Arc<AppState>, job_id: &str, control: &Arc<JobControl>) -> Result<CardJob, String> {
    let mut row = load(st, job_id).await?;
    if row.state == CardJobState::Deleted {
        return Ok(dto_of(st, &row));
    }
    if row.state == CardJobState::Cancelled {
        return Ok(dto_of(st, &row));
    }
    let _send = control.send.lock().await;
    row = load(st, job_id).await?;
    if row.state == CardJobState::Deleted || row.state == CardJobState::Cancelled {
        return Ok(dto_of(st, &row));
    }
    if row.pending_operation.is_some() || matches!(row.state, CardJobState::Committing | CardJobState::Deleting | CardJobState::Resolving) {
        let client = connect::Client::new(&st.http, &row.context.anki.url);
        let job = reconcile_job(&st.db, &client, job_id).await?;
        emit(st, &load(st, job_id).await?);
        row = load(st, job_id).await?;
        if row.state == CardJobState::Deleted || row.state == CardJobState::Cancelled {
            return Ok(job);
        }
        if row.state == CardJobState::Resolving {
            return Err(job.error.unwrap_or_else(|| "Anki не подтвердил операцию".into()));
        }
    }
    if !row.note_confirmed || row.note_id.is_none() {
        return Err("Заметки этой карточки нет в Anki".into());
    }
    let job = remove_note(st, &row, CardJobState::Deleted).await?;
    control.finish();
    Ok(job)
}

pub async fn cards_job_retry(st: &Arc<AppState>, job_id: String) -> Result<CardJob, String> {
    st.card_jobs.ensure_started(st).await;
    let control = st.card_jobs.control(&job_id);
    let result = retry_inner(st, &job_id, &control).await;
    if result.is_ok() {
        refresh_proposal(st, &job_id).await;
    }
    result
}

async fn retry_inner(st: &Arc<AppState>, job_id: &str, control: &Arc<JobControl>) -> Result<CardJob, String> {
    let mut row = load(st, job_id).await?;
    if row.state == CardJobState::Added && row.pending_operation.is_none() {
        return Ok(dto_of(st, &row));
    }
    if matches!(row.state, CardJobState::Cancelled | CardJobState::Deleted) {
        return Err("Карточка отменена — создайте её заново".into());
    }
    if row.state == CardJobState::CancelRequested && row.pending_operation.is_none() && !row.note_confirmed {
        let job = finalize_cancel(st, &row).await?;
        control.finish();
        return Ok(job);
    }
    if row.pending_operation.is_some() || matches!(row.state, CardJobState::Committing | CardJobState::Resolving | CardJobState::Deleting) {
        let _send = control.send.lock().await;
        row = load(st, job_id).await?;
        if row.pending_operation.is_none() && row.state == CardJobState::Added {
            return Ok(dto_of(st, &row));
        }
        let reconciled = {
            let client = connect::Client::new(&st.http, &row.context.anki.url);
            reconcile_job(&st.db, &client, job_id).await?
        };
        if let Ok(done) = load(st, job_id).await {
            emit(st, &done);
        }
        row = load(st, job_id).await?;
        let client = connect::Client::new(&st.http, &row.context.anki.url);
        match row.pending_operation.as_deref() {
            Some("update") => {
                let job = update_owned_note(&st.db, &client, job_id).await?;
                if let Ok(done) = load(st, job_id).await {
                    emit(st, &done);
                }
                control.finish();
                return Ok(job);
            }
            Some(op) if op.starts_with("delete") => {
                let final_state = delete_final(&row);
                let job = delete_owned_note(&st.db, &client, job_id, final_state).await?;
                if let Ok(done) = load(st, job_id).await {
                    emit(st, &done);
                }
                crate::anki::index::refresh(st).await;
                control.finish();
                return Ok(job);
            }
            Some(_) => {
                return Err(reconciled.error.unwrap_or_else(|| "Anki не подтвердил операцию".into()));
            }
            None => {}
        }
        if row.state == CardJobState::Added {
            return Ok(dto_of(st, &row));
        }
        if matches!(row.state, CardJobState::Deleted | CardJobState::Cancelled) {
            return Ok(dto_of(st, &row));
        }
        if row.state == CardJobState::Resolving {
            return Err(row.error.unwrap_or_else(|| "Anki не подтвердил операцию".into()));
        }
    }
    if !matches!(row.state, CardJobState::Failed | CardJobState::Interrupted) {
        return Err("Карточка ещё выполняется".into());
    }
    if row.note_confirmed {
        return Err("Заметка уже в Anki — откройте её для изменений".into());
    }
    let change = Change {
        state: Some(CardJobState::Queued),
        remaining_ms: Some(0),
        cancel_requested: Some(false),
        error: Some(None),
        warnings: Some(Vec::new()),
        progress: Some(Progress::phase("queued")),
        revision: Some(row.revision + 1),
        ..Default::default()
    };
    let Some(done) = apply(st, job_id, row.version, change).await? else { return Err(STALE.into()) };
    if let Some(pid) = done.proposal_id {
        st.card_jobs.reported.lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
    }
    control.finish();
    spawn_worker(st.clone(), job_id.to_string());
    Ok(publish(st, &done))
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

pub async fn cards_job_edit(st: &Arc<AppState>, job_id: String, refresh: bool) -> Result<CardJobEditor, String> {
    st.card_jobs.ensure_started(st).await;
    let control = st.card_jobs.control(&job_id);
    edit_inner(st, &job_id, refresh, &control).await
}

async fn edit_inner(st: &Arc<AppState>, job_id: &str, refresh: bool, control: &Arc<JobControl>) -> Result<CardJobEditor, String> {
    let mut row = load(st, job_id).await?;
    if row.pending_operation.is_some()
        || matches!(row.state, CardJobState::Committing | CardJobState::Resolving | CardJobState::Deleting | CardJobState::CancelRequested)
    {
        let _send = control.send.lock().await;
        row = load(st, job_id).await?;
        if row.pending_operation.is_some()
            || matches!(row.state, CardJobState::Committing | CardJobState::Resolving | CardJobState::Deleting | CardJobState::CancelRequested)
        {
            let client = connect::Client::new(&st.http, &row.context.anki.url);
            let job = reconcile_job(&st.db, &client, job_id).await?;
            if let Ok(done) = load(st, job_id).await {
                emit(st, &done);
            }
            if matches!(job.state, CardJobState::Cancelled | CardJobState::Deleted) {
                return Err("Карточка отменена — создайте её заново".into());
            }
            if job.state == CardJobState::Resolving {
                return Err(job.error.unwrap_or_else(|| OPERATION_RUNNING.into()));
            }
            row = load(st, job_id).await?;
        }
    }
    if row.state == CardJobState::Editing {
        if refresh && row.note_confirmed {
            row = reload_baseline(st, &row).await?;
        }
    } else if row.note_confirmed {
        row = reload_baseline(st, &row).await?;
        // Entering edit on an established note advances the revision: a stale original-add Cancel
        // can no longer delete the note the user is editing.
        let Some(updated) = apply(
            st,
            job_id,
            row.version,
            Change {
                state: Some(CardJobState::Editing),
                revision: Some(row.revision + 1),
                progress: Some(Progress::phase("edit")),
                ..Default::default()
            },
        )
        .await?
        else {
            return Err(STALE.into());
        };
        row = updated;
        control.set_editing(true);
    } else if matches!(
        row.state,
        CardJobState::Grace
            | CardJobState::Queued
            | CardJobState::Drafting
            | CardJobState::Generating
            | CardJobState::Failed
            | CardJobState::Interrupted
    ) {
        let Some(updated) = apply(
            st,
            job_id,
            row.version,
            Change {
                state: Some(CardJobState::Editing),
                remaining_ms: Some(0),
                revision: Some(row.revision + 1),
                progress: Some(Progress::phase("edit")),
                ..Default::default()
            },
        )
        .await?
        else {
            return Err(STALE.into());
        };
        row = updated;
        // The row now belongs to the editor; a worker that was preparing loses ownership and its
        // commit is fenced by the state/revision, so cancelling its token is safe.
        control.start_operation();
        control.finish();
        control.set_editing(true);
    } else if matches!(row.state, CardJobState::Cancelled | CardJobState::Deleted) {
        return Err("Карточка отменена — создайте её заново".into());
    } else if row.state != CardJobState::Editing {
        return Err("Карточку сейчас нельзя редактировать".into());
    }
    if refresh && !row.note_confirmed && row.draft.is_none() {
        let started = st.card_jobs.drafts.lock().unwrap_or_else(|e| e.into_inner()).insert(job_id.to_string());
        if started {
            spawn_draft(st.clone(), job_id.to_string());
        }
    }
    editor(st, &row).await
}

/// Reads the actual mapped fields and stores them as the conflict baseline. Called only by explicit
/// refresh/open, never by a background refetch.
async fn reload_baseline(st: &Arc<AppState>, row: &JobRow) -> Result<JobRow, String> {
    let Some(id) = row.note_id else { return Err(MISSING_NOTE.into()) };
    let client = connect::Client::new(&st.http, &row.context.anki.url);
    let note = note_by_id(&client, id).await?.ok_or_else(|| MISSING_NOTE.to_string())?;
    if note.model_name != row.context.anki.note_type {
        return Err(format!("Тип заметки в Anki — «{}», а не «{}»", note.model_name, row.context.anki.note_type));
    }
    if let (Some(expected), Some(actual)) = (&row.note_profile, &note.profile) {
        if expected != actual {
            return Err("Активный профиль Anki изменился — откройте карточку в прежнем профиле.".into());
        }
    }
    let mapping = effective_mapping(row, &note);
    let baseline: BTreeMap<String, String> = mapping
        .iter()
        .map(|(f, _)| (f.clone(), note.fields.get(f).map(|v| v.value.clone()).unwrap_or_default()))
        .collect();
    let change = Change {
        mapping: Some(mapping),
        baseline_fields: Some(baseline),
        note_profile: note.profile.clone(),
        ..Default::default()
    };
    match apply(st, &row.id, row.version, change).await? {
        Some(r) => Ok(r),
        None => Err(STALE.into()),
    }
}

fn effective_mapping(row: &JobRow, note: &connect::NoteInfo) -> Vec<(String, Option<Source>)> {
    match &row.mapping {
        Some(m) if !m.is_empty() => m.clone(),
        _ => {
            let mut fields: Vec<(String, i64)> = note.fields.iter().map(|(k, f)| (k.clone(), f.order)).collect();
            fields.sort_by_key(|(_, order)| *order);
            let names: Vec<String> = fields.into_iter().map(|(k, _)| k).collect();
            fields::resolve(&names, &row.context.anki.fields)
        }
    }
}

fn spawn_draft(st: Arc<AppState>, job_id: String) {
    tauri::async_runtime::spawn(async move {
        let Ok(row) = load(&st, &job_id).await else {
            st.card_jobs.drafts.lock().unwrap_or_else(|e| e.into_inner()).remove(&job_id);
            return;
        };
        if row.state != CardJobState::Editing || row.draft.is_some() {
            st.card_jobs.drafts.lock().unwrap_or_else(|e| e.into_inner()).remove(&job_id);
            return;
        }
        let media = row.context.media.clone();
        let span = row.span.clone();
        let text = row.context.cue.text.clone();
        let chunk = row.context.cue.chunk_fallback.clone();
        let draft = explain::draft_for_job(&st, &media, row.cue_idx, &text, span.as_deref(), chunk.as_deref()).await;
        st.card_jobs.drafts.lock().unwrap_or_else(|e| e.into_inner()).remove(&job_id);
        let Ok(current) = load(&st, &job_id).await else { return };
        if current.state != CardJobState::Editing || current.revision != row.revision || current.draft.is_some() {
            return;
        }
        let change = match draft {
            Ok(d) => Change { draft: Some(Some(d)), error: Some(None), ..Default::default() },
            Err(e) => Change { error: Some(Some(safe(format!("Черновик не готов: {e}")))), ..Default::default() },
        };
        let _ = apply(&st, &job_id, current.version, change).await;
    });
}

/// The editor snapshot: actual fields plus the selected assets for an added note, or the captured
/// draft and selected assets for an unsaved one. Never generates and never reads another route.
async fn editor(st: &Arc<AppState>, row: &JobRow) -> Result<CardJobEditor, String> {
    let client = connect::Client::new(&st.http, &row.context.anki.url);
    let job = dto_of(st, row);
    if row.note_confirmed {
        let Some(id) = row.note_id else {
            return Ok(CardJobEditor { job, preview: None, field_values: None, baseline_fields: row.baseline_fields.clone() });
        };
        let Some(mut note) = note_by_id(&client, id).await? else {
            return Err(MISSING_NOTE.into());
        };
        let mapping = effective_mapping(row, &note);
        overlay_selected_assets(row, &mapping, &mut note);
        let field_values: BTreeMap<String, String> = mapping
            .iter()
            .map(|(f, _)| (f.clone(), note.fields.get(f).map(|v| v.value.clone()).unwrap_or_default()))
            .collect();
        let preview = preview::build_actual(&client, &anki_target(&row.context.anki), &note, &mapping).await.ok();
        return Ok(CardJobEditor { job, preview, field_values: Some(field_values), baseline_fields: row.baseline_fields.clone() });
    }
    let preview = match &row.draft {
        Some(draft) => preview::build_job(st, &row.context, draft, &row.assets).await.ok(),
        None => None,
    };
    Ok(CardJobEditor { job, preview, field_values: None, baseline_fields: row.baseline_fields.clone() })
}

fn anki_target(t: &AnkiTarget) -> config::Anki {
    config::Anki {
        url: t.url.clone(),
        deck: t.deck.clone(),
        note_type: t.note_type.clone(),
        fields: t.fields.clone(),
        tags: t.tags.clone(),
        tts: t.tts,
        tts_voice: t.tts_voice.clone(),
        sentence_audio: t.sentence_audio.clone(),
        clip: t.clip,
        sync_after_add: t.sync_after_add,
        ..Default::default()
    }
}

/// Replaces media field values of a cloned actual note with the selected job assets, so the preview
/// shows the picture/audio/clip this job would submit rather than an older field value.
fn overlay_selected_assets(row: &JobRow, mapping: &[(String, Option<Source>)], note: &mut connect::NoteInfo) {
    let Some(draft) = row.draft.as_ref() else { return };
    let values = cards::render_values(&row.context, draft, &row.assets);
    for (field, source) in mapping {
        let Some(source) = source else { continue };
        if !is_media(*source) {
            continue;
        }
        if let Some(slot) = asset_for(&row.assets, *source) {
            if slot.status == "ready" {
                if *source == Source::Image {
                    // A freshly generated picture may not be uploaded yet: preview the selected
                    // revision-bound cache file itself, never a different route's cache entry.
                    if let Some(path) = slot.cache_path.as_deref().filter(|p| Path::new(p).is_file()) {
                        if let Ok(url) = images::data_url(Path::new(path)) {
                            let order = note.fields.get(field).map(|f| f.order).unwrap_or(i64::MAX);
                            let value = format!("<img src=\"{url}\">");
                            note.fields.insert(field.clone(), connect::NoteInfoField { value, order });
                            continue;
                        }
                    }
                }
                let rendered = values.value(*source);
                if !rendered.is_empty() {
                    let order = note.fields.get(field).map(|f| f.order).unwrap_or(i64::MAX);
                    note.fields.insert(field.clone(), connect::NoteInfoField { value: rendered, order });
                }
            }
        }
    }
}

fn is_media(source: Source) -> bool {
    matches!(source, Source::Image | Source::WordAudio | Source::SentenceAudio | Source::Clip)
}

fn asset_for<'a>(assets: &'a JobAssets, source: Source) -> Option<&'a AssetSlot> {
    match source {
        Source::Image => assets.image.as_ref(),
        Source::WordAudio => assets.word_audio.as_ref(),
        Source::SentenceAudio => assets.sentence_audio.as_ref(),
        Source::Clip => assets.clip.as_ref(),
        _ => None,
    }
}

/// Read-only preview for the editor's current revision. `field_values` are the local owned text
/// values; they replace the actual note's mapped text fields without touching Anki or the baseline.
pub async fn cards_job_preview(
    st: &Arc<AppState>,
    job_id: String,
    revision: u64,
    draft: WordDraft,
    field_values: Option<BTreeMap<String, String>>,
) -> Result<preview::CardPreview, String> {
    st.card_jobs.ensure_started(st).await;
    let row = load(st, &job_id).await?;
    if row.revision != revision {
        return Err(STALE.into());
    }
    let client = connect::Client::new(&st.http, &row.context.anki.url);
    if row.note_confirmed {
        let Some(id) = row.note_id else { return Err(MISSING_NOTE.into()) };
        let Some(mut note) = note_by_id(&client, id).await? else { return Err(MISSING_NOTE.into()) };
        let mapping = effective_mapping(&row, &note);
        if let Some(values) = &field_values {
            for (field, source) in &mapping {
                let Some(source) = source else { continue };
                if is_media(*source) {
                    continue;
                }
                if let Some(value) = values.get(field) {
                    let order = note.fields.get(field).map(|f| f.order).unwrap_or(i64::MAX);
                    note.fields.insert(field.clone(), connect::NoteInfoField { value: value.clone(), order });
                }
            }
        }
        overlay_selected_assets(&row, &mapping, &mut note);
        return preview::build_actual(&client, &anki_target(&row.context.anki), &note, &mapping).await;
    }
    preview::build_job(st, &row.context, &draft, &row.assets).await
}

/// Explicit image retry/change: the prompt and revision are persisted first, and only an asset for
/// that exact revision is accepted. This never submits the card.
pub async fn cards_job_image(st: &Arc<AppState>, job_id: String, revision: u64, prompt: String) -> Result<CardJobEditor, String> {
    st.card_jobs.ensure_started(st).await;
    // Validate before taking ownership: an image call on a working job must not strand its worker.
    let pre = load(st, &job_id).await?;
    if pre.revision != revision {
        return Err(STALE.into());
    }
    if pre.state != CardJobState::Editing {
        return Err("Картинку можно менять только в редакторе".into());
    }
    let (control, op) = st.card_jobs.start(&job_id);
    image_inner(st, &job_id, revision, prompt, &control, &op.token).await
}

async fn image_inner(
    st: &Arc<AppState>,
    job_id: &str,
    revision: u64,
    prompt: String,
    control: &Arc<JobControl>,
    token: &CancellationToken,
) -> Result<CardJobEditor, String> {
    let row = load(st, job_id).await?;
    if row.revision != revision {
        return Err(STALE.into());
    }
    if row.state != CardJobState::Editing {
        return Err("Картинку можно менять только в редакторе".into());
    }
    let mut draft = row.draft.clone().ok_or_else(|| "Черновик ещё не готов".to_string())?;
    draft.image_prompt = prompt;
    let new_revision = row.revision + 1;
    let Some(current) = apply(
        st,
        job_id,
        row.version,
        Change { draft: Some(Some(draft.clone())), revision: Some(new_revision), error: Some(None), ..Default::default() },
    )
    .await?
    else {
        return Err(STALE.into());
    };
    // An established note must still be this job's note in the same Anki profile before any paid
    // generation or media upload; a switched profile is an explicit refusal, not a silent write.
    if current.note_confirmed {
        if let Some(id) = current.note_id {
            let check = connect::Client::new(&st.http, &current.context.anki.url);
            let note = note_by_id(&check, id).await?.ok_or_else(|| MISSING_NOTE.to_string())?;
            if note.model_name != current.context.anki.note_type {
                return Err(safe(format!("Тип заметки в Anki — «{}», а не «{}»", note.model_name, current.context.anki.note_type)));
            }
            if let (Some(expected), Some(actual)) = (&current.note_profile, &note.profile) {
                if expected != actual {
                    return Err("Активный профиль Anki изменился — картинку не меняю.".into());
                }
            }
        }
    }
    let cfg = st.cfg();
    let route = images::resolve_route(st, &cfg.images, &cfg.tutor).await.map_err(|e| e.public_text())?;
    let subject = cards::image_prompt(&draft);
    let input = hash_image(&subject, &current.context.image_style, &route);
    let client = connect::Client::new(&st.http, &current.context.anki.url);
    let result = images::generate(st, &route, &subject, token, None).await;
    let Ok(latest) = load(st, job_id).await else { return Err(NOT_FOUND.into()) };
    if latest.revision != new_revision || latest.state != CardJobState::Editing {
        return Err(STALE.into());
    }
    let change = match result {
        Ok(asset) => {
            let ext = asset.path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "webp".into());
            let file_name = fields::media_name(&draft.word, &format!("{input}:{}", asset.key), &ext);
            let bytes = tokio::fs::read(&asset.path).await.map_err(|_| "картинка не читается".to_string())?;
            let mut slot = AssetSlot {
                input_hash: input,
                status: "ready".into(),
                cache_path: Some(asset.path.to_string_lossy().into_owned()),
                file_name: None,
                provider: Some(asset.provider.clone()),
                model: Some(asset.model.clone()),
                error: None,
            };
            match client.store_media(&file_name, &bytes).await {
                Ok(()) => slot.file_name = Some(file_name),
                Err(e) => slot.error = Some(safe(format!("Anki: {e}"))),
            }
            let mut assets = latest.assets.clone();
            assets.image = Some(slot);
            let error = slot_error(&assets);
            Change { assets: Some(assets), error: Some(error), ..Default::default() }
        }
        Err(e) if e.kind == images::ImageErrorKind::Cancelled => return Err("Генерация отменена".into()),
        Err(e) => {
            let msg = e.public_text();
            let mut assets = latest.assets.clone();
            assets.image = Some(AssetSlot {
                input_hash: input,
                status: "failed".into(),
                cache_path: None,
                file_name: None,
                provider: Some(e.provider),
                model: None,
                error: Some(msg.clone()),
            });
            Change { assets: Some(assets), error: Some(Some(msg)), ..Default::default() }
        }
    };
    let Some(done) = apply(st, job_id, latest.version, change).await? else { return Err(STALE.into()) };
    control.set_editing(true);
    editor(st, &done).await
}

fn slot_error(assets: &JobAssets) -> Option<String> {
    assets.image.as_ref().and_then(|s| s.error.clone())
}

fn hash_image(subject: &str, style: &str, route: &images::ResolvedRoute) -> String {
    let route_json = serde_json::to_string(&route.specs.iter().map(images::Spec::public_id).collect::<Vec<_>>()).unwrap_or_default();
    let mut h = Sha256::new();
    for p in [subject, style, &route_json] {
        h.update(p.as_bytes());
        h.update([0u8]);
    }
    hex::encode(h.finalize())[..24].to_string()
}

pub async fn cards_job_save(
    st: &Arc<AppState>,
    job_id: String,
    revision: u64,
    draft: WordDraft,
    field_values: Option<BTreeMap<String, String>>,
    baseline_fields: Option<BTreeMap<String, String>>,
) -> Result<CardJob, String> {
    st.card_jobs.ensure_started(st).await;
    if draft.word.trim().is_empty() {
        return Err("Слово не может быть пустым".into());
    }
    if cards::cloze_inner(&draft.cloze_sentence).map(|s| s.trim().is_empty()).unwrap_or(true) {
        return Err("В предложении нет пропуска {{c1::…}}".into());
    }
    let row = load(st, &job_id).await?;
    if row.revision != revision {
        return Err(STALE.into());
    }
    if row.state != CardJobState::Editing {
        return Err("Карточка не в редакторе".into());
    }
    if row.note_confirmed {
        if baseline_fields.as_ref() != row.baseline_fields.as_ref() {
            return Err("Карточка изменена в Anki. Откройте её снова.".into());
        }
        let control = st.card_jobs.control(&job_id);
        let result = {
            let _send = control.send.lock().await;
            save_owned_note(&st.db, &connect::Client::new(&st.http, &row.context.anki.url), &job_id, revision, draft, field_values, baseline_fields).await
        };
        if let Ok(done) = load(st, &job_id).await {
            emit(st, &done);
        }
        if let Ok(job) = &result {
            if job.state != CardJobState::Editing {
                control.set_editing(false);
            }
            if job.state == CardJobState::Added {
                refresh_proposal(st, &job_id).await;
            }
        }
        return result;
    }
    let mut assets = row.assets.clone();
    // Only media whose input changed is invalidated; a translation edit regenerates nothing.
    invalidate_assets(row.draft.as_ref(), &draft, &mut assets);
    let control = st.card_jobs.control(&job_id);
    control.set_editing(false);
    control.finish();
    let mut done = None;
    let mut expected_version = row.version;
    for _ in 0..3 {
        let change = Change {
            draft: Some(Some(draft.clone())),
            assets: Some(assets.clone()),
            revision: Some(row.revision + 1),
            state: Some(CardJobState::Queued),
            remaining_ms: Some(0),
            cancel_requested: Some(false),
            error: Some(None),
            warnings: Some(Vec::new()),
            progress: Some(Progress::phase("queued")),
            ..Default::default()
        };
        match apply(st, &job_id, expected_version, change).await? {
            Some(r) => {
                done = Some(r);
                break;
            }
            None => {
                let fresh = load(st, &job_id).await?;
                if fresh.state != CardJobState::Editing || fresh.revision != row.revision || fresh.cancel_requested {
                    return Err(STALE.into());
                }
                expected_version = fresh.version;
            }
        }
    }
    let Some(done) = done else { return Err(STALE.into()) };
    if let Some(pid) = done.proposal_id {
        st.card_jobs.reported.lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
    }
    spawn_worker(st.clone(), job_id.clone());
    Ok(publish(st, &done))
}

/// Clears the asset slots whose inputs the new draft changed.
fn invalidate_assets(old: Option<&WordDraft>, new: &WordDraft, assets: &mut JobAssets) {
    let Some(old) = old else {
        *assets = JobAssets::default();
        return;
    };
    if old.word != new.word {
        assets.word_audio = None;
    }
    // The picture's subject is explicit when the draft has an image prompt; otherwise the prompt is
    // built from the word and the sentence.
    if cards::image_prompt(old) != cards::image_prompt(new) {
        assets.image = None;
    }
    // Sentence audio is TTS of the English sentence; its translation never changes the sound.
    if old.full_sentence != new.full_sentence {
        assets.sentence_audio = None;
    }
    // The clip belongs to the captured cue, which an edit cannot change.
}

/// Updates the mapped fields of an established note. AppHandle-free so the conflict and preservation
/// rules are exercised against a real loopback AnkiConnect.
pub async fn save_owned_note(
    db: &Arc<Mutex<Connection>>,
    client: &connect::Client<'_>,
    job_id: &str,
    expected_revision: u64,
    draft: WordDraft,
    field_values: Option<BTreeMap<String, String>>,
    baseline_fields: Option<BTreeMap<String, String>>,
) -> Result<CardJob, String> {
    let row = load_db(db, job_id).await?;
    if row.revision != expected_revision {
        return Err(STALE.into());
    }
    if row.state != CardJobState::Editing {
        return Err("Карточка не в редакторе".into());
    }
    if !row.note_confirmed {
        return Err("Заметка ещё не добавлена".into());
    }
    if baseline_fields.as_ref() != row.baseline_fields.as_ref() {
        return Err("Карточка изменена в Anki. Откройте её снова.".into());
    }
    let Some(id) = row.note_id else { return Err(MISSING_NOTE.into()) };
    let Some(note) = note_by_id(client, id).await? else { return Err(MISSING_NOTE.into()) };
    if note.model_name != row.context.anki.note_type {
        return Err(safe(format!("Тип заметки в Anki — «{}», а не «{}»", note.model_name, row.context.anki.note_type)));
    }
    if let (Some(expected), Some(actual)) = (&row.note_profile, &note.profile) {
        if expected != actual {
            return Err("Активный профиль Anki изменился — откройте карточку в прежнем профиле.".into());
        }
    }
    let mapping = effective_mapping(&row, &note);
    let actual: BTreeMap<String, String> = mapping
        .iter()
        .map(|(f, _)| (f.clone(), note.fields.get(f).map(|v| v.value.clone()).unwrap_or_default()))
        .collect();
    let baseline = row.baseline_fields.clone().unwrap_or_else(|| actual.clone());
    let mut submitted = actual.clone();
    if let Some(values) = field_values {
        submitted.extend(values);
    }
    let mut changed: BTreeMap<String, String> = BTreeMap::new();
    // Only the fields the user changed against the persisted baseline; the current Anki value must
    // still equal that baseline, otherwise an external edit would be overwritten silently.
    for (field, source) in &mapping {
        let Some(source) = source else { continue };
        if is_media(*source) {
            continue;
        }
        let Some(value) = submitted.get(field) else { continue };
        let before = baseline.get(field).cloned().unwrap_or_default();
        if value != &before {
            let current = actual.get(field).cloned().unwrap_or_default();
            if current != before {
                return Err("Карточка изменена в Anki. Откройте её снова.".into());
            }
            changed.insert(field.clone(), value.clone());
        }
    }
    // Dependency values come from the actual edited fields, in model order, not from a stale draft.
    let mut effective = draft;
    apply_first_sources(&mut effective, &mapping, &submitted);
    let mut assets = row.assets.clone();
    upload_pending_image(client, &mut assets, &effective.word).await?;
    let media_error = slot_error(&assets);
    let rendered = cards::render_values(&row.context, &effective, &assets);
    for (field, source) in &mapping {
        let Some(source) = source else { continue };
        if !is_media(*source) {
            continue;
        }
        let value = rendered.value(*source);
        let owned_now = row.owned_fields.as_ref().filter(|m| !m.is_empty()).unwrap_or(&actual);
        let before = owned_now.get(field).cloned().unwrap_or_default();
        if !value.is_empty() && value != before {
            changed.insert(field.clone(), value);
        }
    }
    let revision = row.revision + 1;
    if changed.is_empty() {
        let change = Change {
            draft: Some(Some(effective)),
            assets: Some(assets),
            mapping: Some(mapping),
            revision: Some(revision),
            state: Some(CardJobState::Added),
            note_profile: note.profile.clone(),
            owned_fields: Some(actual.clone()),
            baseline_fields: Some(actual),
            pending_operation: Some(None),
            pending_fields: Some(BTreeMap::new()),
            error: Some(media_error),
            progress: Some(Progress::phase("added")),
            ..Default::default()
        };
        let Some(done) = apply_db(db, job_id, row.version, change).await? else { return Err(STALE.into()) };
        return Ok(dto_db(&done));
    }
    let change = Change {
        draft: Some(Some(effective)),
        assets: Some(assets),
        mapping: Some(mapping),
        revision: Some(revision),
        state: Some(CardJobState::Committing),
        pending_operation: Some(Some("update".into())),
        pending_fields: Some(changed),
        note_profile: note.profile.clone(),
        baseline_fields: Some(baseline),
        progress: Some(Progress::phase("committing")),
        error: Some(None),
        ..Default::default()
    };
    let Some(_) = apply_db(db, job_id, row.version, change).await? else { return Err(STALE.into()) };
    let job = update_owned_note(db, client, job_id).await?;
    if let Some(err) = media_error {
        let fresh = load_db(db, job_id).await?;
        if fresh.state == CardJobState::Added && fresh.note_confirmed {
            if let Some(done) = apply_db(db, job_id, fresh.version, Change { error: Some(Some(err)), ..Default::default() }).await? {
                return Ok(dto_db(&done));
            }
        }
    }
    Ok(job)
}

/// First mapped source in model order supplies the value used for dependency decisions.
fn apply_first_sources(draft: &mut WordDraft, mapping: &[(String, Option<Source>)], values: &BTreeMap<String, String>) {
    let mut seen: Vec<Source> = Vec::new();
    for (field, source) in mapping {
        let Some(source) = source else { continue };
        if seen.contains(source) {
            continue;
        }
        let Some(value) = values.get(field) else { continue };
        let text = strip_html(value);
        match *source {
            Source::Word => {
                if !text.trim().is_empty() {
                    draft.word = text.trim().to_string();
                    seen.push(*source);
                }
            }
            Source::Translation => {
                draft.translation = text;
                seen.push(*source);
            }
            Source::WordType => {
                draft.word_type = text;
                seen.push(*source);
            }
            Source::ClozeRaw => {
                draft.cloze_sentence = text;
                seen.push(*source);
            }
            Source::Sentence => {
                draft.full_sentence = text;
                seen.push(*source);
            }
            Source::SentenceTranslation => {
                draft.sentence_translation = text;
                seen.push(*source);
            }
            // `clozeGap` is lossy (`[...]`), so it never rewrites the cloze source of a card.
            _ => {}
        }
    }
}

fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut tag = false;
    for ch in s.chars() {
        match ch {
            '<' => tag = true,
            '>' => {
                tag = false;
                out.push(' ');
            }
            _ if !tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

async fn upload_pending_image(client: &connect::Client<'_>, assets: &mut JobAssets, word: &str) -> Result<(), String> {
    let Some(slot) = assets.image.as_mut() else { return Ok(()) };
    if slot.status != "ready" || slot.file_name.is_some() {
        return Ok(());
    }
    let Some(path) = slot.cache_path.clone() else { return Ok(()) };
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(_) => {
            slot.error = Some("файл картинки не читается".into());
            return Ok(());
        }
    };
    let ext = Path::new(&path).extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "webp".into());
    let file_name = fields::media_name(word, &slot.input_hash, &ext);
    if client.store_media(&file_name, &bytes).await.is_ok() {
        slot.file_name = Some(file_name);
        slot.error = None;
    } else if slot.error.is_none() {
        slot.error = Some("Anki не принял картинку".into());
    }
    Ok(())
}

/// Sends the pending owned-field update and reconciles a lost reply by reading the same note.
/// The row must already be `committing`/`failed` with `pending_operation = "update"`.
pub async fn update_owned_note(
    db: &Arc<Mutex<Connection>>,
    client: &connect::Client<'_>,
    job_id: &str,
) -> Result<CardJob, String> {
    let row = load_db(db, job_id).await?;
    let Some(id) = row.note_id else { return Err(MISSING_NOTE.into()) };
    if !matches!(row.state, CardJobState::Committing | CardJobState::Failed) {
        return Err(STALE.into());
    }
    let note = match note_by_id(client, id).await {
        Ok(Some(note)) => note,
        Ok(None) => return unresolved(db, &row, MISSING_NOTE.to_string()).await,
        Err(e) => return unresolved(db, &row, safe(format!("Anki не ответил при сохранении: {e}. Повторите."))).await,
    };
    if note.model_name != row.context.anki.note_type {
        return unresolved(
            db,
            &row,
            safe(format!("Тип заметки в Anki — «{}», а не «{}»", note.model_name, row.context.anki.note_type)),
        )
        .await;
    }
    if let (Some(expected), Some(actual)) = (&row.note_profile, &note.profile) {
        if expected != actual {
            return unresolved(db, &row, "Активный профиль Anki изменился — карточку не меняю.".into()).await;
        }
    }
    let changed = row.pending_fields.clone().unwrap_or_default();
    if changed.is_empty() {
        return Err("Нет изменений для сохранения".into());
    }
    match client.update_note_fields(id, &changed).await {
        Ok(()) => {}
        Err(e) => {
            logs::log("app", &format!("cards: updateNoteFields {id}: {}", safe(e.to_string())));
            let applied = match note_by_id(client, id).await {
                Ok(Some(after)) => changed.iter().all(|(f, v)| after.fields.get(f).map(|x| &x.value) == Some(v)),
                Ok(None) => {
                    return unresolved(db, &row, MISSING_NOTE.into()).await;
                }
                Err(e2) => {
                    return unresolved(db, &row, safe(format!("Anki не ответил при сохранении: {e2}. Повторите."))).await;
                }
            };
            if !applied {
                let change = Change {
                    state: Some(CardJobState::Failed),
                    pending_operation: Some(Some("update".into())),
                    pending_fields: Some(changed),
                    progress: Some(Progress::phase("failed")),
                    error: Some(Some(safe(format!("Anki не ответил при сохранении: {e}. Повторите.")))),
                    ..Default::default()
                };
                return match apply_db(db, job_id, row.version, change).await? {
                    Some(done) => Ok(dto_db(&done)),
                    None => Err(STALE.into()),
                };
            }
        }
    }
    let mut expected = row.owned_fields.clone().unwrap_or_default();
    expected.extend(changed);
    let Some(done) = apply_db(
        db,
        job_id,
        row.version,
        Change {
            state: Some(CardJobState::Added),
            note_id: Some(id),
            note_profile: note.profile.clone(),
            owned_fields: Some(expected.clone()),
            baseline_fields: Some(expected),
            pending_operation: Some(None),
            pending_fields: Some(BTreeMap::new()),
            progress: Some(Progress::phase("added")),
            error: Some(None),
            ..Default::default()
        },
    )
    .await?
    else {
        return Err(STALE.into());
    };
    Ok(dto_db(&done))
}

// ---------------------------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------------------------

/// Validates and enqueues the selected proposal words in one transaction. AppHandle-free: the
/// runtime supplies the captured context, tests exercise the real SQL rules.
fn enqueue_sync(
    c: &Connection,
    proposal_id: i64,
    picked: &[usize],
    ctx_json: &str,
    words_json: &str,
) -> rusqlite::Result<String> {
    let words: Vec<WordDraft> = serde_json::from_str(words_json).map_err(|e| db_payload(e.to_string()))?;
    for i in picked {
        let word = words.get(*i).ok_or_else(|| db_payload("Выбран несуществующий номер карточки"))?;
        let (id, state, revision, confirmed) = match c
            .query_row(
                "SELECT id,state,revision,note_confirmed FROM card_job WHERE proposal_id=?1 AND word_index=?2",
                rusqlite::params![proposal_id, *i as i64],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, bool>(3)?)),
            )
            .optional()?
        {
            Some(found) => found,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                c.execute(
                    "INSERT INTO card_job(id,origin,proposal_id,word_index,media_id,cue_idx,span,state,revision,version,remaining_ms,\
                     cancel_requested,context_json,draft_json,assets_json,progress_json,warnings_json,note_confirmed,created_at,updated_at) \
                     SELECT ?1,'proposal',?2,?3,media_id,cue_idx,?4,'queued',0,1,0,0,?5,?6,'{}',?7,'[]',0,?8,?8 \
                     FROM proposal WHERE id=?2 ON CONFLICT DO NOTHING",
                    rusqlite::params![
                        id,
                        proposal_id,
                        *i as i64,
                        word.word,
                        ctx_json,
                        serde_json::to_string(word).unwrap_or_default(),
                        serde_json::to_string(&Progress::phase("queued")).unwrap_or_default(),
                        db::now()
                    ],
                )?;
                // A racing insert or a lost conflict: use the durable row.
                let (id, state, revision, confirmed): (String, String, i64, bool) = c
                    .query_row(
                        "SELECT id,state,revision,note_confirmed FROM card_job WHERE proposal_id=?1 AND word_index=?2",
                        rusqlite::params![proposal_id, *i as i64],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )?;
                (id, state, revision, confirmed)
            }
        };
        if !confirmed && (state == "failed" || state == "interrupted") {
            c.execute(
                "UPDATE card_job SET state='queued',version=version+1,revision=?1,error=NULL,draft_json=?2,progress_json=?3,warnings_json='[]',updated_at=?4 WHERE id=?5",
                rusqlite::params![
                    revision + 1,
                    serde_json::to_string(word).unwrap_or_default(),
                    serde_json::to_string(&Progress::phase("queued")).unwrap_or_default(),
                    db::now(),
                    id
                ],
            )?;
        }
    }
    let active: i64 = c.query_row(
        &format!("SELECT COUNT(*) FROM card_job WHERE proposal_id=?1 AND state IN({ACTIVE_STATES})"),
        [proposal_id],
        |r| r.get(0),
    )?;
    let added: i64 = c.query_row("SELECT COUNT(*) FROM card_job WHERE proposal_id=?1 AND state='added'", [proposal_id], |r| r.get(0))?;
    let total: i64 = c.query_row("SELECT COUNT(*) FROM card_job WHERE proposal_id=?1", [proposal_id], |r| r.get(0))?;
    let cancelled: i64 = c.query_row(
        "SELECT COUNT(*) FROM card_job WHERE proposal_id=?1 AND state IN('cancelled','deleted')",
        [proposal_id],
        |r| r.get(0),
    )?;
    let status = if active > 0 {
        "adding"
    } else if added > 0 {
        "added"
    } else if total > 0 && cancelled == total {
        "dismissed"
    } else {
        "failed"
    };
    c.execute("UPDATE proposal SET status=?1, error=NULL WHERE id=?2", rusqlite::params![status, proposal_id])?;
    Ok(status.to_string())
}

/// A legacy `adding`/`failed` proposal without any durable job cannot prove which note it may have
/// created, so retrying it blindly is forbidden. A pending proposal was never sent and is safe.
fn proposal_gate(status: &str, jobs: i64) -> Result<(), String> {
    if matches!(status, "failed" | "adding") && jobs == 0 {
        return Err(LEGACY_PROPOSAL.into());
    }
    if status == "dismissed" {
        return Err("Предложение отклонено".into());
    }
    Ok(())
}

pub async fn enqueue_proposal(st: &Arc<AppState>, proposal_id: i64, indices: Vec<usize>) -> Result<(), String> {
    st.card_jobs.ensure_started(st).await;
    let (media_id, cue_idx, words_json, status): (String, u32, String, String) = db_task(&st.db, move |c| {
        c.query_row("SELECT media_id,cue_idx,words_json,status FROM proposal WHERE id=?1", [proposal_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .optional()?
        .ok_or_else(|| db_payload("Предложение не найдено"))
    })
    .await?;
    let words: Vec<WordDraft> = serde_json::from_str(&words_json).map_err(|e| format!("Слова предложения повреждены: {e}"))?;
    if words.is_empty() {
        return Err("В предложении нет карточек".into());
    }
    let mut picked = indices;
    picked.sort_unstable();
    picked.dedup();
    if picked.is_empty() {
        return Err("ничего не выбрано".into());
    }
    if picked.iter().any(|i| *i >= words.len()) {
        return Err("Выбран несуществующий номер карточки".into());
    }
    {
        let jobs: i64 = db_task(&st.db, move |c| c.query_row("SELECT COUNT(*) FROM card_job WHERE proposal_id=?1", [proposal_id], |r| r.get(0)))
            .await?;
        proposal_gate(&status, jobs)?;
    }
    let audio = st
        .sessions
        .current()
        .filter(|s| s.media_id == media_id)
        .map(|s| *s.audio_index.lock().unwrap_or_else(|e| e.into_inner()))
        .unwrap_or_else(|| 0);
    let offset: f64 = db_task(&st.db, {
        let m = media_id.clone();
        move |c| c.query_row("SELECT COALESCE(sub_offset,0) FROM media WHERE id=?1", [&m], |r| r.get(0))
    })
    .await?;
    let context = capture_context(st, &media_id, cue_idx, audio, offset).await?;
    let ctx_json = serde_json::to_string(&context).map_err(|e| e.to_string())?;
    let (db, words_json2) = (st.db.clone(), words_json.clone());
    let picked2 = picked.clone();
    let status = db_task(&db, move |c| {
        let tx = c.unchecked_transaction()?;
        let status = enqueue_sync(&tx, proposal_id, &picked2, &ctx_json, &words_json2)?;
        tx.commit()?;
        Ok(status)
    })
    .await?;
    st.card_jobs.reported.lock().unwrap_or_else(|e| e.into_inner()).remove(&proposal_id);
    let ids: Vec<String> = db_task(&st.db, move |c| {
        let mut q = c.prepare(&format!("SELECT id FROM card_job WHERE proposal_id=?1 AND state='queued' AND state IN({ACTIVE_STATES}) ORDER BY word_index"))?;
        let rows = q.query_map([proposal_id], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await?;
    for id in &ids {
        if let Ok(row) = load(st, id).await {
            emit(st, &row);
        }
    }
    if status == "adding" {
        for id in ids {
            spawn_worker(st.clone(), id);
        }
    } else {
        // Nothing was queued: refresh the projection so the caller sees the actual settled state,
        // and do not report success for a proposal whose cards all failed before this attempt.
        let any: Option<String> = db_task(&st.db, move |c| {
            c.query_row("SELECT id FROM card_job WHERE proposal_id=?1 ORDER BY word_index LIMIT 1", [proposal_id], |r| r.get(0))
                .optional()
        })
        .await?;
        if let Some(id) = any {
            refresh_proposal(st, &id).await;
        }
        if status == "failed" {
            return Err("Карточки не отправлены — проверьте их состояние в Anki.".into());
        }
    }
    Ok(())
}

pub async fn dismiss_proposal(st: &Arc<AppState>, proposal_id: i64) -> Result<(), String> {
    st.card_jobs.ensure_started(st).await;
    let ids: Vec<String> = db_task(&st.db, move |c| {
        let mut q = c.prepare("SELECT id FROM card_job WHERE proposal_id=?1")?;
        let rows = q.query_map([proposal_id], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await?;
    for id in ids {
        let Ok(row) = load(st, &id).await else { continue };
        if matches!(row.state, CardJobState::Cancelled | CardJobState::Deleted | CardJobState::Added) {
            continue;
        }
        let _ = cards_job_cancel(st, id.clone(), row.revision).await;
    }
    let rows: Vec<JobRow> = db_task(&st.db, move |c| {
        let mut q = c.prepare(&format!("SELECT {COLUMNS} FROM card_job WHERE proposal_id=?1"))?;
        let rows = q.query_map([proposal_id], raw_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?.parse().map_err(db_payload)?);
        }
        Ok(out)
    })
    .await?;
    if rows.iter().any(|r| r.state.active()) {
        return Err("Не все карточки отменены — Anki не ответил. Повторите.".into());
    }
    let status = if rows.iter().any(|r| r.state == CardJobState::Added || r.note_confirmed) { "added" } else { "dismissed" };
    let db = st.db.clone();
    let status2 = status.to_string();
    db_task(&db, move |c| {
        c.execute("UPDATE proposal SET status=?1 WHERE id=?2", rusqlite::params![status2, proposal_id])?;
        Ok(())
    })
    .await?;
    Ok(())
}

async fn refresh_proposal(st: &Arc<AppState>, job_id: &str) {
    let Ok(row) = load(st, job_id).await else { return };
    let Some(pid) = row.proposal_id else { return };
    let report: Option<(Vec<JobRow>, String)> = db_task(&st.db, move |c| {
        let mut q = c.prepare(&format!("SELECT {COLUMNS} FROM card_job WHERE proposal_id=?1 ORDER BY word_index"))?;
        let rows = q.query_map([pid], raw_row)?;
        let mut jobs = Vec::new();
        for r in rows {
            jobs.push(r?.parse().map_err(db_payload)?);
        }
        if jobs.iter().any(|j| j.state.active()) {
            return Ok(Some((jobs, "adding".to_string())));
        }
        let added = jobs.iter().any(|j| j.state == CardJobState::Added);
        let all_cancelled = !jobs.is_empty() && jobs.iter().all(|j| matches!(j.state, CardJobState::Cancelled | CardJobState::Deleted));
        let status = if added { "added" } else if all_cancelled { "dismissed" } else { "failed" };
        Ok(Some((jobs, status.to_string())))
    })
    .await
    .ok()
    .flatten();
    let Some((jobs, status)) = report else { return };
    let Some(first_job) = jobs.first() else { return };
    let settled = status != "adding";
    let db = st.db.clone();
    let status_sql = status.clone();
    let aggregate_error = if status == "failed" {
        jobs.iter().find_map(|j| j.error.clone()).or_else(|| Some("Карточки не добавлены".to_string()))
    } else {
        None
    };
    let err_sql = aggregate_error.clone();
    let _ = db_task(&db, move |c| {
        c.execute("UPDATE proposal SET status=?1, error=?2 WHERE id=?3", rusqlite::params![status_sql, err_sql, pid])?;
        Ok(())
    })
    .await;
    if !settled {
        return;
    }
    let first = st.card_jobs.reported.lock().unwrap_or_else(|e| e.into_inner()).insert(pid);
    if !first {
        return;
    }
    let words: Vec<String> = jobs
        .iter()
        .map(|j| j.draft.as_ref().map(|d| d.word.clone()).or_else(|| j.span.clone()).unwrap_or_default())
        .collect();
    let indices: Vec<usize> = jobs.iter().filter_map(|j| j.word_index.map(|i| i.max(0) as usize)).collect();
    let added = jobs.iter().filter(|j| j.state == CardJobState::Added).count();
    let cancelled = jobs.iter().filter(|j| matches!(j.state, CardJobState::Cancelled | CardJobState::Deleted)).count();
    let mut warnings: Vec<String> = Vec::new();
    for w in jobs.iter().flat_map(|j| j.warnings.clone()) {
        if !warnings.contains(&w) {
            warnings.push(w);
        }
    }
    let error = if added == 0 {
        aggregate_error
    } else {
        None
    };
    let (media_id, cue_idx) = (first_job.media_id.clone(), first_job.cue_idx);
    let job_ids: Vec<String> = jobs.iter().map(|j| j.id.clone()).collect();
    let payload = json!({
        "proposalId": pid,
        "mediaId": media_id,
        "cueIdx": cue_idx,
        "indices": indices,
        "words": words,
        "added": added,
        "cancelled": cancelled,
        "jobIds": job_ids,
        "error": error,
        "warnings": warnings,
    });
    let _ = st.app.emit("cards:result", payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_round_trip_and_cancel_requested_is_snake_case() {
        let s = serde_json::to_string(&CardJobState::CancelRequested).unwrap();
        assert_eq!(s, "\"cancel_requested\"");
        assert_eq!(CardJobState::parse("grace").unwrap(), CardJobState::Grace);
        assert!(CardJobState::parse("nope").is_err());
        assert!(CardJobState::Grace.active());
        assert!(!CardJobState::Editing.active());
        assert!(CardJobState::Added.terminal());
    }

    #[test]
    fn mapping_json_rejects_unknown_sources() {
        assert!(mapping_from_json("[[\"Word\",\"word\"],[\"Back\",null]]").is_ok());
        assert!(mapping_from_json("[[\"Word\",\"nonsense\"]]").is_err());
        assert!(mapping_from_json("not json").is_err());
    }

    #[test]
    fn invalidating_assets_follows_the_changed_inputs() {
        let old = WordDraft {
            word: "bring".into(),
            translation: "принести".into(),
            word_type: "verb".into(),
            cloze_sentence: "It'll {{c1::bring}} him joy.".into(),
            full_sentence: "It'll bring him joy.".into(),
            sentence_translation: "Это доставит ему радость.".into(),
            image_prompt: "A gift".into(),
        };
        let slot = AssetSlot { input_hash: "h".into(), status: "ready".into(), ..Default::default() };
        let assets = JobAssets { image: Some(slot.clone()), word_audio: Some(slot.clone()), sentence_audio: Some(slot.clone()), clip: Some(slot.clone()) };
        let mut a = assets.clone();
        let mut d = old.clone();
        d.translation = "доставить".into();
        invalidate_assets(Some(&old), &d, &mut a);
        assert!(a.image.is_some());
        assert!(a.word_audio.is_some());
        assert!(a.sentence_audio.is_some(), "a translation edit must not regenerate audio");
        assert!(a.clip.is_some());
        let mut a = assets.clone();
        let mut d = old.clone();
        d.word = "deliver".into();
        invalidate_assets(Some(&old), &d, &mut a);
        assert!(a.word_audio.is_none());
        assert!(a.image.is_some(), "an explicit image prompt does not depend on the word");
        let mut bare = old.clone();
        bare.image_prompt = String::new();
        let mut a = assets.clone();
        let mut d = bare.clone();
        d.word = "deliver".into();
        invalidate_assets(Some(&bare), &d, &mut a);
        assert!(a.image.is_none());
    }

    #[test]
    fn intent_key_covers_cue_audio_source_and_destination() {
        let base = context("http://127.0.0.1:9");
        let key = intent_key(&base, Some("bring"));
        assert_eq!(key, intent_key(&base, Some("bring")));
        let mut changed = base.clone();
        changed.cue_idx += 1;
        assert_ne!(key, intent_key(&changed, Some("bring")));
        let mut changed = base.clone();
        changed.cue.end += 0.5;
        assert_ne!(key, intent_key(&changed, Some("bring")));
        let mut changed = base.clone();
        changed.source_url = Some("https://example.test/other?token=x".into());
        assert_ne!(key, intent_key(&changed, Some("bring")));
        let mut changed = base.clone();
        changed.audio_index = 3;
        assert_ne!(key, intent_key(&changed, Some("bring")));
        let mut changed = base.clone();
        changed.clip = Some(ClipContext { source_url: "http://source/raw".into(), audio_index: 0, video_index: Some(2), hdr: true });
        assert_ne!(key, intent_key(&changed, Some("bring")));
        let mut changed = base.clone();
        changed.anki.deck = "Other".into();
        assert_ne!(key, intent_key(&changed, Some("bring")));
    }

    #[test]
    fn guarded_failure_cannot_replace_editing_or_a_newer_revision() {
        let db = memory_db();
        let c = db.lock().unwrap();
        insert_job(&c, "job-g", "generating", &context("http://127.0.0.1:9"), false, None);
        insert_job(&c, "job-e", "editing", &context("http://127.0.0.1:9"), false, None);
        let fail = Change {
            state: Some(CardJobState::Failed),
            error: Some(Some("boom".into())),
            progress: Some(Progress::phase("failed")),
            ..Default::default()
        };
        let stale = Guard { revision: 8, states: FAILABLE_STATES, cancel_requested: Some(false), note_confirmed: Some(false) };
        assert!(!apply_guarded_sync(&c, "job-g", stale, &fail).unwrap(), "a newer revision is fenced");
        let editing = Guard { revision: 7, states: FAILABLE_STATES, cancel_requested: Some(false), note_confirmed: Some(false) };
        assert!(!apply_guarded_sync(&c, "job-e", editing, &fail).unwrap(), "an editor is never replaced by a stale worker");
        let current = Guard { revision: 7, states: FAILABLE_STATES, cancel_requested: Some(false), note_confirmed: Some(false) };
        assert!(apply_guarded_sync(&c, "job-g", current, &fail).unwrap());
        assert_eq!(load_sync(&c, "job-g").unwrap().unwrap().state, CardJobState::Failed);
        assert_eq!(load_sync(&c, "job-e").unwrap().unwrap().state, CardJobState::Editing);
    }

    // ---- grace and holds ----------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn the_first_interval_is_counted_once() {
        let control = JobControl::new(GRACE_MS);
        tokio::time::advance(Duration::from_millis(100)).await;
        control.tick(tokio::time::Instant::now());
        assert_eq!(control.remaining(), 4900, "the first tick must not lose its interval");
    }

    #[tokio::test(start_paused = true)]
    async fn grace_pauses_on_a_hold_and_resumes_the_remainder() {
        let control = JobControl::new(GRACE_MS);
        control.tick(tokio::time::Instant::now());
        tokio::time::advance(Duration::from_secs(2)).await;
        control.tick(tokio::time::Instant::now());
        assert_eq!(control.remaining(), 3000);
        assert!(control.hold("pointer", true, tokio::time::Instant::now()));
        assert!(control.hold("pointer", true, tokio::time::Instant::now()), "a renewal is accepted and persisted");
        assert!(control.hold("focus", true, tokio::time::Instant::now()));
        tokio::time::advance(Duration::from_secs(6)).await;
        control.tick(tokio::time::Instant::now());
        assert_eq!(control.remaining(), 3000, "a held job keeps its grace");
        assert!(control.hold("pointer", false, tokio::time::Instant::now()));
        assert!(control.held(), "focus still holds the job");
        tokio::time::advance(Duration::from_secs(4)).await;
        control.tick(tokio::time::Instant::now());
        assert_eq!(control.remaining(), 3000);
        assert!(control.hold("focus", false, tokio::time::Instant::now()));
        tokio::time::advance(Duration::from_secs(3)).await;
        control.tick(tokio::time::Instant::now());
        assert_eq!(control.remaining(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_lost_heartbeat_expires_without_restoring_elapsed_grace() {
        let control = JobControl::new(GRACE_MS);
        control.tick(tokio::time::Instant::now());
        tokio::time::advance(Duration::from_secs(2)).await;
        control.tick(tokio::time::Instant::now());
        control.hold("pointer", true, tokio::time::Instant::now());
        tokio::time::advance(Duration::from_secs(11)).await;
        control.tick(tokio::time::Instant::now());
        assert!(!control.held(), "the lease expired");
        assert_eq!(control.remaining(), 3000, "the paused time is not replayed as elapsed");
        tokio::time::advance(Duration::from_secs(3)).await;
        control.tick(tokio::time::Instant::now());
        assert_eq!(control.remaining(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn renewal_after_a_hold_keeps_the_live_remaining_time() {
        let control = JobControl::new(GRACE_MS);
        control.tick(tokio::time::Instant::now());
        tokio::time::advance(Duration::from_millis(1500)).await;
        control.hold("pointer", true, tokio::time::Instant::now());
        let first = control.remaining();
        tokio::time::advance(Duration::from_secs(3)).await;
        assert!(control.hold("pointer", true, tokio::time::Instant::now()));
        assert_eq!(control.remaining(), first);
    }

    // ---- commit/reconcile against a loopback AnkiConnect fixture --------------------------

    use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::post, Json, Router};
    use serde_json::Value;
    use std::sync::atomic::AtomicI64;

    static BASE: std::sync::LazyLock<std::sync::RwLock<String>> = std::sync::LazyLock::new(|| std::sync::RwLock::new(String::new()));

    #[derive(Clone, Default)]
    struct FakeNote {
        model: String,
        fields: BTreeMap<String, String>,
        tags: Vec<String>,
        profile: String,
        cards: Vec<i64>,
    }

    #[derive(Default)]
    struct Fake {
        notes: Mutex<BTreeMap<i64, FakeNote>>,
        next: AtomicI64,
        calls: Mutex<HashMap<String, usize>>,
        drop_add: std::sync::atomic::AtomicBool,
        drop_add_silent: std::sync::atomic::AtomicBool,
        add_action_error: std::sync::atomic::AtomicBool,
        drop_update: std::sync::atomic::AtomicBool,
        drop_delete: std::sync::atomic::AtomicBool,
        profile: Mutex<String>,
    }

    impl Fake {
        fn count(&self, action: &str) -> usize {
            self.calls.lock().unwrap().get(action).copied().unwrap_or(0)
        }
        fn put(&self, id: i64, note: FakeNote) {
            self.notes.lock().unwrap().insert(id, note);
        }
        fn notes(&self) -> Vec<(i64, FakeNote)> {
            self.notes.lock().unwrap().iter().map(|(id, n)| (*id, n.clone())).collect()
        }
        fn field(&self, id: i64, name: &str) -> Option<String> {
            self.notes.lock().unwrap().get(&id).and_then(|n| n.fields.get(name).cloned())
        }
    }

    fn note(profile: &str, tags: &[&str]) -> FakeNote {
        FakeNote {
            model: "Smart Subtitles — Vocab".into(),
            fields: [
                ("Word", "bring"),
                ("WordTranslation", "принести"),
                ("ClozeText", "It'll [...] him joy."),
                ("Extra", "keep"),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            profile: profile.into(),
            cards: vec![7],
        }
    }

    struct Cleanup {
        url: String,
        notes: Vec<i64>,
        decks: Vec<String>,
        dirs: Vec<std::path::PathBuf>,
    }

    impl Drop for Cleanup {
        fn drop(&mut self) {
            for dir in std::mem::take(&mut self.dirs) {
                let _ = std::fs::remove_dir_all(dir);
            }
            if self.notes.is_empty() && self.decks.is_empty() {
                return;
            }
            let (url, notes, decks) = (self.url.clone(), std::mem::take(&mut self.notes), std::mem::take(&mut self.decks));
            let _ = std::thread::spawn(move || {
                let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
                rt.block_on(async move {
                    let http = reqwest::Client::new();
                    let client = connect::Client::new(&http, &url);
                    let _ = client.delete_notes(&notes).await;
                    for deck in decks {
                        let query = format!("deck:\"{deck}\"");
                        let Ok(left) = client.find_notes(&query).await else {
                            logs::log("app", &format!("cards smoke: leaving deck {deck}: Anki unavailable"));
                            continue;
                        };
                        if left.iter().all(|id| notes.contains(id)) {
                            let _ = client
                                .call("deleteDecks", json!({ "decks": [deck], "cardsToo": true }), Duration::from_secs(30))
                                .await;
                        } else {
                            logs::log("app", &format!("cards smoke: leaving deck {deck}: {} unrelated cards", left.len()));
                        }
                    }
                });
            })
            .join();
        }
    }

    fn ok(v: Value) -> axum::response::Response {
        Json(json!({ "result": v, "error": null })).into_response()
    }
    fn bad(m: &str) -> axum::response::Response {
        Json(json!({ "result": null, "error": m })).into_response()
    }
    fn lost() -> axum::response::Response {
        (StatusCode::INTERNAL_SERVER_ERROR, "").into_response()
    }

    async fn anki(State(f): State<Arc<Fake>>, Json(body): Json<Value>) -> axum::response::Response {
        let action = body["action"].as_str().unwrap_or("").to_string();
        let params = body["params"].clone();
        *f.calls.lock().unwrap().entry(action.clone()).or_default() += 1;
        match action.as_str() {
            "version" => ok(json!(6)),
            "createDeck" => ok(Value::Null),
            "storeMediaFile" => ok(json!(params["filename"])),
            "modelNames" => ok(json!(["Smart Subtitles — Vocab"])),
            "modelFieldNames" => ok(json!(["Word", "WordTranslation", "ClozeText", "Extra"])),
            "addNote" => {
                let note = &params["note"];
                if f.drop_add_silent.swap(false, Ordering::SeqCst) {
                    return lost();
                }
                let id = f.next.fetch_add(1, Ordering::SeqCst) + 1;
                let fields: BTreeMap<String, String> = note["fields"]
                    .as_object()
                    .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
                    .unwrap_or_default();
                f.put(
                    id,
                    FakeNote {
                        model: note["modelName"].as_str().unwrap_or("").into(),
                        fields,
                        tags: note["tags"].as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default(),
                        profile: f.profile.lock().unwrap().clone(),
                        cards: vec![1000 + id],
                    },
                );
                if f.drop_add.swap(false, Ordering::SeqCst) {
                    return lost();
                }
                if f.add_action_error.swap(false, Ordering::SeqCst) {
                    return bad("addNote internal error");
                }
                ok(json!(id))
            }
            "findNotes" => {
                let q = params["query"].as_str().unwrap_or("");
                let tagged = q.strip_prefix("tag:\"").and_then(|r| r.strip_suffix('"'));
                let ids: Vec<i64> = f
                    .notes
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(_, n)| tagged.is_none_or(|t| n.tags.iter().any(|x| x == t)))
                    .map(|(id, _)| *id)
                    .collect();
                ok(json!(ids))
            }
            "notesInfo" => {
                let ids: Vec<i64> = params["notes"].as_array().map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
                let notes = f.notes.lock().unwrap();
                let out: Vec<Value> = ids
                    .iter()
                    .map(|id| match notes.get(id) {
                        Some(n) => json!({
                            "noteId": id,
                            "modelName": n.model,
                            "tags": n.tags,
                            "profile": n.profile,
                            "cards": n.cards,
                            "fields": n.fields.iter().enumerate().map(|(i, (k, v))| (k.clone(), json!({ "value": v, "order": i }))).collect::<serde_json::Map<_, _>>(),
                        }),
                        None => json!({}),
                    })
                    .collect();
                ok(json!(out))
            }
            "updateNoteFields" => {
                let id = params["note"]["id"].as_i64().unwrap_or(0);
                let fields = params["note"]["fields"].as_object().cloned().unwrap_or_default();
                if let Some(n) = f.notes.lock().unwrap().get_mut(&id) {
                    for (k, v) in fields {
                        if let Some(v) = v.as_str() {
                            n.fields.insert(k, v.to_string());
                        }
                    }
                }
                if f.drop_update.swap(false, Ordering::SeqCst) {
                    return lost();
                }
                ok(Value::Null)
            }
            "deleteNotes" => {
                let ids: Vec<i64> = params["notes"].as_array().map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
                for id in ids {
                    f.notes.lock().unwrap().remove(&id);
                }
                if f.drop_delete.swap(false, Ordering::SeqCst) {
                    return lost();
                }
                ok(Value::Null)
            }
            other => bad(&format!("unsupported {other}")),
        }
    }

    async fn fixture() -> (Arc<Fake>, String) {
        let fake = Arc::new(Fake::default());
        *fake.profile.lock().unwrap() = "User 1".into();
        let app = Router::new().route("/", post(anki)).with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (fake, format!("http://{addr}"))
    }

    fn context(url: &str) -> JobContext {
        JobContext {
            cue_idx: 3,
            media: MediaContext { media_id: "m".into(), title: "Film".into(), original_title: Some("Film".into()), ..Default::default() },
            cue: CapturedCue {
                start: 10.0,
                end: 12.0,
                text: "It'll bring him joy.".into(),
                offset: 0.5,
                next_start: None,
                chunk_fallback: None,
            },
            clip: None,
            source_url: Some("https://example.test/raw?token=secret".into()),
            audio_index: 1,
            anki: AnkiTarget {
                url: url.into(),
                deck: "Deck".into(),
                note_type: "Smart Subtitles — Vocab".into(),
                fields: BTreeMap::new(),
                tags: "vocab".into(),
                tts: false,
                tts_voice: "v".into(),
                sentence_audio: "none".into(),
                clip: false,
                sync_after_add: false,
            },
            image_style: String::new(),
        }
    }

    fn memory_db() -> Arc<Mutex<Connection>> {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init(&c).unwrap();
        Arc::new(Mutex::new(c))
    }

    fn insert_job_at(c: &Connection, id: &str, state: &str, ctx: &JobContext, note_confirmed: bool, note_id: Option<i64>, created_at: i64) {
        let mapping = mapping_to_json(&[
            ("Word".into(), Some(Source::Word)),
            ("WordTranslation".into(), Some(Source::Translation)),
            ("ClozeText".into(), Some(Source::ClozeGap)),
        ]);
        c.execute(
            "INSERT INTO card_job(id,origin,media_id,cue_idx,state,revision,version,remaining_ms,cancel_requested,context_json,draft_json,\
             assets_json,mapping_json,owned_fields_json,progress_json,warnings_json,note_confirmed,note_id,created_at,updated_at) \
             VALUES(?1,'proposal','m',3,?2,7,5,0,0,?3,?4,'{}',?5,'{}','{\"phase\":\"queued\"}','[]',?6,?7,?8,?8)",
            rusqlite::params![
                id,
                state,
                serde_json::to_string(ctx).unwrap(),
                serde_json::to_string(&WordDraft {
                    word: "bring".into(),
                    translation: "принести".into(),
                    word_type: "verb".into(),
                    cloze_sentence: "It'll {{c1::bring}} him joy.".into(),
                    full_sentence: "It'll bring him joy.".into(),
                    sentence_translation: "Это доставит ему радость.".into(),
                    image_prompt: "A gift".into(),
                })
                .unwrap(),
                mapping,
                note_confirmed as i64,
                note_id,
                created_at,
            ],
        )
        .unwrap();
    }

    fn insert_job(c: &Connection, id: &str, state: &str, ctx: &JobContext, note_confirmed: bool, note_id: Option<i64>) {
        insert_job_at(c, id, state, ctx, note_confirmed, note_id, 1)
    }

    fn prepared() -> cards::PreparedCard {
        cards::PreparedCard {
            fields: [
                ("Word".to_string(), "bring".to_string()),
                ("WordTranslation".to_string(), "принести".to_string()),
                ("ClozeText".to_string(), "It'll [...] him joy.".to_string()),
            ]
            .into_iter()
            .collect(),
            mapping: vec![
                ("Word".to_string(), Some(Source::Word)),
                ("WordTranslation".to_string(), Some(Source::Translation)),
                ("ClozeText".to_string(), Some(Source::ClozeGap)),
            ],
            assets: JobAssets::default(),
            warnings: vec![],
        }
    }

    #[tokio::test]
    async fn a_lost_add_reply_is_reconciled_without_a_second_note() {
        let (fake, url) = fixture().await;
        fake.drop_add.store(true, Ordering::SeqCst);
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-1", "generating", &context(&url), false, None);
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let job = commit_prepared(&db, &client, "job-1", 7, prepared()).await.unwrap();
        assert_eq!(job.state, CardJobState::Added);
        assert!(job.has_committed_note);
        assert_eq!(fake.notes().len(), 1, "exactly one note was created");
        assert_eq!(fake.count("addNote"), 1);
        let row = load_db(&db, "job-1").await.unwrap();
        assert_eq!(row.note_id, Some(job.note_id.unwrap_or_default()));
        assert_eq!(row.note_profile.as_deref(), Some("User 1"), "the profile is recorded at confirmation");
        let again = reconcile_job(&db, &client, "job-1").await.unwrap();
        assert_eq!(again.state, CardJobState::Added);
        assert_eq!(fake.count("addNote"), 1);
        let stored = &fake.notes()[0].1;
        assert!(stored.tags.iter().any(|t| t == "smartsubs-job::job-1"));
    }

    #[tokio::test]
    async fn a_cancelled_job_never_sends_its_add() {
        let (fake, url) = fixture().await;
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-15", "generating", &context(&url), false, None);
        db.lock().unwrap().execute("UPDATE card_job SET cancel_requested=1 WHERE id='job-15'", []).unwrap();
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let err = commit_prepared(&db, &client, "job-15", 7, prepared()).await.unwrap_err();
        assert!(err.contains("отменено"));
        assert_eq!(fake.count("addNote"), 0, "the pre-send cancellation CAS blocks the request");
        assert!(fake.notes().is_empty());
    }

    #[tokio::test]
    async fn a_successful_add_racing_cancellation_deletes_instead_of_failing() {
        let (fake, url) = fixture().await;
        fake.put(42, note("User 1", &["smartsubs-job::job-9"]));
        fake.put(99, note("User 1", &["smartsubs-job::control"]));
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-9", "generating", &context(&url), false, None);
        db.lock()
            .unwrap()
            .execute("UPDATE card_job SET cancel_requested=1 WHERE id='job-9'", [])
            .unwrap();
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let job = finish_add(&db, &client, "job-9", 42).await.unwrap();
        assert_eq!(job.state, CardJobState::Cancelled, "a successfully added note must not become a failure");
        assert!(!job.has_committed_note);
        assert!(fake.notes().iter().all(|(id, _)| *id == 99), "only the job's own note was deleted");
        assert!(!fake.notes().iter().any(|(id, _)| *id == 42));
        assert_eq!(fake.count("addNote"), 0);
    }

    #[tokio::test]
    async fn a_lost_add_with_cancel_intent_is_cancelled_only_after_absence() {
        let (fake, url) = fixture().await;
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-10", "committing", &context(&url), false, None);
        db.lock()
            .unwrap()
            .execute("UPDATE card_job SET cancel_requested=1,pending_operation='add' WHERE id='job-10'", [])
            .unwrap();
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let job = reconcile_job(&db, &client, "job-10").await.unwrap();
        assert_eq!(job.state, CardJobState::Cancelled);
        assert!(!job.has_committed_note);
        assert_eq!(fake.count("addNote"), 0);
        assert!(fake.notes().is_empty());
        assert!(client.find_notes("tag:\"smartsubs-job::job-10\"").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_lost_update_reply_reconciles_the_same_note() {
        let (fake, url) = fixture().await;
        fake.put(42, note("User 1", &["smartsubs-job::job-2"]));
        fake.drop_update.store(true, Ordering::SeqCst);
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-2", "committing", &context(&url), true, Some(42));
        {
            let c = db.lock().unwrap();
            c.execute(
                "UPDATE card_job SET pending_operation='update',pending_fields_json=?1,owned_fields_json=?2,baseline_fields_json=?2,note_profile='User 1' WHERE id='job-2'",
                rusqlite::params![
                    serde_json::to_string(&BTreeMap::from([("WordTranslation".to_string(), "доставить".to_string())])).unwrap(),
                    serde_json::to_string(&BTreeMap::from([("WordTranslation".to_string(), "принести".to_string())])).unwrap()
                ],
            )
            .unwrap();
        }
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let job = update_owned_note(&db, &client, "job-2").await.unwrap();
        assert_eq!(job.state, CardJobState::Added);
        assert_eq!(job.note_id, Some(42));
        assert_eq!(fake.count("addNote"), 0, "an update never adds a note");
        let notes = fake.notes();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].0, 42);
        assert_eq!(notes[0].1.fields.get("WordTranslation").map(String::as_str), Some("доставить"));
        assert_eq!(notes[0].1.fields.get("Extra").map(String::as_str), Some("keep"));
        assert_eq!(notes[0].1.cards, vec![7], "cards and scheduling are untouched");
    }

    #[tokio::test]
    async fn a_lost_delete_reply_confirms_deletion() {
        let (fake, url) = fixture().await;
        fake.put(42, note("User 1", &["smartsubs-job::job-3"]));
        fake.drop_delete.store(true, Ordering::SeqCst);
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-3", "added", &context(&url), true, Some(42));
        db.lock().unwrap().execute("UPDATE card_job SET note_profile='User 1' WHERE id='job-3'", []).unwrap();
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let job = delete_owned_note(&db, &client, "job-3", CardJobState::Deleted).await.unwrap();
        assert_eq!(job.state, CardJobState::Deleted);
        assert!(!job.has_committed_note);
        assert!(fake.notes().is_empty());
        assert!(client.find_notes("tag:\"smartsubs-job::job-3\"").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn deleting_removes_only_the_note_this_job_owns() {
        let (fake, url) = fixture().await;
        fake.put(42, note("User 1", &["smartsubs-job::job-4"]));
        fake.put(99, note("User 1", &["smartsubs-job::other"]));
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-4", "added", &context(&url), true, Some(42));
        db.lock().unwrap().execute("UPDATE card_job SET note_profile='User 1' WHERE id='job-4'", []).unwrap();
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let job = delete_owned_note(&db, &client, "job-4", CardJobState::Deleted).await.unwrap();
        assert_eq!(job.state, CardJobState::Deleted);
        let left: Vec<i64> = fake.notes().into_iter().map(|(id, _)| id).collect();
        assert_eq!(left, vec![99], "the unrelated note with the same word survives");
    }

    #[tokio::test]
    async fn a_profile_change_blocks_update_and_delete() {
        let (fake, url) = fixture().await;
        fake.put(42, note("User 2", &["smartsubs-job::job-5"]));
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-5", "committing", &context(&url), true, Some(42));
        {
            let c = db.lock().unwrap();
            c.execute(
                "UPDATE card_job SET pending_operation='update',note_profile='User 1',pending_fields_json=?1 WHERE id='job-5'",
                [serde_json::to_string(&BTreeMap::from([("WordTranslation".to_string(), "новый".to_string())])).unwrap()],
            )
            .unwrap();
        }
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let job = update_owned_note(&db, &client, "job-5").await.unwrap();
        assert_eq!(job.state, CardJobState::Resolving);
        assert!(job.error.unwrap_or_default().contains("профиль"));
        assert_eq!(fake.field(42, "WordTranslation").as_deref(), Some("принести"), "nothing was written");
        let err = delete_owned_note(&db, &client, "job-5", CardJobState::Deleted).await.unwrap();
        assert_eq!(err.state, CardJobState::Resolving);
        assert_eq!(fake.notes().len(), 1, "the note was not deleted through another profile");
    }

    #[tokio::test]
    async fn a_missing_owned_note_is_not_readded_or_reconfirmed() {
        let (fake, url) = fixture().await;
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-6", "committing", &context(&url), true, Some(42));
        {
            let c = db.lock().unwrap();
            c.execute(
                "UPDATE card_job SET pending_operation='update',note_profile='User 1',pending_fields_json=?1 WHERE id='job-6'",
                [serde_json::to_string(&BTreeMap::from([("WordTranslation".to_string(), "новый".to_string())])).unwrap()],
            )
            .unwrap();
        }
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let job = update_owned_note(&db, &client, "job-6").await.unwrap();
        assert_eq!(job.state, CardJobState::Resolving);
        assert!(job.has_committed_note, "a missing lookup is not confirmed absence");
        assert_eq!(fake.count("addNote"), 0);
        assert!(fake.notes().is_empty());
    }

    #[tokio::test]
    async fn two_notes_with_the_same_marker_stay_unresolved() {
        let (fake, url) = fixture().await;
        fake.put(41, note("User 1", &["smartsubs-job::job-7"]));
        fake.put(42, note("User 1", &["smartsubs-job::job-7"]));
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-7", "committing", &context(&url), false, None);
        db.lock().unwrap().execute("UPDATE card_job SET pending_operation='add' WHERE id='job-7'", []).unwrap();
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let job = reconcile_job(&db, &client, "job-7").await.unwrap();
        assert_eq!(job.state, CardJobState::Resolving);
        assert!(job.error.as_deref().unwrap_or("").contains("2"));
        assert_eq!(fake.notes().len(), 2, "nothing is deleted automatically");
        assert_eq!(fake.count("addNote"), 0);
    }

    #[tokio::test]
    async fn an_action_error_after_a_stored_add_is_reconciled_before_any_resend() {
        let (fake, url) = fixture().await;
        fake.add_action_error.store(true, Ordering::SeqCst);
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-14", "generating", &context(&url), false, None);
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let job = commit_prepared(&db, &client, "job-14", 7, prepared()).await.unwrap();
        assert_eq!(job.state, CardJobState::Added);
        assert_eq!(fake.count("addNote"), 1, "an action error is never blindly retried");
        assert_eq!(fake.notes().len(), 1);
        assert_eq!(fake.notes()[0].1.tags.iter().filter(|t| t.starts_with("smartsubs-job::")).count(), 1);
    }

    #[tokio::test]
    async fn a_confirmed_add_is_never_added_again_by_a_stale_retry() {
        let (fake, url) = fixture().await;
        fake.drop_add.store(true, Ordering::SeqCst);
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-8", "generating", &context(&url), false, None);
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let job = commit_prepared(&db, &client, "job-8", 7, prepared()).await.unwrap();
        assert_eq!(job.state, CardJobState::Added);
        let err = commit_prepared(&db, &client, "job-8", 7, prepared()).await.unwrap_err();
        assert!(err.contains("изменилась"), "an added job rejects a stale resend: {err}");
        assert_eq!(fake.count("addNote"), 1);
        assert_eq!(fake.notes().len(), 1);
    }

    #[tokio::test]
    async fn after_a_zero_marker_a_later_attempt_adds_exactly_one_note() {
        let (fake, url) = fixture().await;
        fake.drop_add_silent.store(true, Ordering::SeqCst);
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-11", "generating", &context(&url), false, None);
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let failed = commit_prepared(&db, &client, "job-11", 7, prepared()).await.unwrap();
        assert_eq!(failed.state, CardJobState::Failed);
        assert!(!failed.has_committed_note);
        {
            let c = db.lock().unwrap();
            c.execute(
                "UPDATE card_job SET state='queued',version=version+1,revision=8 WHERE id='job-11'",
                [],
            )
            .unwrap();
        }
        let added = commit_prepared(&db, &client, "job-11", 8, prepared()).await.unwrap();
        assert_eq!(added.state, CardJobState::Added);
        assert_eq!(fake.count("addNote"), 2);
        assert_eq!(fake.notes().len(), 1, "the failed attempt left no note behind");
    }

    #[tokio::test]
    async fn save_rejects_external_edits_and_preserves_unowned_fields() {
        let (fake, url) = fixture().await;
        fake.put(42, note("User 1", &["smartsubs-job::job-12"]));
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-12", "editing", &context(&url), true, Some(42));
        let baseline = BTreeMap::from([
            ("Word".to_string(), "bring".to_string()),
            ("WordTranslation".to_string(), "принести".to_string()),
            ("ClozeText".to_string(), "It'll [...] him joy.".to_string()),
        ]);
        let owned = BTreeMap::from([("WordTranslation".to_string(), "принести".to_string())]);
        {
            let c = db.lock().unwrap();
            c.execute(
                "UPDATE card_job SET note_profile='User 1',baseline_fields_json=?1,owned_fields_json=?2 WHERE id='job-12'",
                rusqlite::params![serde_json::to_string(&baseline).unwrap(), serde_json::to_string(&owned).unwrap()],
            )
            .unwrap();
        }
        // Somebody changed the translation in Anki after the editor established its baseline.
        fake.notes.lock().unwrap().get_mut(&42).unwrap().fields.insert("WordTranslation".into(), "внешний".into());
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let draft = WordDraft {
            word: "bring".into(),
            translation: "новый".into(),
            word_type: "verb".into(),
            cloze_sentence: "It'll {{c1::bring}} him joy.".into(),
            full_sentence: "It'll bring him joy.".into(),
            sentence_translation: "Это доставит ему радость.".into(),
            image_prompt: "A gift".into(),
        };
        let submitted = BTreeMap::from([
            ("Word".to_string(), "bring".to_string()),
            ("WordTranslation".to_string(), "новый".to_string()),
            ("ClozeText".to_string(), "It'll [...] him joy.".to_string()),
        ]);
        let err = save_owned_note(&db, &client, "job-12", 7, draft.clone(), Some(submitted.clone()), Some(baseline.clone()))
            .await
            .unwrap_err();
        assert!(err.contains("изменена в Anki"), "external edit is visible: {err}");
        assert_eq!(fake.field(42, "WordTranslation").as_deref(), Some("внешний"));
        assert_eq!(load_db(&db, "job-12").await.unwrap().state, CardJobState::Editing);
        // Restore the baseline value and save; only the owned translation changes.
        fake.notes.lock().unwrap().get_mut(&42).unwrap().fields.insert("WordTranslation".into(), "принести".into());
        let job = save_owned_note(&db, &client, "job-12", 7, draft, Some(submitted), Some(baseline)).await.unwrap();
        assert_eq!(job.state, CardJobState::Added);
        assert_eq!(fake.field(42, "WordTranslation").as_deref(), Some("новый"));
        assert_eq!(fake.field(42, "Extra").as_deref(), Some("keep"), "unowned fields are untouched");
        assert_eq!(fake.field(42, "Word").as_deref(), Some("bring"));
        assert_eq!(fake.notes()[0].1.cards, vec![7], "cards and scheduling survive the edit");
        assert_eq!(fake.count("addNote"), 0);
    }

    #[tokio::test]
    async fn a_stale_revision_cannot_update_an_established_note() {
        let (fake, url) = fixture().await;
        fake.put(42, note("User 1", &["smartsubs-job::job-13"]));
        let db = memory_db();
        insert_job(&db.lock().unwrap(), "job-13", "editing", &context(&url), true, Some(42));
        db.lock().unwrap().execute("UPDATE card_job SET note_profile='User 1' WHERE id='job-13'", []).unwrap();
        let http = reqwest::Client::new();
        let client = connect::Client::new(&http, &url);
        let draft = WordDraft {
            word: "bring".into(),
            translation: "новый".into(),
            word_type: "verb".into(),
            cloze_sentence: "It'll {{c1::bring}} him joy.".into(),
            full_sentence: "It'll bring him joy.".into(),
            sentence_translation: "Это доставит ему радость.".into(),
            image_prompt: "A gift".into(),
        };
        let err = save_owned_note(&db, &client, "job-13", 6, draft, None, None).await.unwrap_err();
        assert!(err.contains("изменилась"));
        assert_eq!(fake.count("updateNoteFields"), 0);
    }

    #[tokio::test]
    async fn local_recovery_interrupts_reversible_work_and_resolves_sent_operations() {
        let db = memory_db();
        let ctx = context("http://127.0.0.1:9");
        {
            let c = db.lock().unwrap();
            insert_job(&c, "g", "grace", &ctx, false, None);
            insert_job(&c, "q", "generating", &ctx, false, None);
            insert_job(&c, "c", "committing", &ctx, false, None);
            insert_job(&c, "d", "deleting", &ctx, true, Some(42));
            insert_job(&c, "r", "resolving", &ctx, false, None);
            insert_job(&c, "x", "cancel_requested", &ctx, false, None);
            insert_job(&c, "y", "cancel_requested", &ctx, false, None);
            insert_job(&c, "e", "editing", &ctx, false, None);
            c.execute("UPDATE card_job SET pending_operation='add' WHERE id IN('c','y')", []).unwrap();
        }
        let rows = recover_local_db(&db).await.unwrap();
        assert!(rows.iter().any(|r| r.id == "g"));
        let state = |id: &str| load_db_sync(&db, id).state;
        assert_eq!(state("g"), CardJobState::Interrupted);
        assert_eq!(state("q"), CardJobState::Interrupted);
        assert_eq!(state("c"), CardJobState::Resolving, "a sent add stays resolvable");
        assert_eq!(state("d"), CardJobState::Resolving, "a sent delete stays resolvable");
        assert_eq!(state("r"), CardJobState::Resolving);
        assert_eq!(state("x"), CardJobState::Cancelled, "an unsent cancellation is safe to finish");
        assert_eq!(state("y"), CardJobState::Resolving);
        assert_eq!(state("e"), CardJobState::Editing, "an explicit editing hold survives a restart");
    }

    fn load_db_sync(db: &Arc<Mutex<Connection>>, id: &str) -> JobRow {
        load_sync(&db.lock().unwrap(), id).unwrap().unwrap()
    }

    #[tokio::test]
    async fn first_page_includes_all_active_jobs_and_rejects_a_bad_cursor() {
        let db = memory_db();
        let ctx = context("http://127.0.0.1:9");
        {
            let c = db.lock().unwrap();
            for i in 0..25 {
                insert_job_at(&c, &format!("done-{i:02}"), "added", &ctx, true, Some(100 + i), 1000 + i);
            }
            insert_job_at(&c, "live-1", "grace", &ctx, false, None, 5000);
            insert_job_at(&c, "live-2", "generating", &ctx, false, None, 5001);
            insert_job_at(&c, "live-3", "editing", &ctx, false, None, 5002);
        }
        let (items, active, next) = page_db(&db, None).await.unwrap();
        assert_eq!(items.len(), 20);
        assert_eq!(active.len(), 3, "every active job is returned on the first page");
        let next = next.expect("more rows exist");
        let (items2, active2, next2) = page_db(&db, Some(next.clone())).await.unwrap();
        assert_eq!(items2.len(), 8, "the remaining rows continue after the cursor");
        assert!(active2.is_empty());
        assert!(next2.is_none());
        let bad = JobCursor { created_at: next.created_at, id: "missing".into() };
        assert!(page_db(&db, Some(bad)).await.unwrap_err().contains("курсор"));
        let bad = JobCursor { created_at: -1, id: next.id.clone() };
        assert!(page_db(&db, Some(bad)).await.unwrap_err().contains("курсор"));
    }

    #[test]
    fn legacy_proposals_are_gated_and_never_blindly_retried() {
        assert!(proposal_gate("adding", 0).unwrap_err().contains("идентификатора Anki"));
        assert!(proposal_gate("failed", 0).unwrap_err().contains("идентификатора Anki"));
        assert!(proposal_gate("pending", 0).is_ok(), "a never-enqueued proposal can acquire jobs");
        assert!(proposal_gate("adding", 2).is_ok());
        assert!(proposal_gate("dismissed", 2).is_err());
    }

    #[test]
    fn proposal_enqueue_reuses_rows_and_retries_only_failures() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init(&c).unwrap();
        c.execute(
            "INSERT INTO proposal(id,media_id,cue_idx,words_json,status,created_at) VALUES(1,'m',3,?1,'pending',0)",
            [r#"[{"word":"a","translation":"a","word_type":"noun","cloze_sentence":"{{c1::a}}","full_sentence":"a","sentence_translation":"a","image_prompt":""},{"word":"b","translation":"b","word_type":"noun","cloze_sentence":"{{c1::b}}","full_sentence":"b","sentence_translation":"b","image_prompt":""}]"#],
        )
        .unwrap();
        let words = r#"[{"word":"a","translation":"a","word_type":"noun","cloze_sentence":"{{c1::a}}","full_sentence":"a","sentence_translation":"a","image_prompt":""},{"word":"b","translation":"b","word_type":"noun","cloze_sentence":"{{c1::b}}","full_sentence":"b","sentence_translation":"b","image_prompt":""}]"#;
        let status = enqueue_sync(&c, 1, &[0, 1], "{}", words).unwrap();
        assert_eq!(status, "adding");
        let count: i64 = c.query_row("SELECT COUNT(*) FROM card_job WHERE proposal_id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
        let job0: String = c.query_row("SELECT id FROM card_job WHERE proposal_id=1 AND word_index=0", [], |r| r.get(0)).unwrap();
        let job1: String = c.query_row("SELECT id FROM card_job WHERE proposal_id=1 AND word_index=1", [], |r| r.get(0)).unwrap();
        c.execute("UPDATE card_job SET state='added',note_confirmed=1,note_id=42 WHERE id=?1", rusqlite::params![job0]).unwrap();
        c.execute("UPDATE card_job SET state='failed',error='x' WHERE id=?1", rusqlite::params![job1]).unwrap();
        let status = enqueue_sync(&c, 1, &[0, 1], "{}", words).unwrap();
        assert_eq!(status, "adding");
        let (state0, note0): (String, Option<i64>) = c
            .query_row("SELECT state,note_id FROM card_job WHERE id=?1", rusqlite::params![job0], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(state0, "added", "an established success is skipped");
        assert_eq!(note0, Some(42));
        let (state1, revision1): (String, i64) = c
            .query_row("SELECT state,revision FROM card_job WHERE id=?1", rusqlite::params![job1], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(state1, "queued");
        assert_eq!(revision1, 1, "a retry advances the revision");
        assert!(enqueue_sync(&c, 1, &[5], "{}", words).unwrap_err().to_string().contains("номер"));
        assert!(enqueue_sync(&c, 1, &[0], "{}", "not json").is_err());
    }

    // ---- ignored: real Anki + real AnkiConnect + a one-shot lost-response proxy ---------------

    /// Manual smoke: `SMARTSUBS_ANKI_SMOKE_URL=http://127.0.0.1:8765 cargo test ... real_anki_note_lifecycle -- --ignored`.
    /// Owns a unique deck and full-UUID job IDs, uses the production commit/reconcile/update/delete
    /// helpers and removes only its own notes; a same-word control note with a different marker must
    /// survive, and the deck is deleted only when nothing unrelated remains in it.
    #[tokio::test]
    #[ignore]
    async fn real_anki_note_lifecycle() {
        use axum::{body::Bytes, extract::State, http::HeaderMap, response::IntoResponse, routing::post, Router};

        let real = std::env::var("SMARTSUBS_ANKI_SMOKE_URL").unwrap_or_else(|_| "http://127.0.0.1:8765".into());
        let http = reqwest::Client::new();
        let direct = connect::Client::new(&http, &real);
        if direct.version().await.is_err() {
            panic!("AnkiConnect is not reachable at {real}: start Anki with the AnkiConnect add-on");
        }
        let deck = format!("Smart Subtitles Smoke {}", uuid::Uuid::new_v4());
        direct.call("createDeck", json!({ "deck": deck }), Duration::from_secs(30)).await.unwrap();
        let work = std::env::temp_dir().join(format!("smartsubs-smoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&work).unwrap();
        let mut cleanup =
            Cleanup { url: real.clone(), notes: Vec::new(), decks: vec![deck.clone()], dirs: vec![work.clone()] };
        crate::anki::note_type::ensure(&direct, crate::anki::note_type::BUILTIN_NAME).await.unwrap();

        let png_path = work.join("image.png");
        let out = crate::proc::command("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-frames:v", "1", "-y"])
            .arg(&png_path)
            .output()
            .await
            .unwrap();
        assert!(out.status.success(), "ffmpeg png: {}", String::from_utf8_lossy(&out.stderr));
        let png = std::fs::read(&png_path).unwrap();

        #[derive(Clone)]
        struct Fixture {
            drop_add: Arc<std::sync::atomic::AtomicBool>,
            real: String,
        }

        async fn proxy(State(state): State<(Fixture, Arc<Fake>)>, headers: HeaderMap, body: Bytes) -> axum::response::Response {
            let (f, fake) = state;
            let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let action = v["action"].as_str().unwrap_or("");
            if action == "addNote" && f.drop_add.swap(false, Ordering::SeqCst) {
                // Accept the add on the real endpoint, then lose its reply.
                let r = reqwest::Client::new()
                    .post(&f.real)
                    .header("Connection", "close")
                    .header("Content-Type", headers.get("content-type").and_then(|h| h.to_str().ok()).unwrap_or("application/json"))
                    .body(body.clone())
                    .send()
                    .await;
                if let Ok(resp) = r {
                    let text = resp.text().await.unwrap_or_default();
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        if v["error"].is_null() {
                            *fake.calls.lock().unwrap().entry("lost_add".into()).or_default() += 1;
                        }
                    }
                }
                return (StatusCode::INTERNAL_SERVER_ERROR, "").into_response();
            }
            let r = reqwest::Client::new()
                .post(&f.real)
                .header("Connection", "close")
                .header("Content-Type", "application/json")
                .body(body)
                .send()
                .await;
            match r {
                Ok(resp) => {
                    let status = resp.status();
                    let bytes = resp.bytes().await.unwrap_or_default();
                    (status, bytes).into_response()
                }
                Err(e) => (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
            }
        }

        let pf = Fixture { drop_add: Arc::new(std::sync::atomic::AtomicBool::new(true)), real: real.clone() };
        let img_app = Router::new()
            .route("/img.png", axum::routing::get(move || {
                let bytes = png.clone();
                async move { (StatusCode::OK, bytes).into_response() }
            }))
            .route("/rw", post(|| async { Json(json!({ "data": [{ "imageURL": format!("{}/img.png", *BASE.read().unwrap()) }] })) }))
            .route("/v1/images/generations", post(|| async { (StatusCode::SERVICE_UNAVAILABLE, "{}") }));
        let img_base = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { let _ = axum::serve(listener, img_app).await; });
            format!("http://{addr}")
        };
        *BASE.write().unwrap() = img_base.clone();
        let openai = images::Spec {
            backend: "openai".into(),
            model: "gpt-image-1".into(),
            base_url: format!("{img_base}/v1"),
            api_key: "k".into(),
            size: "64x64".into(),
            agent_model: String::new(),
            inherited: false,
        };
        let runware = images::Spec {
            backend: "runware".into(),
            model: "runware:400@2".into(),
            base_url: format!("{img_base}/rw"),
            api_key: "r".into(),
            ..images::Spec::none()
        };
        let route = images::ResolvedRoute { specs: vec![openai, runware], style: String::new() };
        let cache = work.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let rt = images::ImageRuntime { http: &http, dir: &cache };
        let asset = images::generate_with_runtime(&rt, &route, "A blue square", &CancellationToken::new(), None).await.unwrap();
        assert_eq!(asset.provider, "runware");
        assert!(asset.path.is_file());

        let fake = Arc::new(Fake::default());
        let proxy_app = Router::new().route("/", post(proxy)).with_state((pf, fake.clone()));
        let proxy_base = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { let _ = axum::serve(listener, proxy_app).await; });
            format!("http://{addr}")
        };

        let job1 = uuid::Uuid::new_v4().to_string();
        let db_path = work.join("data.db");
        let conn = crate::db::open(&db_path).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let ctx = {
            let mut c = context(&proxy_base);
            c.anki.deck = deck.clone();
            c
        };
        insert_job(&db.lock().unwrap(), &job1, "generating", &ctx, false, None);
        let client = connect::Client::new(&http, &proxy_base);
        let media_name = format!("smoke_{}.png", &uuid::Uuid::new_v4().to_string()[..8]);
        let image_bytes = std::fs::read(&asset.path).unwrap();
        client.store_media(&media_name, &image_bytes).await.unwrap();
        let mut prepared = prepared();
        prepared.fields.insert("Image".into(), format!("<img src=\"{media_name}\">"));
        prepared.mapping.push(("Image".into(), Some(Source::Image)));
        let marker = format!("smartsubs-job::{job1}");
        let job = match commit_prepared(&db, &client, &job1, 7, prepared).await {
            Ok(job) => job,
            Err(e) => {
                // Even a failed assertion path must not leak a note this fixture created.
                if let Ok(ids) = direct.find_notes(&format!("tag:\"{marker}\"")).await {
                    cleanup.notes.extend(ids);
                }
                panic!("commit_prepared failed: {e}");
            }
        };
        assert_eq!(job.state, CardJobState::Added);
        assert_eq!(fake.count("lost_add"), 1, "the first accepted add answer was lost");
        let owned = direct.find_notes(&format!("tag:\"{marker}\"")).await.unwrap();
        assert_eq!(owned.len(), 1, "the reconciliation established exactly one note");
        let owned_id = owned[0];
        cleanup.notes.push(owned_id);

        let control_deck = format!("Smart Subtitles Control {}", uuid::Uuid::new_v4());
        direct.call("createDeck", json!({ "deck": control_deck }), Duration::from_secs(30)).await.unwrap();
        cleanup.decks.push(control_deck.clone());
        let control = direct
            .add_note(json!({
                "deckName": control_deck,
                "modelName": crate::anki::note_type::BUILTIN_NAME,
                "fields": { "Word": "bring", "ClozeText": "control" },
                "tags": [format!("smartsubs-job::control-{}", uuid::Uuid::new_v4())],
                "options": { "allowDuplicate": true },
            }))
            .await
            .unwrap();
        cleanup.notes.push(control);

        let cancelled = delete_owned_note(&db, &client, &job1, CardJobState::Cancelled).await.unwrap();
        assert_eq!(cancelled.state, CardJobState::Cancelled);
        assert!(direct.notes_info(&[owned_id]).await.unwrap().is_empty());
        assert!(!direct.notes_info(&[control]).await.unwrap().is_empty(), "the control note survives");

        let job2 = uuid::Uuid::new_v4().to_string();
        let job2_marker = format!("smartsubs-job::{job2}");
        let history_note = direct
            .add_note(json!({
                "deckName": deck,
                "modelName": crate::anki::note_type::BUILTIN_NAME,
                "fields": { "Word": "smoke-update", "WordTranslation": "старый", "ClozeText": "It'll [...] joy." },
                "tags": [job2_marker],
                "options": { "allowDuplicate": true },
            }))
            .await
            .unwrap();
        cleanup.notes.push(history_note);
        let note = direct.notes_info(&[history_note]).await.unwrap().pop().unwrap();
        let real_profile = note.profile;
        let card_ids = note.cards;
        let answers: Vec<Value> = card_ids.iter().map(|id| json!({ "cardId": id, "ease": 3 })).collect();
        let reviewed = direct.call("answerCards", json!({ "answers": answers }), Duration::from_secs(30)).await.unwrap();
        assert_eq!(reviewed, json!(vec![true; card_ids.len()]), "each owned fixture card was reviewed without navigating Anki");
        let cards = direct.call("cardsInfo", json!({ "cards": card_ids }), Duration::from_secs(10)).await.unwrap();
        let reviews = direct.call("getReviewsOfCards", json!({ "cards": card_ids }), Duration::from_secs(10)).await.unwrap();
        for id in &card_ids {
            assert_eq!(reviews[id.to_string()].as_array().map(Vec::len), Some(1), "the fixture made exactly one review");
        }
        let schedule: Vec<Value> = cards.as_array().unwrap().iter().map(|c| json!([c["interval"], c["due"], c["type"], c["queue"], c["reps"], c["lapses"], c["factor"]])).collect();

        {
            let c = db.lock().unwrap();
            insert_job(&c, &job2, "committing", &ctx, true, Some(history_note));
            c.execute(
                "UPDATE card_job SET pending_operation='update',pending_fields_json=?1,owned_fields_json=?2,baseline_fields_json=?2,note_profile=?3 WHERE id=?4",
                rusqlite::params![
                    serde_json::to_string(&BTreeMap::from([("WordTranslation".to_string(), "новый".to_string())])).unwrap(),
                    serde_json::to_string(&BTreeMap::from([("WordTranslation".to_string(), "старый".to_string())])).unwrap(),
                    real_profile,
                    job2,
                ],
            )
            .unwrap();
        }
        let updated = update_owned_note(&db, &client, &job2).await.unwrap();
        assert_eq!(updated.state, CardJobState::Added);
        assert_eq!(updated.note_id, Some(history_note));
        let after = direct.call("cardsInfo", json!({ "cards": card_ids }), Duration::from_secs(10)).await.unwrap();
        let schedule_after: Vec<Value> = after.as_array().unwrap().iter().map(|c| json!([c["interval"], c["due"], c["type"], c["queue"], c["reps"], c["lapses"], c["factor"]])).collect();
        assert_eq!(schedule, schedule_after, "scheduling history is untouched");
        let note_after = direct.notes_info(&[history_note]).await.unwrap();
        assert_eq!(note_after[0].field("WordTranslation"), Some("новый"));
        assert_eq!(note_after[0].cards, card_ids);
        let reviews_after = direct.call("getReviewsOfCards", json!({ "cards": card_ids }), Duration::from_secs(10)).await.unwrap();
        assert_eq!(reviews, reviews_after, "reviews are untouched");

        let deleted = delete_owned_note(&db, &client, &job2, CardJobState::Deleted).await.unwrap();
        assert_eq!(deleted.state, CardJobState::Deleted);
        assert!(direct.notes_info(&[history_note]).await.unwrap().is_empty());
        assert!(direct.find_notes(&format!("tag:\"{}\"", format!("smartsubs-job::{job2}"))).await.unwrap().is_empty());
        assert!(!direct.notes_info(&[control]).await.unwrap().is_empty(), "the control note still survives");

        drop(cleanup);
    }
}

