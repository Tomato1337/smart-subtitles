//! Pure matching of subtitle cues against recognised speech: where a cue's words actually are, and how
//! far the whole subtitle file is shifted relative to the audio.

use super::{norm_word, tokens, Word};

/// Longest common subsequence of cue tokens and ASR tokens; returns the indices of the matched ASR
/// tokens in order (a word with several tokens contributes several, each with that word's times).
fn lcs(cue: &[String], asr: &[(String, f64, f64)]) -> Vec<usize> {
    let (n, m) = (cue.len(), asr.len());
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            dp[i][j] = if cue[i - 1] == asr[j - 1].0 { dp[i - 1][j - 1] + 1 } else { dp[i - 1][j].max(dp[i][j - 1]) };
        }
    }
    let (mut i, mut out) = (n, vec![]);
    let k = dp[n][m];
    if k == 0 {
        return out;
    }
    // Start the backtrack where the full match is already reachable: the window also holds the line
    // after the cue, and that next line often repeats the cue's words ("I love you." → "I love you too.").
    let mut j = (0..=m).find(|j| dp[n][*j] == k).unwrap_or(m);
    while i > 0 && j > 0 {
        if cue[i - 1] == asr[j - 1].0 && dp[i][j] == dp[i - 1][j - 1] + 1 {
            out.push(j - 1);
            i -= 1;
            j -= 1;
        } else if dp[i - 1][j] >= dp[i][j - 1] {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    out.reverse();
    out
}

/// `(start of the first matched word, end of the last matched word)` of the cue, when enough of its
/// tokens were actually spoken in `words`.
pub fn speech_span(cue_text: &str, words: &[Word]) -> Option<(f64, f64)> {
    let cue = tokens(cue_text);
    if cue.is_empty() {
        return None;
    }
    let mut asr: Vec<(String, f64, f64)> = vec![];
    for w in words {
        // Re-parse per word: one ASR word may carry several tokens.
        for t in tokens(&w.text) {
            asr.push((t, w.start, w.end));
        }
    }
    let hits = lcs(&cue, &asr);
    // Short cues must match completely; longer ones at least half, but never fewer than two words.
    let need = if cue.len() <= 2 { cue.len() } else { 2.max(cue.len().div_ceil(2)) };
    if hits.len() < need {
        return None;
    }
    let first = *hits.first()?;
    let last = *hits.last()?;
    Some((asr[first].1, asr[last].2))
}

/// Outcome of looking for one offset across the whole film.
#[derive(Debug, PartialEq)]
pub enum SyncResult {
    /// One shift fits every fragment; `support` candidates agree on it.
    Offset { offset: f64, support: usize },
    /// Too few anchors to trust a shift.
    Weak { support: usize, total: usize },
    /// Fragments disagree: the subtitles look like they belong to another cut.
    Drift,
}

const WINDOW: f64 = 0.6;
const MAX_SHIFT: f64 = 30.0;

/// `(count, median, first index)` of the widest group of candidates within `WINDOW` seconds.
/// `vals` is sorted by offset.
fn window(vals: &[(f64, usize)]) -> (usize, f64, usize) {
    let (mut best, mut best_l, mut r) = (0, 0, 0);
    for l in 0..vals.len() {
        r = r.max(l);
        while r < vals.len() && vals[r].0 - vals[l].0 <= WINDOW + 1e-9 {
            r += 1;
        }
        if r - l > best {
            best = r - l;
            best_l = l;
        }
    }
    if best == 0 {
        return (0, 0.0, 0);
    }
    let w = &vals[best_l..best_l + best];
    let mid = w.len() / 2;
    let median = if w.len() % 2 == 1 { w[mid].0 } else { (w[mid - 1].0 + w[mid].0) / 2.0 };
    (best, median, best_l)
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// Count of the widest `WINDOW` group among plain offset values.
fn best_count(mut d: Vec<f64>) -> usize {
    d.sort_by(f64::total_cmp);
    window(&d.into_iter().map(|d| (d, 0)).collect::<Vec<_>>()).0
}

/// Offset of every cue's speech relative to its subtitle start, clustered across fragments.
/// Only cue starts are anchored: subtitle ends linger past the speech and would bias the result.
pub fn estimate(cues: &[(f64, f64, String)], fragments: &[Vec<Word>]) -> SyncResult {
    let cue_tokens: Vec<Vec<String>> = cues.iter().map(|c| tokens(&c.2)).collect();
    let mut all: Vec<(f64, usize)> = vec![];
    let mut per_frag: Vec<Vec<f64>> = vec![vec![]; fragments.len()];
    for (fi, frag) in fragments.iter().enumerate() {
        let words: Vec<(&str, f64, f64)> = frag.iter().map(|w| (w.text.as_str(), w.start, w.end)).collect();
        for (ci, t) in cue_tokens.iter().enumerate() {
            if t.len() < 2 {
                continue;
            }
            for i in 0..words.len().saturating_sub(1) {
                if norm_word(words[i].0) == t[0] && norm_word(words[i + 1].0) == t[1] {
                    let d = words[i].1 - cues[ci].0;
                    if d.abs() <= MAX_SHIFT {
                        all.push((d, fi));
                        per_frag[fi].push(d);
                    }
                }
            }
        }
    }
    let total = all.len();
    all.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (support, median, first) = window(&all);
    // Only the fragments that actually agree on this shift count: one fragment repeating a phrase is
    // not evidence about the rest of the film.
    let distinct = {
        let mut f: Vec<usize> = all[first..first + support].iter().map(|c| c.1).collect();
        f.sort_unstable();
        f.dedup();
        f.len()
    };
    if support >= 5 && distinct >= 2 && support * 4 >= total {
        return SyncResult::Offset { offset: round1(median), support };
    }
    if per_frag.iter().filter(|d| best_count((*d).clone()) >= 3).count() >= 2 {
        return SyncResult::Drift;
    }
    SyncResult::Weak { support, total }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(text: &str, start: f64, end: f64) -> Word {
        Word { text: text.into(), start, end }
    }

    /// Real base.en output around cue 1 of Marty Supreme's OpenSubtitles file.
    fn marty_words() -> Vec<Word> {
        vec![
            w("Miss", 30.14, 30.54),
            w("Marianne.", 30.54, 30.94),
            w("Happy", 30.96, 31.14),
            w("9am?", 31.14, 31.64),
            w("Yeah,", 31.92, 32.12),
            w("you're", 32.24, 32.36),
            w("a", 32.36, 32.42),
            w("lucky", 32.42, 32.56),
            w("lady.", 32.56, 32.9),
            w("Oh,", 33.06, 33.06),
            w("I'm", 33.14, 33.18),
            w("excited.", 33.18, 33.58),
            w("Nice", 34.0, 34.0),
            w("pair.", 34.0, 34.22),
        ]
    }

    #[test]
    fn speech_span_finds_the_words_of_the_cue() {
        let span = speech_span("-Yeah, you're a lucky lady.\n-Oh, I'm excited.", &marty_words());
        assert_eq!(span, Some((31.92, 33.58)));
    }

    #[test]
    fn speech_span_ignores_unrelated_speech() {
        let words = vec![w("completely", 1.0, 1.2), w("different", 1.2, 1.4), w("sentence", 1.4, 1.6)];
        assert_eq!(speech_span("I'm excited.", &words), None);
        assert_eq!(speech_span("", &marty_words()), None);
    }

    #[test]
    fn speech_span_keeps_the_cue_s_own_line_not_the_repeat_after_it() {
        let words = vec![
            w("I", 10.0, 10.2),
            w("love", 10.2, 10.4),
            w("you.", 10.4, 10.6),
            w("I", 11.0, 11.2),
            w("love", 11.2, 11.4),
            w("you.", 11.4, 11.6),
            w("too.", 11.6, 11.8),
        ];
        assert_eq!(speech_span("I love you.", &words), Some((10.0, 10.6)));
    }

    /// One fragment per `(offset, cue count)`: three-word cues whose speech sits `offset` seconds after
    /// every cue start, jittered, with unrelated words around it.
    fn synthetic(spec: &[(f64, usize)]) -> (Vec<(f64, f64, String)>, Vec<Vec<Word>>) {
        let mut cues = vec![];
        let mut fragments = vec![];
        let mut k = 0;
        for &(off, count) in spec {
            let mut frag = vec![];
            for c in 0..count {
                let start = 100.0 + 20.0 * k as f64;
                let text = format!("alpha{k} bravo{k} charlie{k}");
                cues.push((start, start + 2.0, text));
                let jitter = [-0.1, 0.0, 0.1][c % 3];
                let at = start + off + jitter;
                frag.extend([w("um", at - 1.5, at - 1.4), w("okay", at - 1.2, at - 1.1), w("what", at - 0.9, at - 0.8)]);
                frag.extend([
                    w(&format!("alpha{k}"), at, at + 0.3),
                    w(&format!("bravo{k}"), at + 0.3, at + 0.6),
                    w(&format!("charlie{k}"), at + 0.6, at + 0.9),
                ]);
                k += 1;
            }
            fragments.push(frag);
        }
        (cues, fragments)
    }

    #[test]
    fn estimate_finds_a_consistent_shift() {
        let (cues, fragments) = synthetic(&[(0.5, 4), (0.5, 4), (0.5, 4)]);
        assert_eq!(estimate(&cues, &fragments), SyncResult::Offset { offset: 0.5, support: 12 });
    }

    #[test]
    fn estimate_calls_disagreeing_fragments_drift() {
        let (cues, fragments) = synthetic(&[(0.5, 4), (3.0, 4), (6.0, 4)]);
        assert_eq!(estimate(&cues, &fragments), SyncResult::Drift);
    }

    #[test]
    fn estimate_is_weak_without_enough_anchors() {
        // Two anchors in total: one per fragment, far too few to trust.
        let (cues, fragments) = synthetic(&[(0.5, 1), (0.5, 1)]);
        assert_eq!(estimate(&cues, &fragments), SyncResult::Weak { support: 2, total: 2 });
    }

    #[test]
    fn estimate_rejects_a_cluster_from_a_single_fragment() {
        // One long fragment can repeat a phrase over and over; that says nothing about the rest of the film.
        let (cues, fragments) = synthetic(&[(0.5, 8), (3.0, 3), (3.0, 3)]);
        assert_eq!(estimate(&cues, &fragments), SyncResult::Drift);
    }
}
