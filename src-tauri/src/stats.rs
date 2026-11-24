//! Local learning analytics: watch-time log, friction events, known words, and `/stats` aggregation.

use crate::{
    anki::index::AnkiCard,
    llm::{
        explain::Explanation,
        usage::{ModelUsageRow, TaskUsageRow},
    },
    patterns::PATTERNS,
    poster::{poster_path, url as poster_url},
    state::AppState,
    vocab::{self, CoreProgress},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Period {
    Days7,
    Days30,
    Days90,
    All,
}

impl Period {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or("30d").trim().to_ascii_lowercase().as_str() {
            "7d" | "7" => Self::Days7,
            "90d" | "90" => Self::Days90,
            "all" | "365d" => Self::All,
            _ => Self::Days30,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Days7 => "7d",
            Self::Days30 => "30d",
            Self::Days90 => "90d",
            Self::All => "all",
        }
    }

    fn days(self) -> Option<u32> {
        match self {
            Self::Days7 => Some(7),
            Self::Days30 => Some(30),
            Self::Days90 => Some(90),
            Self::All => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownWord {
    pub lemma: String,
    pub display: String,
    pub source: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownWordResult {
    pub lemma: String,
    pub display: String,
    pub known: bool,
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapDay {
    pub day: String,
    pub watched_sec: u64,
    pub films: u32,
    pub cards: u32,
    pub level: u8,
    pub future: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyBar {
    pub week_start: String,
    pub label: String,
    pub watched_sec: u64,
    pub films: u32,
    pub cards: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrictionPoint {
    pub media_id: String,
    pub label: String,
    pub title: String,
    pub lookups_per_10m: Option<f64>,
    pub replays_per_10m: Option<f64>,
    pub watched_min: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilmProfile {
    pub media_id: String,
    pub title: String,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub poster_url: Option<String>,
    pub watched_sec: u64,
    pub duration_sec: Option<f64>,
    pub cues_count: u32,
    pub comprehension_pct: Option<u8>,
    pub cefr_a: f32,
    pub cefr_b: f32,
    pub cefr_c: f32,
    pub cefr_other: f32,
    pub wpm: Option<u32>,
    pub lookups_per_10m: Option<f64>,
    pub replays_per_10m: Option<f64>,
    pub cards_added: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImmersionStats {
    pub watched_sec: u64,
    pub prev_watched_sec: Option<u64>,
    pub active_days: u32,
    pub films_count: u32,
    pub streak_days: u32,
    pub avg_session_min: u32,
    pub peak_weekday: Option<String>,
    pub avg_comprehension_pct: Option<u8>,
    pub lookups_per_10_min: Option<f64>,
    pub prev_lookups_per_10_min: Option<f64>,
    pub cards_added: u32,
    pub cards_active_or_learned: u32,
    pub heatmap: Vec<HeatmapDay>,
    pub weekly_bars: Vec<WeeklyBar>,
    pub friction_trend: Vec<FrictionPoint>,
    pub films: Vec<FilmProfile>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnkiMaturityStats {
    pub total: u32,
    pub learned: u32,
    pub young: u32,
    pub learning: u32,
    pub new_count: u32,
    pub weak: u32,
    pub leech: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnaddedWord {
    pub lemma: String,
    pub span: String,
    pub translation: String,
    pub media_id: String,
    pub title: String,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub cue_idx: u32,
    pub audio_index: u32,
    pub sub_offset: f64,
    pub quote: String,
    pub clicks: u32,
    pub films_count: u32,
    pub film_titles: Vec<String>,
    pub tier: Option<String>,
    pub cefr: Option<String>,
    pub above_level: bool,
    pub spoken: bool,
    pub business: bool,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyStats {
    pub ngsl_spoken: CoreProgress,
    pub ngsl: CoreProgress,
    pub known_count: u32,
    pub anki_connected: bool,
    pub anki_deck: String,
    pub anki_maturity: AnkiMaturityStats,
    pub anki_cefr: [u32; 6],
    pub in_window_pct: Option<u8>,
    pub unadded: Vec<UnaddedWord>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrammarLevelCount {
    pub level: String,
    pub encountered: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrammarPatternItem {
    pub id: String,
    pub count: u64,
    pub films_count: u32,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrammarStats {
    pub total: u32,
    pub encountered: u32,
    pub known: u32,
    pub learning: u32,
    pub by_level: Vec<GrammarLevelCount>,
    pub items: Vec<GrammarPatternItem>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpendBucket {
    pub key: String,
    pub label: String,
    pub annotate: f64,
    pub explain: f64,
    pub chat: f64,
    pub draft: f64,
    pub total_usd: f64,
    pub requests: u64,
    pub top_film: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilmSpendRow {
    pub media_id: String,
    pub title: String,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub poster_url: Option<String>,
    pub requests: u64,
    pub cached_pct: u8,
    pub usd: f64,
    pub partial: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiStats {
    pub total_usd: f64,
    pub partial: bool,
    pub avg_per_film_usd: Option<f64>,
    pub requests: u64,
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
    pub cache_hit_pct: u8,
    pub saved_usd_estimate: Option<f64>,
    pub granularity: String,
    pub series: Vec<SpendBucket>,
    pub by_task: Vec<TaskUsageRow>,
    pub by_model: Vec<ModelUsageRow>,
    pub by_film: Vec<FilmSpendRow>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatsOverview {
    pub period: String,
    pub learner_cefr: String,
    pub has_activity: bool,
    pub immersion: ImmersionStats,
    pub vocabulary: VocabularyStats,
    pub grammar: GrammarStats,
    pub ai: AiStats,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PatternFilmExample {
    pub media_id: String,
    pub title: String,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub cue_idx: u32,
    pub start_sec: f64,
    pub text: String,
    pub start_char: u32,
    pub end_char: u32,
}

pub fn record_watch_tick(conn: &Connection, media_id: &str, delta_sec: u32, now_ts: i64) -> rusqlite::Result<()> {
    let sec = delta_sec.clamp(1, 120) as i64;
    if media_id.trim().is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO watch_log(day,media_id,watched_sec,updated_at)
         VALUES(date(?3,'unixepoch','localtime'),?1,?2,?3)
         ON CONFLICT(day,media_id) DO UPDATE SET
           watched_sec = watch_log.watched_sec + excluded.watched_sec,
           updated_at = excluded.updated_at",
        params![media_id, sec, now_ts],
    )?;
    Ok(())
}

pub fn record_friction(
    conn: &Connection,
    media_id: &str,
    cue_idx: u32,
    kind: &str,
    span: Option<&str>,
    now_ts: i64,
) -> Result<(), String> {
    if !matches!(kind, "lookup" | "replay" | "slow_replay") {
        return Err("kind: lookup|replay|slow_replay".into());
    }
    let clean_span = span.map(str::trim).filter(|s| !s.is_empty());
    conn.execute(
        "INSERT INTO friction_event(media_id,cue_idx,kind,span,created_at) VALUES(?1,?2,?3,?4,?5)",
        params![media_id, cue_idx, kind, clean_span, now_ts],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_known_words(conn: &Connection) -> rusqlite::Result<Vec<KnownWord>> {
    let mut stmt = conn.prepare("SELECT lemma,display,source,created_at FROM known_word ORDER BY created_at DESC, lemma ASC")?;
    let rows = stmt.query_map([], |r| {
        Ok(KnownWord {
            lemma: r.get(0)?,
            display: r.get(1)?,
            source: r.get(2)?,
            created_at: r.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn set_known_word(conn: &Connection, word: &str, known: bool, now_ts: i64) -> Result<KnownWordResult, String> {
    let trimmed = word.trim();
    if trimmed.is_empty() {
        return Err("Слово не может быть пустым".into());
    }
    let idx = vocab::index();
    let canonical = idx.canonical_key(trimmed);
    let lemma = if canonical.is_empty() {
        trimmed.to_lowercase()
    } else {
        canonical
    };

    if known {
        conn.execute(
            "INSERT INTO known_word(lemma,display,source,created_at) VALUES(?1,?2,'app',?3)
             ON CONFLICT(lemma) DO UPDATE SET display=excluded.display",
            params![lemma, trimmed, now_ts],
        )
        .map_err(|e| e.to_string())?;
        Ok(KnownWordResult {
            lemma,
            display: trimmed.to_string(),
            known: true,
            created_at: Some(now_ts),
        })
    } else {
        conn.execute("DELETE FROM known_word WHERE lemma=?1", [&lemma])
            .map_err(|e| e.to_string())?;
        Ok(KnownWordResult {
            lemma,
            display: trimmed.to_string(),
            known: false,
            created_at: None,
        })
    }
}

fn local_day(conn: &Connection, ts: i64) -> rusqlite::Result<String> {
    conn.query_row("SELECT date(?1, 'unixepoch', 'localtime')", [ts], |r| r.get(0))
}

fn date_shift(conn: &Connection, day: &str, mod_str: &str) -> rusqlite::Result<String> {
    conn.query_row("SELECT date(?1, ?2)", params![day, mod_str], |r| r.get(0))
}

fn short_month_label(day: &str) -> String {
    let mut it = day.split('-');
    let _y = it.next();
    let m = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);
    let d = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);
    let mon = match m {
        1 => "янв",
        2 => "фев",
        3 => "мар",
        4 => "апр",
        5 => "май",
        6 => "июн",
        7 => "июл",
        8 => "авг",
        9 => "сен",
        10 => "окт",
        11 => "ноя",
        12 => "дек",
        _ => "",
    };
    format!("{d} {mon}")
}

fn weekday_ru(idx: i64) -> &'static str {
    match idx {
        0 => "воскресенье",
        1 => "понедельник",
        2 => "вторник",
        3 => "среда",
        4 => "четверг",
        5 => "пятница",
        6 => "суббота",
        _ => "",
    }
}

fn heatmap_level(sec: u64) -> u8 {
    match sec {
        0 => 0,
        1..=900 => 1,
        901..=2100 => 2,
        2101..=3600 => 3,
        _ => 4,
    }
}

fn compact_film_label(title: &str, season: Option<u32>, episode: Option<u32>) -> String {
    if let (Some(s), Some(e)) = (season, episode) {
        return format!("S{s}E{e}");
    }
    let clean = title.trim();
    let chars: Vec<char> = clean.chars().collect();
    if chars.len() <= 11 {
        clean.to_string()
    } else {
        let mut s: String = chars.into_iter().take(10).collect();
        s.push('…');
        s
    }
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn cefr_index(raw: &str) -> usize {
    match raw.trim().to_ascii_uppercase().as_str() {
        "A1" => 0,
        "A2" => 1,
        "B1" => 2,
        "B2" => 3,
        "C1" => 4,
        "C2" => 5,
        _ => 2,
    }
}

fn build_anki_sets(
    cards: &[AnkiCard],
) -> (HashSet<String>, HashSet<String>, HashSet<String>, AnkiMaturityStats, [u32; 6]) {
    let idx = vocab::index();
    let mut learned = HashSet::new();
    let mut learning = HashSet::new();
    let mut all_anki = HashSet::new();
    let mut maturity = AnkiMaturityStats::default();
    let mut cefr_counts = [0u32; 6];
    let mut seen_notes = HashSet::new();

    for c in cards {
        maturity.total += 1;
        match c.status {
            "learned" => maturity.learned += 1,
            "young" => maturity.young += 1,
            "learning" => maturity.learning += 1,
            "new" => maturity.new_count += 1,
            "weak" => maturity.weak += 1,
            "leech" => maturity.leech += 1,
            _ => {}
        }
        let lower = c.word.trim().to_lowercase();
        let canon = idx.canonical_key(&c.word);
        if !lower.is_empty() {
            all_anki.insert(lower.clone());
        }
        if !canon.is_empty() {
            all_anki.insert(canon.clone());
        }
        let is_learned_tier = matches!(c.status, "learned" | "young");
        for k in [lower.clone(), canon.clone()] {
            if k.is_empty() {
                continue;
            }
            if is_learned_tier {
                learned.insert(k);
            } else {
                learning.insert(k);
            }
        }
        let dedup = if canon.is_empty() { lower } else { canon };
        if !dedup.is_empty() && seen_notes.insert(dedup) {
            if let Some(rank) = idx.cefr_rank_of(&c.word) {
                if rank < 6 {
                    cefr_counts[rank] += 1;
                }
            }
        }
    }
    (learned, learning, all_anki, maturity, cefr_counts)
}

fn query_has_activity(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM watch_log)
             OR EXISTS(SELECT 1 FROM cue)
             OR EXISTS(SELECT 1 FROM media WHERE last_position > 0)
             OR EXISTS(SELECT 1 FROM explanation)
             OR EXISTS(SELECT 1 FROM exposure)
             OR EXISTS(SELECT 1 FROM card_job WHERE state NOT IN('cancelled','deleted'))
             OR EXISTS(SELECT 1 FROM llm_usage)",
        [],
        |r| r.get(0),
    )
}

fn query_streak_days(conn: &Connection, today: &str) -> rusqlite::Result<u32> {
    let mut stmt = conn.prepare(
        "SELECT CAST(julianday(day) AS INTEGER) AS jd
         FROM watch_log
         WHERE watched_sec > 0 AND day <= ?1
         GROUP BY day
         ORDER BY jd DESC",
    )?;
    let today_jd: i64 = conn.query_row("SELECT CAST(julianday(?1) AS INTEGER)", [today], |r| r.get(0))?;
    let jds: Vec<i64> = stmt.query_map([today], |r| r.get(0))?.collect::<Result<_, _>>()?;
    if jds.is_empty() {
        return Ok(0);
    }
    // Allow an active streak from yesterday when nothing has been watched today yet.
    let first = jds[0];
    if first < today_jd - 1 {
        return Ok(0);
    }
    let mut streak = 1u32;
    let mut expected = first - 1;
    for &jd in &jds[1..] {
        if jd == expected {
            streak += 1;
            expected -= 1;
        } else if jd < expected {
            break;
        }
    }
    Ok(streak)
}

fn query_heatmap(conn: &Connection, today: &str) -> rusqlite::Result<Vec<HeatmapDay>> {
    let end_sunday: String = conn.query_row("SELECT date(?1, 'weekday 0')", [today], |r| r.get(0))?;
    let start_monday: String = date_shift(conn, &end_sunday, "-125 days")?;

    let mut watch_map: HashMap<String, (u64, u32)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT day, COALESCE(SUM(watched_sec),0), COUNT(DISTINCT CASE WHEN watched_sec > 0 THEN media_id END)
             FROM watch_log
             WHERE day >= ?1 AND day <= ?2
             GROUP BY day",
        )?;
        let rows = stmt.query_map(params![start_monday, end_sunday], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?.max(0) as u64, r.get::<_, u32>(2)?))
        })?;
        for row in rows {
            let (d, sec, films) = row?;
            watch_map.insert(d, (sec, films));
        }
    }

    let mut cards_map: HashMap<String, u32> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT date(created_at, 'unixepoch', 'localtime') AS d, COUNT(*)
             FROM card_job
             WHERE state NOT IN ('cancelled','deleted')
               AND date(created_at, 'unixepoch', 'localtime') >= ?1
               AND date(created_at, 'unixepoch', 'localtime') <= ?2
             GROUP BY d",
        )?;
        let rows = stmt.query_map(params![start_monday, end_sunday], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?))
        })?;
        for row in rows {
            let (d, cnt) = row?;
            cards_map.insert(d, cnt);
        }
    }

    let mut stmt = conn.prepare(
        "WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 125)
         SELECT date(?1, '+' || n || ' days') FROM seq",
    )?;
    let days: Vec<String> = stmt.query_map([&start_monday], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let out = days
        .into_iter()
        .map(|day| {
            let future = day.as_str() > today;
            let (watched_sec, films) = if future { (0, 0) } else { watch_map.get(&day).copied().unwrap_or((0, 0)) };
            let cards = if future { 0 } else { cards_map.get(&day).copied().unwrap_or(0) };
            HeatmapDay {
                level: if future { 0 } else { heatmap_level(watched_sec) },
                day,
                watched_sec,
                films,
                cards,
                future,
            }
        })
        .collect();
    Ok(out)
}

fn query_weekly_bars(conn: &Connection, today: &str) -> rusqlite::Result<Vec<WeeklyBar>> {
    let cur_sunday: String = conn.query_row("SELECT date(?1, 'weekday 0')", [today], |r| r.get(0))?;
    let cur_monday: String = date_shift(conn, &cur_sunday, "-6 days")?;
    let first_monday: String = date_shift(conn, &cur_monday, "-77 days")?; // 12 weeks

    let mut watch_map: HashMap<String, (u64, u32)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT date(day, 'weekday 0', '-6 days') AS wk,
                    COALESCE(SUM(watched_sec),0),
                    COUNT(DISTINCT CASE WHEN watched_sec > 0 THEN media_id END)
             FROM watch_log
             WHERE day >= ?1 AND day <= ?2
             GROUP BY wk",
        )?;
        let rows = stmt.query_map(params![first_monday, cur_sunday], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?.max(0) as u64, r.get::<_, u32>(2)?))
        })?;
        for r in rows {
            let (wk, sec, films) = r?;
            watch_map.insert(wk, (sec, films));
        }
    }

    let mut card_map: HashMap<String, u32> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT date(created_at, 'unixepoch', 'localtime', 'weekday 0', '-6 days') AS wk, COUNT(*)
             FROM card_job
             WHERE state NOT IN ('cancelled','deleted')
               AND date(created_at, 'unixepoch', 'localtime') >= ?1
             GROUP BY wk",
        )?;
        let rows = stmt.query_map([&first_monday], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?)))?;
        for r in rows {
            let (wk, cnt) = r?;
            card_map.insert(wk, cnt);
        }
    }

    let mut out = Vec::with_capacity(12);
    for w in 0..12 {
        let ws = date_shift(conn, &first_monday, &format!("+{} days", w * 7))?;
        let (watched_sec, films) = watch_map.get(&ws).copied().unwrap_or((0, 0));
        let cards = card_map.get(&ws).copied().unwrap_or(0);
        out.push(WeeklyBar {
            label: short_month_label(&ws),
            week_start: ws,
            watched_sec,
            films,
            cards,
        });
    }
    Ok(out)
}

fn query_films_and_friction(
    conn: &Connection,
    period: Period,
    today: &str,
    since_ts: i64,
    since_day: Option<&str>,
    learner_cefr: &str,
    anki_known: &HashSet<String>,
    user_known: &HashSet<String>,
    port: u16,
) -> rusqlite::Result<(Vec<FilmProfile>, Vec<FrictionPoint>)> {
    struct RawFilm {
        id: String,
        title: String,
        season: Option<u32>,
        episode: Option<u32>,
        duration: Option<f64>,
        last_position: f64,
        updated_at: i64,
        watch_sec_period: u64,
        watch_sec_all: u64,
        last_watch_at: i64,
        cues_count: u32,
        last_cue_end: f64,
        cards_added: u32,
        fe_lookups: u64,
        expl_count: u64,
        fe_replays: u64,
    }

    let since_day_param = since_day.unwrap_or("1970-01-01");
    let ts_param = if period.days().is_some() { since_ts } else { 0 };

    let mut stmt = conn.prepare(
        "SELECT m.id, m.title, m.season, m.episode, m.duration, m.last_position, m.updated_at,
                COALESCE((SELECT SUM(w.watched_sec) FROM watch_log w WHERE w.media_id=m.id AND w.day >= ?1 AND w.day <= ?2), 0),
                COALESCE((SELECT SUM(w.watched_sec) FROM watch_log w WHERE w.media_id=m.id), 0),
                COALESCE((SELECT MAX(w.updated_at) FROM watch_log w WHERE w.media_id=m.id), m.updated_at),
                (SELECT COUNT(*) FROM cue WHERE media_id=m.id),
                COALESCE((SELECT MAX(end) FROM cue WHERE media_id=m.id), 0.0),
                (SELECT COUNT(*) FROM card_job WHERE media_id=m.id AND state NOT IN ('cancelled','deleted') AND created_at >= ?3),
                (SELECT COUNT(*) FROM friction_event WHERE media_id=m.id AND kind='lookup' AND created_at >= ?3),
                (SELECT COUNT(*) FROM explanation WHERE media_id=m.id AND created_at >= ?3),
                (SELECT COUNT(*) FROM friction_event WHERE media_id=m.id AND kind IN ('replay','slow_replay') AND created_at >= ?3)
         FROM media m
         WHERE m.hidden = 0 OR EXISTS(SELECT 1 FROM watch_log w WHERE w.media_id=m.id)
         ORDER BY MAX(m.updated_at, COALESCE((SELECT MAX(w.updated_at) FROM watch_log w WHERE w.media_id=m.id), 0)) DESC
         LIMIT 15",
    )?;
    let raw_films: Vec<RawFilm> = stmt
        .query_map(params![since_day_param, today, ts_param], |r| {
            Ok(RawFilm {
                id: r.get(0)?,
                title: r.get(1)?,
                season: r.get(2)?,
                episode: r.get(3)?,
                duration: r.get(4)?,
                last_position: r.get(5)?,
                updated_at: r.get(6)?,
                watch_sec_period: r.get::<_, i64>(7)?.max(0) as u64,
                watch_sec_all: r.get::<_, i64>(8)?.max(0) as u64,
                last_watch_at: r.get(9)?,
                cues_count: r.get(10)?,
                last_cue_end: r.get(11)?,
                cards_added: r.get(12)?,
                fe_lookups: r.get::<_, i64>(13)?.max(0) as u64,
                expl_count: r.get::<_, i64>(14)?.max(0) as u64,
                fe_replays: r.get::<_, i64>(15)?.max(0) as u64,
            })
        })?
        .collect::<Result<_, _>>()?;

    let idx = vocab::index();
    let mut cue_stmt = conn.prepare("SELECT text FROM cue WHERE media_id=?1 ORDER BY idx")?;

    let mut profiles = Vec::with_capacity(raw_films.len());
    let mut trend_rows: Vec<(i64, FrictionPoint)> = Vec::new();

    for f in raw_films {
        let cues: Vec<String> = if f.cues_count > 0 {
            cue_stmt.query_map([&f.id], |r| r.get(0))?.collect::<Result<_, _>>()?
        } else {
            Vec::new()
        };
        let analyzed = idx.analyze_cues(&cues, learner_cefr, anki_known, user_known);
        let speech_sec = f.duration.unwrap_or(0.0).max(f.last_cue_end);
        let wpm = if f.cues_count > 0 && speech_sec >= 30.0 && analyzed.total_words > 0 {
            let v = ((analyzed.total_words as f64) / (speech_sec / 60.0)).round() as u32;
            (v <= 400).then_some(v)
        } else {
            None
        };

        let watched_sec = if period == Period::All {
            if f.watch_sec_all > 0 {
                f.watch_sec_all
            } else {
                f.last_position.max(0.0).round() as u64
            }
        } else if f.watch_sec_period > 0 {
            f.watch_sec_period
        } else if f.watch_sec_all == 0 && f.updated_at >= ts_param {
            f.last_position.max(0.0).round() as u64
        } else {
            0
        };

        let denom_sec = if watched_sec >= 60 {
            watched_sec as f64
        } else if f.last_position >= 60.0 && (period == Period::All || f.updated_at >= ts_param) {
            f.last_position
        } else {
            0.0
        };

        let lookups = f.fe_lookups.max(f.expl_count);
        let (lookups_per_10m, replays_per_10m) = if denom_sec >= 60.0 {
            let blocks = denom_sec / 600.0;
            (Some(round1(lookups as f64 / blocks)), Some(round1(f.fe_replays as f64 / blocks)))
        } else {
            (None, None)
        };

        let has_signal = denom_sec >= 60.0 && (lookups > 0 || f.fe_replays > 0 || watched_sec >= 120);
        if has_signal {
            let label = compact_film_label(&f.title, f.season, f.episode);
            trend_rows.push((
                f.last_watch_at.max(f.updated_at),
                FrictionPoint {
                    media_id: f.id.clone(),
                    label,
                    title: f.title.clone(),
                    lookups_per_10m,
                    replays_per_10m,
                    watched_min: (denom_sec / 60.0).round() as u32,
                },
            ));
        }

        profiles.push(FilmProfile {
            poster_url: poster_path(&f.id).exists().then(|| poster_url(port, &f.id)),
            media_id: f.id,
            title: f.title,
            season: f.season,
            episode: f.episode,
            watched_sec,
            duration_sec: f.duration,
            cues_count: f.cues_count,
            comprehension_pct: (analyzed.total_words > 0).then_some(analyzed.comprehension_pct),
            cefr_a: analyzed.cefr_a,
            cefr_b: analyzed.cefr_b,
            cefr_c: analyzed.cefr_c,
            cefr_other: analyzed.cefr_other,
            wpm,
            lookups_per_10m,
            replays_per_10m,
            cards_added: f.cards_added,
        });
    }

    // Trend reads left-to-right chronologically for the most recent 10 films.
    trend_rows.sort_by_key(|(ts, _)| *ts);
    if trend_rows.len() > 10 {
        trend_rows = trend_rows.split_off(trend_rows.len() - 10);
    }
    let friction_trend = trend_rows.into_iter().map(|(_, p)| p).collect();
    Ok((profiles, friction_trend))
}

fn query_unadded_words(
    conn: &Connection,
    learner_cefr: &str,
    anki_set: &HashSet<String>,
    user_known: &HashSet<String>,
) -> rusqlite::Result<Vec<UnaddedWord>> {
    let idx = vocab::index();

    // Active card jobs also exclude a word from unadded suggestions.
    let mut job_keys = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT span, draft_json FROM card_job WHERE state NOT IN ('cancelled','deleted')",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)))?;
        for row in rows {
            let (span, draft_json) = row?;
            if let Some(sp) = span {
                let low = sp.trim().to_lowercase();
                if !low.is_empty() {
                    job_keys.insert(low);
                }
                let k = idx.canonical_key(&sp);
                if !k.is_empty() {
                    job_keys.insert(k);
                }
            }
            if let Some(dj) = draft_json.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
                if let Some(w) = dj["word"].as_str() {
                    let low = w.trim().to_lowercase();
                    if !low.is_empty() {
                        job_keys.insert(low);
                    }
                    let k = idx.canonical_key(w);
                    if !k.is_empty() {
                        job_keys.insert(k);
                    }
                }
            }
        }
    }

    let mut fe_clicks: HashMap<(String, u32, String), u32> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT media_id, cue_idx, LOWER(TRIM(COALESCE(span,''))), COUNT(*)
             FROM friction_event
             WHERE kind='lookup' AND span IS NOT NULL AND TRIM(span) != ''
             GROUP BY media_id, cue_idx, LOWER(TRIM(span))",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?, r.get::<_, String>(2)?, r.get::<_, u32>(3)?)))?;
        for r in rows {
            let (mid, cidx, sp, cnt) = r?;
            fe_clicks.insert((mid, cidx, sp), cnt);
        }
    }

    struct Acc {
        lemma: String,
        best_span: String,
        translation: String,
        media_id: String,
        title: String,
        season: Option<u32>,
        episode: Option<u32>,
        cue_idx: u32,
        audio_index: u32,
        sub_offset: f64,
        quote: String,
        clicks: u32,
        films: HashSet<String>,
        film_titles: Vec<String>,
        last_seen_at: i64,
    }

    let mut groups: HashMap<String, Acc> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT e.media_id, e.cue_idx, e.span, e.json, e.created_at,
                m.title, m.season, m.episode, COALESCE(m.audio_index, 0), m.sub_offset, c.text
         FROM explanation e
         JOIN media m ON m.id = e.media_id
         JOIN cue c ON c.media_id = e.media_id AND c.idx = e.cue_idx
         ORDER BY e.created_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, u32>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, Option<u32>>(6)?,
            r.get::<_, Option<u32>>(7)?,
            r.get::<_, u32>(8)?,
            r.get::<_, f64>(9)?,
            r.get::<_, String>(10)?,
        ))
    })?;

    for row in rows {
        let (media_id, cue_idx, span, json_str, created_at, title, season, episode, audio_index, sub_offset, quote) = row?;
        let expl = serde_json::from_str::<Explanation>(&json_str).unwrap_or_default();
        let display_term = if expl.chunk.trim().is_empty() {
            span.trim().to_string()
        } else {
            expl.chunk.trim().to_string()
        };
        if display_term.is_empty() {
            continue;
        }
        let canon = idx.canonical_key(&display_term);
        let span_canon = idx.canonical_key(&span);
        let key = if !canon.is_empty() {
            canon
        } else if !span_canon.is_empty() {
            span_canon
        } else {
            display_term.to_lowercase()
        };
        let lower_disp = display_term.to_lowercase();
        let lower_span = span.trim().to_lowercase();

        if user_known.contains(&key)
            || user_known.contains(&lower_disp)
            || anki_set.contains(&key)
            || anki_set.contains(&lower_disp)
            || anki_set.contains(&lower_span)
            || job_keys.contains(&key)
            || job_keys.contains(&lower_disp)
            || job_keys.contains(&lower_span)
        {
            continue;
        }

        let clicks_for_row = fe_clicks
            .get(&(media_id.clone(), cue_idx, lower_span))
            .copied()
            .unwrap_or(1)
            .max(1);
        let film_label = if let (Some(s), Some(e)) = (season, episode) {
            format!("{title} S{s}E{e}")
        } else {
            title.clone()
        };

        let entry = groups.entry(key.clone()).or_insert_with(|| Acc {
            lemma: key,
            best_span: span.trim().to_string(),
            translation: expl.translation.clone(),
            media_id: media_id.clone(),
            title: title.clone(),
            season,
            episode,
            cue_idx,
            audio_index,
            sub_offset,
            quote: quote.replace('\n', " "),
            clicks: 0,
            films: HashSet::new(),
            film_titles: Vec::new(),
            last_seen_at: created_at,
        });
        entry.clicks += clicks_for_row;
        if entry.films.insert(media_id) && entry.film_titles.len() < 4 {
            entry.film_titles.push(film_label);
        }
        if created_at >= entry.last_seen_at {
            entry.last_seen_at = created_at;
        }
    }

    let mut out: Vec<UnaddedWord> = groups
        .into_values()
        .map(|acc| {
            let info = idx.lookup(&acc.best_span, learner_cefr);
            let fallback_info = if info.found { info } else { idx.lookup(&acc.lemma, learner_cefr) };
            UnaddedWord {
                lemma: acc.lemma,
                span: acc.best_span,
                translation: acc.translation,
                media_id: acc.media_id,
                title: acc.title,
                season: acc.season,
                episode: acc.episode,
                cue_idx: acc.cue_idx,
                audio_index: acc.audio_index,
                sub_offset: acc.sub_offset,
                quote: acc.quote,
                clicks: acc.clicks,
                films_count: acc.films.len() as u32,
                film_titles: acc.film_titles,
                tier: fallback_info.tier.map(str::to_string),
                cefr: fallback_info.cefr.map(str::to_string),
                above_level: fallback_info.above_level,
                spoken: fallback_info.spoken,
                business: fallback_info.business,
                last_seen_at: acc.last_seen_at,
            }
        })
        .collect();

    fn tier_rank(t: Option<&str>) -> u8 {
        match t {
            Some("core") => 0,
            Some("common") => 1,
            Some("uncommon") => 2,
            None => 3,
            Some("rare") => 4,
            _ => 5,
        }
    }

    out.sort_by(|a, b| {
        let a_rare_pen = if a.above_level && a.tier.as_deref() == Some("rare") { 1 } else { 0 };
        let b_rare_pen = if b.above_level && b.tier.as_deref() == Some("rare") { 1 } else { 0 };
        a_rare_pen
            .cmp(&b_rare_pen)
            .then_with(|| tier_rank(a.tier.as_deref()).cmp(&tier_rank(b.tier.as_deref())))
            .then_with(|| a.above_level.cmp(&b.above_level))
            .then_with(|| {
                let sa = a.clicks * 2 + a.films_count * 3;
                let sb = b.clicks * 2 + b.films_count * 3;
                sb.cmp(&sa)
            })
            .then_with(|| b.last_seen_at.cmp(&a.last_seen_at))
    });
    out.truncate(50);
    Ok(out)
}

