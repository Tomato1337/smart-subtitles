import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Chip, Dialog, IconButton, Presence } from '@tomato1337/m3e-react'
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
      <div className="flex flex-wrap items-center gap-2">
        <Chip selected={st?.status === 'known'} label="Знаю" onClick={() => void set('known')} />
        <Chip selected={st?.status === 'learning'} label="Учу" onClick={() => void set('learning')} />
        <Button variant="tonal" size="xs" icon="auto_awesome" className="ml-auto" onClick={() => { close(); onExplain(id) }}>
          Объяснить на примерах
        </Button>
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
