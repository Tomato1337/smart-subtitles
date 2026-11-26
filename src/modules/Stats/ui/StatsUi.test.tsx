import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { AiStats, GrammarStats, ImmersionStats, KnownWord, VocabularyStats } from '@/common/types/ipc'
import { AiUsageTab } from './AiUsageTab'
import { GrammarTab } from './GrammarTab'
import { ImmersionTab } from './ImmersionTab'
import { DailySpendChart, FrictionTrendChart } from './StatsCharts'
import { StatsHub } from './StatsHub'
import { KnownWordsDialog, KnownWordsList, VocabularyTab } from './VocabularyTab'

vi.mock('@/modules/Notifications', () => ({
  NotificationHeaderButton: () => null,
}))
vi.mock('@/modules/Cards', () => ({
  useCardsStore: { getState: () => ({ upsert: vi.fn(), openEditor: vi.fn() }) },
}))
vi.mock('@/modules/Vocab', async () => {
  const { useQuery, useMutation } = await import('@tanstack/react-query')
  return {
    VocabBadges: () => null,
    useKnownWords: () => useQuery({ queryKey: ['known-words'], queryFn: async () => [] as KnownWord[] }),
    useSetKnownWord: () => useMutation({ mutationFn: async () => ({ lemma: 'a', display: 'a', known: true, createdAt: 1 }) }),
  }
})

const longStr = 'X'.repeat(220)

