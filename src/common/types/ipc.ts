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
 /** The source is a TorrServer stream: the player can show its peers, speed and buffer signal. */
 torrent: boolean
}

/** Live TorrServer state of a stream (`media_torrent_health`). */
export type TorrentHealth = {
 activePeers: number
 totalPeers: number
 connectedSeeders: number
 /** Bytes per second. */
 downloadSpeed: number
 /** Contiguous downloaded share of the reader window; null while no reader is open. */
 bufferPercent: number | null
 bufferedPieces: number
 bufferPieces: number
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

/** Stage of one background add (`cards:progress`); the draft modal and agent proposals show it. */
export type CardsPhase = 'queued' | 'preparing' | 'clip' | 'image' | 'audio' | 'anki' | 'sync'
export type CardsProgress = {
 proposalId: number
 mediaId: string
 phase: CardsPhase
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
export type AnkiCard = { word: string; translation: string; status: AnkiStatus; interval: number; lapses: number }

export type AnkiEntry = AnkiCard & { key: string }
export type AnkiLabelMode = 'fresh' | 'unlearned' | 'off'

export type OpenStream = { url: string }

/** inir's generated palette (`$XDG_STATE_HOME/quickshell/user/generated`). */
export type InirTheme = { seed: string; mode: 'dark' | 'light'; colors: Record<string, string> }

export type SubsStatus = {
 mediaId: string
 state: 'searching' | 'downloading' | 'ready' | 'none'
 source?: 'sidecar' | 'opensubtitles' | 'embedded'
 exact?: boolean
 progress?: number
 message?: string
}

/**
 * One embedded (in-file) subtitle load: the confirmation modal, the hold on playback and the
 * load line under the timeline all read it.
 */
export type EmbeddedState = {
 phase: 'confirm' | 'loading' | 'done' | 'failed'
 /** Track label, e.g. `ENG · US`. */
 track: string
 totalCues: number
 loadedCues: number
 /** Every cue starting before this second is stored. */
 loadedUntil: number
 /** Playback may start once `loadedUntil >= headUntil`. */
 headUntil: number
 /** Bytes TorrServer will download for the whole track. */
 estBytes: number
 /** Bytes for the part up to `headUntil`. */
 headBytes: number
 pieceBytes: number
 message: string | null
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

/** One English subtitle file the user can switch to (`source` is the Rust enum tag). */
export type SubCandidate =
 | { source: 'torrserver'; track: number; title: string; lang: string }
 | { source: 'sidecar'; url: string; label: string }
 | { source: 'embedded'; track: number; title: string; cues: number; bytes: number }
 | { source: 'opensubtitles'; fileId: number; release: string; exact: boolean; hearingImpaired: boolean; downloads: number; cached: boolean }

/** Everything the chooser shows: the installed candidate, every option, and the empty sources. */
export type SubsCandidates = {
 activeKey: string | null
 activeLabel: string | null
 items: { key: string; candidate: SubCandidate }[]
 notes: { source: SubtitleSource; message: string }[]
}

/** Background dialog analysis of one film: consent plus batch counters (`annot_status`). */
export type AnnotStatus = { mediaId: string; consent: 'on' | 'off' | null; total: number; done: number; failed: number }
/** Tokens the remaining analysis will cost, counted without an LLM request (`annot_estimate`). */
export type AnnotEstimate = {
 cues: number
 batches: number
 inputTokens: number
 cachedTokens: number
 outputTokens: number
 /** The cues are still being read from the video file: the numbers cover the whole film. */
 partial: boolean
}
/** Which model the remembered "analyze without asking" consent belongs to (`annot_model`). */
export type AnnotModel = { key: string; auto: boolean }
/** Price of the remaining analysis: from the price catalog, or the cost model's guess (`annot_cost`). */
export type AnnotCost = {
 usd: number | null
 inputPrice: number | null
 cachedPrice: number | null
 outputPrice: number | null
 note: string
 source: 'catalog' | 'llm'
 model: string
}

export type LlmApi = 'openai' | 'anthropic'

/** Reasoning effort of one task; `off` sends exactly the old request body. */
export type Effort = 'off' | 'low' | 'medium' | 'high'
/** Tasks that can have their own model (`llmTasks.<key>`). */
export type TaskKey = 'annotate' | 'explain' | 'draft' | 'chat' | 'cost'
/** One task's connection: empty `source` means the main `llm` settings. */
export type TaskLlm = { source: string; provider: string; model: string; effort: Effort }

/** USD per 1M tokens. */
export type ModelPrice = { input: number; output: number; cacheRead: number | null; cacheWrite: number | null }
/** Catalog data of one model (`llm_model_info`). */
export type ModelInfo = { name: string; contextWindow: number | null; price: ModelPrice | null; priceSource: string }
/** Answer of a test request (`llm_ping`): latency and the model's short reply. */
export type LlmPing = { ms: number; reply: string }

/** The film chat's footer: current model plus the running totals of the whole thread (`agent_usage`). */
export type ChatUsage = {
 model: string
 modelName: string
 effort: Effort
 contextWindow: number | null
 contextTokens: number
 inputTokens: number
 outputTokens: number
 usd: number | null
 /** Some requests have no known price, so `usd` is a lower bound. */
 usdPartial: boolean
}

/** A provider already configured in another coding agent (`llm_providers`). */
export type LlmProvider = {
 source: string
 sourceLabel: string
 id: string
 label: string
 api: LlmApi
 baseUrl: string
 hasKey: boolean
 /** Config file it comes from, with $HOME as `~`. */
 file: string
 models: string[]
}

/** A system tool checked by `deps_check`; `notice` is set when a required one is missing. */
export type Dep = {
 id: string
 title: string
 importance: 'required' | 'optional'
 found: boolean
 purpose: string
 install: string
 hint: string
}

export type DepsStatus = { deps: Dep[]; notice: string | null }

/** One row of the first-run wizard and of `/api/setup` (`setup_status`). */
export type SetupStep = {
 id: 'deps' | 'llm' | 'opensubtitles' | 'lampa' | 'anki'
 title: string
 importance: 'required' | 'recommended' | 'optional'
 done: boolean
 hint: string
 fields: string[]
}

export type SetupStatus = {
 complete: boolean
 port: number
 guideUrl: string
 configPath: string
 steps: SetupStep[]
}

/** Source of one Anki field value; '' = field left empty. */
export type CardSource =
 | ''
 | 'word'
 | 'translation'
 | 'wordType'
 | 'clozeGap'
 | 'clozeRaw'
 | 'sentence'
 | 'sentenceTranslation'
 | 'image'
 | 'wordAudio'
 | 'sentenceAudio'
 | 'clip'
 | 'clipText'
 | 'clipSource'

/** Word/translation fields of one note type, for the known-words index. */
export type IndexFields = { word: string; translation: string }

export type AnkiConfig = {
 url: string
 deck: string
 noteType: string
 /** Anki field name -> source id; a missing field is auto-mapped. */
 fields: Record<string, string>
 tags: string
 /** `["*"]` = every deck, empty = only `deck`. */
 indexDecks: string[]
 indexFields: Record<string, IndexFields>
 tts: boolean
 ttsVoice: string
 sentenceAudio: 'none' | 'clip' | 'tts'
 /** Cut the movie clip at all: off empties Clip/ClipText/ClipSource and disables clip audio. */
 clip: boolean
 syncAfterAdd: boolean
}

export type ImagesConfig = {
 backend: 'none' | 'openai' | 'runware' | 'gemini' | 'omp'
 style: string
 openai: { baseUrl: string; apiKey: string; model: string; size: string }
 runware: { apiKey: string; model: string }
 gemini: { apiKey: string; model: string }
 omp: { model: string; agentModel: string }
}

/** A deck Anki reported (`anki_catalog`). */
export type DeckInfo = { name: string; cards: number }
export type NoteTypeInfo = { name: string; fields: string[] }
export type Catalog = { decks: DeckInfo[]; noteTypes: NoteTypeInfo[] }

/** Fields, template and CSS of one note type as Anki has them (`anki_note_type`). */
export type NoteTypeView = {
 name: string
 fields: string[]
 front: string
 back: string
 css: string
 /** The note type the app maintains and creates on demand. */
 builtin: boolean
 /** False when the built-in note type is not in Anki yet: the view is the constant. */
 exists: boolean
}

/** One note type the known-words index reads. */
export type IndexModel = {
 noteType: string
 cards: number
 wordField: string
 translationField: string
 fields: string[]
}

/** A card as the settings dialog and the add-card dialog preview it (`cards_preview`). */
export type CardPreview = {
 noteType: NoteTypeView
 /** Anki field name -> source id (`''` = empty). */
 mapping: [string, string][]
 values: Record<string, string>
}

/** Automatic subtitle sources, in the order `subtitles.sources` lists them. */
export type SubtitleSource = 'torrserver' | 'sidecar' | 'embedded' | 'opensubtitles'

/** `~/.config/smart-subtitle/config.json` (Rust `config::Config`). */
export type AppConfig = {
 server: { port: number }
 lampa: { origins: string[] }
 llm: { source: string; provider: string; model: string; baseUrl: string; apiKey: string; api: LlmApi }
 llmTasks: Record<TaskKey, TaskLlm>
 opensubtitles: { apiKey: string; username: string; password: string }
 subtitles: { sources: SubtitleSource[] }
 /** Consent of the dialog analysis: `auto` = do not ask for `rememberedModel`. */
 annot: { auto: boolean; rememberedModel: string }
 tutor: { enabled: boolean; root: string; apiUrl: string; useImageSettings: boolean }
 anki: AnkiConfig
 images: ImagesConfig
 torrserver: { baseUrl: string; username: string; password: string }
 ffmpeg: { vaapiDevice: string }
 learner: { cefr: string }
}

/** Toast level ("Настройки сохранены" stays an untracked Snackbar, so it is not a level). */
export type NotifyLevel = 'warn' | 'error'

/** A warn/error kept until the user deletes it (`notification` table, `createdAt` in unix seconds). */
export type AppNotification = { id: number; level: NotifyLevel; message: string; createdAt: number }
