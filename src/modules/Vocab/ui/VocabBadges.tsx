import type { CSSProperties } from 'react'
import { StatusChip, type StatusTone } from '@tomato1337/m3e-react'
import type { ExplainFrequency, VocabInfo } from '@/common/types/ipc'
import { formatCorpusSummary, resolveFrequencyBadge, type BadgeTone } from '../lib/format'

const CUSTOM_CHIP_STYLES: Partial<Record<BadgeTone, CSSProperties>> = {
  success: {
    '--m3e-status-chip-container': 'var(--app-success-container)',
    '--m3e-status-chip-content': 'var(--app-on-success-container)',
  } as CSSProperties,
  warning: {
    '--m3e-status-chip-container': 'var(--app-warning-container)',
    '--m3e-status-chip-content': 'var(--app-on-warning-container)',
  } as CSSProperties,
}

function chipTone(tone: BadgeTone): StatusTone {
  return tone === 'success' || tone === 'warning' ? 'neutral' : tone
}

export function pluralTimesRu(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'раза'
  return 'раз'
}

/** Compact M3 StatusChip row: frequency tier, CEFR level (with above-level warning), and film count. */
export function VocabBadges({
  vocab,
  explainFreq,
  compact = false,
}: {
  vocab?: VocabInfo | null
  explainFreq?: ExplainFrequency | null
  compact?: boolean
}) {
  const badge = resolveFrequencyBadge(vocab, explainFreq)
  const cefr = vocab?.cefr ?? null
  const filmCount = vocab?.filmCount ?? 0

  if (!badge && !cefr && filmCount === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {badge && (
        <StatusChip
          size="sm"
          tone={chipTone(badge.tone)}
          style={CUSTOM_CHIP_STYLES[badge.tone]}
          icon={badge.isAiEstimate ? 'auto_awesome' : undefined}
          title={badge.hint}
        >
          {badge.label}
        </StatusChip>
      )}
      {cefr && (
        <StatusChip
          size="sm"
          tone="neutral"
          style={vocab?.aboveLevel ? CUSTOM_CHIP_STYLES.warning : undefined}
          title={
            vocab?.aboveLevel
              ? `Уровень ${cefr} — выше твоего текущего окна`
              : `${vocab?.cefrSource ?? 'CEFR'} ${cefr}`
          }
        >
          {vocab?.aboveLevel ? `${cefr} · выше уровня` : cefr}
        </StatusChip>
      )}
      {filmCount > 0 && (
        <StatusChip
          size="sm"
          tone="neutral"
          title={`Встречается в этом фильме ${filmCount} ${pluralTimesRu(filmCount)}`}
        >
          {compact ? `×${filmCount}` : `×${filmCount} в фильме`}
        </StatusChip>
      )}
    </div>
  )
}

/** Detailed corpus ranks / Zipf or AI frequency explanation inside expanded «Все значения». */
export function VocabDetailLine({
  vocab,
  explainFreq,
}: {
  vocab?: VocabInfo | null
  explainFreq?: ExplainFrequency | null
}) {
  const badge = resolveFrequencyBadge(vocab, explainFreq)
  const summary = vocab ? formatCorpusSummary(vocab) : ''
  if (!badge && !summary) return null

  const parts: string[] = []
  if (badge) parts.push(badge.isAiEstimate ? `${badge.label} (оценка ИИ)` : badge.label)
  if (summary) parts.push(summary)

  return (
    <p className="text-[var(--md-sys-color-on-surface-variant)]">
      Частотность: {parts.join(' · ')}
    </p>
  )
}