fn query_grammar(conn: &Connection) -> rusqlite::Result<GrammarStats> {
    let mut counts: HashMap<String, (u64, u32)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT pattern_id, COUNT(*), COUNT(DISTINCT media_id) FROM exposure GROUP BY pattern_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?.max(0) as u64, r.get::<_, u32>(2)?)))?;
        for r in rows {
            let (id, cnt, films) = r?;
            counts.insert(id, (cnt, films));
        }
    }

    let mut states: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT pattern_id, status FROM pattern_state")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for r in rows {
            let (id, st) = r?;
            states.insert(id, st);
        }
    }

    let mut encountered = 0u32;
    let mut known = 0u32;
    let mut learning = 0u32;
    let mut by_level_map: BTreeMap<&'static str, (u32, u32)> = BTreeMap::new();
    let mut items = Vec::with_capacity(PATTERNS.len());

    for p in PATTERNS.iter() {
        let (count, films_count) = counts.get(&p.id).copied().unwrap_or((0, 0));
        let status = states.get(&p.id).cloned();
        if count > 0 {
            encountered += 1;
        }
        match status.as_deref() {
            Some("known") => known += 1,
            Some("learning") => learning += 1,
            _ => {}
        }
        let lvl_key = match p.level.as_str() {
            "A1" => "A1",
            "A2" => "A2",
            "B1" => "B1",
            "B2" => "B2",
            _ => "C1",
        };
        let e = by_level_map.entry(lvl_key).or_insert((0, 0));
        e.1 += 1;
        if count > 0 {
            e.0 += 1;
        }
        items.push(GrammarPatternItem {
            id: p.id.clone(),
            count,
            films_count,
            status,
        });
    }

    let by_level = ["A1", "A2", "B1", "B2", "C1"]
        .into_iter()
        .filter_map(|lvl| {
            by_level_map.get(lvl).map(|&(enc, tot)| GrammarLevelCount {
                level: lvl.to_string(),
                encountered: enc,
                total: tot,
            })
        })
        .collect();

    Ok(GrammarStats {
        total: PATTERNS.len() as u32,
        encountered,
        known,
        learning,
        by_level,
        items,
    })
}

