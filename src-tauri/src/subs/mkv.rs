//! Minimal Matroska (EBML) reader for the parts of an MKV that hold embedded subtitles: the
//! SeekHead/Tracks/Cues headers and the text of one block. There is no I/O here: the caller reads
//! byte ranges and hands them in, so every function stays pure and testable.

use anyhow::anyhow;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

// Top level.
const EBML: u64 = 0x1A45_DFA3;
const SEGMENT: u64 = 0x1853_8067;
// Segment children.
const SEEK_HEAD: u64 = 0x114D_9B74;
const SEEK: u64 = 0x4DBB;
const SEEK_ID: u64 = 0x53AB;
const SEEK_POSITION: u64 = 0x53AC;
const INFO: u64 = 0x1549_A966;
const TIMESTAMP_SCALE: u64 = 0x2AD7_B1;
const TRACKS: u64 = 0x1654_AE6B;
const CUES: u64 = 0x1C53_BB6B;
const CLUSTER: u64 = 0x1F43_B675;
// TrackEntry.
const TRACK_ENTRY: u64 = 0xAE;
const TRACK_NUMBER: u64 = 0xD7;
const TRACK_TYPE: u64 = 0x83;
const CODEC_ID: u64 = 0x86;
const NAME: u64 = 0x536E;
const LANGUAGE: u64 = 0x22B5_9C;
const LANGUAGE_BCP47: u64 = 0x22B5_9D;
const FLAG_FORCED: u64 = 0x55AA;
// Cues.
const CUE_POINT: u64 = 0xBB;
const CUE_TIME: u64 = 0xB3;
const CUE_TRACK_POSITIONS: u64 = 0xB7;
const CUE_TRACK: u64 = 0xF7;
const CUE_CLUSTER_POSITION: u64 = 0xF1;
const CUE_RELATIVE_POSITION: u64 = 0xF0;
const CUE_DURATION: u64 = 0xB2;
// Blocks.
const BLOCK_GROUP: u64 = 0xA0;
const BLOCK: u64 = 0xA1;
const BLOCK_DURATION: u64 = 0x9B;
const SIMPLE_BLOCK: u64 = 0xA3;

/// A single text block is a few KiB; anything bigger is a false match on a neighbouring byte.
const MAX_BLOCK: u64 = 64 << 10;
const TRACK_TYPE_SUBTITLE: u64 = 17;
const CODE_ID_UTF8: &str = "S_TEXT/UTF8";
/// TimestampScale when Info has none: 1 000 000 ns = 1 ms per tick.
const DEFAULT_SCALE_NS: u64 = 1_000_000;

/// Positions of the head elements, all absolute file offsets.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Head {
    /// Offset of the first Segment child: the Segment header ends here.
    pub seg_data: u64,
    /// `(offset, element size)`, the size 0 when only SeekHead named the element.
    pub info: Option<(u64, u64)>,
    pub tracks: Option<(u64, u64)>,
    pub cues: Option<(u64, u64)>,
    /// A second SeekHead further in the file, whose entries the caller merges.
    pub more: Option<u64>,
}

/// One text subtitle track of the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextTrack {
    pub number: u64,
    pub name: String,
    /// `LanguageBCP47` when present, else `Language`, else `"eng"` (Matroska's default).
    pub lang: String,
    pub forced: bool,
}

/// One cue of `Cues`: where its block starts and when.
#[derive(Debug, Clone, PartialEq)]
pub struct CueRef {
    pub time: f64,
    pub duration: Option<f64>,
    /// Absolute offset of the Cluster element holding the block.
    pub cluster: u64,
    /// Block offset from the Cluster data start (`cluster + 4 + size vint`).
    pub rel: u64,
}

/// Reads an EBML variable-length integer at `b[i]`. `keep_marker` keeps the length marker bits,
/// which is what element IDs need; sizes are read without it. Returns `(value, bytes used)`.
pub fn vint(b: &[u8], i: usize, keep_marker: bool) -> Option<(u64, usize)> {
    let first = *b.get(i)?;
    if first == 0 {
        return None;
    }
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || i + len > b.len() {
        return None;
    }
    let mut v = if keep_marker { first as u64 } else { (first as u64) & (0xFF >> len) };
    for k in 1..len {
        v = (v << 8) | b[i + k] as u64;
    }
    Some((v, len))
}

