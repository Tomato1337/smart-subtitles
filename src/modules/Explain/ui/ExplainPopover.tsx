import { useQuery } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon, IconButton, Presence } from '@tomato1337/m3e-react'
import { api, errorText } from '@/common/api/tauri'
import { AnkiBlock, lookupSpan, useAnkiStore } from '@/modules/Anki'
import { useSubsStore } from '@/modules/Subtitles'
import { useExplainStore, type ExplainTarget } from '../store/explainStore'

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

/** Word card next to the picked span; it pops in and, kept mounted by Presence, fades out on close. */
export function ExplainPopover(props: Props) {
  const target = useExplainStore((s) => s.target)
  return <Presence>{target && <ExplainCard {...props} target={target} />}</Presence>
}

function ExplainCard({ mediaId, onCard, onAsk, target }: Props & { target: ExplainTarget }) {
  const popoverEnter = useExplainStore((s) => s.popoverEnter)
  const popoverLeave = useExplainStore((s) => s.popoverLeave)
  const close = useExplainStore((s) => s.close)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [more, setMore] = useState(false)
  const index = useAnkiStore((s) => s.index)
  const cards = useAnkiStore((s) => s.cards)
  const annotations = useSubsStore((s) => s.annotations)

  const key = `${target.cueIdx}|${target.span}`
  const q = useQuery({
    queryKey: ['explain', mediaId, target.cueIdx, target.span],
    queryFn: () => api.llmExplain(mediaId, target.cueIdx, target.span),
    staleTime: Infinity,
  })

  useEffect(() => { setMore(false) }, [key])

  useLayoutEffect(() => {
    if (!ref.current) return
    // Layout size: getBoundingClientRect() would include the entry scale while it runs.
    const { offsetWidth: width, offsetHeight: height } = ref.current
    const a = target.anchor
    const above = a.top - height - 8
    setPos({
      left: Math.min(Math.max(8, a.left - 16), window.innerWidth - width - 8),
      top: above >= 8 ? above : Math.min(a.bottom + 8, window.innerHeight - height - 8),
    })
  }, [target, q.data, more, q.isLoading])

  useEffect(() => {
    if (!target.pinned) return
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const keydown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', keydown, true) }
  }, [target.pinned, close])

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
      className="m3e-motion-pop fixed z-[150] w-[360px] max-w-[calc(100vw-16px)] bg-[var(--md-sys-color-surface-container-high)] pb-3 pl-6 pr-3 pt-4 text-[var(--md-sys-color-on-surface)]"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, borderRadius: 'var(--md-sys-shape-corner-extra-large)', boxShadow: '0 8px 28px rgb(0 0 0 / 0.5)', userSelect: 'text' }}
    >
      <div className="flex items-center gap-1">
        <span className="type-title-large type-emph min-w-0 flex-1 break-words">{e?.chunk || target.span}</span>
        <IconButton icon="volume_up" label="Произношение" onClick={() => speak(target.span)} />
        <IconButton icon="close" label="Закрыть" onClick={close} />
      </div>
      <div className="mt-1 min-h-6">
        {translation && <span className="type-body-large text-[1.125rem] leading-snug">{translation}</span>}
        {e?.word_type && <div className="type-body-medium mt-1 text-[var(--md-sys-color-on-surface-variant)]">{e.word_type}</div>}
        {q.isLoading && <span className="type-body-small ml-2 text-[var(--md-sys-color-on-surface-variant)]">думаю…</span>}
        {q.isError && <div className="type-body-small text-[var(--md-sys-color-error)]">{errorText(q.error)}</div>}
      </div>
      {entry && <div className="mt-2"><AnkiBlock entry={entry} /></div>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {entry ? (
            <span className="type-label-large inline-flex h-10 items-center rounded-full px-3 text-[var(--md-sys-color-on-surface-variant)]">Уже в колоде</span>
          ) : (
            <button type="button" onClick={() => { close(); onCard(target.cueIdx, target.span) }} className="m3e-morph state-layer type-label-large relative inline-flex h-10 items-center gap-1 whitespace-nowrap rounded-[20px] pl-3 pr-4 font-semibold active:rounded-[var(--md-sys-shape-corner-medium)]" style={{ background: 'var(--app-anki-label-container)', color: 'var(--app-anki-on-label-container)' }}>
              <Icon name="add" size={20} /> В Anki
            </button>
          )}
          <button type="button" onClick={() => { close(); onAsk(target.cueIdx, target.span) }} className="m3e-morph state-layer type-label-large relative inline-flex h-10 items-center gap-1 whitespace-nowrap rounded-[20px] bg-[var(--md-sys-color-tertiary-container)] pl-3 pr-4 font-semibold text-[var(--md-sys-color-on-tertiary-container)] active:rounded-[var(--md-sys-shape-corner-medium)]">
            <Icon name="auto_awesome" size={20} fill /> Спросить
          </button>
        </div>
        {e && (
          <button type="button" onClick={() => setMore((v) => !v)} className="m3e-morph state-layer type-label-large relative inline-flex h-10 items-center gap-1 whitespace-nowrap rounded-[20px] pl-3 pr-4 font-semibold text-[var(--md-sys-color-primary)]">
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
