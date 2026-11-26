import { useState, type CSSProperties } from 'react'
import { Segmented, ShapeBadge, StatusChip, ListGroup } from '@tomato1337/m3e-react'
import type { ImmersionStats } from '@/common/types/ipc'
import { Cover } from '@/common/ui/Cover'
import { formatCountRu } from '@/common/utilities/pluralRu'
import {
  filmCefrSummary,
  formatEpisodeTitle,
  formatSharePct,
  formatWatchDelta,
  formatWatchDuration,
  paceLabel,
} from '../lib/format'
import { FrictionTrendChart, HeatmapChart, LegendDot, StackedBar, WeeklyBarsChart } from './StatsCharts'

const SUCCESS_CHIP: CSSProperties = {
  '--m3e-status-chip-container': 'var(--app-success-container)',
  '--m3e-status-chip-content': 'var(--app-on-success-container)',
} as CSSProperties

const WARNING_CHIP: CSSProperties = {
  '--m3e-status-chip-container': 'var(--app-warning-container)',
  '--m3e-status-chip-content': 'var(--app-on-warning-container)',
} as CSSProperties

const ANKI_TAG_STYLE: CSSProperties = {
  background: 'var(--app-anki-label-container)',
  color: 'var(--app-anki-on-label-container)',
}

const BADGE_SUCCESS: CSSProperties = {
  '--m3e-badge-container': 'var(--app-success-container)',
  '--m3e-badge-content': 'var(--app-on-success-container)',
} as CSSProperties

const BADGE_ANKI: CSSProperties = {
  '--m3e-badge-container': 'var(--app-anki-label-container)',
  '--m3e-badge-content': 'var(--app-anki-on-label-container)',
} as CSSProperties

function KpiCard({
  shape,
  icon,
  tone = 'primary',
  badgeStyle,
  label,
  value,
  sub,
  subSuccess = false,
}: {
  shape: 'sunny' | 'cookie9' | 'clover4' | 'cookie12'
  icon: string
  tone?: 'primary' | 'secondary' | 'neutral'
  badgeStyle?: CSSProperties
  label: string
  value: string
  sub: string
  subSuccess?: boolean
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[28px] bg-[var(--md-sys-color-surface-container)] p-5">
      <div className="flex items-center gap-3">
        <ShapeBadge shape={shape} size={42} tone={tone} icon={icon} iconFill iconSize={20} style={badgeStyle} />
        <span className="type-title-small text-[var(--md-sys-color-on-surface-variant)]">{label}</span>
      </div>
      <div className="type-headline-large type-emph tabular-nums text-[var(--md-sys-color-on-surface)]">{value}</div>
      <p
        className="type-body-small"
        style={{ color: subSuccess ? 'var(--app-success)' : 'var(--md-sys-color-on-surface-variant)' }}
      >
        {sub}
      </p>
    </div>
  )
}

