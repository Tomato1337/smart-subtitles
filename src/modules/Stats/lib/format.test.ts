import { describe, expect, test } from 'vitest'
import type { HeatmapDay, UnaddedWord } from '@/common/types/ipc'
import {
  buildHeatmapColumns,
  cefrGoalLabel,
  cefrWindowLabel,
  computeSpendSharePct,
  filmCefrSummary,
  filterGrammarPatterns,
  filterUnaddedWords,
  formatAiTaskRequestCount,
  formatFilmCountLabel,
  formatSharePct,
  formatUsdAxisTick,
  formatWatchDelta,
  formatWatchDuration,
  niceAxisCeil,
  paceLabel,
  PATTERN_STATS_KEY,
  pickAxisLabelIndices,
} from './format'

function makeWord(over: Partial<UnaddedWord>): UnaddedWord {
  return {
    lemma: 'decide',
    span: 'decide',
    translation: 'решать',
    mediaId: 'm1',
    title: 'Film',
    season: null,
    episode: null,
    cueIdx: 1,
    audioIndex: 0,
    subOffset: 0,
    quote: 'I decide.',
    clicks: 1,
    filmsCount: 1,
    filmTitles: ['Film'],
    tier: 'core',
    cefr: 'A2',
    aboveLevel: false,
    spoken: true,
    business: false,
    lastSeenAt: 100,
    ...over,
  }
}

