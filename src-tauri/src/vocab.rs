//! Offline English frequency and CEFR lookup backed by `data/vocab.tsv.gz`.
//!
//! Built from NGSL 1.2, NGSL-Spoken 1.2, BSL 1.2.0, FrequencyWords en_50k (OpenSubtitles 2018),
//! CEFR-J 1.5, and Octanove C1/C2 1.0 (see `THIRD_PARTY_NOTICES.md`).

use crate::state::AppState;
use flate2::read::GzDecoder;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    sync::LazyLock,
};

const RAW_GZ: &[u8] = include_bytes!("../data/vocab.tsv.gz");
const MAX_BATCH: usize = 50;

static INDEX: LazyLock<VocabIndex> =
    LazyLock::new(|| VocabIndex::from_gz(RAW_GZ).expect("embedded vocab.tsv.gz"));

static FUNCTION_WORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "a", "an", "the", "and", "or", "but", "so", "if", "than", "that", "this", "these", "those",
        "there", "here", "it", "its", "i", "me", "my", "mine", "we", "us", "our", "ours", "you",
        "your", "yours", "he", "him", "his", "she", "her", "hers", "they", "them", "their",
        "theirs", "am", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
        "have", "has", "had", "will", "would", "shall", "should", "can", "could", "may", "might",
        "must", "not", "no", "yes", "to", "of", "in", "on", "at", "by", "for", "with", "from",
        "into", "onto", "about", "as", "up", "out", "off", "over", "under", "again", "then",
        "too", "very", "just", "also", "what", "where", "when", "who", "whom", "whose", "which",
        "why", "how", "all", "any", "some", "one", "someone", "somebody", "something", "anyone",
        "anybody", "anything", "everyone", "everybody", "everything", "nobody", "nothing",
    ]
    .into_iter()
    .collect()
});

static SEPARABLE_PRONOUNS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "it", "him", "her", "them", "me", "us", "you", "this", "that", "one",
        "i", "he", "she", "we", "they",
    ]
    .into_iter()
    .collect()
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Cefr {
    A1 = 0,
    A2 = 1,
    B1 = 2,
    B2 = 3,
    C1 = 4,
    C2 = 5,
}

impl Cefr {
    fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_uppercase().as_str() {
            "A1" => Some(Self::A1),
            "A2" => Some(Self::A2),
            "B1" => Some(Self::B1),
            "B2" => Some(Self::B2),
            "C1" => Some(Self::C1),
            "C2" => Some(Self::C2),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::A1 => "A1",
            Self::A2 => "A2",
            Self::B1 => "B1",
            Self::B2 => "B2",
            Self::C1 => "C1",
            Self::C2 => "C2",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CefrSource {
    CefrJ,
    Octanove,
}

impl CefrSource {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "J" => Some(Self::CefrJ),
            "O" => Some(Self::Octanove),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::CefrJ => "CEFR-J 1.5",
            Self::Octanove => "Octanove C1/C2",
        }
    }
}

#[derive(Debug, Clone, Default)]
struct VocabEntry {
    ngsl: Option<u32>,
    ngsl_s: Option<u32>,
    bsl: Option<u32>,
    fw: Option<u32>,
    zipf_x100: Option<u16>,
    cefr: Option<Cefr>,
    cefr_src: Option<CefrSource>,
}

impl VocabEntry {
    fn has_strong(&self) -> bool {
        self.ngsl.is_some() || self.ngsl_s.is_some() || self.bsl.is_some() || self.cefr.is_some()
    }
}

