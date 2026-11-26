import type { RecentMedia } from '@/common/api/tauri'
import type { AnkiConnectionStatus, DepsStatus, SetupStatus, SetupStep, SystemInfo } from '@/common/types/ipc'
import { pluralRu } from '@/common/utilities/pluralRu'
import { formatTime } from '@/common/utilities/time'

export type SettingsSection =
  | 'models'
  | 'level'
  | 'subs'
  | 'anki'
  | 'media'
  | 'images'
  | 'lampa'
  | 'keys'
  | 'system'

export const VIDEO_EXTENSIONS = ['mkv', 'mp4', 'avi', 'webm', 'mov'] as const

const VIDEO_RE = /\.(mkv|mp4|avi|webm|mov)$/i

/** Checks whether a file path or name uses a supported video extension. */
export function isVideoPath(path: string): boolean {
  return VIDEO_RE.test(path.trim())
}

/** Picks the first supported video file from a drag-and-drop list, or null when none match. */
export function pickDroppedVideoPath(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (isVideoPath(path)) return path
  }
  return null
}

/** Formats season/episode tag such as `S1E3`; returns null when neither is set. */
export function formatSeasonEpisode(season: number | null, episode: number | null): string | null {
  if (season !== null && episode !== null) return `S${season}E${episode}`
  if (season !== null) return `S${season}`
  if (episode !== null) return `E${episode}`
  return null
}

/** Formats duration in Russian compact form (`1 ч 43 мин`, `52 мин`, `< 1 мин`). */
export function formatDurationRu(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0 мин'
  const totalSec = Math.floor(sec)
  if (totalSec > 0 && totalSec < 60) return '< 1 мин'
  const mins = Math.floor(totalSec / 60)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h > 0 && m > 0) return `${h} ч ${m} мин`
  if (h > 0) return `${h} ч`
  return `${m} мин`
}

/** Formats remaining playback time (`12 мин`, `1 ч 14 мин`, `< 1 мин`). */
export function formatRemainingMinutes(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0 мин'
  const rem = Math.ceil(sec)
  if (rem > 0 && rem < 60) return '< 1 мин'
  return formatDurationRu(rem)
}

/** True when playback reached the final tail of a film (matching backend `resume_position` 60 s rule). */
export function isMediaCompleted(lastPosition: number, duration: number | null): boolean {
  if (!Number.isFinite(lastPosition) || !duration || !Number.isFinite(duration) || duration <= 0) return false
  return lastPosition >= Math.max(duration - 60, duration * 0.95)
}

/** Progress readout for the hero `ContinueCard`. */
export function formatContinueProgress(
  lastPosition: number,
  duration: number | null,
): { label: string; progress: number; completed: boolean } {
  const pos = Number.isFinite(lastPosition) && lastPosition > 0 ? lastPosition : 0
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    return { label: formatTime(pos), progress: 0, completed: false }
  }
  const completed = isMediaCompleted(pos, duration)
  const progress = completed ? 1 : Math.max(0, Math.min(1, pos / duration))
  if (completed) {
    return { label: `Досмотрен · ${formatTime(duration)}`, progress: 1, completed: true }
  }
  const rem = Math.max(0, duration - pos)
  const base = `${formatTime(pos)} / ${formatTime(duration)}`
  if (pos > 0 && rem > 0) {
    return { label: `${base} · осталось ${formatRemainingMinutes(rem)}`, progress, completed: false }
  }
  return { label: base, progress, completed: false }
}

/** Compact progress readout for cards and rows in «Недавние». */
export function formatRecentPosition(
  lastPosition: number,
  duration: number | null,
): { label: string; progress: number; completed: boolean } {
  const pos = Number.isFinite(lastPosition) && lastPosition > 0 ? lastPosition : 0
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    return { label: pos > 0 ? formatTime(pos) : 'Не начат', progress: 0, completed: false }
  }
  const completed = isMediaCompleted(pos, duration)
  if (completed) return { label: 'Досмотрен', progress: 1, completed: true }
  const progress = Math.max(0, Math.min(1, pos / duration))
  const posText = pos < 60 && pos > 0 ? '< 1 мин' : formatDurationRu(pos)
  return { label: `${posText} из ${formatDurationRu(duration)}`, progress, completed: false }
}

/** Human-readable label for the stored subtitle source. */
export function formatSubSource(source: RecentMedia['subSource']): { label: string; shortLabel: string } | null {
  switch (source) {
    case 'torrserver':
      return { label: 'субтитры из раздачи', shortLabel: 'Раздача' }
    case 'sidecar':
      return { label: 'субтитры рядом с файлом', shortLabel: 'Файл' }
    case 'opensubtitles':
      return { label: 'субтитры OpenSubtitles', shortLabel: 'OpenSubtitles' }
    case 'embedded':
      return { label: 'встроенные субтитры', shortLabel: 'Контейнер' }
    default:
      return null
  }
}

export function pluralCards(count: number): string {
  return `${count} ${pluralRu(count, 'карточка', 'карточки', 'карточек')}`
}

export function pluralQueuedCards(count: number): string {
  const noun = pluralRu(count, 'карточка', 'карточки', 'карточек')
  const verb = pluralRu(count, 'добавится сама', 'добавятся сами', 'добавятся сами')
  return `${count} ${noun} в очереди ${verb}, когда Anki откроется.`
}