fn query_ai(conn: &Connection, period: Period, today: &str, now_ts: i64, port: u16) -> rusqlite::Result<AiStats> {
    let since_ts = match period.days() {
        Some(d) => now_ts - (d as i64) * 86400,
        None => 0,
    };

    let (total_usd, partial, requests, input_tokens, cached_tokens, output_tokens, films_with_usage): (
        f64,
        bool,
        u64,
        u64,
        u64,
        u64,
        u32,
    ) = conn.query_row(
        "SELECT COALESCE(SUM(usd),0.0),
                MAX(CASE WHEN usd IS NULL THEN 1 ELSE 0 END),
                COUNT(*),
                COALESCE(SUM(input + cache_write),0),
                COALESCE(SUM(cache_read),0),
                COALESCE(SUM(output),0),
                COUNT(DISTINCT CASE WHEN media_id != '' THEN media_id END)
         FROM llm_usage
         WHERE created_at >= ?1",
        [since_ts],
        |r| {
            Ok((
                r.get(0)?,
                r.get::<_, Option<i64>>(1)?.unwrap_or(0) != 0,
                r.get::<_, i64>(2)?.max(0) as u64,
                r.get::<_, i64>(3)?.max(0) as u64,
                r.get::<_, i64>(4)?.max(0) as u64,
                r.get::<_, i64>(5)?.max(0) as u64,
                r.get::<_, i64>(6)?.max(0) as u32,
            ))
        },
    )?;

    let total_prompt = input_tokens + cached_tokens;
    let cache_hit_pct = if total_prompt > 0 {
        ((cached_tokens as f64 / total_prompt as f64) * 100.0).round().clamp(0.0, 100.0) as u8
    } else {
        0
    };
    let avg_per_film_usd = (films_with_usage > 0).then_some(total_usd / films_with_usage as f64);
    let saved_usd_estimate = if cached_tokens > 0 && input_tokens > 0 && total_usd > 0.0 {
        // Rough conservative saving estimate assuming ~85% cache read discount vs regular input pricing.
        let est = (cached_tokens as f64) * (total_usd / (input_tokens as f64 + output_tokens as f64 * 3.0).max(1.0)) * 0.85;
        (est >= 0.005).then_some(est)
    } else {
        None
    };

    let by_task: Vec<TaskUsageRow> = {
        let mut stmt = conn.prepare(
            "SELECT task, COUNT(*), COALESCE(SUM(input + cache_write),0), COALESCE(SUM(cache_read),0),
                    COALESCE(SUM(output),0), COALESCE(SUM(usd),0.0), MAX(CASE WHEN usd IS NULL THEN 1 ELSE 0 END)
             FROM llm_usage WHERE created_at >= ?1
             GROUP BY task
             ORDER BY COALESCE(SUM(usd),0.0) DESC, COUNT(*) DESC, task ASC",
        )?;
        let rows = stmt.query_map([since_ts], |r| {
            Ok(TaskUsageRow {
                task: r.get(0)?,
                requests: r.get::<_, i64>(1)?.max(0) as u64,
                input_tokens: r.get::<_, i64>(2)?.max(0) as u64,
                cached_tokens: r.get::<_, i64>(3)?.max(0) as u64,
                output_tokens: r.get::<_, i64>(4)?.max(0) as u64,
                usd: r.get(5)?,
                partial: r.get::<_, i64>(6)? != 0,
            })
        })?;
        rows.collect::<Result<_, _>>()?
    };

    let by_model: Vec<ModelUsageRow> = {
        let mut stmt = conn.prepare(
            "SELECT model, COUNT(*), COALESCE(SUM(input + cache_write),0), COALESCE(SUM(cache_read),0),
                    COALESCE(SUM(output),0), COALESCE(SUM(usd),0.0), MAX(CASE WHEN usd IS NULL THEN 1 ELSE 0 END)
             FROM llm_usage WHERE created_at >= ?1
             GROUP BY model
             ORDER BY COALESCE(SUM(usd),0.0) DESC, COUNT(*) DESC, model ASC",
        )?;
        let rows = stmt.query_map([since_ts], |r| {
            Ok(ModelUsageRow {
                model: r.get(0)?,
                requests: r.get::<_, i64>(1)?.max(0) as u64,
                input_tokens: r.get::<_, i64>(2)?.max(0) as u64,
                cached_tokens: r.get::<_, i64>(3)?.max(0) as u64,
                output_tokens: r.get::<_, i64>(4)?.max(0) as u64,
                usd: r.get(5)?,
                partial: r.get::<_, i64>(6)? != 0,
            })
        })?;
        rows.collect::<Result<_, _>>()?
    };

    let by_film: Vec<FilmSpendRow> = {
        let mut stmt = conn.prepare(
            "SELECT m.id, m.title, m.season, m.episode, COUNT(*),
                    COALESCE(SUM(u.input + u.cache_write),0), COALESCE(SUM(u.cache_read),0),
                    COALESCE(SUM(u.usd),0.0), MAX(CASE WHEN u.usd IS NULL THEN 1 ELSE 0 END)
             FROM llm_usage u
             JOIN media m ON m.id = u.media_id
             WHERE u.created_at >= ?1
             GROUP BY m.id
             ORDER BY COALESCE(SUM(u.usd),0.0) DESC, COUNT(*) DESC
             LIMIT 50",
        )?;
        let rows = stmt.query_map([since_ts], |r| {
            let media_id: String = r.get(0)?;
            let inp = r.get::<_, i64>(5)?.max(0) as u64;
            let cache = r.get::<_, i64>(6)?.max(0) as u64;
            let tot = inp + cache;
            let cached_pct = if tot > 0 { ((cache as f64 / tot as f64) * 100.0).round().clamp(0.0, 100.0) as u8 } else { 0 };
            Ok(FilmSpendRow {
                poster_url: poster_path(&media_id).exists().then(|| poster_url(port, &media_id)),
                media_id,
                title: r.get(1)?,
                season: r.get(2)?,
                episode: r.get(3)?,
                requests: r.get::<_, i64>(4)?.max(0) as u64,
                cached_pct,
                usd: r.get(7)?,
                partial: r.get::<_, i64>(8)? != 0,
            })
        })?;
        rows.collect::<Result<_, _>>()?
    };

    let by_day = matches!(period, Period::Days7 | Period::Days30);
    let granularity = if by_day { "day".to_string() } else { "week".to_string() };

    let bucket_expr = if by_day {
        "date(u.created_at, 'unixepoch', 'localtime')"
    } else {
        "date(u.created_at, 'unixepoch', 'localtime', 'weekday 0', '-6 days')"
    };

    #[derive(Default)]
    struct BucketAcc {
        annotate: f64,
        explain: f64,
        chat: f64,
        draft: f64,
        requests: u64,
        film_usd: HashMap<String, f64>,
    }

    let mut bucket_map: BTreeMap<String, BucketAcc> = BTreeMap::new();
    {
        let sql = format!(
            "SELECT {bucket_expr} AS bk, u.task, COALESCE(SUM(u.usd),0.0), COUNT(*), COALESCE(m.title,'')
             FROM llm_usage u
             LEFT JOIN media m ON m.id = u.media_id
             WHERE u.created_at >= ?1
             GROUP BY bk, u.task, u.media_id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([since_ts], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, i64>(3)?.max(0) as u64,
                r.get::<_, String>(4)?,
            ))
        })?;
        for r in rows {
            let (bk, task, usd, reqs, ftitle) = r?;
            let acc = bucket_map.entry(bk).or_default();
            match task.as_str() {
                "annotate" => acc.annotate += usd,
                "explain" => acc.explain += usd,
                "chat" => acc.chat += usd,
                "draft" => acc.draft += usd,
                _ => acc.explain += usd,
            }
            acc.requests += reqs;
            if !ftitle.is_empty() {
                *acc.film_usd.entry(ftitle).or_default() += usd;
            }
        }
    }

    let keys: Vec<String> = if by_day {
        let count = period.days().unwrap_or(30) as i32;
        (0..count)
            .map(|i| date_shift(conn, today, &format!("-{} days", count - 1 - i)))
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else if period == Period::Days90 {
        let cur_mon: String = conn.query_row("SELECT date(?1, 'weekday 0', '-6 days')", [today], |r| r.get(0))?;
        (0..13)
            .map(|i| date_shift(conn, &cur_mon, &format!("-{} days", (12 - i) * 7)))
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        bucket_map.keys().cloned().collect()
    };

    let series = keys
        .into_iter()
        .map(|key| {
            let acc = bucket_map.remove(&key).unwrap_or_default();
            let top_film = acc
                .film_usd
                .into_iter()
                .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(t, _)| t);
            let total_b = acc.annotate + acc.explain + acc.chat + acc.draft;
            let label = if by_day && key == today {
                "Сегодня".to_string()
            } else {
                short_month_label(&key)
            };
            SpendBucket {
                key,
                label,
                annotate: acc.annotate,
                explain: acc.explain,
                chat: acc.chat,
                draft: acc.draft,
                total_usd: total_b,
                requests: acc.requests,
                top_film,
            }
        })
        .collect();

    Ok(AiStats {
        total_usd,
        partial,
        avg_per_film_usd,
        requests,
        input_tokens,
        cached_tokens,
        output_tokens,
        cache_hit_pct,
        saved_usd_estimate,
        granularity,
        series,
        by_task,
        by_model,
        by_film,
    })
}

