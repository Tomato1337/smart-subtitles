use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq)]
pub struct RawCue { pub start: f64, pub end: f64, pub text: String }

/// UTF-8 (BOM stripped), UTF-16 with BOM, else Windows-1252.
pub fn decode(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return encoding_rs::UTF_16LE.decode_with_bom_removal(bytes).0.into_owned();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return encoding_rs::UTF_16BE.decode_with_bom_removal(bytes).0.into_owned();
    }
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252.decode(b).0.into_owned(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format { Srt, Vtt, Ass }

pub fn sniff(text: &str) -> Format {
    let head = text.trim_start_matches('\u{feff}').trim_start();
    if head.starts_with("WEBVTT") { Format::Vtt }
    else if text.contains("[Script Info]") || text.contains("[Events]") { Format::Ass }
    else { Format::Srt }
}

pub fn parse(text: &str) -> Vec<RawCue> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut cues = match sniff(&text) {
        Format::Ass => parse_ass(&text),
        Format::Srt | Format::Vtt => parse_blocks(&text),
    };
    cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    cues
}

fn time_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})").unwrap()
    })
}

fn secs(h: Option<&str>, m: &str, s: &str, frac: &str) -> f64 {
    let h: f64 = h.and_then(|x| x.parse().ok()).unwrap_or(0.0);
    let m: f64 = m.parse().unwrap_or(0.0);
    let s: f64 = s.parse().unwrap_or(0.0);
    let ms = format!("0.{frac}").parse::<f64>().unwrap_or(0.0);
    h * 3600.0 + m * 60.0 + s + ms
}

/// SRT and VTT share the block layout: optional id line, time line, text lines, blank line.
fn parse_blocks(text: &str) -> Vec<RawCue> {
    let mut out = vec![];
    for block in text.split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        let first = lines.first().map(|l| l.trim_start_matches('\u{feff}').trim()).unwrap_or("");
        if first.starts_with("NOTE") || first.starts_with("STYLE") || first.starts_with("WEBVTT") { continue; }
        let Some(ti) = lines.iter().position(|l| time_re().is_match(l)) else { continue };
        let c = time_re().captures(lines[ti]).unwrap();
        let body = lines[ti + 1..].join("\n");
        out.push(RawCue {
            start: secs(c.get(1).map(|x| x.as_str()), &c[2], &c[3], &c[4]),
            end: secs(c.get(5).map(|x| x.as_str()), &c[6], &c[7], &c[8]),
            text: body.trim().to_string(),
        });
    }
    out
}

fn ass_time(s: &str) -> Option<f64> {
    let (h, rest) = s.trim().split_once(':')?;
    let (m, rest) = rest.split_once(':')?;
    let (sec, cs) = rest.split_once('.').unwrap_or((rest, "0"));
    Some(h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + sec.parse::<f64>().ok()? + format!("0.{cs}").parse::<f64>().ok()?)
}

fn parse_ass(text: &str) -> Vec<RawCue> {
    let mut in_events = false;
    let mut fields: Vec<String> = vec![];
    let mut out = vec![];
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_events = l.eq_ignore_ascii_case("[Events]");
            continue;
        }
        if !in_events { continue; }
        if let Some(f) = l.strip_prefix("Format:") {
            fields = f.split(',').map(|x| x.trim().to_lowercase()).collect();
        } else if let Some(d) = l.strip_prefix("Dialogue:") {
            if fields.is_empty() { continue; }
            let parts: Vec<&str> = d.trim_start().splitn(fields.len(), ',').collect();
            let idx = |n: &str| fields.iter().position(|f| f == n);
            let (Some(si), Some(ei), Some(ti)) = (idx("start"), idx("end"), idx("text")) else { continue };
            if parts.len() <= ti { continue; }
            let (Some(start), Some(end)) = (ass_time(parts[si]), ass_time(parts[ei])) else { continue };
            out.push(RawCue { start, end, text: parts[ti].replace("\\N", "\n").replace("\\n", "\n") });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRT: &str = include_str!("../../tests/fixtures/sample.srt");
    const VTT: &str = include_str!("../../tests/fixtures/sample.vtt");
    const ASS: &str = include_str!("../../tests/fixtures/sample.ass");

    fn near(a: &[RawCue], b: &[RawCue]) {
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(b) {
            assert!((x.start - y.start).abs() < 0.011 && (x.end - y.end).abs() < 0.011, "{x:?} vs {y:?}");
            assert_eq!(x.text, y.text);
        }
    }

    #[test]
    fn three_formats_agree() {
        let srt = parse(SRT);
        assert_eq!(srt.len(), 3);
        assert_eq!(srt[0].text, "Hello there.\nHow are you?");
        assert!((srt[2].start - 3723.456).abs() < 1e-6);
        near(&srt, &parse(VTT));
        near(&srt, &parse(ASS));
    }

    #[test]
    fn decoding() {
        assert_eq!(decode(b"\xEF\xBB\xBFabc"), "abc");
        assert_eq!(decode(b"caf\xE9"), "café");
        assert_eq!(decode(&[0xFF, 0xFE, b'h', 0, b'i', 0]), "hi");
    }

    #[test]
    fn srt_without_numbers_and_dot_separator() {
        let c = parse("00:00:01.5 --> 00:00:02.0\nHi\n");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].start, 1.5);
    }
}
