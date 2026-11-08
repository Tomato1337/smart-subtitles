import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
 AnkiCard, AnnotCost, AnnotEstimate, AnnotModel, AnnotStatus, AppConfig, AppNotification, CardJob, CardJobEditor, CardJobPage, CardPreview, CardsResult, Catalog, ChatMessage, ChatUsage, DepsStatus, EmbeddedState, Explanation, GeneratedImage, ImageRouteView, IndexModel, InirTheme, JobCursor, JobGrace, LlmPing, LlmProvider, ModelInfo, NoteTypeView, NotifyLevel, OpenStream, PatternOccurrence, PatternStat, SessionState, SetupStatus, SubCandidate, SubsCandidates, SubsList, TorrentHealth, WordDraft,
} from '@/common/types/ipc'
import { logEvent } from './eventLog'

/** Commands whose calls are too frequent to be worth a log line. */
const QUIET: Record<string, true> = { media_save_position: true, media_torrent_health: true, patterns_exposure: true, annot_prioritize: true }
/** Commands whose arguments carry credentials: the shape is logged, never the values. */
const SECRET_ARGS: Record<string, true> = {
 config_save: true, llm_models: true, llm_ping: true,
 // Unsaved image overrides carry provider keys.
 cards_preview: true, images_generate: true, images_route: true,
}

/**
 * Every IPC command goes through here so `events.log` gets the command, its duration and its outcome.
 * A failed call always logs; a successful one is skipped for QUIET commands.
  */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
 const started = performance.now()
 const shown = args === undefined ? '' : ` ${SECRET_ARGS[cmd] === true ? '{…}' : JSON.stringify(args).slice(0, 300)}`
 try {
  const result = await invoke<T>(cmd, args)
  if (QUIET[cmd] !== true) logEvent(`ipc ${cmd} ok ${Math.round(performance.now() - started)}ms${shown}`)
  return result
 } catch (e) {
  logEvent(`ipc ${cmd} fail ${Math.round(performance.now() - started)}ms${shown}: ${errorText(e)}`)
  throw e
 }
}

export type RecentMedia = {
 mediaId: string
 title: string
 originalTitle: string | null
 season: number | null
 episode: number | null
 duration: number | null
 lastPosition: number
 sourceUrl: string
 kind: 'lampa' | 'file'
 /** Dialog analysis badge for the home screen (`noSubs` = no cues at all). */
 annot: 'noSubs' | 'off' | 'new' | 'partial' | 'done' | 'failed'
 annotDone: number
 annotTotal: number
 /** Cached poster on the local media server; null when none is cached yet. */
 posterUrl: string | null
}

