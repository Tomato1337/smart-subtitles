import { expect, it } from 'vitest'
import type { AnkiConnectionStatus, DepsStatus, SetupStatus, SystemInfo } from '@/common/types/ipc'
import {
  formatContinueProgress,
  formatDurationRu,
  formatRecentPosition,
  formatRemainingMinutes,
  formatSeasonEpisode,
  formatSubSource,
  formatUpdatedAt,
  getSettingsAttentionLevel,
  greetingForHour,
  isMediaCompleted,
  isVideoPath,
  pickDroppedVideoPath,
  pickHomeAttention,
  pickWelcomeSteps,
  pluralCards,
  pluralQueuedCards,
} from './homeHelpers'

const makeSetup = (overrides: Partial<Record<'deps' | 'llm' | 'opensubtitles' | 'lampa' | 'anki', boolean>> = {}): SetupStatus => ({
  complete: true,
  port: 47800,
  guideUrl: 'http://127.0.0.1:47800/llms.txt',
  configPath: '~/.config/smart-subtitle/config.json',
  steps: [
    { id: 'deps', title: 'Системные зависимости', importance: 'required', done: overrides.deps ?? true, hint: 'ok', fields: [] },
    { id: 'llm', title: 'Модель для перевода', importance: 'required', done: overrides.llm ?? true, hint: 'llm hint', fields: [] },
    { id: 'opensubtitles', title: 'Ключ OpenSubtitles', importance: 'recommended', done: overrides.opensubtitles ?? true, hint: 'os hint', fields: [] },
    { id: 'lampa', title: 'Адрес Lampa', importance: 'recommended', done: overrides.lampa ?? true, hint: 'lampa hint', fields: [] },
    { id: 'anki', title: 'Anki и карточки', importance: 'optional', done: overrides.anki ?? true, hint: 'anki hint', fields: [] },
  ],
})

it('formats season/episode tags and video extensions cleanly', () => {
  expect(formatSeasonEpisode(1, 3)).toBe('S1E3')
  expect(formatSeasonEpisode(2, null)).toBe('S2')
  expect(formatSeasonEpisode(null, 5)).toBe('E5')
  expect(formatSeasonEpisode(null, null)).toBeNull()

  expect(isVideoPath('/films/Movie.MKV')).toBe(true)
  expect(isVideoPath('/films/clip.webm')).toBe(true)
  expect(isVideoPath('/films/subtitles.srt')).toBe(false)
  expect(pickDroppedVideoPath(['/a/notes.txt', '/a/film.mp4', '/a/second.mkv'])).toBe('/a/film.mp4')
  expect(pickDroppedVideoPath(['/a/notes.txt'])).toBeNull()
})

it('formats durations, remaining minutes, and continue/recent progress', () => {
  expect(formatDurationRu(45)).toBe('< 1 мин')
  expect(formatDurationRu(3120)).toBe('52 мин')
  expect(formatDurationRu(6180)).toBe('1 ч 43 мин')
  expect(formatRemainingMinutes(720)).toBe('12 мин')

  expect(isMediaCompleted(850, 888)).toBe(true)
  expect(isMediaCompleted(148, 888)).toBe(false)

  expect(formatContinueProgress(148, 888)).toEqual({
    label: '2:28 / 14:48 · осталось 12 мин',
    progress: 148 / 888,
    completed: false,
  })
  expect(formatContinueProgress(880, 888)).toEqual({
    label: 'Досмотрен · 14:48',
    progress: 1,
    completed: true,
  })
  expect(formatRecentPosition(1740, 6180)).toEqual({
    label: '29 мин из 1 ч 43 мин',
    progress: 1740 / 6180,
    completed: false,
  })
  expect(formatRecentPosition(6150, 6180)).toEqual({
    label: 'Досмотрен',
    progress: 1,
    completed: true,
  })
})