/// An all-ones size means "unknown": the element runs to the end of the file.
fn unknown_size(v: u64, len: usize) -> bool {
    v == (1u64 << (7 * len)) - 1
}

struct Header {
    id: u64,
    /// Offset of the first body byte.
    body: usize,
    size: u64,
    known: bool,
}

fn header(b: &[u8], i: usize) -> Option<Header> {
    let (id, n) = vint(b, i, true)?;
    let (size, m) = vint(b, i + n, false)?;
    Some(Header { id, body: i + n + m, size, known: !unknown_size(size, m) })
}

/// Complete child elements of `b` as `(id, body)`; walking stops at a truncated or unknown-size one.
fn kids(b: &[u8]) -> Vec<(u64, &[u8])> {
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        let Some(h) = header(b, i) else { break };
        if !h.known {
            break;
        }
        let Some(end) = h.body.checked_add(h.size as usize) else { break };
        let Some(body) = b.get(h.body..end) else { break };
        out.push((h.id, body));
        i = end;
    }
    out
}

fn uint(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |a, x| (a << 8) | *x as u64)
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).trim_end_matches('\0').to_string()
}

fn not_mkv() -> anyhow::Error {
    anyhow!("не Matroska")
}

/// Reads the first 64 KiB of the file: where the Segment data, Info, Tracks and Cues are.
pub fn parse_head(buf: &[u8]) -> anyhow::Result<Head> {
    let (id, _) = vint(buf, 0, true).ok_or_else(not_mkv)?;
    let mut i = 0usize;
    if id == EBML {
        let h = header(buf, 0).ok_or_else(not_mkv)?;
        if !h.known {
            return Err(not_mkv());
        }
        i = h.body + h.size as usize;
    }
    let (id, n) = vint(buf, i, true).ok_or_else(not_mkv)?;
    if id != SEGMENT {
        return Err(not_mkv());
    }
    let (_, m) = vint(buf, i + n, false).ok_or_else(not_mkv)?;
    let seg_data = (i + n + m) as u64;

    let mut head = Head { seg_data, ..Default::default() };
    let mut i = seg_data as usize;
    while i < buf.len() {
        let Some(h) = header(buf, i) else { break };
        if !h.known {
            break;
        }
        let Some(end) = h.body.checked_add(h.size as usize) else { break };
        let Some(body) = buf.get(h.body..end) else { break };
        match h.id {
            CLUSTER => break,
            INFO => head.info = Some((i as u64, h.size)),
            TRACKS => head.tracks = Some((i as u64, h.size)),
            CUES => head.cues = Some((i as u64, h.size)),
            SEEK_HEAD => merge_seek_head(&mut head, body),
            _ => {}
        }
        i = end;
    }
    Ok(head)
}

/// Fills the positions SeekHead names; a directly found element keeps its size. Also used for the
/// second SeekHead a first one points at.
pub fn merge_seek_head(head: &mut Head, body: &[u8]) {
    for (id, seek) in kids(body) {
        if id != SEEK {
            continue;
        }
        let k = kids(seek);
        let Some((want, pos)) = k
            .iter()
            .find(|(i, _)| *i == SEEK_ID)
            .and_then(|(_, b)| vint(b, 0, true))
            .zip(k.iter().find(|(i, _)| *i == SEEK_POSITION).map(|(_, b)| uint(b)))
        else {
            continue;
        };
        let at = head.seg_data + pos;
        let slot = match want.0 {
            INFO => &mut head.info,
            TRACKS => &mut head.tracks,
            CUES => &mut head.cues,
            SEEK_HEAD => {
                head.more = Some(at);
                continue;
            }
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some((at, 0));
        }
    }
}

/// Seconds per timestamp tick (`TimestampScale / 1e9`); 1 ms when the element is absent.
pub fn parse_scale(info_body: &[u8]) -> f64 {
    let ns = kids(info_body)
        .into_iter()
        .find(|(id, _)| *id == TIMESTAMP_SCALE)
        .map(|(_, b)| uint(b))
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_SCALE_NS);
    ns as f64 / 1e9
}

