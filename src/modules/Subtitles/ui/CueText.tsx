import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Chunk, ChunkKind, Cue } from '@/common/types/ipc'
import { tokenize, type Token } from '../lib/tokens'
import { useHoverWord, wordKey } from '../store/hoverWordStore'

export type SpanPick = { cueIdx: number; span: string; anchor: DOMRect; tokenStart: number; tokenEnd: number }

type Props = {
 cue: Cue
 chunks: Chunk[]
 /** Fraction 0..1 of the cue text already "spoken" (hidden-mode karaoke); undefined = no karaoke. */
 karaoke?: number
 onPick?: (p: SpanPick) => void
 /** Pointer entered a word (span = its chunk or the word) or left (null). */
 onHover?: (p: SpanPick | null) => void
 /** Extra decoration per token (Anki labels, grammar underlines). Returns inline style and optional label node. */
 decorate?: (token: Token, index: number) => { style?: CSSProperties; label?: ReactNode } | undefined
 /** Publish the hovered word so other cue texts can echo it (`showShared`). */
 shareHover?: boolean
 /** Light up the words equal to the one hovered in any `shareHover` text (overlay and dialog list). */
 showShared?: boolean
}

function chunkAt(chunks: Chunk[], t: Token): Chunk | undefined {
 return chunks.find((c) => t.start >= c.startChar && t.end <= c.endChar)
}

const KIND_VAR: Record<ChunkKind, string> = {
 idiom: 'idiom', phrasal_verb: 'phrasal-verb', collocation: 'collocation', slang: 'slang', reduction: 'reduction', grammar: 'grammar',
}

/** Color variable of a chunk kind. */
export const kindColor = (kind: ChunkKind) => `var(--app-kind-${KIND_VAR[kind]})`

/** Solid colored underline of a chunk. */
export const chunkUnderline = (kind: ChunkKind): CSSProperties => ({
 textDecoration: 'underline', textDecorationThickness: 'var(--chunk-underline, 2px)', textUnderlineOffset: '0.22em', textDecorationColor: kindColor(kind),
})

/** English cue text as clickable word tokens with chunk underlines. */
export function CueText({ cue, chunks, karaoke, onPick, onHover, decorate, shareHover, showShared }: Props) {
 const tokens = useMemo(() => tokenize(cue.text), [cue.text])
 const [hoverChunk, setHoverChunk] = useState<Chunk | null>(null)
 const dragFrom = useRef<number | null>(null)
 const total = cue.text.length
 // Only texts that contain the hovered word re-render (every dialog row used to, on every hover).
 const words = useMemo(() => new Set(tokens.filter((t) => t.isWord).map((t) => wordKey(t.text))), [tokens])
 const shared = useHoverWord((s) => (showShared && s.word !== null && words.has(s.word) ? s.word : null))
 const setShared = useHoverWord((s) => s.setWord)
 // The overlay unmounts a cue under a resting pointer without mouseleave: drop the word it published.
 const published = useRef(false)
 useEffect(() => () => { if (published.current) setShared(null) }, [setShared])

 const pick = (a: number, b: number, el: HTMLElement) => {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  let span: string
  if (lo === hi) {
   const c = chunkAt(chunks, tokens[lo])
   span = c ? c.text : tokens[lo].text
  } else {
   span = cue.text.slice(tokens[lo].start, tokens[hi].end)
  }
  onPick?.({ cueIdx: cue.idx, span, anchor: el.getBoundingClientRect(), tokenStart: lo, tokenEnd: hi })
 }
 /**
  * Spoken words lit, the rest dimmed. 0.7 keeps the dimmed words readable on a bright frame (0.55
  * fell below text contrast there). No per-word transition: every word of the overlay carries a
  * text shadow, so each fade repainted the whole line for 220 ms, once per word, on the thread
  * that also feeds the video.
  */
 const spoken = (t: Token): CSSProperties | undefined =>
  karaoke === undefined ? undefined : { opacity: t.start / total <= karaoke ? 1 : 0.7 }

 return (
  <span>
   {tokens.map((t, i) => {
    if (!t.isWord) return <span key={i} style={spoken(t)}>{t.text}</span>
    const c = chunkAt(chunks, t)
    const dec = decorate?.(t, i)
    const inHover = c && hoverChunk === c
    const echoed = shared !== null && wordKey(t.text) === shared
    const style: CSSProperties = {
     cursor: 'pointer',
     ...(c && chunkUnderline(c.kind)),
     backgroundColor: inHover
      ? `color-mix(in srgb, ${kindColor(c.kind)} 18%, transparent)`
      : echoed ? 'color-mix(in srgb, var(--md-sys-color-primary) 30%, transparent)' : undefined,
     ...spoken(t),
     ...dec?.style,
    }
    return (
     <span
      key={i}
      className="relative rounded-sm"
      style={style}
      onMouseEnter={(e) => {
       setHoverChunk(c ?? null)
       if (shareHover) { published.current = true; setShared(wordKey(t.text)) }
       onHover?.({ cueIdx: cue.idx, span: c ? c.text : t.text, anchor: e.currentTarget.getBoundingClientRect(), tokenStart: i, tokenEnd: i })
      }}
      onMouseLeave={() => {
       setHoverChunk(null)
       if (shareHover) { published.current = false; setShared(null) }
       onHover?.(null)
      }}
      onMouseDown={() => { dragFrom.current = i }}
      onMouseUp={(e) => {
       const from = dragFrom.current
       dragFrom.current = null
       if (from !== null) pick(from, i, e.currentTarget)
      }}
     >
      {dec?.label}
      {t.text}
     </span>
    )
   })}
  </span>
 )
}
