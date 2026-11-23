import type { AppConfig, IndexFields, TaskKey, TaskLlm } from '@/common/types/ipc'
import type { NavSection } from './sections'

export type SettingsDiff = {
  dirty: boolean
  count: number
  changedKeys: Set<string>
  changedBySection: Partial<Record<NavSection, number>>
  restartRequired: boolean
}

const TASK_KEYS: TaskKey[] = ['annotate', 'explain', 'draft', 'chat', 'cost']

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function recordsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return arraysEqual(ka, kb) && ka.every((k) => a[k] === b[k])
}

function indexFieldsEqual(a: Record<string, IndexFields>, b: Record<string, IndexFields>): boolean {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return (
    arraysEqual(ka, kb) &&
    ka.every((k) => a[k].word === b[k].word && a[k].translation === b[k].translation)
  )
}

function taskEqual(a: TaskLlm, b: TaskLlm): boolean {
  return a.source === b.source && a.provider === b.provider && a.model === b.model && a.effort === b.effort
}

function opacityEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-4
}

/**
 * Computes logical per-setting diffs between an edited draft and the saved `AppConfig`.
 * Drives the floating `SaveBar` counter, per-row «изменено» chips, section badges and restart warning.
 */
export function diffConfig(draft: AppConfig, saved: AppConfig): SettingsDiff {
  const changedKeys = new Set<string>()
  const changedBySection: Partial<Record<NavSection, number>> = {}

  const check = (key: string, section: NavSection, equal: boolean) => {
    if (equal) return
    changedKeys.add(key)
    changedBySection[section] = (changedBySection[section] ?? 0) + 1
  }

  // Models (LLM + per-task routing)
  check('llm.source', 'models', draft.llm.source === saved.llm.source)
  check('llm.provider', 'models', draft.llm.provider === saved.llm.provider)
  check('llm.model', 'models', draft.llm.model === saved.llm.model)
  check('llm.baseUrl', 'models', draft.llm.baseUrl === saved.llm.baseUrl)
  check('llm.apiKey', 'models', draft.llm.apiKey === saved.llm.apiKey)
  check('llm.api', 'models', draft.llm.api === saved.llm.api)
  for (const task of TASK_KEYS) {
    check(`llmTasks.${task}`, 'models', taskEqual(draft.llmTasks[task], saved.llmTasks[task]))
  }

  // Level & analysis
  check('learner.cefr', 'level', draft.learner.cefr === saved.learner.cefr)
  check('annot.auto', 'level', draft.annot.auto === saved.annot.auto)
  check('annot.rememberedModel', 'level', draft.annot.rememberedModel === saved.annot.rememberedModel)

  // Subtitles & sources
  check('subtitles.sources', 'subs', arraysEqual(draft.subtitles.sources, saved.subtitles.sources))
  check('opensubtitles.apiKey', 'subs', draft.opensubtitles.apiKey === saved.opensubtitles.apiKey)
  check('opensubtitles.username', 'subs', draft.opensubtitles.username === saved.opensubtitles.username)
  check('opensubtitles.password', 'subs', draft.opensubtitles.password === saved.opensubtitles.password)
  check('subtitles.idleOpacity', 'subs', opacityEqual(draft.subtitles.idleOpacity, saved.subtitles.idleOpacity))

  // Anki
  check('anki.url', 'anki', draft.anki.url === saved.anki.url)
  check('anki.syncAfterAdd', 'anki', draft.anki.syncAfterAdd === saved.anki.syncAfterAdd)
  check('anki.deck', 'anki', draft.anki.deck === saved.anki.deck)
  check('anki.noteType', 'anki', draft.anki.noteType === saved.anki.noteType)
  check('anki.tags', 'anki', draft.anki.tags === saved.anki.tags)
  check('anki.fields', 'anki', recordsEqual(draft.anki.fields, saved.anki.fields))
  check('anki.indexDecks', 'anki', arraysEqual(draft.anki.indexDecks, saved.anki.indexDecks))
  check('anki.indexFields', 'anki', indexFieldsEqual(draft.anki.indexFields, saved.anki.indexFields))

  // Media (clip & audio)
  check('anki.quickAdd', 'media', draft.anki.quickAdd === saved.anki.quickAdd)
  check('anki.clip', 'media', draft.anki.clip === saved.anki.clip)
  check('anki.sentenceAudio', 'media', draft.anki.sentenceAudio === saved.anki.sentenceAudio)
  check('anki.tts', 'media', draft.anki.tts === saved.anki.tts)
  check('anki.ttsVoice', 'media', draft.anki.ttsVoice === saved.anki.ttsVoice)

  // Images
  check('images.backend', 'images', draft.images.backend === saved.images.backend)
  check('images.fallbacks', 'images', arraysEqual(draft.images.fallbacks, saved.images.fallbacks))
  check('images.style', 'images', draft.images.style === saved.images.style)
  check('images.openai.baseUrl', 'images', draft.images.openai.baseUrl === saved.images.openai.baseUrl)
  check('images.openai.apiKey', 'images', draft.images.openai.apiKey === saved.images.openai.apiKey)
  check('images.openai.model', 'images', draft.images.openai.model === saved.images.openai.model)
  check('images.openai.size', 'images', draft.images.openai.size === saved.images.openai.size)
  check('images.runware.apiKey', 'images', draft.images.runware.apiKey === saved.images.runware.apiKey)
  check('images.runware.model', 'images', draft.images.runware.model === saved.images.runware.model)
  check('images.gemini.apiKey', 'images', draft.images.gemini.apiKey === saved.images.gemini.apiKey)
  check('images.gemini.model', 'images', draft.images.gemini.model === saved.images.gemini.model)
  check('images.omp.model', 'images', draft.images.omp.model === saved.images.omp.model)
  check('images.omp.agentModel', 'images', draft.images.omp.agentModel === saved.images.omp.agentModel)

  // Lampa & TorrServer & server port
  check('lampa.origins', 'lampa', arraysEqual(draft.lampa.origins, saved.lampa.origins))
  check('torrserver.baseUrl', 'lampa', draft.torrserver.baseUrl === saved.torrserver.baseUrl)
  check('torrserver.username', 'lampa', draft.torrserver.username === saved.torrserver.username)
  check('torrserver.password', 'lampa', draft.torrserver.password === saved.torrserver.password)
  check('server.port', 'lampa', draft.server.port === saved.server.port)

  // System & Tutor
  check('ffmpeg.vaapiDevice', 'system', draft.ffmpeg.vaapiDevice === saved.ffmpeg.vaapiDevice)
  check('tutor.enabled', 'system', draft.tutor.enabled === saved.tutor.enabled)
  check('tutor.root', 'system', draft.tutor.root === saved.tutor.root)
  check('tutor.apiUrl', 'system', draft.tutor.apiUrl === saved.tutor.apiUrl)
  check('tutor.useImageSettings', 'system', draft.tutor.useImageSettings === saved.tutor.useImageSettings)

  return {
    dirty: changedKeys.size > 0,
    count: changedKeys.size,
    changedKeys,
    changedBySection,
    restartRequired: draft.server.port !== saved.server.port,
  }
}