it('formats subtitle sources, pluralized card counts, greetings, and relative dates', () => {
  expect(formatSubSource('torrserver')).toEqual({ label: 'субтитры из раздачи', shortLabel: 'Раздача' })
  expect(formatSubSource('opensubtitles')?.shortLabel).toBe('OpenSubtitles')
  expect(formatSubSource(null)).toBeNull()

  expect(pluralCards(1)).toBe('1 карточка')
  expect(pluralCards(3)).toBe('3 карточки')
  expect(pluralCards(12)).toBe('12 карточек')
  expect(pluralQueuedCards(1)).toBe('1 карточка в очереди добавится сама, когда Anki откроется.')
  expect(pluralQueuedCards(3)).toBe('3 карточки в очереди добавятся сами, когда Anki откроется.')

  expect(greetingForHour(8)).toBe('Доброе утро!')
  expect(greetingForHour(15)).toBe('Добрый день!')
  expect(greetingForHour(20)).toBe('Добрый вечер!')
  expect(greetingForHour(2)).toBe('Доброй ночи!')

  const now = 1_750_000_000
  expect(formatUpdatedAt(now - 20, now)).toBe('только что')
  expect(formatUpdatedAt(now - 600, now)).toBe('10 мин назад')
  expect(formatUpdatedAt(now - 3 * 86_400, now)).toBe('3 дн назад')
})

it('picks welcome steps prioritizing missing deps first', () => {
  expect(pickWelcomeSteps(makeSetup()).map((s) => s.step.id)).toEqual(['llm', 'opensubtitles', 'lampa'])
  expect(pickWelcomeSteps(makeSetup({ deps: false })).map((s) => s.step.id)).toEqual(['deps', 'llm', 'opensubtitles'])
})

it('prioritizes home attention banners and settings indicator levels', () => {
  const depsMissing: DepsStatus = { deps: [], notice: 'Не найден ffprobe' }
  const depsOk: DepsStatus = { deps: [], notice: null }
  const ankiQueued: AnkiConnectionStatus = { ok: false, checkedAt: 1, error: 'refused', indexCount: 0, indexUpdatedAt: null, queuedCards: 3 }
  const ankiOk: AnkiConnectionStatus = { ok: true, checkedAt: 1, error: null, indexCount: 10, indexUpdatedAt: 1, queuedCards: 0 }
  const sysInfo: SystemInfo = { version: '0.3.2', configDir: '~/.config/smart-subtitle', logsDir: '~/.config/smart-subtitle/logs', vaapiOk: true, listenPort: 47800, lampaLastSeen: {} }

  expect(pickHomeAttention({ deps: depsMissing, setup: makeSetup(), anki: ankiQueued, systemInfo: sysInfo, hasRecent: true, lampaDismissed: false })?.id).toBe('deps')
  expect(pickHomeAttention({ deps: depsOk, setup: makeSetup({ llm: false }), anki: ankiQueued, systemInfo: sysInfo, hasRecent: true, lampaDismissed: false })?.id).toBe('llm')
  expect(pickHomeAttention({ deps: depsOk, setup: makeSetup(), anki: ankiQueued, systemInfo: sysInfo, hasRecent: true, lampaDismissed: false })).toMatchObject({
    id: 'anki',
    section: 'anki',
    canRecheck: true,
    body: '3 карточки в очереди добавятся сами, когда Anki откроется.',
  })
  expect(pickHomeAttention({ deps: depsOk, setup: makeSetup({ lampa: false }), anki: ankiOk, systemInfo: sysInfo, hasRecent: true, lampaDismissed: false })?.id).toBe('lampa')
  expect(pickHomeAttention({ deps: depsOk, setup: makeSetup({ lampa: false }), anki: ankiOk, systemInfo: sysInfo, hasRecent: true, lampaDismissed: true })).toBeNull()
  expect(pickHomeAttention({ deps: depsOk, setup: makeSetup(), anki: ankiOk, systemInfo: sysInfo, hasRecent: true, lampaDismissed: false })).toBeNull()

  expect(getSettingsAttentionLevel({ deps: depsMissing, setup: makeSetup(), anki: ankiOk })).toBe('error')
  expect(getSettingsAttentionLevel({ deps: depsOk, setup: makeSetup({ llm: false }), anki: ankiOk })).toBe('error')
  expect(getSettingsAttentionLevel({ deps: depsOk, setup: makeSetup({ opensubtitles: false }), anki: ankiOk })).toBe('warn')
  expect(getSettingsAttentionLevel({ deps: depsOk, setup: makeSetup(), anki: ankiQueued })).toBe('warn')
  expect(getSettingsAttentionLevel({ deps: depsOk, setup: makeSetup(), anki: ankiOk })).toBeNull()
})