pub struct VocabIndex {
    lemmas: HashMap<String, VocabEntry>,
    forms: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocabRanks {
    pub ngsl: Option<u32>,
    pub ngsl_spoken: Option<u32>,
    pub bsl: Option<u32>,
    pub subtitles: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocabPart {
    pub word: String,
    pub lemma: Option<String>,
    pub tier: Option<&'static str>,
    pub cefr: Option<&'static str>,
    pub function_word: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocabInfo {
    pub query: String,
    pub lemma: Option<String>,
    pub is_phrase: bool,
    pub found: bool,
    pub tier: Option<&'static str>,
    pub cefr: Option<&'static str>,
    pub cefr_source: Option<&'static str>,
    pub above_level: bool,
    pub ranks: VocabRanks,
    pub zipf: Option<f32>,
    pub business: bool,
    pub spoken: bool,
    pub film_count: u32,
    pub parts: Vec<VocabPart>,
}

enum Section {
    None,
    Lemmas,
    Forms,
}

fn opt_u32(s: &str) -> Option<u32> {
    if s.is_empty() { None } else { s.parse().ok() }
}

fn opt_u16(s: &str) -> Option<u16> {
    if s.is_empty() { None } else { s.parse().ok() }
}

fn normalize(s: &str) -> String {
    s.to_lowercase()
        .replace(['\u{2018}', '\u{2019}', '\u{02bc}'], "'")
        .trim()
        .to_string()
}

fn tokens_of(s: &str) -> Vec<String> {
    normalize(s)
        .split(|c: char| !c.is_ascii_lowercase() && c != '\'')
        .map(|t| t.trim_matches('\'').to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

fn contraction_lemma(t: &str) -> Option<Option<&'static str>> {
    Some(match t {
        "don't" | "doesn't" | "didn't" => Some("do"),
        "isn't" | "aren't" | "wasn't" | "weren't" | "i'm" | "you're" | "we're" | "they're"
        | "he's" | "she's" | "it's" | "that's" | "there's" => Some("be"),
        "can't" => Some("can"),
        "couldn't" => Some("could"),
        "won't" => Some("will"),
        "wouldn't" => Some("would"),
        "shouldn't" => Some("should"),
        "haven't" | "hasn't" | "hadn't" => Some("have"),
        "mustn't" => Some("must"),
        "what's" => Some("what"),
        "let's" => Some("let"),
        "ain't" => None,
        _ => return None,
    })
}

fn strip_clitic(t: &str) -> Option<&str> {
    for suffix in ["'s", "'re", "'ve", "'ll", "'d", "'m"] {
        if let Some(base) = t.strip_suffix(suffix) {
            if !base.is_empty() {
                return Some(base);
            }
        }
    }
    None
}

fn undouble(stem: &str) -> Option<String> {
    let bytes = stem.as_bytes();
    if bytes.len() >= 2 && bytes[bytes.len() - 1] == bytes[bytes.len() - 2] {
        Some(stem[..stem.len() - 1].to_string())
    } else {
        None
    }
}

fn push_candidate(out: &mut Vec<String>, c: String) {
    if c.len() >= 2 && !out.contains(&c) {
        out.push(c);
    }
}

/// Candidate lemmas for regular English inflections, ordered most likely first.
fn rule_candidates(t: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(stem) = t.strip_suffix("ies") {
        push_candidate(&mut out, format!("{stem}y"));
    }
    if let Some(stem) = t.strip_suffix("ves") {
        push_candidate(&mut out, format!("{stem}f"));
        push_candidate(&mut out, format!("{stem}fe"));
    }
    if t.ends_with('s') && !t.ends_with("ss") {
        push_candidate(&mut out, t[..t.len() - 1].to_string());
    }
    if ["ses", "xes", "zes", "ches", "shes", "oes"].iter().any(|suf| t.ends_with(suf)) {
        push_candidate(&mut out, t[..t.len() - 2].to_string());
    }
    if let Some(stem) = t.strip_suffix("ied") {
        push_candidate(&mut out, format!("{stem}y"));
    }
    if let Some(stem) = t.strip_suffix("ed") {
        push_candidate(&mut out, stem.to_string());
        push_candidate(&mut out, format!("{stem}e"));
        if let Some(u) = undouble(stem) {
            push_candidate(&mut out, u);
        }
    }
    if let Some(stem) = t.strip_suffix("ing") {
        push_candidate(&mut out, stem.to_string());
        push_candidate(&mut out, format!("{stem}e"));
        if let Some(u) = undouble(stem) {
            push_candidate(&mut out, u);
        }
        if let Some(base) = stem.strip_suffix('y') {
            push_candidate(&mut out, format!("{base}ie"));
        }
    }
    if let Some(stem) = t.strip_suffix("ier") {
        push_candidate(&mut out, format!("{stem}y"));
    } else if let Some(stem) = t.strip_suffix("iest") {
        push_candidate(&mut out, format!("{stem}y"));
    }
    for suf in ["er", "est"] {
        if let Some(stem) = t.strip_suffix(suf) {
            push_candidate(&mut out, stem.to_string());
            push_candidate(&mut out, format!("{stem}e"));
            if let Some(u) = undouble(stem) {
                push_candidate(&mut out, u);
            }
        }
    }
    if let Some(stem) = t.strip_suffix("ily") {
        push_candidate(&mut out, format!("{stem}y"));
    }
    if let Some(stem) = t.strip_suffix("ly") {
        push_candidate(&mut out, stem.to_string());
    }
    out
}

fn tier_of_entry(e: &VocabEntry) -> &'static str {
    if e.ngsl.is_some() || e.ngsl_s.is_some() || e.fw.is_some_and(|r| r <= 2_500) {
        "core"
    } else if e.fw.is_some_and(|r| r <= 10_000)
        || e.bsl.is_some()
        || matches!(e.cefr, Some(Cefr::A1 | Cefr::A2 | Cefr::B1))
    {
        "common"
    } else if e.fw.is_some_and(|r| r <= 25_000) || matches!(e.cefr, Some(Cefr::B2 | Cefr::C1)) {
        "uncommon"
    } else {
        "rare"
    }
}

fn tier_of_phrase_entry(e: &VocabEntry) -> &'static str {
    if e.ngsl.is_some() || e.ngsl_s.is_some() || e.fw.is_some_and(|r| r <= 2_500) {
        return "core";
    }
    if let Some(cefr) = e.cefr {
        return match cefr {
            Cefr::A1 | Cefr::A2 => "core",
            Cefr::B1 => "common",
            Cefr::B2 | Cefr::C1 => "uncommon",
            Cefr::C2 => "rare",
        };
    }
    tier_of_entry(e)
}

fn is_above_level(word_cefr: Option<Cefr>, learner_cefr: &str) -> bool {
    let Some(w) = word_cefr else { return false };
    let learner = Cefr::parse(learner_cefr).unwrap_or(Cefr::B1);
    let max_allowed = (learner as u8 + 1).min(Cefr::C2 as u8);
    (w as u8) > max_allowed
}

const MAX_VOCAB_BYTES: u64 = 16 * 1024 * 1024;

impl VocabIndex {
    pub fn from_gz(bytes: &[u8]) -> anyhow::Result<Self> {
        let mut decoder = GzDecoder::new(bytes).take(MAX_VOCAB_BYTES + 1);
        let mut raw = Vec::new();
        decoder.read_to_end(&mut raw)?;
        if raw.len() as u64 > MAX_VOCAB_BYTES {
            anyhow::bail!("vocab index exceeds max decompressed size ({MAX_VOCAB_BYTES} bytes)");
        }
        let text = String::from_utf8(raw)?;
        Self::parse_tsv(&text)
    }

    pub fn parse_tsv(text: &str) -> anyhow::Result<Self> {
        let mut lemmas = HashMap::new();
        let mut forms = HashMap::new();
        let mut section = Section::None;
        for line in text.lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if line == "@lemmas" {
                section = Section::Lemmas;
                continue;
            }
            if line == "@forms" {
                section = Section::Forms;
                continue;
            }
            match section {
                Section::Lemmas => {
                    let mut cols = line.split('\t');
                    let Some(lemma) = cols.next() else { continue };
                    let entry = VocabEntry {
                        ngsl: cols.next().and_then(opt_u32),
                        ngsl_s: cols.next().and_then(opt_u32),
                        bsl: cols.next().and_then(opt_u32),
                        fw: cols.next().and_then(opt_u32),
                        zipf_x100: cols.next().and_then(opt_u16),
                        cefr: cols.next().and_then(Cefr::parse),
                        cefr_src: cols.next().and_then(CefrSource::parse),
                    };
                    lemmas.insert(lemma.to_string(), entry);
                }
                Section::Forms => {
                    if let Some((form, lemma)) = line.split_once('\t') {
                        forms.insert(form.to_string(), lemma.to_string());
                    }
                }
                Section::None => {}
            }
        }
        Ok(Self { lemmas, forms })
    }

    pub fn lemma_of(&self, token: &str) -> Option<String> {
        let norm = normalize(token);
        let t = norm.trim_matches('\'');
        if t.is_empty() {
            return None;
        }
        if let Some(mapped) = contraction_lemma(t) {
            return mapped.map(str::to_string);
        }
        if t.contains('\'') {
            if let Some(base) = strip_clitic(t) {
                return self.lemma_of(base);
            }
            return self.lemmas.contains_key(t).then(|| t.to_string());
        }
        if let Some(lemma) = self.forms.get(t) {
            return Some(lemma.clone());
        }
        let own = self.lemmas.get(t);
        if own.is_some_and(VocabEntry::has_strong) {
            return Some(t.to_string());
        }
        let candidates = rule_candidates(t);
        if let Some(strong) = candidates
            .iter()
            .find(|c| self.lemmas.get(c.as_str()).is_some_and(VocabEntry::has_strong))
        {
            return Some(strong.clone());
        }
        if let Some(any_hit) = candidates.iter().find(|c| self.lemmas.contains_key(c.as_str())) {
            return Some(any_hit.clone());
        }
        own.map(|_| t.to_string())
    }

    fn build_from_entry(
        &self,
        query: &str,
        lemma: String,
        e: &VocabEntry,
        is_phrase: bool,
        learner_cefr: &str,
        parts: Vec<VocabPart>,
    ) -> VocabInfo {
        let tier = if is_phrase {
            tier_of_phrase_entry(e)
        } else {
            tier_of_entry(e)
        };
        VocabInfo {
            query: query.to_string(),
            lemma: Some(lemma),
            is_phrase,
            found: true,
            tier: Some(tier),
            cefr: e.cefr.map(Cefr::as_str),
            cefr_source: e.cefr.and_then(|_| e.cefr_src.map(CefrSource::as_str)),
            above_level: is_above_level(e.cefr, learner_cefr),
            ranks: VocabRanks {
                ngsl: e.ngsl,
                ngsl_spoken: e.ngsl_s,
                bsl: e.bsl,
                subtitles: e.fw,
            },
            zipf: e.zipf_x100.map(|z| z as f32 / 100.0),
            business: e.bsl.is_some(),
            spoken: e.ngsl_s.is_some(),
            film_count: 0,
            parts,
        }
    }

    pub fn lookup(&self, query: &str, learner_cefr: &str) -> VocabInfo {
        let tokens = tokens_of(query);
        if tokens.is_empty() {
            return VocabInfo {
                query: query.to_string(),
                lemma: None,
                is_phrase: false,
                found: false,
                tier: None,
                cefr: None,
                cefr_source: None,
                above_level: false,
                ranks: VocabRanks::default(),
                zipf: None,
                business: false,
                spoken: false,
                film_count: 0,
                parts: vec![],
            };
        }

        if tokens.len() == 1 {
            let tok = &tokens[0];
            if let Some(lemma) = self.lemma_of(tok) {
                if let Some(e) = self.lemmas.get(&lemma) {
                    return self.build_from_entry(query, lemma, e, false, learner_cefr, vec![]);
                }
            }
            return VocabInfo {
                query: query.to_string(),
                lemma: None,
                is_phrase: false,
                found: false,
                tier: Some("rare"),
                cefr: None,
                cefr_source: None,
                above_level: false,
                ranks: VocabRanks::default(),
                zipf: None,
                business: false,
                spoken: false,
                film_count: 0,
                parts: vec![],
            };
        }

        let parts: Vec<VocabPart> = tokens
            .iter()
            .map(|t| {
                let lemma = self.lemma_of(t);
                let e = lemma.as_deref().and_then(|l| self.lemmas.get(l));
                let function_word = FUNCTION_WORDS.contains(t.as_str())
                    || lemma.as_deref().is_some_and(|l| FUNCTION_WORDS.contains(l));
                VocabPart {
                    word: t.clone(),
                    lemma,
                    tier: e.map(tier_of_entry),
                    cefr: e.and_then(|x| x.cefr.map(Cefr::as_str)),
                    function_word,
                }
            })
            .collect();

        let exact_key = tokens.join(" ");
        let head_lemmatized_key = {
            let mut ks = tokens.clone();
            if let Some(l) = self.lemma_of(&ks[0]) {
                ks[0] = l;
            }
            ks.join(" ")
        };

        for candidate in [&exact_key, &head_lemmatized_key] {
            if let Some(e) = self.lemmas.get(candidate.as_str()) {
                return self.build_from_entry(query, candidate.clone(), e, true, learner_cefr, parts);
            }
        }

        VocabInfo {
            query: query.to_string(),
            lemma: Some(exact_key),
            is_phrase: true,
            found: false,
            tier: None,
            cefr: None,
            cefr_source: None,
            above_level: false,
            ranks: VocabRanks::default(),
            zipf: None,
            business: false,
            spoken: false,
            film_count: 0,
            parts,
        }
    }

    fn lemmatize_tokens(&self, s: &str) -> Vec<String> {
        tokens_of(s)
            .into_iter()
            .map(|t| self.lemma_of(&t).unwrap_or(t))
            .collect()
    }

    pub fn count_in_cues(&self, cues: &[String], infos: &[VocabInfo]) -> Vec<u32> {
        if cues.is_empty() || infos.is_empty() {
            return vec![0; infos.len()];
        }
        let cue_lemmas: Vec<Vec<String>> = cues.iter().map(|c| self.lemmatize_tokens(c)).collect();
        infos
            .iter()
            .map(|info| self.count_one(&cue_lemmas, info))
            .collect()
    }

    fn count_one(&self, cue_lemmas: &[Vec<String>], info: &VocabInfo) -> u32 {
        let raw_tokens = tokens_of(&info.query);
        if raw_tokens.is_empty() {
            return 0;
        }
        if raw_tokens.len() == 1 {
            let target = info
                .lemma
                .clone()
                .or_else(|| self.lemma_of(&raw_tokens[0]))
                .unwrap_or_else(|| raw_tokens[0].clone());
            return cue_lemmas
                .iter()
                .map(|cl| cl.iter().filter(|t| *t == &target).count() as u32)
                .sum();
        }

        let needle: Vec<String> = raw_tokens
            .iter()
            .map(|t| self.lemma_of(t).unwrap_or_else(|| t.clone()))
            .collect();
        let separable_pair: Option<(&str, &str)> = if needle.len() == 2 {
            Some((needle[0].as_str(), needle[1].as_str()))
        } else if needle.len() == 3
            && (SEPARABLE_PRONOUNS.contains(raw_tokens[1].as_str())
                || SEPARABLE_PRONOUNS.contains(needle[1].as_str()))
        {
            Some((needle[0].as_str(), needle[2].as_str()))
        } else {
            None
        };

        let mut total = 0u32;
        for cl in cue_lemmas {
            total += count_subslice_matches(cl, &needle, separable_pair);
        }
        total
    }
}

fn count_subslice_matches(
    hay: &[String],
    needle: &[String],
    separable_pair: Option<(&str, &str)>,
) -> u32 {
    let mut hits = 0u32;
    let mut i = 0usize;
    while i < hay.len() {
        if i + needle.len() <= hay.len() && hay[i..i + needle.len()] == *needle {
            hits += 1;
            i += needle.len();
            continue;
        }
        if let Some((a, b)) = separable_pair {
            // Match `[a, pronoun, b]` for separable phrasal verbs like "figure it out"
            // and `[a, b]` when the query itself included a pronoun like "figure it out".
            if needle.len() == 2
                && i + 3 <= hay.len()
                && hay[i] == a
                && SEPARABLE_PRONOUNS.contains(hay[i + 1].as_str())
                && hay[i + 2] == b
            {
                hits += 1;
                i += 3;
                continue;
            }
            if needle.len() == 3
                && i + 2 <= hay.len()
                && hay[i] == a
                && hay[i + 1] == b
            {
                hits += 1;
                i += 2;
                continue;
            }
        }
        i += 1;
    }
    hits
}

pub async fn lookup_batch(
    st: &AppState,
    mut spans: Vec<String>,
    media_id: Option<String>,
) -> Result<Vec<VocabInfo>, String> {
    if spans.is_empty() {
        return Ok(vec![]);
    }
    spans.truncate(MAX_BATCH);
    let cefr = st.cfg().learner.cefr.clone();
    let mut out: Vec<VocabInfo> = spans.iter().map(|s| INDEX.lookup(s, &cefr)).collect();
    if let Some(mid) = media_id.filter(|m| !m.trim().is_empty()) {
        let cues: Vec<String> = st
            .db(move |c| {
                c.prepare("SELECT text FROM cue WHERE media_id=?1")?
                    .query_map([&mid], |r| r.get(0))?
                    .collect()
            })
            .await?;
        let counts = INDEX.count_in_cues(&cues, &out);
        for (info, count) in out.iter_mut().zip(counts) {
            info.film_count = count;
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoreProgress {
    pub total: u32,
    pub learned: u32,
    pub learning: u32,
    pub known: u32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct FilmVocabProfile {
    pub total_words: u32,
    pub comprehension_pct: u8,
    pub cefr_a: f32,
    pub cefr_b: f32,
    pub cefr_c: f32,
    pub cefr_other: f32,
}

pub(crate) fn index() -> &'static VocabIndex {
    &INDEX
}

impl VocabIndex {
    /// Canonical lowercase lemma/phrase key used for deduplicating Anki, `known_word`, and stats lookups.
    pub(crate) fn canonical_key(&self, raw: &str) -> String {
        let tokens = tokens_of(raw);
        if tokens.is_empty() {
            return String::new();
        }
        if tokens.len() == 1 {
            return self.lemma_of(&tokens[0]).unwrap_or_else(|| tokens[0].clone());
        }
        let exact = tokens.join(" ");
        if self.lemmas.contains_key(&exact) {
            return exact;
        }
        let mut head = tokens;
        if let Some(l) = self.lemma_of(&head[0]) {
            head[0] = l;
        }
        head.join(" ")
    }

    /// 0..=5 for A1..=C2 when the word or indexed phrase has a CEFR label.
    pub(crate) fn cefr_rank_of(&self, raw: &str) -> Option<usize> {
        let key = self.canonical_key(raw);
        if key.is_empty() {
            return None;
        }
        self.lemmas
            .get(&key)
            .and_then(|e| e.cefr)
            .map(|c| c as usize)
    }

    /// Mutually exclusive coverage of NGSL-Spoken and NGSL 1.2 (`learned` > `learning` > `known`).
    pub(crate) fn core_coverage(
        &self,
        learned: &HashSet<String>,
        learning: &HashSet<String>,
        known: &HashSet<String>,
    ) -> (CoreProgress, CoreProgress) {
        let mut spoken = CoreProgress::default();
        let mut ngsl = CoreProgress::default();
        for (lemma, entry) in &self.lemmas {
            let bucket = if learned.contains(lemma) {
                Some(0)
            } else if learning.contains(lemma) {
                Some(1)
            } else if known.contains(lemma) {
                Some(2)
            } else {
                None
            };
            if entry.ngsl_s.is_some() {
                spoken.total += 1;
                match bucket {
                    Some(0) => spoken.learned += 1,
                    Some(1) => spoken.learning += 1,
                    Some(2) => spoken.known += 1,
                    _ => {}
                }
            }
            if entry.ngsl.is_some() {
                ngsl.total += 1;
                match bucket {
                    Some(0) => ngsl.learned += 1,
                    Some(1) => ngsl.learning += 1,
                    Some(2) => ngsl.known += 1,
                    _ => {}
                }
            }
        }
        (spoken, ngsl)
    }

    /// Estimates comprehension % and content-word CEFR distribution across a film's subtitle cues.
    pub(crate) fn analyze_cues(
        &self,
        cues: &[String],
        learner_cefr: &str,
        anki_known: &HashSet<String>,
        user_known: &HashSet<String>,
    ) -> FilmVocabProfile {
        if cues.is_empty() {
            return FilmVocabProfile::default();
        }
        let learner = Cefr::parse(learner_cefr).unwrap_or(Cefr::B1) as u8;
        let mut total_words = 0u32;
        let mut understood = 0u32;
        let mut content_a = 0u32;
        let mut content_b = 0u32;
        let mut content_c = 0u32;
        let mut content_other = 0u32;

        for cue in cues {
            for tok in tokens_of(cue) {
                total_words += 1;
                let lemma = self.lemma_of(&tok);
                let key = lemma.as_deref().unwrap_or(tok.as_str());
                let is_func = tok.len() <= 1 || FUNCTION_WORDS.contains(tok.as_str()) || FUNCTION_WORDS.contains(key);
                let entry = self.lemmas.get(key);
                let cefr = entry.and_then(|e| e.cefr);

                let known_token = is_func
                    || user_known.contains(tok.as_str())
                    || user_known.contains(key)
                    || anki_known.contains(tok.as_str())
                    || anki_known.contains(key)
                    || cefr.is_some_and(|wc| (wc as u8) < learner);
                if known_token {
                    understood += 1;
                }

                if !is_func {
                    match cefr {
                        Some(Cefr::A1 | Cefr::A2) => content_a += 1,
                        Some(Cefr::B1 | Cefr::B2) => content_b += 1,
                        Some(Cefr::C1 | Cefr::C2) => content_c += 1,
                        None => content_other += 1,
                    }
                }
            }
        }

        if total_words == 0 {
            return FilmVocabProfile::default();
        }
        let comprehension_pct = ((understood as f64 / total_words as f64) * 100.0).round().clamp(0.0, 100.0) as u8;
        let content_total = (content_a + content_b + content_c + content_other).max(1) as f32;
        FilmVocabProfile {
            total_words,
            comprehension_pct,
            cefr_a: content_a as f32 / content_total,
            cefr_b: content_b as f32 / content_total,
            cefr_c: content_c as f32 / content_total,
            cefr_other: content_other as f32 / content_total,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_loads_with_expected_coverage() {
        assert!(INDEX.lemmas.len() > 30_000, "lemmas: {}", INDEX.lemmas.len());
        assert!(INDEX.forms.len() > 10_000, "forms: {}", INDEX.forms.len());
        let d = INDEX.lookup("decide", "B1");
        assert!(d.found);
        assert_eq!(d.tier, Some("core"));
        assert_eq!(d.cefr, Some("A2"));
        assert!(d.ranks.ngsl.is_some());
        assert!(d.ranks.ngsl_spoken.is_some());
        assert!(d.ranks.subtitles.is_some());
        assert!(d.zipf.is_some());
        assert!(d.spoken);
    }

    #[test]
    fn lemmatization_handles_irregular_regular_contractions() {
        let cases = [
            ("went", Some("go")),
            ("decided", Some("decide")),
            ("lying", Some("lie")),
            ("stopped", Some("stop")),
            ("don't", Some("do")),
            ("friend's", Some("friend")),
            ("cities", Some("city")),
        ];
        for (token, expected) in cases {
            assert_eq!(
                INDEX.lemma_of(token).as_deref(),
                expected,
                "lemma_of({token})"
            );
        }
    }

    #[test]
    fn tier_classification_and_cefr_window() {
        let decide = INDEX.lookup("decide", "B1");
        assert_eq!(decide.tier, Some("core"));
        assert!(!decide.above_level);

        let bail = INDEX.lookup("bail", "B1");
        assert_eq!(bail.tier, Some("common"));

        let ephemeral = INDEX.lookup("ephemeral", "A2");
        assert!(ephemeral.found);
        assert_eq!(ephemeral.tier, Some("rare"));
        assert_eq!(ephemeral.cefr, Some("C2"));
        assert!(ephemeral.above_level);

        let ubiquitous = INDEX.lookup("ubiquitous", "A2");
        assert!(ubiquitous.found);
        assert_eq!(ubiquitous.tier, Some("rare"));

        // B2 is within B1 + 1 window; C1/C2 exceeds A2 + 1 window.
        let b2_for_b1 = INDEX.lookup("ambiguous", "B1");
        assert_eq!(b2_for_b1.cefr, Some("B2"));
        assert!(!b2_for_b1.above_level);

        let unknown = INDEX.lookup("xyzzynotaword", "B1");
        assert!(!unknown.found);
        assert_eq!(unknown.tier, Some("rare"));
        assert_eq!(unknown.lemma, None);

        let num = INDEX.lookup("2024", "B1");
        assert!(!num.found);
        assert_eq!(num.tier, None);
    }

    #[test]
    fn multiword_lookup_distinguishes_indexed_and_unindexed() {
        let mull = INDEX.lookup("mulling over", "B1");
        assert!(mull.is_phrase);
        assert!(mull.found);
        assert_eq!(mull.lemma.as_deref(), Some("mull over"));
        assert_eq!(mull.cefr, Some("C2"));
        assert!(mull.above_level);

        let alright = INDEX.lookup("all right", "A1");
        assert!(alright.is_phrase);
        assert!(alright.found);
        assert_eq!(alright.cefr, Some("A1"));
        assert_eq!(alright.tier, Some("core"));
        assert!(!alright.above_level);

        let idiom = INDEX.lookup("kick the bucket", "B1");
        assert!(idiom.is_phrase);
        assert!(!idiom.found);
        assert_eq!(idiom.tier, None);
        assert_eq!(idiom.parts.len(), 3);
        assert!(idiom.parts[1].function_word);
        assert!(!idiom.parts[0].function_word);
    }

    #[test]
    fn film_count_handles_single_phrase_and_separable_phrasal() {
        let cues = vec![
            "I decided to go.".to_string(),
            "She is deciding now, we decide later.".to_string(),
            "No big deal, honestly.".to_string(),
            "I'll figure it out soon.".to_string(),
            "Did you figure out the trick?".to_string(),
        ];
        let queries = vec![
            INDEX.lookup("decide", "B1"),
            INDEX.lookup("no big deal", "B1"),
            INDEX.lookup("figure out", "B1"),
            INDEX.lookup("figure it out", "B1"),
        ];
        let counts = INDEX.count_in_cues(&cues, &queries);
        assert_eq!(counts, vec![3, 1, 2, 2]);
    }

    #[test]
    fn canonical_key_cefr_and_core_coverage_work() {
        assert_eq!(INDEX.canonical_key("  Decided! "), "decide");
        assert_eq!(INDEX.canonical_key("mulling over"), "mull over");
        assert_eq!(INDEX.canonical_key("2025"), "");
        assert_eq!(INDEX.cefr_rank_of("ephemeral"), Some(5));
        assert_eq!(INDEX.cefr_rank_of("decide"), Some(1));

        let mut learned = HashSet::new();
        let mut learning = HashSet::new();
        let mut known = HashSet::new();
        learned.insert("decide".into());
        // If "decide" is both learned and known, learned wins (mutually exclusive).
        known.insert("decide".into());
        learning.insert("time".into());
        known.insert("person".into());

        let (spoken, ngsl) = INDEX.core_coverage(&learned, &learning, &known);
        assert!(spoken.total >= 500);
        assert!(ngsl.total >= 2500);
        assert_eq!(ngsl.learned, 1);
        assert_eq!(ngsl.learning, 1);
        assert_eq!(ngsl.known, 1);
    }

    #[test]
    fn analyze_cues_computes_comprehension_and_cefr_shares() {
        let cues = vec![
            "I decided to go home early.".to_string(),
            "It was an ephemeral illusion for Zorblax.".to_string(),
        ];
        let mut anki = HashSet::new();
        let mut user = HashSet::new();
        let b1_base = INDEX.analyze_cues(&cues, "B1", &anki, &user);
        assert!(b1_base.total_words >= 12);
        assert!(b1_base.cefr_a > 0.0);
        assert!(b1_base.cefr_c > 0.0);
        assert!(b1_base.cefr_other > 0.0);
        let sum = b1_base.cefr_a + b1_base.cefr_b + b1_base.cefr_c + b1_base.cefr_other;
        assert!((sum - 1.0).abs() < 0.01);

        anki.insert("ephemeral".into());
        user.insert("illusion".into());
        let after = INDEX.analyze_cues(&cues, "B1", &anki, &user);
        assert!(after.comprehension_pct > b1_base.comprehension_pct);
    }

    #[test]
    fn from_gz_rejects_oversized_payloads() {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;

        let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
        let bomb = vec![b'#'; (MAX_VOCAB_BYTES as usize) + 64];
        enc.write_all(&bomb).unwrap();
        let gz = enc.finish().unwrap();

        let err = VocabIndex::from_gz(&gz).err().expect("oversized gzip should fail");
        assert!(err.to_string().contains("max decompressed size"), "unexpected err: {err}");
    }

    #[test]
    fn separable_phrasal_matches_object_pronouns_and_unindexed_canonical_key_lemmatizes_head() {
        let cues = vec![
            "I'll bail him out tonight.".to_string(),
            "Can you cheer her up?".to_string(),
            "Drop them off at the corner.".to_string(),
            "Help me out here.".to_string(),
            "Count us in!".to_string(),
        ];
        let queries = vec![
            INDEX.lookup("bail out", "B1"),
            INDEX.lookup("bail him out", "B1"),
            INDEX.lookup("cheer up", "B1"),
            INDEX.lookup("cheer her up", "B1"),
            INDEX.lookup("drop off", "B1"),
            INDEX.lookup("drop them off", "B1"),
            INDEX.lookup("help out", "B1"),
            INDEX.lookup("help me out", "B1"),
            INDEX.lookup("count in", "B1"),
            INDEX.lookup("count us in", "B1"),
        ];
        let counts = INDEX.count_in_cues(&cues, &queries);
        assert_eq!(counts, vec![1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);

        // Unindexed multi-word expressions normalize the head verb consistently.
        assert_eq!(INDEX.canonical_key("bailing out"), "bail out");
        assert_eq!(INDEX.canonical_key("bailed out"), "bail out");
        assert_eq!(INDEX.canonical_key("taking off"), "take off");
        assert_eq!(INDEX.canonical_key("took off"), "take off");
    }
}
