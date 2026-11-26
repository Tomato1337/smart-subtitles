import type { CSSProperties } from 'react'
import { ListGroup, ShapeBadge } from '@tomato1337/m3e-react'
import type { AiStats } from '@/common/types/ipc'
import { Cover } from '@/common/ui/Cover'
import { formatTokens, formatUsd } from '@/common/utilities/tokens'
import { computeSpendSharePct, formatAiTaskRequestCount, formatEpisodeTitle } from '../lib/format'
import { DailySpendChart, LegendDot, StackedBar } from './StatsCharts'

const TASK_META: Record<string, { label: string; color: string }> = {
  annotate: { label: 'Разбор диалогов', color: 'var(--md-sys-color-primary)' },
  explain: { label: 'Объяснения слов', color: 'var(--app-kind-phrasal-verb)' },
  chat: { label: 'Чат с репетитором', color: 'var(--app-kind-reduction)' },
  draft: { label: 'Черновики карточек', color: 'var(--app-anki-label)' },
}

const BADGE_SUCCESS: CSSProperties = {
  '--m3e-badge-container': 'var(--app-success-container)',
  '--m3e-badge-content': 'var(--app-on-success-container)',
} as CSSProperties

const BADGE_ANKI: CSSProperties = {
  '--m3e-badge-container': 'var(--app-anki-label-container)',
  '--m3e-badge-content': 'var(--app-anki-on-label-container)',
} as CSSProperties

const BADGE_ON_PRIMARY: CSSProperties = {
  '--m3e-badge-container': 'var(--md-sys-color-surface)',
  '--m3e-badge-content': 'var(--md-sys-color-primary)',
} as CSSProperties

