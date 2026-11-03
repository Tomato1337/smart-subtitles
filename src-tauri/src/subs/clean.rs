use regex::Regex;
use std::sync::OnceLock;

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).unwrap())
}

/// Strips markup, sound descriptions and speaker labels; returns "" when nothing speakable is left.
pub fn clean(text: &str) -> String {
    static ASS: OnceLock<Regex> = OnceLock::new();
    static HTML: OnceLock<Regex> = OnceLock::new();
    static BRACKET: OnceLock<Regex> = OnceLock::new();
    static SPEAKER: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();

    let t = re(&ASS, r"\{[^}]*\}").replace_all(text, "");
    let t = re(&HTML, r"<[^>]+>").replace_all(&t, "");
    let t = t.replace("\\N", "\n").replace("\\n", "\n").replace('\r', "");
    let t = re(&BRACKET, r"\[[^\]]*\]").replace_all(&t, "");
    let lines: Vec<String> = t
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('♪') && !(l.starts_with('(') && l.ends_with(')') && !l[1..l.len() - 1].contains('(')))
        .map(|l| {
            let l = re(&SPEAKER, r"^[A-Z][A-Z0-9 .'-]{1,30}:\s+").replace(l, "");
            re(&SPACES, r"\s+").replace_all(l.trim(), " ").into_owned()
        })
        .filter(|l| !l.is_empty())
        .collect();
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_markup_sounds_and_speaker() {
        assert_eq!(clean("<i>JOHN: Hey!</i>\n[door slams]"), "Hey!");
    }
    #[test]
    fn music_cue_is_empty() {
        assert_eq!(clean("♪ la la ♪"), "");
        assert_eq!(clean("(sighs)"), "");
    }
    #[test]
    fn ass_tags_and_newlines() {
        assert_eq!(clean("{\\an8}Hello\\Nworld  again"), "Hello\nworld again");
    }
    #[test]
    fn keeps_lowercase_colon_and_inline_parens() {
        assert_eq!(clean("Note: it works (mostly)"), "Note: it works (mostly)");
    }
}