/** Relative Russian date label for `updatedAt` (unix seconds). */
export function formatUpdatedAt(unixSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
  if (!unixSec || unixSec <= 0) return ''
  const diff = Math.max(0, nowSec - unixSec)
  if (diff < 60) return 'только что'
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`
  if (diff < 86_400) {
    const today = new Date(nowSec * 1000)
    const then = new Date(unixSec * 1000)
    if (today.toDateString() === then.toDateString()) return 'сегодня'
    return 'вчера'
  }
  const days = Math.floor(diff / 86_400)
  if (days === 1) return 'вчера'
  if (days < 7) return `${days} дн назад`
  return new Date(unixSec * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Доброе утро!'
  if (hour >= 12 && hour < 18) return 'Добрый день!'
  if (hour >= 18 && hour < 23) return 'Добрый вечер!'
  return 'Доброй ночи!'
}

export type WelcomeStepItem = {
  step: SetupStep
  section: SettingsSection
  actionLabel: string
  priority: 'tonal' | 'outlined'
}

const STEP_META: Record<SetupStep['id'], { section: SettingsSection; actionLabel: string; priority: 'tonal' | 'outlined' }> = {
  deps: { section: 'system', actionLabel: 'Проверить', priority: 'tonal' },
  llm: { section: 'models', actionLabel: 'Выбрать', priority: 'tonal' },
  opensubtitles: { section: 'subs', actionLabel: 'Добавить', priority: 'tonal' },
  lampa: { section: 'lampa', actionLabel: 'Указать', priority: 'outlined' },
  anki: { section: 'anki', actionLabel: 'Настроить', priority: 'outlined' },
}

/** Picks the 3 key onboarding steps for `WelcomeCard`: `deps` only when missing, otherwise LLM, OpenSubtitles, Lampa. */
export function pickWelcomeSteps(setup: SetupStatus | undefined): WelcomeStepItem[] {
  if (!setup) return []
  const byId = new Map(setup.steps.map((s) => [s.id, s]))
  const deps = byId.get('deps')
  const order: SetupStep['id'][] =
    deps && !deps.done ? ['deps', 'llm', 'opensubtitles'] : ['llm', 'opensubtitles', 'lampa']
  const out: WelcomeStepItem[] = []
  for (const id of order) {
    const step = byId.get(id)
    if (!step) continue
    out.push({ step, ...STEP_META[id] })
  }
  return out
}

export type HomeAttentionBanner = {
  id: 'deps' | 'llm' | 'anki' | 'lampa'
  tone: 'error' | 'warning' | 'neutral'
  icon: string
  title: string
  body: string
  section: SettingsSection
  actionLabel: string
  canRecheck?: boolean
  canDismiss?: boolean
}

/** Chooses the highest-priority actionable status banner for the Home screen. */
export function pickHomeAttention({
  deps,
  setup,
  anki,
  systemInfo,
  hasRecent,
  lampaDismissed,
}: {
  deps?: DepsStatus
  setup?: SetupStatus
  anki?: AnkiConnectionStatus
  systemInfo?: SystemInfo
  hasRecent: boolean
  lampaDismissed: boolean
}): HomeAttentionBanner | null {
  if (deps?.notice) {
    return {
      id: 'deps',
      tone: 'error',
      icon: 'build',
      title: 'Не найдены системные программы',
      body: deps.notice,
      section: 'system',
      actionLabel: 'Настройки',
    }
  }

  const llmStep = setup?.steps.find((s) => s.id === 'llm')
  if (hasRecent && llmStep && !llmStep.done) {
    return {
      id: 'llm',
      tone: 'warning',
      icon: 'neurology',
      title: 'Модель ИИ не настроена',
      body: llmStep.hint,
      section: 'models',
      actionLabel: 'Настроить',
    }
  }

  if (anki && !anki.ok && anki.queuedCards > 0) {
    return {
      id: 'anki',
      tone: 'warning',
      icon: 'sync_problem',
      title: 'Anki не запущен',
      body: pluralQueuedCards(anki.queuedCards),
      section: 'anki',
      actionLabel: 'Настройки',
      canRecheck: true,
    }
  }

  const lampaStep = setup?.steps.find((s) => s.id === 'lampa')
  const lampaSeenCount = systemInfo ? Object.keys(systemInfo.lampaLastSeen).length : 0
  if (hasRecent && lampaStep && !lampaStep.done && lampaSeenCount === 0 && !lampaDismissed) {
    return {
      id: 'lampa',
      tone: 'neutral',
      icon: 'live_tv',
      title: 'Lampa не подключена',
      body: 'Укажите адрес вашей Lampa, чтобы открывать фильмы в один клик.',
      section: 'lampa',
      actionLabel: 'Указать',
      canDismiss: true,
    }
  }

  return null
}

/** Attention indicator severity for the Settings header icon button. */
export function getSettingsAttentionLevel({
  deps,
  setup,
  anki,
}: {
  deps?: DepsStatus
  setup?: SetupStatus
  anki?: AnkiConnectionStatus
}): 'error' | 'warn' | null {
  if (deps?.notice) return 'error'
  const requiredMissing = setup?.steps.some((s) => s.importance === 'required' && !s.done) ?? false
  if (requiredMissing) return 'error'
  const recommendedMissing = setup?.steps.some((s) => s.importance === 'recommended' && !s.done) ?? false
  if (recommendedMissing) return 'warn'
  if (anki && !anki.ok && anki.queuedCards > 0) return 'warn'
  return null
}
