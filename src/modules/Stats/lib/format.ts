import type {
  FilmProfile,
  GrammarPatternItem,
  HeatmapDay,
  StatsPeriod,
  UnaddedWord,
} from '@/common/types/ipc'
import { formatCountRu } from '@/common/utilities/pluralRu'

export type StatsTab = 'immersion' | 'vocab' | 'grammar' | 'ai'
export type UnaddedFilter = 'useful' | 'all' | 'repeat'
export type GrammarStatusFilter = 'all' | 'learning' | 'encountered' | 'known'

/** Query key matching `Patterns` module's `statsKey` (`['patterns-stats']`). */
export const PATTERN_STATS_KEY = ['patterns-stats'] as const

const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const MONTHS_CAP = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек']

export function normalizePeriod(raw: unknown): StatsPeriod {
  if (raw === '7d' || raw === '30d' || raw === '90d' || raw === 'all') return raw
  return '30d'
}

export function normalizeTab(raw: unknown): StatsTab {
  if (raw === 'immersion' || raw === 'vocab' || raw === 'grammar' || raw === 'ai') return raw
  return 'immersion'
}

/** Formats watched seconds cleanly in Russian: `0 м`, `42 м`, `1 ч 43 м`, `14 ч 20 м`. */
export function formatWatchDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0 м'
  const mins = Math.max(0, Math.round(sec / 60))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m} м`
  return m === 0 ? `${h} ч` : `${h} ч ${m} м`
}

/** Signed change between current and previous watch-time windows; null when no prior data exists. */
export function formatWatchDelta(curSec: number, prevSec: number | null): string | null {
  if (prevSec === null || !Number.isFinite(curSec) || !Number.isFinite(prevSec)) return null
  const diffMin = Math.round((curSec - prevSec) / 60)
  if (diffMin === 0) return 'на уровне прошлого периода'
  const sign = diffMin > 0 ? '+' : '−'
  return `${sign}${formatWatchDuration(Math.abs(diffMin) * 60)} к пред. периоду`
}

export function formatShortDate(isoDay: string): string {
  const parts = isoDay.split('-').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) return isoDay
  const [, month, day] = parts
  const m = MONTHS_SHORT[month - 1] ?? ''
  return `${day} ${m}`
}

export function formatEpisodeTitle(title: string, season: number | null, episode: number | null): string {
  if (season != null && episode != null) return `${title} · S${season}E${episode}`
  return title
}

export function formatFilmCountLabel(count: number): string {
  return formatCountRu(count, 'фильм', 'фильма', 'фильмов')
}

export function paceLabel(wpm: number | null): string | null {
  if (wpm === null || !Number.isFinite(wpm)) return null
  if (wpm < 120) return 'спокойный'
  if (wpm <= 145) return 'средний'
  return 'быстрый'
}

export function cefrWindowBounds(cefr: string): [number, number] {
  const idx = CEFR_ORDER.indexOf(cefr.trim().toUpperCase() as (typeof CEFR_ORDER)[number])
  const lo = idx >= 0 ? idx : 2
  const hi = Math.min(5, lo + 1)
  return [lo, hi]
}

export function cefrWindowLabel(cefr: string): string {
  const [lo, hi] = cefrWindowBounds(cefr)
  return `${CEFR_ORDER[lo]}–${CEFR_ORDER[hi]}`
}

export function cefrGoalLabel(cefr: string): string {
  const [lo, hi] = cefrWindowBounds(cefr)
  return lo === hi ? CEFR_ORDER[lo] : `${CEFR_ORDER[lo]} → ${CEFR_ORDER[hi]}`
}

export function formatSharePct(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  if (share < 0.01) return '<1%'
  return `${Math.round(share * 100)}%`
}

export function filmCefrSummary(f: FilmProfile): string {
  const rawBase = (Number.isFinite(f.cefrA) ? f.cefrA : 0) + (Number.isFinite(f.cefrB) ? f.cefrB : 0)
  const basePct = Math.round(Math.max(0, rawBase) * 100)
  const parts = [`A1–B2 ${basePct}%`]
  if (Number.isFinite(f.cefrC) && f.cefrC > 0) parts.push(`C1–C2 ${formatSharePct(f.cefrC)}`)
  if (Number.isFinite(f.cefrOther) && f.cefrOther > 0) parts.push(`прочее ${formatSharePct(f.cefrOther)}`)
  return parts.join(' · ')
}

/** Computes rounded percentage share directly against `totalUsd` (so sub-cent totals still add up to 100%). */
export function computeSpendSharePct(usd: number, totalUsd: number): number {
  if (!Number.isFinite(usd) || !Number.isFinite(totalUsd) || totalUsd <= 0 || usd <= 0) return 0
  return Math.round((usd / totalUsd) * 100)
}

const AI_TASK_FORMS: Record<string, readonly [string, string, string]> = {
  annotate: ['разбор', 'разбора', 'разборов'],
  explain: ['объяснение', 'объяснения', 'объяснений'],
  chat: ['вопрос в чат', 'вопроса в чат', 'вопросов в чат'],
  draft: ['черновик', 'черновика', 'черновиков'],
  cost: ['оценка цены', 'оценки цены', 'оценок цены'],
}

/** Formats per-task AI request counts with exact Russian noun agreement (`10 разборов`). */
export function formatAiTaskRequestCount(task: string, requests: number): string {
  const forms = AI_TASK_FORMS[task]
  if (!forms) {
    const safe = Number.isFinite(requests) ? Math.trunc(requests) : 0
    return `${safe} ${task}`
  }
  return formatCountRu(requests, forms[0], forms[1], forms[2])
}

export type HeatmapWeekColumn = {
  weekIdx: number
  monthLabel: string | null
  days: HeatmapDay[]
}

/** Splits flat 126-day heatmap array into 18 Mon..Sun columns and marks first week of each month. */
export function buildHeatmapColumns(days: HeatmapDay[]): HeatmapWeekColumn[] {
  const cols: HeatmapWeekColumn[] = []
  let lastMonth: number | null = null
  for (let w = 0; w * 7 < days.length; w++) {
    const slice = days.slice(w * 7, w * 7 + 7)
    const anchor = slice.find((d) => Number(d.day.split('-')[2]) === 1) ?? (w === 0 ? slice[0] : undefined)
    let monthLabel: string | null = null
    if (anchor) {
      const m = Number(anchor.day.split('-')[1])
      if (m !== lastMonth && m >= 1 && m <= 12) {
        monthLabel = MONTHS_CAP[m - 1]
        lastMonth = m
      }
    }
    cols.push({ weekIdx: w, monthLabel, days: slice })
  }
  return cols
}

export function isUsefulWord(w: UnaddedWord): boolean {
  return !(w.tier === 'rare' && w.aboveLevel)
}

export function filterUnaddedWords(words: UnaddedWord[], filter: UnaddedFilter): UnaddedWord[] {
  switch (filter) {
    case 'useful':
      return words.filter(isUsefulWord)
    case 'repeat':
      return words.filter((w) => w.clicks >= 2 || w.filmsCount >= 2)
    default:
      return words
  }
}

export function filterGrammarPatterns<T extends { id: string; level: string; label: string; formula: string }>(
  catalog: readonly T[],
  statsMap: ReadonlyMap<string, GrammarPatternItem>,
  status: GrammarStatusFilter,
  level: string | null,
  query: string,
): (T & { count: number; filmsCount: number; status: 'learning' | 'known' | null })[] {
  const q = query.trim().toLowerCase()
  const out: (T & { count: number; filmsCount: number; status: 'learning' | 'known' | null })[] = []
  for (const p of catalog) {
    const st = statsMap.get(p.id)
    const count = st?.count ?? 0
    const filmsCount = st?.filmsCount ?? 0
    const curStatus = st?.status ?? null
    if (level && p.level !== level) continue
    if (status === 'learning' && curStatus !== 'learning') continue
    if (status === 'known' && curStatus !== 'known') continue
    if (status === 'encountered' && count === 0) continue
    if (q && !`${p.label} ${p.formula} ${p.level}`.toLowerCase().includes(q)) continue
    out.push({ ...p, count, filmsCount, status: curStatus })
  }
  return out
}

const NICE_MULTIPLIERS = [1, 1.2, 1.4, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10] as const

/** Computes a clean axis ceiling targeting ~75% max bar fill (strictly within 63%–85%). */
export function niceAxisCeil(rawMax: number, emptyCeil = 0.01): number {
  if (!Number.isFinite(rawMax) || rawMax <= 0) return emptyCeil
  const target = rawMax / 0.85
  const exp = Math.floor(Math.log10(target))
  const base = 10 ** exp
  const norm = target / base
  const m = NICE_MULTIPLIERS.find((s) => s >= norm - 1e-9) ?? 10
  return Number((m * base).toPrecision(10))
}

function neededDecimals(x: number): number {
  for (let d = 0; d <= 6; d++) {
    if (Math.abs(Number(x.toFixed(d)) - x) < 1e-10) return d
  }
  return 6
}

/** Formats USD Y-axis ticks without rounding collisions across sub-cent and multi-dollar scales. */
export function formatUsdAxisTick(value: number, ceilMax: number): string {
  if (value <= 0) return ceilMax >= 10 || ceilMax < 0.005 ? '$0' : '$0.00'
  if (ceilMax >= 10 && neededDecimals(value) === 0) return `$${Math.round(value)}`
  const d = Math.max(2, neededDecimals(value))
  return `$${value.toFixed(d)}`
}

/** Selects up to `maxLabels` non-colliding X-axis indices, preserving first, last, and peak. */
export function pickAxisLabelIndices(len: number, peakIdx: number, maxLabels = 7): Set<number> {
  const shown = new Set<number>()
  if (len <= 0) return shown
  shown.add(0)
  if (len > 1) shown.add(len - 1)
  if (len <= 2) return shown

  const stride = Math.max(1, Math.ceil((len - 1) / Math.max(1, maxLabels - 1)))
  const minGap = Math.max(1, Math.floor(stride * 0.6))
  const hasPeak = peakIdx > 0 && peakIdx < len - 1 && peakIdx >= minGap && len - 1 - peakIdx >= minGap
  if (hasPeak) shown.add(peakIdx)

  for (let i = stride; i < len - 1; i += stride) {
    if (len - 1 - i < minGap) continue
    if (hasPeak && Math.abs(i - peakIdx) < minGap) continue
    shown.add(i)
  }
  return shown
}
