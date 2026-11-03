import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AnkiCard, AppConfig, CardsResult, ChatMessage, Explanation, InirTheme, OpenStream, PatternOccurrence, PatternStat, SessionState, SubsList, WordDraft,
} from '@/common/types/ipc'

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
}

export const api = {
  sessionCurrent: () => invoke<SessionState | null>('session_current'),
  sessionClose: () => invoke<void>('session_close'),
  sessionOpenFile: (path: string) => invoke<string>('session_open_file', { path }),
  sessionOpenPlaylistItem: (index: number) => invoke<string>('session_open_playlist_item', { index }),
  sessionReopen: (mediaId: string) => invoke<string>('session_reopen', { mediaId }),
  mediaRecent: () => invoke<RecentMedia[]>('media_recent'),
  mediaOpenStream: (sessionId: string, at: number, audioIndex: number) =>
    invoke<OpenStream>('media_open_stream', { sessionId, at, audioIndex }),
  mediaSavePosition: (mediaId: string, t: number) => invoke<void>('media_save_position', { mediaId, t }),
  mediaSetAudio: (mediaId: string, index: number) => invoke<void>('media_set_audio', { mediaId, index }),
  mediaSetSubOffset: (mediaId: string, sec: number) => invoke<void>('media_set_sub_offset', { mediaId, sec }),

  subsList: (mediaId: string) => invoke<SubsList>('subs_list', { mediaId }),
  subsLoadFile: (mediaId: string, path: string) => invoke<void>('subs_load_file', { mediaId, path }),

  annotPrioritize: (mediaId: string, cueIdx: number) => invoke<void>('annot_prioritize', { mediaId, cueIdx }),
  annotRetry: (mediaId: string, firstIdx: number) => invoke<void>('annot_retry', { mediaId, firstIdx }),

  llmExplain: (mediaId: string, cueIdx: number, span: string) =>
    invoke<Explanation>('llm_explain', { mediaId, cueIdx, span }),
  agentSend: (mediaId: string, cueIdx: number | null, at: number, text: string) => invoke<void>('agent_send', { mediaId, cueIdx, at, text }),
  agentHistory: (mediaId: string) => invoke<ChatMessage[]>('agent_history', { mediaId }),

  cardsDraft: (mediaId: string, cueIdx: number, span: string | null) =>
    invoke<WordDraft>('cards_draft', { mediaId, cueIdx, span }),
  cardsCreateProposal: (mediaId: string, cueIdx: number, words: WordDraft[]) =>
    invoke<number>('cards_create_proposal', { mediaId, cueIdx, words }),
  /** Queues the words; the outcome arrives later as `cards:result`. */
  cardsAdd: (proposalId: number, indices: number[]) => invoke<void>('cards_add', { proposalId, indices }),
  cardsDismiss: (proposalId: number) => invoke<void>('cards_dismiss', { proposalId }),
  ankiRefresh: () => invoke<void>('anki_refresh'),

  patternsExposure: (mediaId: string, cueIdx: number) => invoke<void>('patterns_exposure', { mediaId, cueIdx }),
  patternsStats: () => invoke<PatternStat[]>('patterns_stats'),
  patternsSetStatus: (id: string, status: 'learning' | 'known') => invoke<void>('patterns_set_status', { id, status }),
  patternsOccurrences: (mediaId: string, patternId: string) =>
    invoke<PatternOccurrence[]>('patterns_occurrences', { mediaId, patternId }),

  tutorImportScript: (mediaId: string) => invoke<{ id: number }>('tutor_import_script', { mediaId }),

  themeCurrent: () => invoke<InirTheme | null>('theme_current'),

  configGet: () => invoke<AppConfig>('config_get'),
  /** Applies at once; resolves true when the app must restart (server port). */
  configSave: (cfg: AppConfig) => invoke<boolean>('config_save', { cfg }),
}

export type AppEvents = {
  'session:loading': { title: string }
  'session:opened': SessionState
  'subs:status': import('@/common/types/ipc').SubsStatus
  'subs:updated': { mediaId: string }
  'subs:offset': { mediaId: string; offset: number }
  'annot:updated': { mediaId: string; cues: import('@/common/types/ipc').CueAnnotation[] }
  'annot:failed': { mediaId: string; firstIdx: number }
  'agent:delta': { mediaId: string; text: string }
  'agent:tool': { mediaId: string; name: string }
  'agent:proposal': { mediaId: string; proposalId: number; words: WordDraft[] }
  'agent:done': { mediaId: string }
  'agent:error': { mediaId: string; message: string }
  'player:error': { message: string }
  'theme:changed': InirTheme
  'anki:index': AnkiCard[]
  'cards:result': CardsResult
  toast: { message: string }
}

export function onEvent<K extends keyof AppEvents>(name: K, cb: (payload: AppEvents[K]) => void): Promise<UnlistenFn> {
  return listen<AppEvents[K]>(name, (e) => cb(e.payload))
}

export function errorText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : JSON.stringify(e)
}