export function AiUsageTab({ data }: { data: AiStats }) {
  return (
    <div className="flex flex-col gap-6">
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-3 rounded-[28px] bg-[var(--md-sys-color-primary-container)] p-5 text-[var(--md-sys-color-on-primary-container)]">
          <div className="flex items-center gap-3">
            <ShapeBadge shape="sunny" size={42} tone="neutral" icon="payments" iconFill iconSize={20} style={BADGE_ON_PRIMARY} />
            <span className="type-title-small">Расход за период</span>
          </div>
          <div className="type-headline-large type-emph tabular-nums">
            {data.partial ? 'от ' : ''}
            {formatUsd(data.totalUsd)}
          </div>
          <p className="type-body-small opacity-90">
            {data.avgPerFilmUsd !== null ? `≈ ${formatUsd(data.avgPerFilmUsd)} в среднем за фильм` : 'Локальный журнал запросов'}
          </p>
        </div>

        <div className="flex flex-col gap-3 rounded-[28px] bg-[var(--md-sys-color-surface-container)] p-5">
          <div className="flex items-center gap-3">
            <ShapeBadge shape="cookie9" size={42} tone="secondary" icon="bolt" iconFill iconSize={20} />
            <span className="type-title-small text-[var(--md-sys-color-on-surface-variant)]">Запросов к ИИ</span>
          </div>
          <div className="type-headline-large type-emph tabular-nums">{data.requests}</div>
          <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
            {data.byTask.length > 0
              ? data.byTask.map((t) => formatAiTaskRequestCount(t.task, t.requests)).join(' · ')
              : 'Запросов ещё не было'}
          </p>
        </div>

        <div className="flex flex-col gap-3 rounded-[28px] bg-[var(--md-sys-color-surface-container)] p-5">
          <div className="flex items-center gap-3">
            <ShapeBadge shape="clover4" size={42} tone="neutral" icon="cached" iconFill iconSize={20} style={BADGE_SUCCESS} />
            <span className="type-title-small text-[var(--md-sys-color-on-surface-variant)]">Попаданий в кэш</span>
          </div>
          <div className="type-headline-large type-emph tabular-nums">{data.cacheHitPct}%</div>
          <p className="type-body-small" style={{ color: data.savedUsdEstimate ? 'var(--app-success)' : 'var(--md-sys-color-on-surface-variant)' }}>
            {data.savedUsdEstimate !== null
              ? `Сэкономило ≈ ${formatUsd(data.savedUsdEstimate)} на контексте`
              : `${formatTokens(data.cachedTokens)} кэшированных токенов`}
          </p>
        </div>

        <div className="flex flex-col gap-3 rounded-[28px] bg-[var(--md-sys-color-surface-container)] p-5">
          <div className="flex items-center gap-3">
            <ShapeBadge shape="cookie12" size={42} tone="neutral" icon="token" iconFill iconSize={20} style={BADGE_ANKI} />
            <span className="type-title-small text-[var(--md-sys-color-on-surface-variant)]">Токены вход / выход</span>
          </div>
          <div className="type-headline-large type-emph tabular-nums">
            {formatTokens(data.inputTokens + data.cachedTokens)} / {formatTokens(data.outputTokens)}
          </div>
          <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
            {formatTokens(data.cachedTokens)} входных токенов из кэша
          </p>
        </div>
      </section>

      {data.partial && (
        <p className="type-body-small text-[var(--app-warning)]">
          Для части запросов цена модели неизвестна — суммы показывают только известную долю.
        </p>
      )}

      <section className="flex min-w-0 flex-col gap-4 rounded-[28px] bg-[var(--md-sys-color-surface-container)] p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="type-title-large type-emph">
              {data.granularity === 'day' ? 'Расход по дням' : 'Расход по неделям'}
            </h2>
            <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
              Локальный журнал запросов к моделям
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <LegendDot color="var(--md-sys-color-primary)" label="Разбор" />
            <LegendDot color="var(--app-kind-phrasal-verb)" label="Объяснения" />
            <LegendDot color="var(--app-kind-reduction)" label="Чат" />
            <LegendDot color="var(--app-anki-label)" label="Карточки" />
          </div>
        </div>

        <DailySpendChart series={data.series} granularity={data.granularity} />
      </section>

      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-2.5">
            <h2 className="type-title-large type-emph">По задачам</h2>
            {data.byTask.length === 0 ? (
              <div className="rounded-[20px] bg-[var(--md-sys-color-surface-container)] p-5 text-center">
                <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Нет запросов за период</p>
              </div>
            ) : (
              <ListGroup>
                {data.byTask.map((row) => {
                  const meta = TASK_META[row.task] ?? { label: row.task, color: 'var(--md-sys-color-primary)' }
                  const totIn = row.inputTokens + row.cachedTokens
                  const cachePct = totIn > 0 ? Math.round((row.cachedTokens / totIn) * 100) : 0
                  const share = computeSpendSharePct(row.usd, data.totalUsd)
                  return (
                    <div
                      key={row.task}
                      className="flex items-center justify-between gap-4 bg-[var(--md-sys-color-surface-container)] px-5 py-3"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <div className="type-title-small type-emph">{meta.label}</div>
                        <div className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                          {row.requests} запр. · {cachePct}% кэш · {formatTokens(totIn)} / {formatTokens(row.outputTokens)}
                        </div>
                        <StackedBar
                          height={6}
                          radius={3}
                          segments={[
                            { value: row.usd, color: meta.color },
                            { value: Math.max(0, data.totalUsd - row.usd), color: 'var(--md-sys-color-surface-container-highest)' },
                          ]}
                        />
                      </div>
                      <div className="shrink-0 text-right tabular-nums">
                        <div className="type-title-medium type-emph">
                          {row.partial ? 'от ' : ''}
                          {formatUsd(row.usd)}
                        </div>
                        <div className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">{share}%</div>
                      </div>
                    </div>
                  )
                })}
              </ListGroup>
            )}
          </div>

          {data.byModel.length > 0 && (
            <div className="flex min-w-0 flex-col gap-2.5">
              <h2 className="type-title-large type-emph">По моделям</h2>
              <div
                tabIndex={0}
                aria-label="Расход по моделям"
                className="stats-scroll max-h-[124px] overflow-y-auto overscroll-contain rounded-[24px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--md-sys-color-primary)]"
              >
                <ListGroup>
                  {data.byModel.map((row) => {
                    const totIn = row.inputTokens + row.cachedTokens
                    const cachePct = totIn > 0 ? Math.round((row.cachedTokens / totIn) * 100) : 0
                    return (
                      <div
                        key={row.model}
                        className="flex items-center justify-between gap-3 bg-[var(--md-sys-color-surface-container)] px-5 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="type-title-small min-w-0 wrap-anywhere font-mono font-semibold">
                            {row.model || 'не указана'}
                          </div>
                          <div className="type-body-small wrap-anywhere text-[var(--md-sys-color-on-surface-variant)]">
                            {row.requests} запр. · {cachePct}% кэш · {formatTokens(totIn)} вход / {formatTokens(row.outputTokens)} выход
                          </div>
                        </div>
                        <span className="type-title-medium type-emph shrink-0 tabular-nums">
                          {row.partial ? 'от ' : ''}
                          {formatUsd(row.usd)}
                        </span>
                      </div>
                    )
                  })}
                </ListGroup>
              </div>
            </div>
          )}
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-2.5">
          <h2 className="type-title-large type-emph shrink-0">По фильмам</h2>
          {data.byFilm.length === 0 ? (
            <div className="rounded-[20px] bg-[var(--md-sys-color-surface-container)] p-5 text-center">
              <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Расходов по фильмам пока нет</p>
            </div>
          ) : (
            <div
              className="lg:relative lg:flex-1"
              style={{ minHeight: Math.min(280, data.byFilm.length * 73) }}
            >
              <div
                tabIndex={0}
                aria-label="Расход по фильмам"
                className="stats-scroll max-h-[420px] overflow-y-auto overscroll-contain rounded-[24px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--md-sys-color-primary)] lg:absolute lg:inset-0 lg:max-h-none"
              >
                <ListGroup>
                  {data.byFilm.map((f) => (
                    <div
                      key={f.mediaId}
                      className="flex items-center justify-between gap-3 bg-[var(--md-sys-color-surface-container)] px-4 py-2.5"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <Cover
                          src={f.posterUrl}
                          title={f.title}
                          className="h-[51px] w-[34px] shrink-0 rounded-[7px]"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="type-title-small type-emph min-w-0 wrap-anywhere">
                            {formatEpisodeTitle(f.title, f.season, f.episode)}
                          </div>
                          <div className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                            {f.requests} запр. · {f.cachedPct}% кэш
                          </div>
                        </div>
                      </div>
                      <span className="type-title-medium type-emph shrink-0 tabular-nums">
                        {f.partial ? 'от ' : ''}
                        {formatUsd(f.usd)}
                      </span>
                    </div>
                  ))}
                </ListGroup>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