export const api = {
 sessionCurrent: () => call<SessionState | null>('session_current'),
 sessionClose: () => call<void>('session_close'),
 sessionOpenFile: (path: string) => call<string>('session_open_file', { path }),
 sessionOpenPlaylistItem: (index: number) => call<string>('session_open_playlist_item', { index }),
 sessionReopen: (mediaId: string) => call<string>('session_reopen', { mediaId }),
 mediaRecent: () => call<RecentMedia[]>('media_recent'),
 /** Forgets the analysis consent of a film, so reopening it asks again. */
 mediaResetAnnot: (mediaId: string) => call<void>('media_reset_annot', { mediaId }),
 /** Hides a film from «Недавних» or brings it back; nothing else about the film is deleted. */
 mediaSetHidden: (mediaId: string, hidden: boolean) => call<void>('media_set_hidden', { mediaId, hidden }),
 mediaOpenStream: (sessionId: string, at: number, audioIndex: number) =>
  call<OpenStream>('media_open_stream', { sessionId, at, audioIndex }),
 /** TorrServer peers, speed and buffer health; null for non-torrent sources and while it is silent. */
 mediaTorrentHealth: (sessionId: string) => call<TorrentHealth | null>('media_torrent_health', { sessionId }),
 mediaSavePosition: (mediaId: string, t: number) => call<void>('media_save_position', { mediaId, t }),
 mediaSetAudio: (mediaId: string, index: number) => call<void>('media_set_audio', { mediaId, index }),
 mediaSetSubOffset: (mediaId: string, sec: number) => call<void>('media_set_sub_offset', { mediaId, sec }),

 subsList: (mediaId: string) => call<SubsList>('subs_list', { mediaId }),
 subsLoadFile: (mediaId: string, path: string) => call<void>('subs_load_file', { mediaId, path }),
 /** Every English candidate the sources offer, with the installed one marked. */
 subsCandidates: (mediaId: string) => call<SubsCandidates>('subs_candidates', { mediaId }),
 subsSelect: (mediaId: string, candidate: SubCandidate) => call<void>('subs_select', { mediaId, candidate }),
 /** The embedded-subtitles load of this film, `null` when there is none. */
 subsEmbeddedState: (mediaId: string) => call<EmbeddedState | null>('subs_embedded_state', { mediaId }),
 /** The modal's answer: `true` starts reading the track, `false` lets the next source try. */
 subsEmbeddedDecide: (mediaId: string, accept: boolean) => call<void>('subs_embedded_decide', { mediaId, accept }),

 annotPrioritize: (mediaId: string, cueIdx: number) => call<void>('annot_prioritize', { mediaId, cueIdx }),
 annotRetry: (mediaId: string, firstIdx: number) => call<void>('annot_retry', { mediaId, firstIdx }),
 annotStatus: (mediaId: string) => call<AnnotStatus>('annot_status', { mediaId }),
 annotEstimate: (mediaId: string) => call<AnnotEstimate>('annot_estimate', { mediaId }),
 annotCost: (mediaId: string) => call<AnnotCost>('annot_cost', { mediaId }),
 /**
  * Consent for the dialog analysis of this film; `on` starts the background run right away.
  * `remember` also stops asking for as long as the annotate model stays the same.
  */
 annotSet: (mediaId: string, on: boolean, remember = false) => call<void>('annot_set', { mediaId, on, remember }),
 /** The current annotate model and whether its consent is remembered. */
 annotModel: () => call<AnnotModel>('annot_model'),

 llmExplain: (mediaId: string, cueIdx: number, span: string) =>
  call<Explanation>('llm_explain', { mediaId, cueIdx, span }),
 agentSend: (mediaId: string, cueIdx: number | null, at: number, text: string) => call<void>('agent_send', { mediaId, cueIdx, at, text }),
 agentHistory: (mediaId: string) => call<ChatMessage[]>('agent_history', { mediaId }),
 /** Model, effort and the film chat's running totals for the footer under the input. */
 agentUsage: (mediaId: string) => call<ChatUsage>('agent_usage', { mediaId }),

 /** Queues the words; the outcome arrives later as `cards:result` and `cards:job`. */
 cardsAdd: (proposalId: number, indices: number[]) => call<void>('cards_add', { proposalId, indices }),
 cardsDismiss: (proposalId: number) => call<void>('cards_dismiss', { proposalId }),
 /** Quick: a five-second grace job; review: a held editing job. Returns the durable job. */
 cardsJobCreate: (mediaId: string, cueIdx: number, span: string | null, audioIndex: number, subOffset: number, mode: 'quick' | 'review') =>
  call<CardJob>('cards_job_create', { mediaId, cueIdx, span, audioIndex, subOffset, mode }),
 cardsJobs: (cursor: JobCursor | null) => call<CardJobPage>('cards_jobs', { cursor }),
 cardsJobGet: (jobId: string) => call<CardJob>('cards_job_get', { jobId }),
 cardsJobHold: (jobId: string, clientId: string, held: boolean) => call<CardJob>('cards_job_hold', { jobId, clientId, held }),
 cardsJobCancel: (jobId: string, revision: number) => call<CardJob>('cards_job_cancel', { jobId, revision }),
 cardsJobEdit: (jobId: string, refresh: boolean) => call<CardJobEditor>('cards_job_edit', { jobId, refresh }),
 cardsJobPreview: (jobId: string, revision: number, draft: WordDraft, fieldValues: Record<string, string> | null) =>
  call<CardPreview>('cards_job_preview', { jobId, revision, draft, fieldValues }),
 cardsJobImage: (jobId: string, revision: number, prompt: string) => call<CardJobEditor>('cards_job_image', { jobId, revision, prompt }),
 cardsJobSave: (jobId: string, revision: number, draft: WordDraft, fieldValues: Record<string, string> | null, baselineFields: Record<string, string> | null) =>
  call<CardJob>('cards_job_save', { jobId, revision, draft, fieldValues, baselineFields }),
 cardsJobDelete: (jobId: string) => call<CardJob>('cards_job_delete', { jobId }),
 cardsJobRetry: (jobId: string) => call<CardJob>('cards_job_retry', { jobId }),
 ankiRefresh: () => call<void>('anki_refresh'),
 /** Decks with card counts and note types with their fields; fails when Anki is not running. */
 ankiCatalog: () => call<Catalog>('anki_catalog'),
 /** Note types the known-words index reads (re-read after every `anki:index`). */
 ankiIndexModels: () => call<IndexModel[]>('anki_index_models'),
 ankiNoteType: (name: string) => call<NoteTypeView>('anki_note_type', { name }),
 /** One card as Anki would show it; `anki`/`draft` null mean the saved config and a sample word. */
 cardsPreview: (anki: AppConfig['anki'] | null, draft: WordDraft | null, mediaId: string | null, cueIdx: number | null, images: AppConfig['images'] | null = null, tutor: AppConfig['tutor'] | null = null) =>
  call<CardPreview>('cards_preview', { anki, draft, mediaId, cueIdx, images, tutor }),
 /** Generates one picture and returns it as a data URL; it lands in the cache the add reuses. */
 imagesGenerate: (prompt: string, images: AppConfig['images'] | null = null, tutor: AppConfig['tutor'] | null = null) =>
  call<GeneratedImage>('images_generate', { prompt, images, tutor }),
 imagesRoute: (images: AppConfig['images'] | null = null, tutor: AppConfig['tutor'] | null = null) =>
  call<ImageRouteView>('images_route', { images, tutor }),

 patternsExposure: (mediaId: string, cueIdx: number) => call<void>('patterns_exposure', { mediaId, cueIdx }),
 patternsStats: () => call<PatternStat[]>('patterns_stats'),
 patternsSetStatus: (id: string, status: 'learning' | 'known') => call<void>('patterns_set_status', { id, status }),
 patternsOccurrences: (mediaId: string, patternId: string) =>
  call<PatternOccurrence[]>('patterns_occurrences', { mediaId, patternId }),

 tutorImportScript: (mediaId: string) => call<{ id: number }>('tutor_import_script', { mediaId }),

 themeCurrent: () => call<InirTheme | null>('theme_current'),

 /** Providers found in other coding agents' configs, with their declared models. */
 llmProviders: () => call<LlmProvider[]>('llm_providers'),
 /** Live model list for an unsaved draft. */
 llmModels: (llm: AppConfig['llm']) => call<string[]>('llm_models', { llm }),
 /** Display name, context window and price of one model. */
 llmModelInfo: (source: string, provider: string, baseUrl: string, model: string) =>
  call<ModelInfo>('llm_model_info', { source, provider, baseUrl, model }),
 /** One tiny request with the draft connection: does this model answer at all? */
 llmPing: (llm: AppConfig['llm'], model: string) => call<LlmPing>('llm_ping', { llm, model }),

 configGet: () => call<AppConfig>('config_get'),
 /** Applies at once; resolves true when the app must restart (server port). */
 configSave: (cfg: AppConfig) => call<boolean>('config_save', { cfg }),
 /** First-run checklist; also served to agents at `/api/setup`. */
 setupStatus: () => call<SetupStatus>('setup_status'),
 /** Installed system tools; a missing required one gets a toast on start. */
 depsCheck: () => call<DepsStatus>('deps_check'),

 /** Warn/error notifications kept until the user deletes them. */
 notificationsList: () => call<AppNotification[]>('notifications_list'),
 notificationsPush: (level: NotifyLevel, message: string) => call<AppNotification>('notifications_push', { level, message }),
 notificationsRemove: (id: number) => call<void>('notifications_remove', { id }),
 notificationsClear: () => call<void>('notifications_clear'),
}

