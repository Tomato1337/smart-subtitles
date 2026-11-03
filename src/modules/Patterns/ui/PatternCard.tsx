import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/common/api/tauri'
import { Icon } from '@/common/ui/Icon'
import { IconButton } from '@/common/ui/IconButton'
import { formatTime } from '@/common/utilities/time'
import { patternById } from '../lib/catalog'
import { usePatternStore } from '../store/patternStore'
import { statsKey, usePatternStats } from '../usePatterns'

type Props = {
  mediaId: string
  /** Jump to a cue of the film. */
  onSeekCue: (cueIdx: number) => void
  onExplain: (patternId: string) => void
  cueStart: (cueIdx: number) => number
}

export function PatternCard({ mediaId, onSeekCue, onExplain, cueStart }: Props) {
  const { openId, close } = usePatternStore()
  const qc = useQueryClient()
  const stats = usePatternStats()
  const occ = useQuery({ queryKey: ['pattern-occ', mediaId, openId], queryFn: () => api.patternsOccurrences(mediaId, openId!), enabled: !!openId })
  const pat = openId ? patternById(openId) : undefined
  if (!openId || !pat) return null
  const st = stats.data?.find((s) => s.id === openId)
  const set = (status: 'learning' | 'known') => api.patternsSetStatus(openId, status).then(() => qc.invalidateQueries({ queryKey: statsKey }))
  const chip = (active: boolean) => `state-layer state-on-surface type-label-large relative rounded-full px-4 py-1.5 ${active ? 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]' : 'border border-[var(--md-sys-color-outline)]'}`

  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-[color-mix(in_srgb,var(--md-sys-color-scrim)_50%,transparent)]" onPointerDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div role="dialog" aria-label={pat.label} className="md-pop flex max-h-[85vh] w-[520px] max-w-[95vw] flex-col gap-3 bg-[var(--md-sys-color-surface-container-high)] p-6" style={{ borderRadius: 'var(--md-sys-shape-corner-extra-large)', userSelect: 'text' }}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="type-headline-small">{pat.label}</h2>
            <div className="type-label-large text-[var(--app-kind-grammar)]">{pat.formula} · {pat.level} · встречено ×{st?.count ?? 0}</div>
          </div>
          <IconButton icon="close" label="Закрыть" onClick={close} />
        </div>
        <p className="type-body-medium">{pat.about}</p>
        <div className="flex gap-2">
          <button type="button" className={chip(st?.status === 'known')} onClick={() => void set('known')}>Знаю</button>
          <button type="button" className={chip(st?.status === 'learning')} onClick={() => void set('learning')}>Учу</button>
          <button type="button" className="state-layer state-on-surface type-label-large relative ml-auto flex items-center gap-1 rounded-full bg-[var(--md-sys-color-surface-container-highest)] px-4 py-1.5" onClick={() => { close(); onExplain(openId) }}>
            <Icon name="auto_awesome" size={18} /> Объяснить на примерах
          </button>
        </div>
        <div className="type-label-medium text-[var(--md-sys-color-on-surface-variant)]">В этом фильме</div>
        <ul className="flex min-h-0 flex-col overflow-y-auto">
          {occ.data?.map((o) => (
            <li key={o.idx}>
              <button type="button" onClick={() => { close(); onSeekCue(o.idx) }} className="state-layer state-on-surface type-body-medium relative flex w-full gap-3 rounded-[var(--md-sys-shape-corner-small)] px-2 py-1.5 text-left">
                <span className="type-label-small w-12 shrink-0 pt-0.5 text-[var(--md-sys-color-primary)]">{formatTime(cueStart(o.idx))}</span>
                <span className="whitespace-pre-line">{o.text}</span>
              </button>
            </li>
          ))}
          {occ.data?.length === 0 && <li className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Пока не встречалась</li>}
        </ul>
      </div>
    </div>
  )
}