pub fn query_overview(
    conn: &Connection,
    raw_period: Option<&str>,
    anki_cards: &[AnkiCard],
    anki_connected: bool,
    anki_deck: &str,
    learner_cefr: &str,
    port: u16,
    now_ts: i64,
) -> rusqlite::Result<StatsOverview> {
    let period = Period::parse(raw_period);
    let today = local_day(conn, now_ts)?;
    let has_activity = query_has_activity(conn)?;

    let (since_ts, since_day, prev_since_ts, prev_since_day) = match period.days() {
        Some(d) => {
            let cur_ts = now_ts - (d as i64) * 86400;
            let prev_ts = now_ts - 2 * (d as i64) * 86400;
            let cur_day = date_shift(conn, &today, &format!("-{} days", d - 1))?;
            let prev_day = date_shift(conn, &today, &format!("-{} days", d * 2 - 1))?;
            (cur_ts, Some(cur_day), Some(prev_ts), Some(prev_day))
        }
        None => (0, None, None, None),
    };

    let (watched_sec, active_days, films_count): (u64, u32, u32) = match &since_day {
        Some(sd) => conn.query_row(
            "SELECT COALESCE(SUM(watched_sec),0),
                    COUNT(DISTINCT CASE WHEN watched_sec > 0 THEN day END),
                    COUNT(DISTINCT CASE WHEN watched_sec > 0 THEN media_id END)
             FROM watch_log
             WHERE day >= ?1 AND day <= ?2",
            params![sd, today],
            |r| Ok((r.get::<_, i64>(0)?.max(0) as u64, r.get(1)?, r.get(2)?)),
        )?,
        None => conn.query_row(
            "SELECT COALESCE(SUM(watched_sec),0),
                    COUNT(DISTINCT CASE WHEN watched_sec > 0 THEN day END),
                    COUNT(DISTINCT CASE WHEN watched_sec > 0 THEN media_id END)
             FROM watch_log",
            [],
            |r| Ok((r.get::<_, i64>(0)?.max(0) as u64, r.get(1)?, r.get(2)?)),
        )?,
    };

    let prev_watched_sec: Option<u64> = match (&since_day, &prev_since_day) {
        (Some(sd), Some(pd)) => Some(conn.query_row(
            "SELECT COALESCE(SUM(watched_sec),0) FROM watch_log WHERE day >= ?1 AND day < ?2",
            params![pd, sd],
            |r| Ok(r.get::<_, i64>(0)?.max(0) as u64),
        )?),
        _ => None,
    };

    let avg_session_min = if active_days > 0 {
        ((watched_sec as f64 / active_days as f64) / 60.0).round() as u32
    } else {
        0
    };

    let peak_weekday: Option<String> = match &since_day {
        Some(sd) => conn
            .query_row(
                "SELECT CAST(strftime('%w', day) AS INTEGER) AS wd
                 FROM watch_log WHERE day >= ?1 AND day <= ?2 AND watched_sec > 0
                 GROUP BY wd ORDER BY SUM(watched_sec) DESC LIMIT 1",
                params![sd, today],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .map(|wd| weekday_ru(wd).to_string()),
        None => conn
            .query_row(
                "SELECT CAST(strftime('%w', day) AS INTEGER) AS wd
                 FROM watch_log WHERE watched_sec > 0
                 GROUP BY wd ORDER BY SUM(watched_sec) DESC LIMIT 1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .map(|wd| weekday_ru(wd).to_string()),
    };

    let lookup_count_for = |from_ts: i64, to_ts: i64| -> rusqlite::Result<u64> {
        let fe: u64 = conn.query_row(
            "SELECT COUNT(*) FROM friction_event WHERE kind='lookup' AND created_at >= ?1 AND created_at < ?2",
            params![from_ts, to_ts],
            |r| Ok(r.get::<_, i64>(0)?.max(0) as u64),
        )?;
        let ex: u64 = conn.query_row(
            "SELECT COUNT(*) FROM explanation WHERE created_at >= ?1 AND created_at < ?2",
            params![from_ts, to_ts],
            |r| Ok(r.get::<_, i64>(0)?.max(0) as u64),
        )?;
        Ok(fe.max(ex))
    };

    let cur_lookups = lookup_count_for(since_ts, now_ts + 1)?;
    let lookups_per_10_min = (watched_sec >= 60).then(|| round1(cur_lookups as f64 / (watched_sec as f64 / 600.0)));
    let prev_lookups_per_10_min = match (prev_since_ts, prev_watched_sec) {
        (Some(pts), Some(pw)) if pw >= 60 => {
            let pl = lookup_count_for(pts, since_ts)?;
            Some(round1(pl as f64 / (pw as f64 / 600.0)))
        }
        _ => None,
    };

    let cards_added: u32 = conn.query_row(
        "SELECT COUNT(*) FROM card_job WHERE state NOT IN ('cancelled','deleted') AND created_at >= ?1",
        [since_ts],
        |r| r.get(0),
    )?;

    let known_rows = list_known_words(conn)?;
    let known_count = known_rows.len() as u32;
    let user_known: HashSet<String> = known_rows.into_iter().map(|k| k.lemma).collect();

    let (learned_set, learning_set, anki_all_set, anki_maturity, anki_cefr) =
        build_anki_sets(anki_cards);

    let learner_idx = cefr_index(learner_cefr);
    let max_win_idx = (learner_idx + 1).min(5);
    let cefr_classified_total: u32 = anki_cefr.iter().sum();
    let in_window_pct = (cefr_classified_total > 0).then(|| {
        let in_win: u32 = anki_cefr[learner_idx..=max_win_idx].iter().sum();
        ((in_win as f64 / cefr_classified_total as f64) * 100.0).round() as u8
    });

    let (ngsl_spoken, ngsl) = vocab::index().core_coverage(&learned_set, &learning_set, &user_known);
    let unadded = query_unadded_words(conn, learner_cefr, &anki_all_set, &user_known)?;

    let (films, friction_trend) = query_films_and_friction(
        conn,
        period,
        &today,
        since_ts,
        since_day.as_deref(),
        learner_cefr,
        &learned_set,
        &user_known,
        port,
    )?;

    let comp_vals: Vec<u32> = films.iter().filter_map(|f| f.comprehension_pct.map(u32::from)).collect();
    let avg_comprehension_pct = (!comp_vals.is_empty()).then(|| {
        ((comp_vals.iter().sum::<u32>() as f64) / comp_vals.len() as f64).round() as u8
    });

    let heatmap = query_heatmap(conn, &today)?;
    let weekly_bars = query_weekly_bars(conn, &today)?;
    let streak_days = query_streak_days(conn, &today)?;

    let cards_active_or_learned = anki_maturity.learned + anki_maturity.young + anki_maturity.learning;

    Ok(StatsOverview {
        period: period.as_str().to_string(),
        learner_cefr: learner_cefr.to_ascii_uppercase(),
        has_activity,
        immersion: ImmersionStats {
            watched_sec,
            prev_watched_sec,
            active_days,
            films_count,
            streak_days,
            avg_session_min,
            peak_weekday,
            avg_comprehension_pct,
            lookups_per_10_min,
            prev_lookups_per_10_min,
            cards_added,
            cards_active_or_learned,
            heatmap,
            weekly_bars,
            friction_trend,
            films,
        },
        vocabulary: VocabularyStats {
            ngsl_spoken,
            ngsl,
            known_count,
            anki_connected,
            anki_deck: anki_deck.to_string(),
            anki_maturity,
            anki_cefr,
            in_window_pct,
            unadded,
        },
        grammar: query_grammar(conn)?,
        ai: query_ai(conn, period, &today, now_ts, port)?,
    })
}

pub fn query_pattern_examples(conn: &Connection, pattern_id: &str, limit: usize) -> rusqlite::Result<Vec<PatternFilmExample>> {
    let lim = limit.clamp(1, 30) as i64;
    let mut stmt = conn.prepare(
        "SELECT m.id, m.title, m.season, m.episode, c.idx, c.start, c.text, p.start_char, p.end_char
         FROM cue_pattern p
         JOIN cue c ON c.media_id = p.media_id AND c.idx = p.cue_idx
         JOIN media m ON m.id = p.media_id
         LEFT JOIN exposure ex ON ex.pattern_id = p.pattern_id AND ex.media_id = p.media_id AND ex.cue_idx = p.cue_idx
         WHERE p.pattern_id = ?1
         ORDER BY (ex.seen_at IS NOT NULL) DESC, COALESCE(ex.seen_at, m.updated_at) DESC, c.idx ASC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![pattern_id, lim], |r| {
        Ok(PatternFilmExample {
            media_id: r.get(0)?,
            title: r.get(1)?,
            season: r.get(2)?,
            episode: r.get(3)?,
            cue_idx: r.get(4)?,
            start_sec: r.get(5)?,
            text: r.get(6)?,
            start_char: r.get(7)?,
            end_char: r.get(8)?,
        })
    })?;
    rows.collect()
}

/// Async state wrapper for `stats_overview`.
pub async fn overview_for(st: &AppState, period: Option<String>) -> Result<StatsOverview, String> {
    let cfg = st.cfg();
    let learner_cefr = cfg.learner.cefr.clone();
    let anki_deck = cfg.anki.deck.clone();
    let port = st.listen_port;
    let (anki_cards, anki_connected) = {
        let a = st.anki.lock().unwrap();
        (a.cards.clone(), a.updated_at.is_some() && a.last_error.is_none())
    };
    let now_ts = crate::db::now();
    st.db(move |c| {
        query_overview(
            c,
            period.as_deref(),
            &anki_cards,
            anki_connected,
            &anki_deck,
            &learner_cefr,
            port,
            now_ts,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn card(word: &str, status: &'static str) -> AnkiCard {
        AnkiCard {
            word: word.into(),
            translation: "перевод".into(),
            status,
            interval: if status == "learned" { 30 } else { 3 },
            lapses: 0,
        }
    }

    #[test]
    fn watch_tick_clamps_and_accumulates_and_friction_validates() {
        let c = Connection::open_in_memory().unwrap();
        db::init(&c).unwrap();
        let now_ts = 1_760_000_000;
        record_watch_tick(&c, "m1", 200, now_ts).unwrap();
        record_watch_tick(&c, "m1", 25, now_ts + 5).unwrap();
        let total: i64 = c.query_row("SELECT watched_sec FROM watch_log WHERE media_id='m1'", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 145);

        assert!(record_friction(&c, "m1", 3, "replay", None, now_ts).is_ok());
        assert!(record_friction(&c, "m1", 4, "slow_replay", None, now_ts).is_ok());
        assert!(record_friction(&c, "m1", 4, "invalid", None, now_ts).is_err());
    }

    #[test]
    fn known_word_canonicalizes_and_toggles() {
        let c = Connection::open_in_memory().unwrap();
        db::init(&c).unwrap();
        let res = set_known_word(&c, "  Deciding  ", true, 1000).unwrap();
        assert_eq!(res.lemma, "decide");
        assert!(res.known);
        assert_eq!(list_known_words(&c).unwrap().len(), 1);

        let rm = set_known_word(&c, "decided", false, 1005).unwrap();
        assert_eq!(rm.lemma, "decide");
        assert!(!rm.known);
        assert_eq!(list_known_words(&c).unwrap().len(), 0);
    }

    #[test]
    fn overview_on_empty_db_returns_126_day_heatmap_and_no_activity() {
        let c = Connection::open_in_memory().unwrap();
        db::init(&c).unwrap();
        let ov = query_overview(&c, Some("30d"), &[], false, "Learning English", "B1", 47800, 1_760_000_000).unwrap();
        assert!(!ov.has_activity);
        assert_eq!(ov.period, "30d");
        assert_eq!(ov.immersion.heatmap.len(), 126);
        assert_eq!(ov.immersion.weekly_bars.len(), 12);
        assert_eq!(ov.grammar.total, 48);
        assert_eq!(ov.ai.series.len(), 30);
    }

    #[test]
    fn overview_aggregates_watch_friction_unadded_grammar_and_ai() {
        let c = Connection::open_in_memory().unwrap();
        db::init(&c).unwrap();
        let now_ts = 1_760_000_000;

        c.execute(
            "INSERT INTO media(id,kind,source_url,title,duration,last_position,audio_index,sub_offset,updated_at)
             VALUES('m1','file','file:///a.mkv','The Truman Show',6000.0,1800.0,1,0.5,?1)",
            [now_ts - 600],
        )
        .unwrap();
        c.execute(
            "INSERT INTO cue(media_id,idx,start,end,text) VALUES
             ('m1',0,10.0,14.0,'I decided to go early.'),
             ('m1',1,15.0,19.0,'She is reluctant to leave.'),
             ('m1',2,20.0,25.0,'They have been waiting for hours.')",
            [],
        )
        .unwrap();

        // Watch streak across today & yesterday
        record_watch_tick(&c, "m1", 120, now_ts).unwrap();
        record_watch_tick(&c, "m1", 120, now_ts - 86_400).unwrap();
        record_friction(&c, "m1", 1, "lookup", Some("reluctant"), now_ts - 120).unwrap();
        record_friction(&c, "m1", 1, "lookup", Some("reluctant"), now_ts - 60).unwrap();
        record_friction(&c, "m1", 1, "replay", None, now_ts - 50).unwrap();

        // Explanations: reluctant (unadded), decided (in Anki -> filtered), ephemeral (in known_word -> filtered)
        c.execute(
            "INSERT INTO explanation(media_id,cue_idx,span,json,created_at) VALUES
             ('m1',1,'reluctant','{\"chunk\":\"reluctant\",\"translation\":\"неохотный\"}',?1),
             ('m1',0,'decided','{\"chunk\":\"decide\",\"translation\":\"решать\"}',?1),
             ('m1',2,'ephemeral','{\"chunk\":\"ephemeral\",\"translation\":\"мимолётный\"}',?1),
             ('m1',2,'waiting','{\"chunk\":\"wait\",\"translation\":\"ждать\"}',?1)",
            [now_ts - 30],
        )
        .unwrap();
        set_known_word(&c, "ephemeral", true, now_ts - 20).unwrap();

        // Active card job excludes "waiting" too
        c.execute(
            "INSERT INTO card_job(id,origin,media_id,cue_idx,span,state,context_json,created_at,updated_at)
             VALUES('j1','quick','m1',2,'waiting','queued','{}',?1,?1)",
            [now_ts - 10],
        )
        .unwrap();

        c.execute(
            "INSERT INTO cue_pattern(media_id,cue_idx,pattern_id,start_char,end_char)
             VALUES('m1',2,'PRESENT_PERFECT_CONT',5,22)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO exposure(pattern_id,media_id,cue_idx,seen_at) VALUES('PRESENT_PERFECT_CONT','m1',2,?1)",
            [now_ts - 10],
        )
        .unwrap();
        c.execute(
            "INSERT INTO pattern_state(pattern_id,status,updated_at) VALUES('PRESENT_PERFECT_CONT','learning',?1)",
            [now_ts - 10],
        )
        .unwrap();

        c.execute(
            "INSERT INTO llm_usage(media_id,task,model,input,cache_read,cache_write,output,usd,created_at)
             VALUES('m1','annotate','deepseek-flash',1000,2000,0,150,0.05,?1),
                   ('m1','explain','claude-haiku-5-5',400,600,0,80,0.03,?1)",
            [now_ts - 15],
        )
        .unwrap();

        let cards = vec![card("decide", "learned"), card("ambiguous", "learning")];
        let ov = query_overview(&c, Some("30d"), &cards, true, "Learning English", "B1", 47800, now_ts).unwrap();

        assert!(ov.has_activity);
        assert_eq!(ov.immersion.watched_sec, 240);
        assert_eq!(ov.immersion.streak_days, 2);
        assert_eq!(ov.immersion.films.len(), 1);
        assert_eq!(ov.immersion.films[0].cards_added, 1);

        assert_eq!(ov.vocabulary.known_count, 1);
        assert_eq!(ov.vocabulary.ngsl.learned, 1);
        assert_eq!(ov.vocabulary.unadded.len(), 1);
        assert_eq!(ov.vocabulary.unadded[0].lemma, "reluctant");
        assert_eq!(ov.vocabulary.unadded[0].clicks, 2);

        assert_eq!(ov.grammar.encountered, 1);
        assert_eq!(ov.grammar.learning, 1);

        assert_eq!(ov.ai.requests, 2);
        assert!((ov.ai.total_usd - 0.08).abs() < 1e-6);
        assert_eq!(ov.ai.by_film.len(), 1);

        let exs = query_pattern_examples(&c, "PRESENT_PERFECT_CONT", 10).unwrap();
        assert_eq!(exs.len(), 1);
        assert_eq!(exs[0].cue_idx, 2);
        assert_eq!(exs[0].start_char, 5);
    }

    #[test]
    fn ai_series_sums_multiple_requests_per_day_and_picks_top_film_by_total() {
        let c = Connection::open_in_memory().unwrap();
        db::init(&c).unwrap();
        let now_ts = 1_760_000_000;

        c.execute(
            "INSERT INTO media(id,kind,source_url,title,updated_at) VALUES
             ('m1','file','file:///a.mkv','Film Alpha',?1),
             ('m2','file','file:///b.mkv','Film Beta',?1)",
            [now_ts - 100],
        )
        .unwrap();

        c.execute(
            "INSERT INTO llm_usage(media_id,task,model,input,cache_read,cache_write,output,usd,created_at) VALUES
             ('m1','annotate','m',100,0,0,20,0.011,?1),
             ('m1','annotate','m',100,0,0,20,0.012,?2),
             ('m1','explain','m',100,0,0,20,0.005,?3),
             ('m1','explain','m',100,0,0,20,0.007,?4),
             ('m2','annotate','m',200,0,0,40,0.018,?5)",
            params![now_ts - 40, now_ts - 30, now_ts - 20, now_ts - 15, now_ts - 10],
        )
        .unwrap();

        let ov = query_overview(&c, Some("7d"), &[], false, "Learning English", "B1", 47800, now_ts).unwrap();
        assert!((ov.ai.total_usd - 0.053).abs() < 1e-6);

        let today_bucket = ov.ai.series.last().unwrap();
        assert_eq!(today_bucket.requests, 5);
        assert!((today_bucket.annotate - 0.041).abs() < 1e-6);
        assert!((today_bucket.explain - 0.012).abs() < 1e-6);
        assert!((today_bucket.total_usd - ov.ai.total_usd).abs() < 1e-6);
        assert_eq!(today_bucket.top_film.as_deref(), Some("Film Alpha"));
    }

    #[test]
    fn film_wpm_prefers_max_cue_span_over_truncated_duration_and_drops_outliers() {
        let c = Connection::open_in_memory().unwrap();
        db::init(&c).unwrap();
        let now_ts = 1_760_000_000;

        c.execute(
            "INSERT INTO media(id,kind,source_url,title,duration,last_position,updated_at) VALUES
             ('m1','file','file:///a.mkv','Dark Knight',120.0,60.0,?1),
             ('m2','file','file:///b.mkv','Glitch Film',35.0,10.0,?1)",
            [now_ts - 50],
        )
        .unwrap();

        let sentence = "We must protect the city tonight before chaos spreads everywhere across every bridge and street now.";
        for idx in 0..100u32 {
            let end = if idx == 99 { 3600.0 } else { (idx as f64 + 1.0) * 35.0 };
            c.execute(
                "INSERT INTO cue(media_id,idx,start,end,text) VALUES('m1',?1,?2,?3,?4)",
                params![idx, end - 3.0, end, sentence],
            )
            .unwrap();
        }
        // Dense cues in 35s (> 400 wpm) must be dropped as outlier.
        for idx in 0..25u32 {
            let end = if idx == 24 { 35.0 } else { idx as f64 + 1.2 };
            c.execute(
                "INSERT INTO cue(media_id,idx,start,end,text) VALUES('m2',?1,?2,?3,?4)",
                params![idx, end - 1.0, end, sentence],
            )
            .unwrap();
        }

        let ov = query_overview(&c, Some("30d"), &[], false, "Learning English", "B1", 47800, now_ts).unwrap();
        let f1 = ov.immersion.films.iter().find(|f| f.media_id == "m1").unwrap();
        let f2 = ov.immersion.films.iter().find(|f| f.media_id == "m2").unwrap();
        assert_eq!(f1.wpm, Some(27));
        assert_eq!(f2.wpm, None);
    }
}