describe('Stats UI regression tests', () => {
  test('KnownWordsList virtualizes 10,000 words via Virtuoso into bounded DOM nodes', () => {
    const tenThousand: KnownWord[] = Array.from({ length: 10_000 }, (_, i) => ({
      lemma: `word-${i}`,
      display: `Word ${i}`,
      source: 'manual',
      createdAt: 1000 + i,
    }))
    const html = renderToStaticMarkup(
      <KnownWordsList items={tenThousand} emptyText="empty" onRemove={() => {}} />,
    )
    const renderedRows = (html.match(/data-index="/g) ?? []).length
    expect(renderedRows).toBeGreaterThan(0)
    expect(renderedRows).toBeLessThan(30)
    expect(html.length).toBeLessThan(25_000)
  })

  test('KnownWordsDialog aligns add row items-end, autofocuses input, and suppresses close tooltip', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['known-words'], [{ lemma: 'reluctant', display: 'reluctant', source: 'manual', createdAt: 1 }])
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <KnownWordsDialog onClose={() => {}} />
      </QueryClientProvider>,
    )
    expect(html).toContain('items-end')
    expect(html).toMatch(/data-autofocus(?:="(?:true|)")?/)
    // Close button has noTip so data-tip="Закрыть" is omitted.
    expect(html).not.toContain('data-tip="Закрыть"')
  })

  test('ImmersionTab uses minmax(0) grid tracks, Cover fallback, finite guards, and Russian pluralization', () => {
    const data: ImmersionStats = {
      watchedSec: 3600,
      prevWatchedSec: 1800,
      activeDays: 2,
      filmsCount: 1,
      streakDays: 1,
      avgSessionMin: 30,
      peakWeekday: 'Пн',
      avgComprehensionPct: Number.NaN,
      lookupsPer10Min: Number.NaN,
      prevLookupsPer10Min: null,
      cardsAdded: 2,
      cardsActiveOrLearned: 1,
      heatmap: [{ day: '2026-11-26', watchedSec: 3600, films: 2, cards: 1, level: 3, future: false }],
      weeklyBars: [],
      frictionTrend: [],
      films: [
        {
          mediaId: 'f1',
          title: longStr,
          season: null,
          episode: null,
          posterUrl: 'http://127.0.0.1:47800/poster/404',
          watchedSec: 1800,
          durationSec: 3600,
          cuesCount: 21,
          comprehensionPct: Number.NaN,
          cefrA: Number.NaN,
          cefrB: 0.2,
          cefrC: 0,
          cefrOther: 0,
          wpm: Number.NaN,
          lookupsPer10m: Number.NaN,
          replaysPer10m: Number.NaN,
          cardsAdded: 1,
        },
      ],
    }
    const html = renderToStaticMarkup(<ImmersionTab data={data} learnerCefr="B1" />)
    expect(html).toContain('lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]')
    expect(html).toContain('1 фильм')
    expect(html).toContain('2 фильма')
    expect(html).toContain('21 реплика')
    expect(html).toContain('Трение / 10 мин')
    expect(html).toContain('alt="Постер «')
    expect(html).not.toContain('NaN%')
    expect(html).not.toContain('NaN сл/м')
    expect(html).not.toContain('NaN кл')

    const emptyChartHtml = renderToStaticMarkup(<FrictionTrendChart points={[]} />)
    expect(emptyChartHtml).toContain('flex-1 min-h-[196px]')
  })

  test('AiUsageTab computes exact sub-cent share, hides empty models, uses Cover and Russian nouns', () => {
    const data: AiStats = {
      totalUsd: 0.00001,
      partial: false,
      avgPerFilmUsd: null,
      requests: 10,
      inputTokens: 1000,
      cachedTokens: 200,
      outputTokens: 300,
      cacheHitPct: 17,
      savedUsdEstimate: null,
      granularity: 'day',
      series: [
        { key: '2026-11-26', label: 'Сегодня', annotate: 0, explain: 0, chat: 0, draft: 0, totalUsd: 0, requests: 0, topFilm: longStr },
      ],
      byTask: [{ task: 'annotate', requests: 10, inputTokens: 1000, cachedTokens: 200, outputTokens: 300, usd: 0.00001, partial: false }],
      byModel: [],
      byFilm: [
        { mediaId: 'm1', title: longStr, season: null, episode: null, posterUrl: null, requests: 10, cachedPct: 20, usd: 0.00001, partial: false },
      ],
    }
    const html = renderToStaticMarkup(<AiUsageTab data={data} />)
    expect(html).toContain('100%')
    expect(html).not.toContain('>10%<')
    expect(html).toContain('10 разборов')
    expect(html).not.toContain('10 разбор<')
    expect(html).not.toContain('llm_usage')
    expect(html).not.toContain('По моделям')
    expect(html).toContain('lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]')
    expect(html).toContain('wrap-anywhere')
    expect(html).toContain('aria-hidden="true"') // Cover placeholder
    // 1-day centered label & non-highlighted $0 active date.
    expect(html).toContain('left:50%')
    expect(html).not.toContain('font-semibold text-[var(--md-sys-color-primary)]">Сегодня')
    expect(html).not.toContain('focus-visible:outline-none')
  })

  test('DailySpendChart preserves focus outlines and centers single-day X label', () => {
    const html = renderToStaticMarkup(
      <DailySpendChart
        granularity="day"
        series={[{ key: 'd1', label: '26 ноя', annotate: 0.00001, explain: 0, chat: 0, draft: 0, totalUsd: 0.00001, requests: 1, topFilm: longStr }]}
      />,
    )
    expect(html).toContain('left:50%')
    expect(html).toContain('translateX(-50%)')
    expect(html).toContain('wrap-anywhere')
    expect(html).toContain('focus-visible:outline-2')
    expect(html).not.toContain('focus-visible:outline-none')
  })

  test('GrammarTab uses pill search, surface tint without opacity-65, line-clamp-2, and clean zero copy', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const data: GrammarStats = {
      total: 48,
      encountered: 1,
      known: 0,
      learning: 0,
      byLevel: [{ level: 'B1', encountered: 1, total: 10 }],
      items: [
        { id: 'P_PRESENT', count: 3, filmsCount: 2, status: null },
      ],
    }
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <GrammarTab data={data} />
      </QueryClientProvider>,
    )
    expect(html).toContain('data-variant="pill"')
    expect(html).toContain('line-clamp-2')
    expect(html).toContain('пока не встречалась')
    expect(html).not.toContain('×0 пока')
    expect(html).not.toContain('opacity-65')
    expect(html).not.toContain('фильм(ах)')

    // Verify source fixes for query invalidation key & openExample without navigate({ to: '/' }).
    const raw = (await import('./GrammarTab.tsx?raw')).default
    expect(raw).toContain('PATTERN_STATS_KEY')
    expect(raw).not.toContain("'pattern-stats'")
    expect(raw).not.toContain("navigate({ to: '/' })")
  })

  test('VocabularyTab adds outline ring to LegendDot and pluralizes clicks, StatsHub aligns header to 1160px', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const data: VocabularyStats = {
      ngslSpoken: { total: 100, learned: 10, learning: 10, known: 5 },
      ngsl: { total: 100, learned: 10, learning: 10, known: 5 },
      knownCount: 21,
      ankiConnected: true,
      ankiDeck: 'English',
      ankiMaturity: { total: 1, learned: 1, young: 0, learning: 0, newCount: 0, weak: 0, leech: 0 },
      ankiCefr: [1, 0, 0, 0, 0, 0],
      inWindowPct: 100,
      unadded: [
        {
          lemma: 'grasp',
          span: 'grasp',
          translation: 'понять',
          mediaId: 'm1',
          title: 'Film',
          season: null,
          episode: null,
          cueIdx: 1,
          audioIndex: 0,
          subOffset: 0,
          quote: 'Grasp it',
          clicks: 21,
          filmsCount: 1,
          filmTitles: ['Film'],
          tier: 'core',
          cefr: 'B1',
          aboveLevel: false,
          spoken: true,
          business: false,
          lastSeenAt: 100,
        },
      ],
    }
    const vocabHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <VocabularyTab data={data} learnerCefr="B1" onRefreshAnki={() => {}} />
      </QueryClientProvider>,
    )
    expect(vocabHtml).toContain('ring-1 ring-[var(--md-sys-color-outline)]')
    expect(vocabHtml).toContain('21 слово')
    expect(vocabHtml).toContain('1 карточка')
    expect(vocabHtml).toContain('21 клик')
    expect(vocabHtml).not.toContain('клик(ов)')

    const hubHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <StatsHub
          tab="immersion"
          period="30d"
          onChangeTab={() => {}}
          onChangePeriod={() => {}}
          onBack={() => {}}
          onGoHome={() => {}}
        />
      </QueryClientProvider>,
    )
    expect(hubHtml).toContain('mx-auto flex max-w-[1160px]')
    expect(hubHtml).not.toContain('mx-auto flex max-w-[1440px]')
  })
})
