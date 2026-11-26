import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type CSSProperties } from 'react'
import {
  Button,
  Chip,
  Icon,
  ListGroup,
  Segmented,
  ShapeBadge,
  Spinner,
  StatusChip,
  TextField,
  WavyProgress,
} from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { GrammarStats } from '@/common/types/ipc'
import { pluralRu } from '@/common/utilities/pluralRu'
import { formatTime } from '@/common/utilities/time'
import { PATTERNS } from '@/modules/Patterns'
import { filterGrammarPatterns, formatEpisodeTitle, PATTERN_STATS_KEY, type GrammarStatusFilter } from '../lib/format'
import { usePatternExamples } from '../useStats'

const SUCCESS_CHIP: CSSProperties = {
  '--m3e-status-chip-container': 'var(--app-success-container)',
  '--m3e-status-chip-content': 'var(--app-on-success-container)',
} as CSSProperties

const WARNING_CHIP: CSSProperties = {
  '--m3e-status-chip-container': 'var(--app-warning-container)',
  '--m3e-status-chip-content': 'var(--app-on-warning-container)',
} as CSSProperties

const BADGE_WARN: CSSProperties = {
  '--m3e-badge-container': 'var(--app-warning-container)',
  '--m3e-badge-content': 'var(--app-on-warning-container)',
} as CSSProperties

function HighlightedCue({ text, start, end }: { text: string; start: number; end: number }) {
  if (start < 0 || end <= start || end > text.length) return <>{text}</>
  return (
    <>
      {text.slice(0, start)}
      <strong className="font-semibold text-[var(--app-kind-grammar)]">{text.slice(start, end)}</strong>
      {text.slice(end)}
    </>
  )
}

