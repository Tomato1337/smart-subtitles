// TS mirror of the serde structs in src-tauri (camelCase). Keep in sync with Rust.

export type Cue = { idx: number; start: number; end: number; text: string; ru: string | null }

export type ChunkKind = 'idiom' | 'phrasal_verb' | 'collocation' | 'slang' | 'reduction' | 'grammar'

export type Chunk = { startChar: number; endChar: number; text: string; kind: ChunkKind; ru: string }
export type CuePattern = { patternId: string; startChar: number; endChar: number }
export type CueAnnotation = { idx: number; ru: string; chunks: Chunk[]; patterns: CuePattern[] }

export type AudioTrack = { index: number; codec: string; lang: string | null; title: string | null; channels: number }

export type SessionState = {
  sessionId: string
  mediaId: string
  title: string
  originalTitle: string | null
  year: number | null
  season: number | null
  episode: number | null
  episodeTitle: string | null
  posterUrl: string | null
  duration: number
  audioTracks: AudioTrack[]
  audioIndex: number
  resumeAt: number
  subOffset: number
  playlist: { title: string }[]
  playlistIndex: number | null
  llmEnabled: boolean
}

export type WordDraft = {
  word: string
  translation: string
  word_type: string
  cloze_sentence: string
  full_sentence: string
  sentence_translation: string
  image_prompt: string
}

/** Outcome of one background Anki add (`cards:result`). */
export type CardsResult = {
  proposalId: number
  mediaId: string
  cueIdx: number
  indices: number[]
  words: string[]
  added: number
  /** Nothing reached Anki. */
  error: string | null
  /** Added, but some media is missing. */
  warnings: string[]
}

export type Explanation = {
  chunk: string
  translation: string
  meaning: string
  literal: string
  register: string
  word_type: string
  grammar: string
  pattern_id: string | null
  examples: { en: string; ru: string }[]
}

export type AnkiStatus = 'new' | 'learning' | 'young' | 'learned' | 'weak' | 'leech'
export type AnkiCard = { word: string; translation: string; status: AnkiStatus; interval: number }

export type AnkiEntry = AnkiCard & { key: string }
export type AnkiLabelMode = 'fresh' | 'unlearned' | 'off'

export type OpenStream = { url: string }

/** inir's generated palette (`$XDG_STATE_HOME/quickshell/user/generated`). */
export type InirTheme = { seed: string; mode: 'dark' | 'light'; colors: Record<string, string> }

export type SubsStatus = {
  mediaId: string
  state: 'searching' | 'downloading' | 'ready' | 'none'
  source?: 'sidecar' | 'opensubtitles'
  exact?: boolean
  progress?: number
  message?: string
}

export type ChatMessage = {
  id: number
  role: 'user' | 'assistant' | 'proposal'
  text: string
  /** Learner's place in the film when sending (user messages); null for older or non-user messages. */
  cueIdx: number | null
  at: number | null
  proposalId: number | null
  words: WordDraft[] | null
  status: 'pending' | 'adding' | 'added' | 'dismissed' | 'failed' | null
  createdAt: number
}
export type PatternStat = { id: string; count: number; status: 'learning' | 'known' | null }
export type PatternOccurrence = { idx: number; text: string }
export type SubsList = { cues: Cue[]; annotations: CueAnnotation[] }

/** `~/.config/smart-subtitle/config.json` (Rust `config::Config`). */
export type AppConfig = {
  server: { port: number }
  lampa: { origins: string[] }
  llm: { baseUrl: string; apiKey: string; model: string }
  opensubtitles: { apiKey: string; username: string; password: string }
  tutor: { root: string; apiUrl: string; deck: string }
  torrserver: { baseUrl: string; username: string; password: string }
  ffmpeg: { vaapiDevice: string }
  learner: { cefr: string }
}
