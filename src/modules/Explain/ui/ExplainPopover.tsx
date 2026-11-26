import { useQuery } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Button, Icon, IconButton, Presence, toast } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import { AnkiBlock, lookupSpan, useAnkiStore } from '@/modules/Anki'
import { useSubsStore } from '@/modules/Subtitles'
import { VocabBadges, VocabDetailLine, isWordKnown, mergeSpanAndChunk, useKnownWords, useSetKnownWord, useVocabLookup } from '@/modules/Vocab'
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

/** Clamps popover position inside the viewport with an 8 px margin so tall/wide content never pushes the header off-screen. */
export function clampPopoverPos(
  anchor: { left: number; top: number; bottom: number },
  width: number,
  height: number,
  vw: number,
  vh: number,
): { left: number; top: number } {
  const above = anchor.top - height - 8
  const maxLeft = Math.max(8, vw - width - 8)
  const maxTop = Math.max(8, vh - height - 8)
  const left = Math.max(8, Math.min(anchor.left - 16, maxLeft))
  const top = above >= 8 ? above : Math.max(8, Math.min(anchor.bottom + 8, maxTop))
  return { left, top }
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
  const e = q.data
  const spanVocab = useVocabLookup(target.span, mediaId)
  const canonical =
    e?.chunk && e.chunk.trim().toLowerCase() !== target.span.trim().toLowerCase() ? e.chunk : null
  const chunkVocab = useVocabLookup(canonical, mediaId)
  const vocab = useMemo(
    () => mergeSpanAndChunk(spanVocab.data, chunkVocab.data),
    [spanVocab.data, chunkVocab.data],
  )
  const knownWords = useKnownWords()
  const toggleKnown = useSetKnownWord()
  const known = isWordKnown(knownWords.data, target.span, vocab?.lemma ?? canonical)

  useEffect(() => { setMore(false) }, [key])

  useLayoutEffect(() => {
    if (!ref.current) return
    // Layout size: getBoundingClientRect() would include the entry scale while it runs.
    const { offsetWidth: width, offsetHeight: height } = ref.current
    const { left, top } = clampPopoverPos(target.anchor, width, height, window.innerWidth, window.innerHeight)
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
  }, [target, q.data, more, q.isLoading, vocab, known])

  useEffect(() => {
    const keydown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    document.addEventListener('keydown', keydown, true)
    if (!target.pinned) return () => document.removeEventListener('keydown', keydown, true)
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    document.addEventListener('pointerdown', down)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', keydown, true) }
  }, [target.pinned, close])

  const ann = annotations.get(target.cueIdx)
  const chunk = ann?.chunks.find((c) => c.text.toLowerCase() === target.span.toLowerCase())
  const entry = lookupSpan(target.span, index, cards)
  const translation = e?.translation || chunk?.ru
  const hasBadges = Boolean(vocab?.tier || vocab?.cefr || (vocab?.filmCount ?? 0) > 0 || e?.frequency)

  return (
    <div
      ref={ref}
      onMouseEnter={popoverEnter}
      onMouseLeave={popoverLeave}
      className="m3e-motion-pop fixed z-[150] flex max-h-[calc(100vh-16px)] w-[360px] max-w-[calc(100vw-16px)] flex-col overflow-hidden bg-[var(--md-sys-color-surface-container-high)] text-[var(--md-sys-color-on-surface)]"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, borderRadius: 'var(--md-sys-shape-corner-extra-large)', boxShadow: '0 8px 28px rgb(0 0 0 / 0.5)', userSelect: 'text' }}
    >
      <div className="flex shrink-0 items-center gap-1 pt-4 pr-3 pl-6">
        <span className="type-title-large type-emph min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{e?.chunk || target.span}</span>
        <IconButton icon="volume_up" label="Произношение" onClick={() => speak(target.span)} />
        <IconButton icon="close" label="Закрыть" onClick={close} />
      </div>
      <div className="stats-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-1 pb-3">
        <div className="min-w-0 min-h-6 break-words [overflow-wrap:anywhere]">
          {translation && <span className="type-body-large text-[1.125rem] leading-snug">{translation}</span>}
          {e?.word_type && <div className="type-body-medium mt-1 text-[var(--md-sys-color-on-surface-variant)]">{e.word_type}</div>}
          {q.isLoading && <span className="type-body-small ml-2 text-[var(--md-sys-color-on-surface-variant)]">думаю…</span>}
          {q.isError && <div className="type-body-small text-[var(--md-sys-color-error)]">{errorText(q.error)}</div>}
        </div>
        {hasBadges && (
          <div className="mt-2">
            <VocabBadges vocab={vocab} explainFreq={e?.frequency} />
          </div>
        )}
        {entry && <div className="mt-2"><AnkiBlock entry={entry} /></div>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {entry ? (
              <span className="type-label-large inline-flex min-h-10 items-center rounded-full px-3 py-1.5 text-[var(--md-sys-color-on-surface-variant)]">Уже в колоде</span>
            ) : (
              <>
                <Button
                  size="sm"
                  icon="add"
                  onClick={() => { close(); onCard(target.cueIdx, target.span) }}
                  style={{ '--m3e-button-container': 'var(--app-anki-label-container)', '--m3e-button-content': 'var(--app-anki-on-label-container)' } as CSSProperties}
                >
                  В Anki
                </Button>
                <Button
                  size="sm"
                  variant={known ? 'tonal' : 'outlined'}
                  selected={known}
                  disabled={toggleKnown.isPending}
                  onClick={() => {
                    const word = canonical || target.span
                    toggleKnown.mutate(
                      { word, known: !known },
                      {
                        onSuccess: (res) => toast(res.known ? `Отмечено «Знаю»: ${res.display}` : `Убрано из «Знаю»: ${res.display}`),
                        onError: (err) => notify('error', errorText(err)),
                      },
                    )
                  }}
                  style={known ? ({ '--m3e-button-container': 'var(--app-success-container)', '--m3e-button-content': 'var(--app-on-success-container)' } as CSSProperties) : undefined}
                  title={known ? 'Убрать из списка известных слов' : 'Отметить слово как уже известное'}
                >
                  <Icon name="check_circle" size={18} fill={known} /> Знаю
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="tonal"
              onClick={() => { close(); onAsk(target.cueIdx, target.span) }}
              style={{ '--m3e-button-container': 'var(--md-sys-color-tertiary-container)', '--m3e-button-content': 'var(--md-sys-color-on-tertiary-container)' } as CSSProperties}
            >
              <Icon name="auto_awesome" size={20} fill /> Спросить
            </Button>
          </div>
          {e && (
            <Button size="sm" variant="text" trailingIcon={more ? 'expand_less' : 'expand_more'} className="ml-auto" onClick={() => setMore((v) => !v)}>
              Все значения
            </Button>
          )}
        </div>
        {more && e && (
          <div className="type-body-medium mt-3 flex min-w-0 flex-col gap-2 border-t border-[var(--md-sys-color-outline-variant)] pt-3 break-words [overflow-wrap:anywhere]">
            {e.meaning && <p>{e.meaning}</p>}
            {e.literal && <p className="text-[var(--md-sys-color-on-surface-variant)]">Буквально: {e.literal}</p>}
            {e.register && <p className="text-[var(--md-sys-color-on-surface-variant)]">Регистр: {e.register}</p>}
            <VocabDetailLine vocab={vocab} explainFreq={e.frequency} />
            {e.grammar && <p>{e.grammar}</p>}
            {e.examples.map((x, i) => (
              <p key={i}>{x.en}<br /><span className="text-[var(--md-sys-color-on-surface-variant)]">{x.ru}</span></p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
