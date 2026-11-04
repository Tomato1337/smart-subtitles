import { useCallback, useMemo, type CSSProperties } from 'react'
import type { Cue, CueAnnotation } from '@/common/types/ipc'
import { useAnkiDecor } from '@/modules/Anki'
import { CueText, tokenize, useSpokenFraction, useSubsStore, type SpanPick } from '@/modules/Subtitles'

type Props = {
 cue: Cue
 ann: CueAnnotation | undefined
 karaoke?: number
 /** Follow playback: light up the words of this cue as they are spoken (sidebar's focused row). */
 live?: boolean
 onPick?: (p: SpanPick) => void
 onHover?: (p: SpanPick | null) => void
 /** Overlay and sidebar both publish the hovered word and light up its occurrences. */
 shareHover?: boolean
 showShared?: boolean
}

/**
 * Double underline of a grammar pattern (drawn only on words outside chunks). Two background
 * stripes, not `text-decoration: underline double`: in WebKitGTK the second decoration line came
 * and went with unrelated repaints (gone after a hover elsewhere, back when karaoke reached the
 * word), apparently because it lies outside the area the word repaints.
 *
 * The first stripe sits exactly where `chunkUnderline` draws its line: 0.93em is the Roboto Flex
 * ascent (baseline below the top of the inline box), plus the same 0.22em offset and thickness.
 * The second one follows after a gap of one thickness. Vertical padding on an inline box does not
 * move lines, it only gives the background room below the descenders.
 */
const GRAMMAR_STRIPE = 'linear-gradient(var(--app-kind-grammar), var(--app-kind-grammar))'
const LINE = 'var(--chunk-underline, 2px)'
const FIRST = 'calc(0.93em + 0.22em)'
export const PATTERN_UNDERLINE: CSSProperties = {
 backgroundImage: `${GRAMMAR_STRIPE}, ${GRAMMAR_STRIPE}`,
 backgroundSize: `100% ${LINE}`,
 backgroundPosition: `0 ${FIRST}, 0 calc(${FIRST} + ${LINE} * 2)`,
 backgroundRepeat: 'no-repeat',
 paddingBottom: '0.5em',
}

/** English cue text with chunk underlines, grammar double underlines and Anki labels. Used by overlay and sidebar. */
export function CueLine({ cue, ann, karaoke, live, onPick, onHover, shareHover, showShared }: Props) {
 const spoken = useSpokenFraction(live ? cue : null)
 const tokens = useMemo(() => tokenize(cue.text), [cue.text])
 const { decorate: anki, hasLabels } = useAnkiDecor(cue, tokens)
 const showPatterns = useSubsStore((s) => s.patterns)

 const decorate = useCallback(
  (t: { start: number; end: number; text: string; isWord: boolean }, i: number) => {
   const a = anki(t, i)
   const inChunk = ann?.chunks.some((c) => t.start >= c.startChar && t.end <= c.endChar)
   const inPattern = showPatterns && !inChunk && ann?.patterns.some((p) => t.start >= p.startChar && t.end <= p.endChar)
   if (!inPattern) return a
   return { label: a?.label, style: { ...a?.style, ...PATTERN_UNDERLINE } }
  },
  [anki, ann, showPatterns],
 )

 return (
  <span className={hasLabels ? 'block pt-5' : undefined}>
   <CueText cue={cue} chunks={ann?.chunks ?? []} karaoke={karaoke ?? spoken} onPick={onPick} onHover={onHover} decorate={decorate} shareHover={shareHover} showShared={showShared} />
  </span>
 )
}
