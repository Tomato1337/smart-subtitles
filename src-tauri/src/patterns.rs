use serde::Deserialize;
use std::sync::LazyLock;

#[derive(Debug, Clone, Deserialize)]
pub struct Pattern {
    pub id: String,
    pub label: String,
    pub formula: String,
    pub level: String,
    pub about: String,
}

pub static PATTERNS: LazyLock<Vec<Pattern>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../src/modules/Patterns/patterns.json")).expect("patterns.json"));

pub fn get(id: &str) -> Option<&'static Pattern> { PATTERNS.iter().find(|p| p.id == id) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_complete_and_unique() {
        assert_eq!(PATTERNS.len(), 48);
        let mut ids: Vec<_> = PATTERNS.iter().map(|p| p.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 48);
        assert!(get("PRESENT_PERFECT").is_some() && get("NOPE").is_none());
    }
}
