//! Native Anki pipeline: AnkiConnect transport, field mapping, the built-in note type, the
//! known-words index, AI images, TTS and the card writer. tutor's `flashcards.py` is not called.

pub mod cards;
pub mod connect;
pub mod fields;
pub mod images;
pub mod index;
pub mod note_type;
pub mod tts;
