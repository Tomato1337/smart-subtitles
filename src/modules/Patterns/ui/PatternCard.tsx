import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog, Icon, IconButton, Presence } from '@tomato1337/m3e-react'
import { api } from '@/common/api/tauri'
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

/** The pattern dialog; kept on screen by Presence while it animates out after `close()`. */
export function PatternCard(props: Props) {
  const openId = usePatternStore((s) => s.openId)
  const pat = openId ? patternById(openId) : undefined
  return <Presence>{openId && pat && <PatternDialog id={openId} {...props} />}</Presence>
}

function PatternDialog({ id, mediaId, onSeekCue, onExplain, cueStart }: Props & { id: string }) {
  const close = usePatternStore((s) => s.close)
  const qc = useQueryClient()
  const stats = usePatternStats()
  const occ = useQuery({ queryKey: ['pattern-occ', mediaId, id], queryFn: () => api.patternsOccurrences(mediaId, id) })
  const pat = patternById(id)
  if (!pat) return null
  const st = stats.data?.find((s) => s.id === id)
  const set = (status: 'learning' | 'known') => api.patternsSetStatus(id, status).then(() => qc.invalidateQueries({ queryKey: statsKey }))
  const chip = (active: boolean) => `state-layer state-on-surface type-label-large relative rounded-full px-4 py-1.5 ${active ? 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]' : 'border border-[var(--md-sys-color-outline)]'}`

  return (
    <Dialog onClose={close} dismissible aria-labelledby="pattern-title" className="max-h-[85vh] w-[520px] max-w-[95vw] gap-3" style={{ userSelect: 'text' }}>
      <div className="flex items-start justify-between">
        <div>
          <h2 id="pattern-title" className="type-headline-small">{pat.label}</h2>
          <div className="type-label-large text-[var(--app-kind-grammar)]">{pat.formula} · {pat.level} · встречено ×{st?.count ?? 0}</div>
        </div>
        <IconButton icon="close" label="Закрыть" onClick={close} />
      </div>
      <p className="type-body-medium">{pat.about}</p>
      <div className="flex gap-2">
        <button type="button" aria-pressed={st?.status === 'known'} className={chip(st?.status === 'known')} onClick={() => void set('known')}>Знаю</button>
        <button type="button" aria-pressed={st?.status === 'learning'} className={chip(st?.status === 'learning')} onClick={() => void set('learning')}>Учу</button>
        <button type="button" className="state-layer state-on-surface type-label-large relative ml-auto flex items-center gap-1 rounded-full bg-[var(--md-sys-color-surface-container-highest)] px-4 py-1.5" onClick={() => { close(); onExplain(id) }}>
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
    </Dialog>
  )
}
