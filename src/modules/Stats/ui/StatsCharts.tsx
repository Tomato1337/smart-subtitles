import { useMemo, useState } from 'react'
import type { FrictionPoint, HeatmapDay, SpendBucket, WeeklyBar } from '@/common/types/ipc'
import { formatUsd } from '@/common/utilities/tokens'
import {
  buildHeatmapColumns,
  cefrWindowBounds,
  formatShortDate,
  formatUsdAxisTick,
  formatWatchDuration,
  niceAxisCeil,
  pickAxisLabelIndices,
} from '../lib/format'

const CEFR_LABELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
const WEEKDAY_ROW_LABELS: Record<number, string> = { 0: 'Пн', 2: 'Ср', 4: 'Пт', 6: 'Вс' }

const HEATMAP_FILLS = [
  'var(--md-sys-color-surface-container-highest)',
  'color-mix(in srgb, var(--md-sys-color-primary) 28%, var(--md-sys-color-surface-container-highest))',
  'color-mix(in srgb, var(--md-sys-color-primary) 50%, var(--md-sys-color-surface-container-highest))',
  'color-mix(in srgb, var(--md-sys-color-primary) 75%, var(--md-sys-color-surface-container-highest))',
  'var(--md-sys-color-primary)',
] as const

export function StackedBar({
  segments,
  height = 14,
  radius = 7,
}: {
  segments: { value: number; color: string; title?: string }[]
  height?: number
  radius?: number
}) {
  const total = segments.reduce((acc, s) => acc + Math.max(0, s.value), 0)
  return (
    <div
      className="flex w-full overflow-hidden bg-[var(--md-sys-color-surface-container-highest)]"
      style={{ height, borderRadius: radius, gap: 2 }}
    >
      {total <= 0 ? null : segments.map((s, idx) => {
        if (s.value <= 0) return null
        const pct = (s.value / total) * 100
        return (
          <div
            key={idx}
            title={s.title}
            className="h-full min-w-[3px] rounded-[2px]"
            style={{ width: `${pct}%`, background: s.color }}
          />
        )
      })}
    </div>
  )
}

export function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 type-body-small text-[var(--md-sys-color-on-surface-variant)]">
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