/// Text subtitle tracks of a Tracks element, in Matroska order.
pub fn parse_tracks(tracks_body: &[u8]) -> Vec<TextTrack> {
    let mut out = vec![];
    for (id, body) in kids(tracks_body) {
        if id != TRACK_ENTRY {
            continue;
        }
        let k = kids(body);
        let get = |want: u64| k.iter().find(|(i, _)| *i == want).map(|(_, b)| *b);
        if get(TRACK_TYPE).map(uint) != Some(TRACK_TYPE_SUBTITLE) {
            continue;
        }
        if get(CODEC_ID).map(text).as_deref() != Some(CODE_ID_UTF8) {
            continue;
        }
        let lang = get(LANGUAGE_BCP47)
            .map(text)
            .or_else(|| get(LANGUAGE).map(text))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "eng".into());
        out.push(TextTrack {
            number: get(TRACK_NUMBER).map(uint).unwrap_or(0),
            name: get(NAME).map(text).unwrap_or_default(),
            lang,
            forced: get(FLAG_FORCED).map(uint).unwrap_or(0) != 0,
        });
    }
    out
}

/// English tracks, best first: the plain ones, then SDH/forced/commentary/signs, Matroska order kept.
pub fn pick_track(tracks: &[TextTrack]) -> Vec<&TextTrack> {
    static NOISY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)sdh|forced|commentary|signs").unwrap());
    let noisy = &*NOISY;
    let (mut plain, mut marked) = (vec![], vec![]);
    for t in tracks {
        if t.forced || !t.lang.to_lowercase().starts_with("en") {
            continue;
        }
        if noisy.is_match(&t.name) {
            marked.push(t);
        } else {
            plain.push(t);
        }
    }
    plain.extend(marked);
    plain
}

/// Every cue of `track` that names both a cluster and a relative position, sorted by time.
pub fn parse_cues(cues_body: &[u8], seg_data: u64, track: u64, scale: f64) -> Vec<CueRef> {
    let mut out: Vec<CueRef> = vec![];
    for (id, body) in kids(cues_body) {
        if id != CUE_POINT {
            continue;
        }
        let k = kids(body);
        let Some(time) = k.iter().find(|(i, _)| *i == CUE_TIME).map(|(_, b)| uint(b)) else { continue };
        for (_, positions) in k.iter().filter(|(i, _)| *i == CUE_TRACK_POSITIONS) {
            let p = kids(positions);
            let get = |want: u64| p.iter().find(|(i, _)| *i == want).map(|(_, b)| uint(b));
            if get(CUE_TRACK) != Some(track) {
                continue;
            }
            let (Some(cluster), Some(rel)) = (get(CUE_CLUSTER_POSITION), get(CUE_RELATIVE_POSITION)) else { continue };
            out.push(CueRef {
                time: time as f64 * scale,
                duration: get(CUE_DURATION).map(|d| d as f64 * scale),
                cluster: seg_data + cluster,
                rel,
            });
        }
    }
    out.sort_by(|a, b| a.time.total_cmp(&b.time));
    let mut seen = HashSet::new();
    out.retain(|c| seen.insert((c.cluster, c.rel)));
    out
}

struct Located<'a> {
    /// Length of the Cluster size vint this block was found with (1..=8).
    l: usize,
    /// Declared total length of the block element, header included.
    total: u64,
    /// Declared body length.
    size: u64,
    /// The window from the body start on, possibly cut short by the window end.
    avail: &'a [u8],
    group: bool,
}

/// The block-element body starts `l - 1` bytes into `win`, because `win` begins five bytes before
/// the element position and the Cluster size vint is `l` bytes long.
fn locate<'a>(win: &'a [u8], track: u64) -> Option<Located<'a>> {
    for l in 1..=8usize {
        let i = l - 1;
        let Some((id, n)) = vint(win, i, true) else { continue };
        if id != BLOCK_GROUP && id != SIMPLE_BLOCK {
            continue;
        }
        let Some((size, m)) = vint(win, i + n, false) else { continue };
        // The offsets before the real one can land on video payload, where a stray 0xA0/0xA3 and a
        // matching track byte would be a false match; a text block is never this big.
        if size == 0 || size > MAX_BLOCK {
            continue;
        }
        let body = i + n + m;
        let Some(avail) = win.get(body..) else { continue };
        let group = id == BLOCK_GROUP;
        // Track number: the block's first vint, inside the group's Block child when there is one.
        let mut at = 0usize;
        if group {
            let Some(off) = find_child(avail, BLOCK) else { continue };
            at = off;
        }
        match vint(avail, at, false) {
            Some((t, _)) if t == track => {}
            _ => continue,
        }
        return Some(Located { l, total: (n + m) as u64 + size, size, avail, group });
    }
    None
}