export type AppEvents = {
 'session:loading': { title: string }
 'session:opened': SessionState
 'subs:status': import('@/common/types/ipc').SubsStatus
 'subs:updated': { mediaId: string }
 'subs:offset': { mediaId: string; offset: number }
 'subs:embedded': { mediaId: string; state: EmbeddedState | null }
 'annot:updated': { mediaId: string; cues: import('@/common/types/ipc').CueAnnotation[] }
 'annot:failed': { mediaId: string; firstIdx: number }
 'annot:progress': AnnotStatus
 'agent:delta': { mediaId: string; text: string }
 'agent:tool': { mediaId: string; name: string }
 'agent:proposal': { mediaId: string; proposalId: number; words: WordDraft[] }
 'agent:done': { mediaId: string }
 'agent:error': { mediaId: string; message: string }
 'player:error': { message: string }
 'config:changed': { by: 'agent' | 'app' }
 'theme:changed': InirTheme
 'anki:index': AnkiCard[]
 'cards:result': CardsResult
 'cards:job': CardJob
 'cards:grace': JobGrace
 toast: { message: string }
 'notification:added': AppNotification
}

export function onEvent<K extends keyof AppEvents>(name: K, cb: (payload: AppEvents[K]) => void): Promise<UnlistenFn> {
 return listen<AppEvents[K]>(name, (e) => cb(e.payload))
}

export function errorText(e: unknown): string {
 return typeof e === 'string' ? e : e instanceof Error ? e.message : JSON.stringify(e)
}