export function HeatmapChart({ days }: { days: HeatmapDay[] }) {
  const cols = useMemo(() => buildHeatmapColumns(days), [days])
  const defaultActive = useMemo(() => {
    const active = [...days].reverse().find((d) => !d.future && d.watchedSec > 0)
    return active ?? [...days].reverse().find((d) => !d.future) ?? null
  }, [days])
  const [hovered, setHovered] = useState<HeatmapDay | null>(null)
  const shown = hovered ?? defaultActive

  return (
    <div className="flex flex-col gap-3">
      <div className="min-h-[28px] flex flex-wrap items-center justify-between gap-2 rounded-[12px] bg-[var(--md-sys-color-surface-container-high)]/70 px-3 py-1.5">
        {shown ? (
          <span className="type-label-medium flex items-center gap-2 text-[var(--md-sys-color-on-surface)]">
            <span className="size-2 rounded-full bg-[var(--md-sys-color-primary)]" />
            <span>
              <strong>{formatShortDate(shown.day)}</strong> ·{' '}
              {shown.watchedSec > 0 ? formatWatchDuration(shown.watchedSec) : 'без просмотра'}
              {shown.films > 0 ? ` · ${shown.films} фильм(а)` : ''}
              {shown.cards > 0 ? ` · +${shown.cards} карт.` : ''}
            </span>
          </span>
        ) : (
          <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Наведите на день для деталей</span>
        )}
        <div className="flex items-center gap-1.5">
          <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">Меньше</span>
          {HEATMAP_FILLS.map((fill, i) => (
            <span key={i} className="size-3 rounded-[3px]" style={{ background: fill }} />
          ))}
          <span className="type-label-small text-[var(--md-sys-color-on-surface-variant)]">Больше</span>
        </div>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="inline-flex min-w-full flex-col gap-1.5">
          <div className="flex pl-7" style={{ gap: 6 }}>
            {cols.map((col) => (
              <div
                key={col.weekIdx}
                className="type-label-small w-[22px] shrink-0 text-[var(--md-sys-color-on-surface-variant)]"
              >
                {col.monthLabel ?? ''}
              </div>
            ))}
          </div>

          <div className="flex items-start" style={{ gap: 8 }}>
            <div className="flex w-5 shrink-0 flex-col" style={{ gap: 5 }}>
              {Array.from({ length: 7 }, (_, rowIdx) => (
                <div
                  key={rowIdx}
                  className="type-label-small flex h-[22px] items-center text-[var(--md-sys-color-on-surface-variant)]"
                >
                  {WEEKDAY_ROW_LABELS[rowIdx] ?? ''}
                </div>
              ))}
            </div>

            <div className="flex" style={{ gap: 6 }}>
              {cols.map((col) => (
                <div key={col.weekIdx} className="flex flex-col" style={{ gap: 5 }}>
                  {col.days.map((d) => {
                    const selected = shown?.day === d.day
                    return (
                      <button
                        key={d.day}
                        type="button"
                        disabled={d.future}
                        aria-label={`${formatShortDate(d.day)}: ${formatWatchDuration(d.watchedSec)}`}
                        onMouseEnter={() => !d.future && setHovered(d)}
                        onFocus={() => !d.future && setHovered(d)}
                        onMouseLeave={() => setHovered(null)}
                        className={`size-[22px] rounded-[6px] transition-transform focus-visible:outline-none ${
                          d.future ? 'opacity-25' : 'hover:scale-110'
                        } ${selected ? 'ring-2 ring-[var(--md-sys-color-on-surface)] ring-offset-1 ring-offset-[var(--md-sys-color-surface-container)]' : ''}`}
                        style={{ background: HEATMAP_FILLS[d.level] ?? HEATMAP_FILLS[0] }}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function WeeklyBarsChart({ bars }: { bars: WeeklyBar[] }) {
  const maxSec = Math.max(60, ...bars.map((b) => b.watchedSec))
  return (
    <div className="flex h-[220px] items-end gap-2 pt-4">
      {bars.map((b) => {
        const pct = Math.max(b.watchedSec > 0 ? 8 : 3, Math.round((b.watchedSec / maxSec) * 100))
        return (
          <div
            key={b.weekStart}
            className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
            title={`${b.label}: ${formatWatchDuration(b.watchedSec)}${b.cards > 0 ? ` · +${b.cards} карт.` : ''}`}
          >
            <span className="type-label-small truncate text-[var(--md-sys-color-on-surface-variant)]">
              {b.watchedSec > 0 ? formatWatchDuration(b.watchedSec) : ''}
            </span>
            <div className="flex h-[142px] w-full items-end justify-center">
              <div
                className="w-full max-w-[28px] rounded-t-[8px] rounded-b-[4px] transition-all"
                style={{
                  height: `${pct}%`,
                  background:
                    b.watchedSec > 0
                      ? 'var(--md-sys-color-primary)'
                      : 'var(--md-sys-color-surface-container-highest)',
                }}
              />
            </div>
            <span className="type-label-small truncate text-[var(--md-sys-color-on-surface-variant)]">
              {b.label.split(' ')[0]}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function FrictionTrendChart({ points }: { points: FrictionPoint[] }) {
  const valid = points.filter((p) => p.lookupsPer10m !== null || p.replaysPer10m !== null)
  const [activeIdx, setActiveIdx] = useState<number | null>(null)

  if (valid.length === 0) {
    return (
      <div className="flex h-[196px] items-center justify-center rounded-[16px] bg-[var(--md-sys-color-surface-container-low)] px-4 text-center">
        <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
          График появится после просмотра фильма с кликами по словам или повторами реплик.
        </p>
      </div>
    )
  }

  const rawMax = Math.max(
    0,
    ...valid.flatMap((p) => [p.lookupsPer10m ?? 0, p.replaysPer10m ?? 0]),
  )
  const ceilMax = niceAxisCeil(rawMax, 2)
  const midTick = Number((ceilMax / 2).toPrecision(10))

  const w = 408
  const h = 196
  const plotL = ceilMax >= 100 ? 34 : ceilMax < 2 || !Number.isInteger(midTick) ? 32 : 28
  const plotR = 388
  const plotT = 18
  const plotB = 160

  const xFor = (i: number) =>
    valid.length === 1 ? (plotL + plotR) / 2 : plotL + 16 + ((plotR - plotL - 32) * i) / (valid.length - 1)
  const yFor = (v: number) => plotB - (v / ceilMax) * (plotB - plotT)

  const clickPts = valid
    .map((p, i) => (p.lookupsPer10m !== null ? { x: xFor(i), y: yFor(p.lookupsPer10m), v: p.lookupsPer10m, p } : null))
    .filter((x): x is NonNullable<typeof x> => x !== null)
  const replayPts = valid
    .map((p, i) => (p.replaysPer10m !== null ? { x: xFor(i), y: yFor(p.replaysPer10m), v: p.replaysPer10m, p } : null))
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const clickPath = clickPts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ')
  const areaPath =
    clickPts.length > 1
      ? `M${clickPts[0].x.toFixed(1)} ${plotB} ${clickPts.map((pt) => `L${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ')} L${clickPts[clickPts.length - 1].x.toFixed(1)} ${plotB} Z`
      : ''
  const replayPath = replayPts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ')

  const focused = activeIdx !== null ? valid[activeIdx] : valid[valid.length - 1]

  return (
    <div className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[196px] w-full overflow-visible" role="img" aria-label="Динамика кликов и повторов по фильмам">
        {[0, midTick, ceilMax].map((tick) => {
          const yy = yFor(tick)
          return (
            <g key={tick}>
              <text
                x={plotL - 6}
                y={yy + 4}
                textAnchor="end"
                fontSize="11"
                fill="var(--md-sys-color-on-surface-variant)"
              >
                {tick}
              </text>
              <line
                x1={plotL}
                x2={plotR}
                y1={yy}
                y2={yy}
                stroke="var(--md-sys-color-outline-variant)"
                strokeDasharray="4 4"
                strokeWidth="1"
              />
            </g>
          )
        })}

        {areaPath && <path d={areaPath} fill="var(--md-sys-color-primary)" fillOpacity={0.14} />}
        {clickPts.length > 1 && (
          <path d={clickPath} fill="none" stroke="var(--md-sys-color-primary)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {replayPts.length > 1 && (
          <path
            d={replayPath}
            fill="none"
            stroke="var(--md-sys-color-tertiary)"
            strokeWidth="2"
            strokeDasharray="6 4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {replayPts.map((pt, i) => (
          <circle
            key={`r-${i}`}
            cx={pt.x}
            cy={pt.y}
            r={3.5}
            fill="var(--md-sys-color-surface-container)"
            stroke="var(--md-sys-color-tertiary)"
            strokeWidth="2"
          />
        ))}
        {clickPts.map((pt, i) => {
          const isLast = i === clickPts.length - 1
          return (
            <circle
              key={`c-${i}`}
              cx={pt.x}
              cy={pt.y}
              r={isLast || activeIdx === i ? 5 : 4}
              fill="var(--md-sys-color-primary)"
              stroke="var(--md-sys-color-surface-container)"
              strokeWidth="2"
              className="cursor-pointer"
              onMouseEnter={() => setActiveIdx(i)}
              onMouseLeave={() => setActiveIdx(null)}
            />
          )
        })}

        {valid.map((p, i) => (
          <text
            key={p.mediaId}
            x={xFor(i)}
            y={plotB + 18}
            textAnchor="middle"
            fontSize="11"
            fill="var(--md-sys-color-on-surface-variant)"
          >
            {p.label}
          </text>
        ))}
      </svg>

      {focused && (
        <div className="type-body-small flex flex-wrap items-center justify-between gap-2 text-[var(--md-sys-color-on-surface-variant)]">
          <span className="truncate font-medium text-[var(--md-sys-color-on-surface)]">{focused.title}</span>
          <span>
            {focused.lookupsPer10m ?? 0} кл · {focused.replaysPer10m ?? 0} повт. / 10 м
          </span>
        </div>
      )}
    </div>
  )
}

export function CefrBarsChart({
  counts,
  learnerCefr,
}: {
  counts: readonly number[]
  learnerCefr: string
}) {
  const [winLo, winHi] = cefrWindowBounds(learnerCefr)
  const maxV = Math.max(1, ...counts)
  return (
    <div className="grid h-[112px] grid-cols-6 items-end gap-2.5 pt-2">
      {CEFR_LABELS.map((lvl, i) => {
        const cnt = counts[i] ?? 0
        const inWin = i >= winLo && i <= winHi
        const above = i > winHi
        const hPct = Math.max(cnt > 0 ? 14 : 6, Math.round((cnt / maxV) * 100))
        const color = inWin
          ? 'var(--md-sys-color-primary)'
          : above
            ? 'var(--md-sys-color-tertiary)'
            : 'var(--md-sys-color-secondary-container)'
        return (
          <div key={lvl} className="flex h-full flex-col items-center justify-end gap-1">
            <span
              className={`type-label-small tabular-nums ${
                inWin ? 'font-semibold text-[var(--md-sys-color-primary)]' : 'text-[var(--md-sys-color-on-surface-variant)]'
              }`}
            >
              {cnt}
            </span>
            <div className="flex h-[58px] w-full items-end justify-center">
              <div
                className="w-full max-w-[44px] rounded-t-[8px] rounded-b-[4px]"
                style={{ height: `${hPct}%`, background: color }}
              />
            </div>
            <span
              className={`type-label-medium ${
                inWin ? 'font-semibold text-[var(--md-sys-color-on-surface)]' : 'text-[var(--md-sys-color-on-surface-variant)]'
              }`}
            >
              {lvl}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function DailySpendChart({
  series,
  granularity,
}: {
  series: SpendBucket[]
  granularity: 'day' | 'week'
}) {
  const peakIdx = useMemo(() => {
    let best = -1
    let bestUsd = 0
    series.forEach((b, i) => {
      if (b.totalUsd > bestUsd) {
        bestUsd = b.totalUsd
        best = i
      }
    })
    return best
  }, [series])
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const activeIdx = hoveredIdx ?? (peakIdx >= 0 ? peakIdx : series.length - 1)
  const active = series[activeIdx]

  if (series.length === 0) {
    return (
      <div className="flex h-[180px] items-center justify-center rounded-[18px] bg-[var(--md-sys-color-surface-container-low)]">
        <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">Нет записей о расходах за этот период</p>
      </div>
    )
  }

  const rawMax = Math.max(0, ...series.map((b) => b.totalUsd))
  const ceilMax = niceAxisCeil(rawMax, 0.01)
  const midTick = Number((ceilMax / 2).toPrecision(10))
  const shownLabels = pickAxisLabelIndices(series.length, peakIdx, 7)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-[30px] flex-wrap items-center justify-between gap-2">
        {active && active.totalUsd > 0 ? (
          <span className="type-label-medium inline-flex items-center gap-2 rounded-[10px] bg-[var(--md-sys-color-inverse-surface)] px-3 py-1 text-[var(--md-sys-color-inverse-on-surface)]">
            <span className="size-2 rounded-full bg-[var(--md-sys-color-inverse-primary)]" />
            <span>
              {active.label} · <strong>{formatUsd(active.totalUsd)}</strong> · {active.requests} запр.
              {active.topFilm ? ` (${active.topFilm})` : ''}
            </span>
          </span>
        ) : (
          <span className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
            {granularity === 'day' ? 'По дням' : 'По неделям'} · наведите на столбец
          </span>
        )}
      </div>

      <div className="relative flex gap-3 pt-2">
        <div className="type-label-small flex h-[156px] min-w-12 shrink-0 flex-col justify-between whitespace-nowrap text-right text-[var(--md-sys-color-on-surface-variant)] tabular-nums">
          <span>{formatUsdAxisTick(ceilMax, ceilMax)}</span>
          <span>{formatUsdAxisTick(midTick, ceilMax)}</span>
          <span>{formatUsdAxisTick(0, ceilMax)}</span>
        </div>

        <div className="relative min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[156px]">
            <div className="absolute inset-x-0 top-0 border-t border-dashed border-[var(--md-sys-color-outline-variant)]" />
            <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-[var(--md-sys-color-outline-variant)]" />
            <div className="absolute inset-x-0 bottom-0 border-t border-dashed border-[var(--md-sys-color-outline-variant)]" />
          </div>

          <div className="relative flex h-[156px] items-end gap-1.5">
            {series.map((b, i) => {
              const totalH = b.totalUsd > 0 ? Math.max(5, Math.round((b.totalUsd / ceilMax) * 156)) : 3
              const isSelected = activeIdx === i && b.totalUsd > 0
              const segs = [
                { val: b.annotate, color: 'var(--md-sys-color-primary)' },
                { val: b.explain, color: 'var(--app-kind-phrasal-verb)' },
                { val: b.chat, color: 'var(--app-kind-reduction)' },
                { val: b.draft, color: 'var(--app-anki-label)' },
              ].filter((s) => s.val > 0)
              const segTotal = segs.reduce((acc, s) => acc + s.val, 0) || 1

              return (
                <button
                  key={b.key}
                  type="button"
                  aria-label={`${b.label}: ${formatUsd(b.totalUsd)}`}
                  onMouseEnter={() => setHoveredIdx(i)}
                  onFocus={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                  className="group flex h-full min-w-0 flex-1 items-end justify-center focus-visible:outline-none"
                >
                  {b.totalUsd <= 0 ? (
                    <span className="h-[3px] w-full max-w-[22px] rounded-sm bg-[var(--md-sys-color-surface-container-highest)]" />
                  ) : (
                    <span
                      className={`flex w-full max-w-[22px] flex-col-reverse overflow-hidden rounded-t-[5px] rounded-b-[2px] ${
                        isSelected
                          ? 'ring-2 ring-[var(--md-sys-color-on-surface)] ring-offset-2 ring-offset-[var(--md-sys-color-surface-container)]'
                          : ''
                      }`}
                      style={{ height: totalH, gap: 1 }}
                    >
                      {segs.map((s, si) => (
                        <span
                          key={si}
                          style={{
                            flex: `${(s.val / segTotal) * 100} 1 0%`,
                            minHeight: totalH >= 14 ? 2 : 1,
                            background: s.color,
                          }}
                        />
                      ))}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="relative mt-2 h-4">
            {series.map((b, i) => {
              if (!shownLabels.has(i)) return null
              const posStyle =
                i === 0
                  ? { left: 0 }
                  : i === series.length - 1
                    ? { right: 0 }
                    : { left: `${((i + 0.5) / series.length) * 100}%`, transform: 'translateX(-50%)' }
              return (
                <span
                  key={b.key}
                  style={posStyle}
                  className={`type-label-small absolute top-0 whitespace-nowrap ${
                    i === activeIdx
                      ? 'font-semibold text-[var(--md-sys-color-primary)]'
                      : 'text-[var(--md-sys-color-on-surface-variant)]'
                  }`}
                >
                  {b.label}
                </span>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