/// Offset of the body of the first child `want` inside `b`, reading headers only, so a child whose
/// body is cut by the window still counts.
fn find_child(b: &[u8], want: u64) -> Option<usize> {
    let mut i = 0;
    while i < b.len() {
        let (id, n) = vint(b, i, true)?;
        let (size, m) = vint(b, i + n, false)?;
        let body = i + n + m;
        if id == want {
            return Some(body);
        }
        i = body.checked_add(size as usize)?;
    }
    None
}

/// `(l, total bytes of the element)` when the header at the cue position is a block of `track`:
/// the caller re-reads `total` bytes from `cluster + 4 + l + rel` when the window cut the text.
pub fn block_span(win: &[u8], track: u64) -> Option<(usize, u64)> {
    let e = locate(win, track)?;
    Some((e.l, e.total))
}

/// The line stored at the cue position: `(cluster size vint length, BlockDuration ticks, text)`.
pub fn block_in_window(win: &[u8], track: u64) -> Option<(usize, Option<u64>, String)> {
    let e = locate(win, track)?;
    if e.size > e.avail.len() as u64 {
        return None;
    }
    let body = &e.avail[..e.size as usize];
    let (block, duration) = if e.group {
        let k = kids(body);
        let block = k.iter().find(|(i, _)| *i == BLOCK).map(|(_, b)| *b)?;
        (block, k.iter().find(|(i, _)| *i == BLOCK_DURATION).map(|(_, b)| uint(b)))
    } else {
        (body, None)
    };
    let (t, n) = vint(block, 0, false)?;
    if t != track {
        return None;
    }
    let frame = block.get(n..)?;
    // 2 bytes of timecode, then the flags byte: lacing means more than one line.
    if *frame.get(2)? & 0x06 != 0 {
        return None;
    }
    Some((e.l, duration, String::from_utf8_lossy(&frame[3..]).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EBML_ID: &[u8] = &[0x1A, 0x45, 0xDF, 0xA3];
    const SEG_ID: &[u8] = &[0x18, 0x53, 0x80, 0x67];
    const SEEK_HEAD_ID: &[u8] = &[0x11, 0x4D, 0x9B, 0x74];
    const SEEK_ID_ID: &[u8] = &[0x4D, 0xBB];
    const SEEK_WANT: &[u8] = &[0x53, 0xAB];
    const SEEK_POS: &[u8] = &[0x53, 0xAC];
    const INFO_ID: &[u8] = &[0x15, 0x49, 0xA9, 0x66];
    const SCALE_ID: &[u8] = &[0x2A, 0xD7, 0xB1];
    const TRACKS_ID: &[u8] = &[0x16, 0x54, 0xAE, 0x6B];
    const ENTRY_ID: &[u8] = &[0xAE];
    const NUM_ID: &[u8] = &[0xD7];
    const TYPE_ID: &[u8] = &[0x83];
    const CODEC_ID_B: &[u8] = &[0x86];
    const NAME_ID: &[u8] = &[0x53, 0x6E];
    const LANG_ID: &[u8] = &[0x22, 0xB5, 0x9C];
    const FORCED_ID: &[u8] = &[0x55, 0xAA];
    const CUES_ID: &[u8] = &[0x1C, 0x53, 0xBB, 0x6B];
    const POINT_ID: &[u8] = &[0xBB];
    const TIME_ID: &[u8] = &[0xB3];
    const POS_ID: &[u8] = &[0xB7];
    const TRACK_ID: &[u8] = &[0xF7];
    const CLUSTER_POS: &[u8] = &[0xF1];
    const REL_POS: &[u8] = &[0xF0];
    const DUR_ID: &[u8] = &[0xB2];
    const CLUSTER_ID: &[u8] = &[0x1F, 0x43, 0xB6, 0x75];
    const GROUP_ID: &[u8] = &[0xA0];
    const BLOCK_ID: &[u8] = &[0xA1];
    const BLOCK_DUR_ID: &[u8] = &[0x9B];
    const SIMPLE_ID: &[u8] = &[0xA3];

    fn size(n: usize, len: usize) -> Vec<u8> {
        let mut v = vec![0u8; len];
        let mut x = n as u64;
        for k in (0..len).rev() {
            v[k] = (x & 0xFF) as u8;
            x >>= 8;
        }
        v[0] |= 1u8 << (8 - len);
        v
    }

    fn el_sized(id: &[u8], body: &[u8], len: usize) -> Vec<u8> {
        let mut out = id.to_vec();
        out.extend(size(body.len(), len));
        out.extend_from_slice(body);
        out
    }

    fn el(id: &[u8], body: &[u8]) -> Vec<u8> {
        let len = (1..=8).find(|l| (body.len() as u64) < (1u64 << (7 * *l as u32)) - 1).unwrap();
        el_sized(id, body, len)
    }

    fn uint(n: u64) -> Vec<u8> {
        let b = n.to_be_bytes();
        b[b.iter().position(|x| *x != 0).unwrap_or(7)..].to_vec()
    }

    fn tvint(n: u64) -> u8 {
        0x80 | n as u8
    }

    /// A text block: track vint, 2-byte timecode, flags, then the line.
    fn block(track: u64, tc: u16, flags: u8, text: &str) -> Vec<u8> {
        let mut b = vec![tvint(track)];
        b.extend(tc.to_be_bytes());
        b.push(flags);
        b.extend_from_slice(text.as_bytes());
        b
    }

    /// Cluster body with a video SimpleBlock and a track-3 BlockGroup; also the group's relative position.
    fn cluster(tc: u16, text: &str) -> (Vec<u8>, usize) {
        let mut body = el(SIMPLE_ID, &block(1, tc, 0x80, "video"));
        let rel = body.len();
        let mut group = el(BLOCK_ID, &block(3, tc, 0, text));
        group.extend(el(BLOCK_DUR_ID, &uint(1500)));
        body.extend(el(GROUP_ID, &group));
        (body, rel)
    }

    struct File {
        bytes: Vec<u8>,
        seg_data: u64,
        info: usize,
        tracks: usize,
        cluster1: usize,
        cluster2: usize,
        cues: usize,
        rel1: usize,
        rel2: usize,
        info_len: usize,
        tracks_len: usize,
    }

    /// A whole synthetic file: EBML header, Segment (8-byte size) with SeekHead, Info, Tracks,
    /// two clusters with 8-byte sizes and Cues.
    fn build() -> File {
        let ebml = el(EBML_ID, &[]);
        let info = el(INFO_ID, &el(SCALE_ID, &uint(1_000_000)));
        let mut tracks_body = vec![];
        for entry in [
            vec![el(NUM_ID, &uint(1)), el(TYPE_ID, &uint(1)), el(CODEC_ID_B, b"V_MPEG4/ISO/AVC")].concat(),
            vec![el(NUM_ID, &uint(2)), el(TYPE_ID, &uint(17)), el(CODEC_ID_B, b"S_TEXT/UTF8"), el(LANG_ID, b"rus")].concat(),
            // No Language element at all: Matroska's default is "eng".
            vec![el(NUM_ID, &uint(3)), el(TYPE_ID, &uint(17)), el(CODEC_ID_B, b"S_TEXT/UTF8"), el(NAME_ID, b"US")].concat(),
            vec![
                el(NUM_ID, &uint(4)),
                el(TYPE_ID, &uint(17)),
                el(CODEC_ID_B, b"S_TEXT/UTF8"),
                el(LANG_ID, b"eng"),
                el(FORCED_ID, &uint(1)),
            ]
            .concat(),
        ] {
            tracks_body.extend(el(ENTRY_ID, &entry));
        }
        let tracks = el(TRACKS_ID, &tracks_body);
        let (c1, rel1) = cluster(0, "Hello");
        let (c2, rel2) = cluster(4000, "Bye");
        let cluster1 = el_sized(CLUSTER_ID, &c1, 8);
        let cluster2 = el_sized(CLUSTER_ID, &c2, 8);

        let seg_data = ebml.len() + 4 + 8;
        // SeekHead first, with fixed 8-byte positions, so a second pass keeps every offset.
        let seek_head = |info_at: usize, tracks_at: usize, cues_at: usize| {
            let seek = |want: &[u8], at: usize| {
                el(SEEK_ID_ID, &[el(SEEK_WANT, want), el(SEEK_POS, &(at as u64).to_be_bytes())].concat())
            };
            el(
                SEEK_HEAD_ID,
                &[seek(INFO_ID, info_at), seek(TRACKS_ID, tracks_at), seek(CUES_ID, cues_at)].concat(),
            )
        };
        let sh_len = seek_head(0, 0, 0).len();
        let info_at = sh_len;
        let tracks_at = info_at + info.len();
        let cluster1_at = tracks_at + tracks.len();
        let cluster2_at = cluster1_at + cluster1.len();
        let cues_at = cluster2_at + cluster2.len();

        let point = |time: u64, track: u64, cluster_at: usize, rel: Option<usize>, duration: Option<u64>| {
            let mut pos = vec![el(TRACK_ID, &uint(track)), el(CLUSTER_POS, &uint(cluster_at as u64))];
            if let Some(rel) = rel {
                pos.push(el(REL_POS, &uint(rel as u64)));
            }
            if let Some(d) = duration {
                pos.push(el(DUR_ID, &uint(d)));
            }
            el(POINT_ID, &[el(TIME_ID, &uint(time)), el(POS_ID, &pos.concat())].concat())
        };
        let cues_body = [
            point(1000, 3, cluster1_at, Some(rel1), Some(1000)),
            point(5000, 3, cluster2_at, Some(rel2), None),
            point(2000, 1, cluster1_at, Some(0), None),
            // No CueRelativePosition: the block cannot be found without a second read.
            point(3000, 3, cluster1_at, None, None),
        ]
        .concat();
        let cues = el(CUES_ID, &cues_body);

        let seg_body = [seek_head(info_at, tracks_at, cues_at), info.clone(), tracks.clone(), cluster1.clone(), cluster2.clone(), cues]
            .concat();
        let bytes = [ebml, el_sized(SEG_ID, &seg_body, 8)].concat();
        File {
            bytes,
            seg_data: seg_data as u64,
            info: info_at,
            tracks: tracks_at,
            cluster1: cluster1_at,
            cluster2: cluster2_at,
            cues: cues_at,
            rel1,
            rel2,
            info_len: info.len(),
            tracks_len: tracks.len(),
        }
    }

    #[test]
    fn head_names_the_segment_and_its_elements() {
        let f = build();
        let head = parse_head(&f.bytes).unwrap();
        assert_eq!(head.seg_data, f.seg_data);
        // Found directly, so the size is known too (5 = 4-byte element ID + 1-byte size).
        let body_len = |len: usize| (len - 5) as u64;
        assert_eq!(head.info, Some((f.seg_data + f.info as u64, body_len(f.info_len))));
        assert_eq!(head.tracks, Some((f.seg_data + f.tracks as u64, body_len(f.tracks_len))));
        // Cues lie past the first cluster, so only SeekHead knows them: no size.
        assert_eq!(head.cues, Some((f.seg_data + f.cues as u64, 0)));
        assert_eq!(head.more, None);
        assert!(parse_head(b"not an mkv at all").is_err());
    }

    #[test]
    fn tracks_are_text_only_and_english_ones_are_picked() {
        let f = build();
        let head = parse_head(&f.bytes).unwrap();
        let at = head.tracks.unwrap().0 as usize;
        let tracks_body = &f.bytes[at + 5..at + 5 + head.tracks.unwrap().1 as usize];
        assert_eq!(parse_scale(&[]), 0.001);
        let tracks = parse_tracks(tracks_body);
        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[0].number, 2);
        assert_eq!(tracks[0].lang, "rus");
        assert_eq!(tracks[1].number, 3);
        assert_eq!(tracks[1].lang, "eng");
        assert_eq!(tracks[1].name, "US");
        assert!(tracks[2].forced);
        let picked = pick_track(&tracks);
        assert_eq!(picked.iter().map(|t| t.number).collect::<Vec<_>>(), vec![3]);
    }

    #[test]
    fn noisy_names_come_last() {
        let tracks = vec![
            TextTrack { number: 1, name: "SDH".into(), lang: "en".into(), forced: false },
            TextTrack { number: 2, name: "US".into(), lang: "eng".into(), forced: false },
            TextTrack { number: 3, name: "Signs".into(), lang: "en-US".into(), forced: false },
        ];
        assert_eq!(pick_track(&tracks).iter().map(|t| t.number).collect::<Vec<_>>(), vec![2, 1, 3]);
    }

    #[test]
    fn cues_carry_absolute_clusters_in_time_order() {
        let f = build();
        let head = parse_head(&f.bytes).unwrap();
        let at = head.cues.unwrap().0 as usize;
        let body = &f.bytes[at + 5..];
        let cues = parse_cues(body, f.seg_data, 3, 0.001);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].time, 1.0);
        assert_eq!(cues[0].duration, Some(1.0));
        assert_eq!(cues[0].cluster, f.seg_data + f.cluster1 as u64);
        assert_eq!(cues[0].rel, f.rel1 as u64);
        assert_eq!(cues[1].time, 5.0);
        assert_eq!(cues[1].duration, None);
        assert_eq!(cues[1].cluster, f.seg_data + f.cluster2 as u64);
        assert_eq!(cues[1].rel, f.rel2 as u64);
        // No cue of the video track got through.
        let video = parse_cues(body, f.seg_data, 1, 0.001);
        assert_eq!(video.len(), 1);
        assert_eq!(video[0].time, 2.0);
        assert_eq!(video[0].rel, 0);
    }

    #[test]
    fn block_text_and_duration_from_a_window() {
        let f = build();
        let cues = {
            let head = parse_head(&f.bytes).unwrap();
            let at = head.cues.unwrap().0 as usize;
            parse_cues(&f.bytes[at + 5..], f.seg_data, 3, 0.001)
        };
        let cue = &cues[0];
        let base = (cue.cluster + cue.rel) as usize;
        let win = &f.bytes[base + 5..(base + 12 + 4096).min(f.bytes.len())];
        assert_eq!(block_in_window(win, 3), Some((8, Some(1500), "Hello".to_string())));
        assert_eq!(block_span(win, 3), Some((8, block_span_len(&f, &cues[0]))));

        // The same window for the video SimpleBlock is not track 3.
        let video = &f.bytes[(f.seg_data as usize + f.cluster1) + 5..];
        assert_eq!(block_in_window(video, 3), None);
        assert_eq!(block_in_window(video, 1), Some((8, None, "video".to_string())));
    }

    /// Total bytes of the track-3 block element of `cue`, read straight from its header.
    fn block_span_len(f: &File, cue: &CueRef) -> u64 {
        let at = (cue.cluster + cue.rel) as usize + 12;
        let (_, n) = vint(&f.bytes, at, true).unwrap();
        let (size, m) = vint(&f.bytes, at + n, false).unwrap();
        (n + m) as u64 + size
    }

    #[test]
    fn a_window_cut_before_the_text_still_finds_the_span() {
        let f = build();
        let cues = {
            let head = parse_head(&f.bytes).unwrap();
            let at = head.cues.unwrap().0 as usize;
            parse_cues(&f.bytes[at + 5..], f.seg_data, 3, 0.001)
        };
        let base = (cues[0].cluster + cues[0].rel) as usize;
        // Only the first 10 bytes of the element: header and block header, no text.
        let win = &f.bytes[base + 5..base + 12 + 10];
        assert_eq!(block_in_window(win, 3), None);
        assert_eq!(block_span(win, 3), Some((8, block_span_len(&f, &cues[0]))));
    }

    #[test]
    fn laced_blocks_are_rejected() {
        let mut body = el(BLOCK_ID, &block(3, 0, 0x06, "a\0b"));
        body.extend(el(BLOCK_DUR_ID, &uint(10)));
        let mut win = vec![0u8; 7];
        win.extend(el(GROUP_ID, &body));
        assert_eq!(block_in_window(&win, 3), None);
    }
}