export function GrammarTab({ data }: { data: GrammarStats }) {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<GrammarStatusFilter>('all')
  const [levelFilter, setLevelFilter] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const statsMap = useMemo(() => new Map(data.items.map((x) => [x.id, x])), [data.items])
  const filtered = useMemo(
    () => filterGrammarPatterns(PATTERNS, statsMap, statusFilter, levelFilter, query),
    [statsMap, statusFilter, levelFilter, query],
  )

  const activeId = useMemo(() => {
    if (selectedId && filtered.some((p) => p.id === selectedId)) return selectedId
    return filtered.find((p) => p.count > 0)?.id ?? filtered[0]?.id ?? null
  }, [filtered, selectedId])

  const activePattern = useMemo(() => PATTERNS.find((p) => p.id === activeId) ?? null, [activeId])
  const activeStats = activeId ? statsMap.get(activeId) : undefined
  const examples = usePatternExamples(activeId)

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'learning' | 'known' | 'none' }) =>
      api.patternsSetStatus(id, status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stats'] })
      void qc.invalidateQueries({ queryKey: PATTERN_STATS_KEY })
    },
    onError: (e) => notify('error', errorText(e)),
  })

  const openExample = async (mediaId: string, startSec: number) => {
    try {
      await api.sessionReopen(mediaId, false, startSec)
    } catch (e) {
      notify('error', errorText(e))
    }
  }

  const unseen = Math.max(0, data.total - data.encountered)

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-6 rounded-[28px] bg-[var(--md-sys-color-surface-container)] p-6 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div>
            <h2 className="type-headline-small type-emph">
              {data.encountered} из {data.total} конструкций встречены в фильмах
            </h2>
            <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
              Автоматически размечаются в субтитрах: {data.known} знаешь, {data.learning} отмечено «Учу»
            </p>
          </div>
          <WavyProgress
            value={data.total > 0 ? data.encountered / data.total : 0}
            amp={3}
            len={18}
            stroke={4}
            animated={false}
          />
          <div className="flex flex-wrap gap-2">
            <StatusChip size="sm" tone="neutral" style={SUCCESS_CHIP}>Знаю · {data.known}</StatusChip>
            <StatusChip size="sm" tone="neutral" style={WARNING_CHIP}>Учу · {data.learning}</StatusChip>
            <StatusChip size="sm" tone="primary">
              Встречено · {Math.max(0, data.encountered - data.known - data.learning)}
            </StatusChip>
            <StatusChip size="sm" tone="neutral">Ещё не было · {unseen}</StatusChip>
          </div>
        </div>

        <div className="hidden h-[116px] w-px bg-[var(--md-sys-color-outline-variant)] lg:block" />

        <div className="flex shrink-0 flex-col gap-2.5 lg:w-[390px]">
          <span className="type-title-small type-emph">По уровням (всего {data.total})</span>
          <div className="grid grid-cols-5 items-end gap-3">
            {data.byLevel.map((lvl) => {
              const sel = levelFilter === lvl.level
              const pct = lvl.total > 0 ? Math.max(10, Math.round((lvl.encountered / lvl.total) * 100)) : 0
              return (
                <button
                  key={lvl.level}
                  type="button"
                  onClick={() => setLevelFilter((cur) => (cur === lvl.level ? null : lvl.level))}
                  className="flex flex-col items-center gap-1.5 rounded-[12px] p-1.5 transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]"
                >
                  <span
                    className={`type-label-small tabular-nums ${
                      sel ? 'font-semibold text-[var(--md-sys-color-primary)]' : 'text-[var(--md-sys-color-on-surface-variant)]'
                    }`}
                  >
                    {lvl.encountered}/{lvl.total}
                  </span>
                  <div className="flex h-[52px] w-8 items-end overflow-hidden rounded-[8px] bg-[var(--md-sys-color-surface-container-highest)]">
                    <div
                      className="w-full rounded-[6px]"
                      style={{
                        height: `${lvl.encountered > 0 ? pct : 0}%`,
                        background: sel ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-secondary)',
                      }}
                    />
                  </div>
                  <span
                    className={`type-label-medium ${
                      sel ? 'font-semibold text-[var(--md-sys-color-primary)]' : 'text-[var(--md-sys-color-on-surface-variant)]'
                    }`}
                  >
                    {lvl.level}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-2.5">
        <Segmented
          label="Статус конструкции"
          size="xs"
          value={statusFilter}
          options={[
            { value: 'all', label: `Все · ${data.total}` },
            { value: 'learning', label: `Учу · ${data.learning}` },
            { value: 'encountered', label: `Встречено · ${data.encountered}` },
            { value: 'known', label: `Знаю · ${data.known}` },
          ]}
          onChange={setStatusFilter}
        />

        <div className="flex flex-wrap items-center gap-1.5">
          {data.byLevel.map((lvl) => (
            <Chip
              key={lvl.level}
              label={`${lvl.level} · ${lvl.total}`}
              selected={levelFilter === lvl.level}
              onClick={() => setLevelFilter((cur) => (cur === lvl.level ? null : lvl.level))}
            />
          ))}
        </div>

        <div className="ml-auto w-full sm:w-[240px]">
          <TextField
            variant="pill"
            aria-label="Поиск конструкции или формулы"
            placeholder="Конструкция или формула"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            leading={<Icon name="search" size={18} />}
          />
        </div>
      </section>

      {activePattern && (
        <section className="flex flex-col gap-6 rounded-[28px] border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-low)] p-6 lg:flex-row">
          <div className="flex flex-col gap-3 lg:w-[44%]">
            <div className="flex items-start gap-3">
              <ShapeBadge shape="clover4" size={44} tone="neutral" icon="school" iconFill iconSize={22} style={BADGE_WARN} />
              <div className="min-w-0 flex-1">
                <h3 className="type-title-large type-emph">{activePattern.label}</h3>
                <div className="type-label-large font-semibold text-[var(--app-kind-grammar)]">
                  {activePattern.formula} · {activePattern.level} · встречено ×{activeStats?.count ?? 0}
                </div>
              </div>
            </div>
            <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">{activePattern.about}</p>
            <div className="flex flex-wrap gap-2">
              <Chip
                label="Знаю"
                selected={activeStats?.status === 'known'}
                onClick={() =>
                  setStatus.mutate({
                    id: activePattern.id,
                    status: activeStats?.status === 'known' ? 'none' : 'known',
                  })
                }
              />
              <Chip
                label="Учу"
                selected={activeStats?.status === 'learning'}
                onClick={() =>
                  setStatus.mutate({
                    id: activePattern.id,
                    status: activeStats?.status === 'learning' ? 'none' : 'learning',
                  })
                }
              />
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <h4 className="type-title-small type-emph">Примеры из твоих фильмов</h4>
            {examples.isPending ? (
              <div className="flex justify-center py-6">
                <Spinner label="Ищу примеры" />
              </div>
            ) : !examples.data || examples.data.length === 0 ? (
              <div className="rounded-[18px] bg-[var(--md-sys-color-surface-container)] p-4">
                <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                  Эта конструкция ещё не встречалась в разобранных репликах.
                </p>
              </div>
            ) : (
              <ListGroup>
                {examples.data.slice(0, 5).map((ex) => (
                  <div
                    key={`${ex.mediaId}:${ex.cueIdx}`}
                    className="flex items-center justify-between gap-3 bg-[var(--md-sys-color-surface-container)] px-4 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="type-label-small wrap-anywhere font-semibold text-[var(--md-sys-color-primary)]">
                        {formatEpisodeTitle(ex.title, ex.season, ex.episode)} · {formatTime(ex.startSec)}
                      </div>
                      <div className="type-body-medium wrap-anywhere">
                        <HighlightedCue text={ex.text.replaceAll('\n', ' ')} start={ex.startChar} end={ex.endChar} />
                      </div>
                    </div>
                    <Button
                      variant="tonal"
                      size="xs"
                      icon="play_arrow"
                      onClick={() => void openExample(ex.mediaId, ex.startSec)}
                    >
                      Открыть
                    </Button>
                  </div>
                ))}
              </ListGroup>
            )}
          </div>
        </section>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-[24px] bg-[var(--md-sys-color-surface-container)] p-6 text-center">
          <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">
            Под выбранные фильтры не подошла ни одна конструкция.
          </p>
        </div>
      ) : (
        <section className="grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => {
            const isSelected = p.id === activeId
            const statusLabel =
              p.status === 'known'
                ? 'Знаю'
                : p.status === 'learning'
                  ? 'Учу'
                  : p.count > 0
                    ? 'Встречено'
                    : 'Не встречалось'
            const statusStyle = p.status === 'known' ? SUCCESS_CHIP : p.status === 'learning' ? WARNING_CHIP : undefined
            const statusTone = p.status === null && p.count > 0 ? 'primary' : 'neutral'
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={`flex min-w-0 flex-col gap-2 rounded-[24px] p-4.5 text-left transition-colors ${
                  isSelected
                    ? 'border-2 border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-surface-container-high)]'
                    : p.count === 0
                      ? 'border border-[var(--md-sys-color-outline-variant)]/50 bg-[var(--md-sys-color-surface-container-low)] hover:bg-[var(--md-sys-color-surface-container)]'
                      : 'bg-[var(--md-sys-color-surface-container)] hover:bg-[var(--md-sys-color-surface-container-high)]'
                }`}
              >
                <div className="flex w-full min-w-0 items-start justify-between gap-2">
                  <span className="type-title-medium type-emph min-w-0 flex-1 line-clamp-2 wrap-anywhere">{p.label}</span>
                  <StatusChip size="sm" tone={statusTone} style={statusStyle} className="shrink-0">
                    {statusLabel}
                  </StatusChip>
                </div>
                <div className="type-label-large min-w-0 wrap-anywhere font-semibold text-[var(--app-kind-grammar)]">{p.formula}</div>
                <div className="type-body-small mt-auto flex w-full items-center justify-between text-[var(--md-sys-color-on-surface-variant)]">
                  <span>
                    {p.level} ·{' '}
                    {p.count === 0
                      ? 'пока не встречалась'
                      : `×${p.count}${p.filmsCount > 0 ? ` в ${p.filmsCount} ${pluralRu(p.filmsCount, 'фильме', 'фильмах', 'фильмах')}` : ''}`}
                  </span>
                  {isSelected && <span className="type-label-small font-semibold text-[var(--md-sys-color-primary)]">выбрано</span>}
                </div>
              </button>
            )
          })}
        </section>
      )}
    </div>
  )
}