describe('Stats formatters & filters', () => {
  test('formats durations and signed deltas cleanly in Russian', () => {
    expect(formatWatchDuration(0)).toBe('0 м')
    expect(formatWatchDuration(2520)).toBe('42 м')
    expect(formatWatchDuration(51_600)).toBe('14 ч 20 м')
    expect(formatWatchDuration(7200)).toBe('2 ч')
    expect(formatWatchDelta(3600, 1800)).toBe('+30 м к пред. периоду')
    expect(formatWatchDelta(1800, 3600)).toBe('−30 м к пред. периоду')
    expect(formatWatchDelta(100, null)).toBeNull()
    expect(formatFilmCountLabel(1)).toBe('1 фильм')
    expect(formatFilmCountLabel(2)).toBe('2 фильма')
    expect(formatFilmCountLabel(5)).toBe('5 фильмов')
    expect(formatFilmCountLabel(11)).toBe('11 фильмов')
    expect(formatFilmCountLabel(21)).toBe('21 фильм')
  })

  test('computes CEFR target window and speech pace label', () => {
    expect(cefrWindowLabel('A1')).toBe('A1–A2')
    expect(cefrWindowLabel('B1')).toBe('B1–B2')
    expect(cefrWindowLabel('C2')).toBe('C2–C2')
    expect(cefrGoalLabel('A1')).toBe('A1 → A2')
    expect(cefrGoalLabel('A2')).toBe('A2 → B1')
    expect(cefrGoalLabel('B1')).toBe('B1 → B2')
    expect(cefrGoalLabel('C2')).toBe('C2')
    expect(paceLabel(112)).toBe('спокойный')
    expect(paceLabel(134)).toBe('средний')
    expect(paceLabel(162)).toBe('быстрый')
    expect(paceLabel(null)).toBeNull()
  })

  test('chunks 126 days into 18 week columns with month headers', () => {
    const start = Date.UTC(2026, 7, 3)
    const days: HeatmapDay[] = Array.from({ length: 126 }, (_, i) => {
      const d = new Date(start + i * 86_400_000)
      const iso = d.toISOString().slice(0, 10)
      return { day: iso, watchedSec: i % 5 === 0 ? 1200 : 0, films: 1, cards: 0, level: i % 5 === 0 ? 2 : 0, future: false }
    })
    const cols = buildHeatmapColumns(days)
    expect(cols).toHaveLength(18)
    expect(cols[0].monthLabel).toBe('Авг')
    expect(cols.some((c) => c.monthLabel === 'Сен')).toBe(true)
    expect(cols.some((c) => c.monthLabel === 'Ноя')).toBe(true)
  })

  test('filters unadded words & grammar patterns accurately', () => {
    const words = [
      makeWord({ lemma: 'decide', tier: 'core', aboveLevel: false, clicks: 3 }),
      makeWord({ lemma: 'ephemeral', tier: 'rare', aboveLevel: true, clicks: 1 }),
      makeWord({ lemma: 'bail on', tier: 'common', aboveLevel: false, filmsCount: 2 }),
    ]
    expect(filterUnaddedWords(words, 'useful').map((w) => w.lemma)).toEqual(['decide', 'bail on'])
    expect(filterUnaddedWords(words, 'repeat').map((w) => w.lemma)).toEqual(['decide', 'bail on'])
    expect(filterUnaddedWords(words, 'all')).toHaveLength(3)

    const cat = [
      { id: 'P1', level: 'B1', label: 'Present Perfect Continuous', formula: 'have/has been + V-ing' },
      { id: 'P2', level: 'B2', label: 'Get-пассив', formula: 'get + V3' },
    ]
    const statsMap = new Map([
      ['P1', { id: 'P1', count: 5, filmsCount: 2, status: 'learning' as const }],
      ['P2', { id: 'P2', count: 0, filmsCount: 0, status: null }],
    ])
    expect(filterGrammarPatterns(cat, statsMap, 'encountered', 'B1', '').map((x) => x.id)).toEqual(['P1'])
    expect(filterGrammarPatterns(cat, statsMap, 'all', null, 'пассив').map((x) => x.id)).toEqual(['P2'])
  })

  test('computes dynamic Y-axis ceilings and collision-free USD/friction ticks', () => {
    expect(niceAxisCeil(0)).toBe(0.01)
    expect(niceAxisCeil(0, 2)).toBe(2)
    expect(niceAxisCeil(Number.NaN, 0.01)).toBe(0.01)

    expect(niceAxisCeil(0.0003)).toBe(0.0004)
    expect(niceAxisCeil(0.0045)).toBe(0.006)
    expect(niceAxisCeil(0.018)).toBe(0.024)
    expect(niceAxisCeil(0.02)).toBe(0.024)
    expect(niceAxisCeil(0.022)).toBe(0.03)
    expect(niceAxisCeil(0.065)).toBe(0.08)
    expect(niceAxisCeil(0.09)).toBe(0.12)
    expect(niceAxisCeil(0.21)).toBe(0.3)
    expect(niceAxisCeil(1.35)).toBe(1.6)
    expect(niceAxisCeil(14)).toBe(20)

    // Invariant across 6 decades: tallest bar stays above 60% middle and below 86% top
    for (let exp = -4; exp <= 2; exp++) {
      for (const mult of [1, 1.1, 1.3, 1.5, 1.9, 2.3, 3.1, 4.7, 6.4, 8.8, 9.7]) {
        const v = mult * 10 ** exp
        const ratio = v / niceAxisCeil(v)
        expect(ratio).toBeGreaterThan(0.6)
        expect(ratio).toBeLessThanOrEqual(0.86)
      }
    }

    // Friction scales
    expect(niceAxisCeil(0.8, 2)).toBe(1)
    expect(niceAxisCeil(1.6, 2)).toBe(2)
    expect(niceAxisCeil(3.1, 2)).toBe(4)
    expect(niceAxisCeil(14, 2)).toBe(20)

    // USD axis tick precision
    expect(formatUsdAxisTick(0.03, 0.03)).toBe('$0.03')
    expect(formatUsdAxisTick(0.015, 0.03)).toBe('$0.015')
    expect(formatUsdAxisTick(0, 0.03)).toBe('$0.00')

    expect(formatUsdAxisTick(0.005, 0.005)).toBe('$0.005')
    expect(formatUsdAxisTick(0.0025, 0.005)).toBe('$0.0025')
    expect(formatUsdAxisTick(0, 0.005)).toBe('$0.00')

    expect(formatUsdAxisTick(0.0004, 0.0004)).toBe('$0.0004')
    expect(formatUsdAxisTick(0.0002, 0.0004)).toBe('$0.0002')
    expect(formatUsdAxisTick(0, 0.0004)).toBe('$0')

    expect(formatUsdAxisTick(1.6, 1.6)).toBe('$1.60')
    expect(formatUsdAxisTick(0.8, 1.6)).toBe('$0.80')

    expect(formatUsdAxisTick(16, 16)).toBe('$16')
    expect(formatUsdAxisTick(8, 16)).toBe('$8')
    expect(formatUsdAxisTick(0, 16)).toBe('$0')
  })

  test('picks non-colliding X-axis label indices while preserving edges and peak', () => {
    const idxs30 = pickAxisLabelIndices(30, 8, 7)
    expect(idxs30.has(0)).toBe(true)
    expect(idxs30.has(8)).toBe(true)
    expect(idxs30.has(29)).toBe(true)
    expect(idxs30.has(10)).toBe(false) // skipped because |10 - 8| < minGap (3)
    const sorted = [...idxs30].sort((a, b) => a - b)
    expect(sorted.length).toBeLessThanOrEqual(7)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(3)
    }

    const idxs7 = pickAxisLabelIndices(7, 2, 7)
    expect([...idxs7].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6])

    expect([...pickAxisLabelIndices(1, 0, 7)]).toEqual([0])
    expect([...pickAxisLabelIndices(0, -1, 7)]).toEqual([])
  })

  test('formats CEFR film share breakdown without hiding rare levels', () => {
    expect(formatSharePct(0)).toBe('0%')
    expect(formatSharePct(0.004)).toBe('<1%')
    expect(formatSharePct(0.02)).toBe('2%')
    expect(formatSharePct(0.78)).toBe('78%')

    const baseFilm = {
      mediaId: 'f1',
      title: 'Film',
      season: null,
      episode: null,
      posterUrl: null,
      watchedSec: 600,
      durationSec: 3600,
      cuesCount: 100,
      comprehensionPct: 80,
      wpm: 120,
      lookupsPer10m: null,
      replaysPer10m: null,
      cardsAdded: 0,
    }
    expect(
      filmCefrSummary({ ...baseFilm, cefrA: 0.66, cefrB: 0.12, cefrC: 0.02, cefrOther: 0.2 }),
    ).toBe('A1–B2 78% · C1–C2 2% · прочее 20%')
    expect(
      filmCefrSummary({ ...baseFilm, cefrA: 0.72, cefrB: 0.12, cefrC: 0.004, cefrOther: 0.156 }),
    ).toBe('A1–B2 84% · C1–C2 <1% · прочее 16%')
    expect(
      filmCefrSummary({ ...baseFilm, cefrA: 0.7, cefrB: 0.3, cefrC: 0, cefrOther: 0 }),
    ).toBe('A1–B2 100%')
    expect(
      filmCefrSummary({ ...baseFilm, cefrA: Number.NaN, cefrB: Number.NaN, cefrC: Number.NaN, cefrOther: Number.NaN }),
    ).toBe('A1–B2 0%')
  })

  test('guards non-finite numbers across duration, pace, counts, and AI share math', () => {
    expect(formatWatchDuration(Number.NaN)).toBe('0 м')
    expect(formatWatchDuration(Number.POSITIVE_INFINITY)).toBe('0 м')
    expect(formatWatchDelta(Number.NaN, 120)).toBeNull()
    expect(formatWatchDelta(120, Number.NaN)).toBeNull()
    expect(formatFilmCountLabel(Number.NaN)).toBe('0 фильмов')
    expect(paceLabel(Number.NaN)).toBeNull()
    expect(paceLabel(Number.POSITIVE_INFINITY)).toBeNull()
    expect(formatSharePct(Number.NaN)).toBe('0%')

    expect(computeSpendSharePct(0.00001, 0.00001)).toBe(100)
    expect(computeSpendSharePct(0.000005, 0.00001)).toBe(50)
    expect(computeSpendSharePct(0, 0)).toBe(0)
    expect(computeSpendSharePct(Number.NaN, 1)).toBe(0)

    expect(formatAiTaskRequestCount('annotate', 10)).toBe('10 разборов')
    expect(formatAiTaskRequestCount('annotate', 1)).toBe('1 разбор')
    expect(formatAiTaskRequestCount('explain', 2)).toBe('2 объяснения')
    expect(formatAiTaskRequestCount('chat', 1)).toBe('1 вопрос в чат')
    expect(formatAiTaskRequestCount('draft', 5)).toBe('5 черновиков')

    expect(PATTERN_STATS_KEY).toEqual(['patterns-stats'])
  })
})
