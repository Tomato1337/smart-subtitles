import { useQuery } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, errorText } from '@/common/api/tauri'
import { Icon } from '@/common/ui/Icon'
import { IconButton } from '@/common/ui/IconButton'
import { AnkiBlock, lookupSpan, useAnkiStore } from '@/modules/Anki'
import { useSubsStore } from '@/modules/Subtitles'
import { useExplainStore } from '../store/explainStore'

type Props = {
  mediaId: string
  onCard: (cueIdx: number, span: string) => void
  onAsk: (cueIdx: number, span: string) => void
}

function speak(text: string) {
  if (typeof speechSynthesis === 'undefined') return
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'en-US'
  speechSynthesis.cancel()
  speechSynthesis.speak(u)
}

export function ExplainPopover({ mediaId, onCard, onAsk }: Props) {
  const { target, popoverEnter, popoverLeave, close } = useExplainStore()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [more, setMore] = useState(false)
  const index = useAnkiStore((s) => s.index)
  const cards = useAnkiStore((s) => s.cards)
  const annotations = useSubsStore((s) => s.annotations)

  const key = target ? `${target.cueIdx}|${target.span}` : ''
  const q = useQuery({
    queryKey: ['explain', mediaId, target?.cueIdx, target?.span],
    queryFn: () => api.llmExplain(mediaId, target!.cueIdx, target!.span),
    enabled: !!target,
    staleTime: Infinity,
  })

  useEffect(() => { setMore(false) }, [key])

  useLayoutEffect(() => {
    if (!target || !ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    const a = target.anchor
    const above = a.top - height - 8
    setPos({
      left: Math.min(Math.max(8, a.left - 16), window.innerWidth - width - 8),
      top: above >= 8 ? above : Math.min(a.bottom + 8, window.innerHeight - height - 8),
    })
  }, [target, q.data, more, q.isLoading])

  useEffect(() => {
    if (!target?.pinned) return
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const keydown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', keydown, true) }
  }, [target?.pinned, close])

  if (!target) return null
  const ann = annotations.get(target.cueIdx)
  const chunk = ann?.chunks.find((c) => c.text.toLowerCase() === target.span.toLowerCase())
  const e = q.data
  const entry = lookupSpan(target.span, index, cards)
  const translation = e?.translation || chunk?.ru

  return (
    <div
      ref={ref}
      onMouseEnter={popoverEnter}
      onMouseLeave={popoverLeave}
      className="md-pop fixed z-[150] w-[340px] max-w-[calc(100vw-16px)] bg-[var(--md-sys-color-surface-container)] p-4 text-[var(--md-sys-color-on-surface)] shadow-lg"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, borderRadius: 'var(--md-sys-shape-corner-large)', userSelect: 'text' }}
    >
      <div className="flex items-center gap-1">
        <span className="type-title-medium min-w-0 flex-1 break-words font-bold">{e?.chunk || target.span}</span>
        <button type="button" aria-label="Произношение" onClick={() => speak(target.span)} className="flex size-8 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)]">
          <Icon name="volume_up" size={20} />
        </button>
        <IconButton icon="close" label="Закрыть" onClick={close} className="!size-8" />
      </div>
      <div className="mt-1 min-h-6">
        {translation && <span className="type-title-medium font-bold">{translation}</span>}
        {e?.word_type && <span className="type-body-small ml-2 text-[var(--md-sys-color-on-surface-variant)]">{e.word_type}</span>}
        {q.isLoading && <span className="type-body-small ml-2 text-[var(--md-sys-color-on-surface-variant)]">думаю…</span>}
        {q.isError && <div className="type-body-small text-[var(--md-sys-color-error)]">{errorText(q.error)}</div>}
      </div>
      {entry && <div className="mt-2"><AnkiBlock entry={entry} /></div>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {entry ? (
            <span className="type-label-large px-3 py-1.5 text-[var(--md-sys-color-on-surface-variant)]">Уже в колоде</span>
          ) : (
            <button type="button" onClick={() => { close(); onCard(target.cueIdx, target.span) }} className="state-layer type-label-large relative flex items-center gap-1 whitespace-nowrap rounded-[var(--md-sys-shape-corner-medium)] px-3 py-1.5" style={{ background: 'var(--app-anki-label-container)', color: 'var(--app-anki-on-label-container)' }}>
              <Icon name="add" size={18} /> В Anki
            </button>
          )}
          <button type="button" onClick={() => { close(); onAsk(target.cueIdx, target.span) }} className="state-layer state-on-surface type-label-large relative flex items-center gap-1 whitespace-nowrap rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-surface-container-highest)] px-3 py-1.5">
            <Icon name="auto_awesome" size={18} /> Спросить
          </button>
        </div>
        {e && (
          <button type="button" onClick={() => setMore((v) => !v)} className="type-label-large flex items-center whitespace-nowrap text-[var(--md-sys-color-on-surface-variant)]">
            Все значения <Icon name={more ? 'expand_less' : 'expand_more'} size={20} />
          </button>
        )}
      </div>
      {more && e && (
        <div className="type-body-medium mt-3 flex flex-col gap-2 border-t border-[var(--md-sys-color-outline-variant)] pt-3">
          {e.meaning && <p>{e.meaning}</p>}
          {e.literal && <p className="text-[var(--md-sys-color-on-surface-variant)]">Буквально: {e.literal}</p>}
          {e.register && <p className="text-[var(--md-sys-color-on-surface-variant)]">Регистр: {e.register}</p>}
          {e.grammar && <p>{e.grammar}</p>}
          {e.examples.map((x, i) => (
            <p key={i}>{x.en}<br /><span className="text-[var(--md-sys-color-on-surface-variant)]">{x.ru}</span></p>
          ))}
        </div>
      )}
    </div>
  )
}