export function ImmersionTab({
  data,
  learnerCefr,
}: {
  data: ImmersionStats
  learnerCefr: string
}) {
  const [activityMode, setActivityMode] = useState<'days' | 'weeks'>('days')

  const watchDelta = formatWatchDelta(data.watchedSec, data.prevWatchedSec)
  const watchSub =
    data.filmsCount > 0
      ? `${formatCountRu(data.filmsCount, 'фильм', 'фильма', 'фильмов')}${watchDelta ? ` · ${watchDelta}` : ''}`
      : 'Запусти фильм, чтобы начать учёт минут'

  const lookupsPer10Min = data.lookupsPer10Min !== null && Number.isFinite(data.lookupsPer10Min) ? data.lookupsPer10Min : null
  const prevLookupsPer10Min =
    data.prevLookupsPer10Min !== null && Number.isFinite(data.prevLookupsPer10Min) ? data.prevLookupsPer10Min : null
  const avgComprehensionPct =
    data.avgComprehensionPct !== null && Number.isFinite(data.avgComprehensionPct) ? data.avgComprehensionPct : null

  const frictionSub = (() => {
    if (lookupsPer10Min === null) return 'Нет данных за период'
    if (prevLookupsPer10Min !== null) {
      const diff = +(lookupsPer10Min - prevLookupsPer10Min).toFixed(1)
      if (diff < 0) return `↓ с ${prevLookupsPer10Min} к пред. периоду — реже паузишь`
      if (diff > 0) return `↑ с ${prevLookupsPer10Min} — более сложные фильмы`
      return `на уровне прошлого периода (${prevLookupsPer10Min})`
    }
    return 'Подсказок за каждые 10 мин речи'
  })()

  const firstClick =
    data.frictionTrend.find((p) => p.lookupsPer10m !== null && Number.isFinite(p.lookupsPer10m))?.lookupsPer10m ?? null
  const lastClick =
    [...data.frictionTrend]
      .reverse()
      .find((p) => p.lookupsPer10m !== null && Number.isFinite(p.lookupsPer10m))?.lookupsPer10m ?? null
  const trendDeltaPct =
    data.frictionTrend.length >= 2 && firstClick !== null && firstClick > 0 && lastClick !== null
      ? Math.round(((lastClick - firstClick) / firstClick) * 100)
      : null

  return (
    <div className="flex flex-col gap-6">
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          shape="sunny"
          icon="schedule"
          tone="primary"
          label="Время в английском"
          value={formatWatchDuration(data.watchedSec)}
          sub={watchSub}
          subSuccess={Boolean(
            data.prevWatchedSec !== null &&
              Number.isFinite(data.watchedSec) &&
              Number.isFinite(data.prevWatchedSec) &&
              data.watchedSec > data.prevWatchedSec,
          )}
        />
        <KpiCard
          shape="cookie9"
          icon="psychology"
          tone="neutral"
          badgeStyle={BADGE_SUCCESS}
          label="Среднее понимание"
          value={avgComprehensionPct !== null ? `${avgComprehensionPct}%` : '—'}
          sub={`По субтитрам · база ${learnerCefr} + Anki + «Знаю»`}
        />
        <KpiCard
          shape="clover4"
          icon="touch_app"
          tone="secondary"
          label="Кликов на 10 мин"
          value={lookupsPer10Min !== null ? String(lookupsPer10Min) : '—'}
          sub={frictionSub}
          subSuccess={Boolean(lookupsPer10Min !== null && prevLookupsPer10Min !== null && lookupsPer10Min < prevLookupsPer10Min)}
        />
        <KpiCard
          shape="cookie12"
          icon="style"
          tone="neutral"
          badgeStyle={BADGE_ANKI}
          label="Карточек добавлено"
          value={String(data.cardsAdded)}
          sub={
            data.cardsActiveOrLearned > 0
              ? `${data.cardsActiveOrLearned} уже выучены или в повторении`
              : 'Из фильмов и чата с агентом'
          }
        />
      </section>

      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4 rounded-[28px] bg-[var(--md-sys-color-surface-container)] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="type-title-large type-emph">Активность</h2>
              <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
                {formatWatchDuration(data.watchedSec)} · {data.activeDays} активн. дн.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {data.streakDays > 0 && (
                <StatusChip size="md" tone="neutral" icon="local_fire_department" style={WARNING_CHIP}>
                  Серия · {data.streakDays} дн.
                </StatusChip>
              )}
              <Segmented
                label="Режим активности"
                size="xs"
                value={activityMode}
                options={[
                  { value: 'days', label: 'Дни' },
                  { value: 'weeks', label: 'Недели' },
                ]}
                onChange={setActivityMode}
              />
            </div>
          </div>

          {activityMode === 'days' ? (
            <HeatmapChart days={data.heatmap} />
          ) : (
            <WeeklyBarsChart bars={data.weeklyBars} />
          )}

          <div className="type-body-small flex flex-wrap items-center justify-between gap-2 text-[var(--md-sys-color-on-surface-variant)]">
            <span>
              {data.peakWeekday
                ? `Пик: ${data.peakWeekday} · ср. ${data.avgSessionMin} мин за день`
                : 'Сеансы записываются во время воспроизведения фильма'}
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4 rounded-[28px] bg-[var(--md-sys-color-surface-container)] p-6">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="type-title-large type-emph">Снижение «трения»</h2>
              <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
                Остановок на 10 мин речи
              </p>
            </div>
            {trendDeltaPct !== null && (
              <StatusChip
                size="md"
                tone="neutral"
                style={trendDeltaPct <= 0 ? SUCCESS_CHIP : WARNING_CHIP}
              >
                {trendDeltaPct > 0 ? `+${trendDeltaPct}%` : `${trendDeltaPct}%`}
              </StatusChip>
            )}
          </div>

          <FrictionTrendChart points={data.frictionTrend} />

          <div className="mt-auto flex flex-wrap items-center gap-4">
            <LegendDot color="var(--md-sys-color-primary)" label="Клики за переводом" />
            <LegendDot color="var(--md-sys-color-tertiary)" label="Повторы / замедление" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <h2 className="type-title-large type-emph">Профиль фильмов</h2>
            <StatusChip size="sm" tone="neutral">{data.films.length}</StatusChip>
          </div>
          <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
            Понимание оценивается на основе базы {learnerCefr}, колод Anki и списка «Знаю»
          </span>
        </div>

        {data.films.length === 0 ? (
          <div className="rounded-[24px] bg-[var(--md-sys-color-surface-container)] p-6 text-center">
            <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
              Здесь появится лексический профиль каждого просмотренного фильма.
            </p>
          </div>
        ) : (
          <>
            <div className="hidden grid-cols-[minmax(220px,1.35fr)_84px_minmax(215px,1.3fr)_96px_124px_60px] gap-4 px-5 type-label-medium text-[var(--md-sys-color-on-surface-variant)] md:grid">
              <span>Фильм и время</span>
              <span>Понимание</span>
              <span>Лексика по CEFR</span>
              <span>Темп речи</span>
              <span>Трение / 10 мин</span>
              <span>Anki</span>
            </div>

            <ListGroup>
              {data.films.map((f) => {
                const wpm = f.wpm !== null && Number.isFinite(f.wpm) ? f.wpm : null
                const pace = paceLabel(wpm)
                const compPct = f.comprehensionPct !== null && Number.isFinite(f.comprehensionPct) ? f.comprehensionPct : null
                const lookups = f.lookupsPer10m !== null && Number.isFinite(f.lookupsPer10m) ? f.lookupsPer10m : null
                const replays = f.replaysPer10m !== null && Number.isFinite(f.replaysPer10m) ? f.replaysPer10m : null
                const compStyle =
                  compPct === null
                    ? undefined
                    : compPct >= 80
                      ? SUCCESS_CHIP
                      : compPct < 70
                        ? WARNING_CHIP
                        : undefined
                return (
                  <div
                    key={f.mediaId}
                    className="grid grid-cols-1 items-center gap-3 bg-[var(--md-sys-color-surface-container)] px-5 py-3 md:grid-cols-[minmax(220px,1.35fr)_84px_minmax(215px,1.3fr)_96px_124px_60px] md:gap-4"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <Cover
                        src={f.posterUrl}
                        title={f.title}
                        className="h-[57px] w-[38px] shrink-0 rounded-[8px]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="type-title-small type-emph truncate">
                          {formatEpisodeTitle(f.title, f.season, f.episode)}
                        </div>
                        <div className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                          {f.watchedSec > 0 ? formatWatchDuration(f.watchedSec) : '0 м'}
                          {f.cuesCount > 0
                            ? ` · ${formatCountRu(f.cuesCount, 'реплика', 'реплики', 'реплик')}`
                            : ' · без субтитров'}
                        </div>
                      </div>
                    </div>

                    <div>
                      {compPct !== null ? (
                        <StatusChip
                          size="sm"
                          tone={compPct >= 70 && compPct < 80 ? 'primary' : 'neutral'}
                          style={compStyle}
                        >
                          {compPct}%
                        </StatusChip>
                      ) : (
                        <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">—</span>
                      )}
                    </div>

                    <div className="flex flex-col gap-1">
                      {f.cuesCount > 0 ? (
                        <>
                          <StackedBar
                            height={10}
                            radius={5}
                            segments={[
                              { value: f.cefrA, color: 'var(--app-success)', title: `A1–A2 база: ${formatSharePct(f.cefrA)}` },
                              { value: f.cefrB, color: 'var(--md-sys-color-primary)', title: `B1–B2 цель: ${formatSharePct(f.cefrB)}` },
                              { value: f.cefrC, color: 'var(--md-sys-color-tertiary)', title: `C1–C2 редкие: ${formatSharePct(f.cefrC)}` },
                              { value: f.cefrOther, color: 'var(--md-sys-color-outline)', title: `Прочее (имена, сленг): ${formatSharePct(f.cefrOther)}` },
                            ]}
                          />
                          <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                            {filmCefrSummary(f)}
                          </span>
                        </>
                      ) : (
                        <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Нет субтитров</span>
                      )}
                    </div>

                    <div>
                      {wpm !== null ? (
                        <>
                          <div className="type-title-small type-emph tabular-nums">{wpm} сл/м</div>
                          {pace && <div className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">{pace}</div>}
                        </>
                      ) : (
                        <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">—</span>
                      )}
                    </div>

                    <div className="type-body-medium tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
                      {lookups !== null || replays !== null
                        ? `${lookups ?? 0} кл · ${replays ?? 0} повт.`
                        : '—'}
                    </div>

                    <div>
                      <span
                        className="type-label-medium inline-flex rounded-[6px] px-2 py-0.5 tabular-nums"
                        style={ANKI_TAG_STYLE}
                      >
                        +{f.cardsAdded}
                      </span>
                    </div>
                  </div>
                )
              })}
            </ListGroup>

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <span className="type-label-medium text-[var(--md-sys-color-on-surface-variant)]">Лексика фильма:</span>
              <LegendDot color="var(--app-success)" label="A1–A2 база" />
              <LegendDot color="var(--md-sys-color-primary)" label="B1–B2 цель" />
              <LegendDot color="var(--md-sys-color-tertiary)" label="C1–C2 редкие" />
              <LegendDot color="var(--md-sys-color-outline)" label="прочее (имена, сленг)" />
            </div>
          </>
        )}
      </section>
    </div>
  )
}
